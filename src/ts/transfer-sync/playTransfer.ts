import { get, writable } from 'svelte/store'
import { forageStorage, requestImmediateSave, checkCharOrder } from '../globalApi.svelte'
import { getDatabase, getCurrentCharacter, newChatModelDefaults, normalizeChat, type Chat, type character } from '../storage/database.svelte'
import { ensureChatHydrated } from '../storage/chatStorage'
import { doingChat, isAnyGenerating } from '../process/generationState'
import { importSession } from '../importSession'
import { loadedStore, alertStore } from '../stores.svelte'
import { alertSelect, alertConfirm } from '../alert'
import { applyMemorySavePromptSettings } from '../risubard/memorySaveSlots'
import { transferBusy, transferStatus, syncSaveHold } from './transferState'
import { hashLocalJson } from '../../../shared/play-set/protocol'
import { playNative, playSetAvailable, sendNative } from './transferNative'
import { applyReceivedPersonas, planPersonas, personaPlanText, personaTargetMap, type ReceivedPersona } from './personaTransfer'
/** Persona files already asked about automatically in this session: a failed or declined automatic apply is not asked again by
 *  the poll (the list's 「가져오기」 still works), so a lasting failure never turns into a repeating question. */
const personaAutoAsked = new Set<string>()
export { transferBusy, transferStatus } from './transferState'
/**
 * One native inbox entry through the server. Play sets are queued as before. A NAS sync key share is answered by the server
 * record: terminal (applied/failed) → accept the native entry; `waiting` (an apply is in progress, or a different key is installed
 * and awaits the user's decision) → leave it unaccepted so `inbox.list` offers it again next poll. A request from a registered
 * device that produced a grant is answered automatically over the same registered channel (best effort; the UI can resend).
 */
export async function handleNativeInboxEntry(entry: { id: string }, io: { post: (path: string, body: unknown) => Promise<any>; native: typeof playNative; send: typeof sendNative }) {
    const result = await io.post('/native-import', { id: entry.id })
    if (result?.share && result.state === 'waiting') return 'waiting'
    await io.native('inbox.accept', { id: entry.id })
    if (result?.share && result.kind === 'request' && result.grant && typeof result.replyTo === 'string' && result.replyTo !== 'usb:adb') {
        try { await io.send(result.grant, 'wifi', result.replyTo) } catch (error) { transferStatus.set('동기화 키를 보내지 못했어요. 전송 화면에서 다시 보낼 수 있어요. ' + String(error)) }
        return 'replied'
    }
    return result?.share ? String(result.state) : 'queued'
}

export interface TransferEntry { id: string; name: string; direction: 'send' | 'receive'; state: string; bytes?: number; error?: string; trusted?: boolean; applyRequested?: boolean; nativeId?: string; kind?: string }
export const transferQueue = writable<TransferEntry[]>([])
export async function transferRequest(path = '', init: RequestInit = {}) {
    await forageStorage.Init()
    const response = await forageStorage.realStorage.transferRequest(path, init)
    if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        // Structured gate answers (423 NAS_SYNC_BUSY / TRANSFER_BUSY) keep their code and status so callers can tell a write-gate race from a real failure.
        throw Object.assign(new Error(data.error || `전송 요청 실패 (${response.status})`), { status: response.status, ...(typeof data.code === 'string' ? { code: data.code } : {}), ...(typeof data.transaction === 'string' ? { transaction: data.transaction } : {}) })
    }
    return response
}
const post = async (path: string, body: unknown = {}) => (await transferRequest(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
export async function requestRemoteTransfer(kind: 'nas' | 'github', operation: string, input: unknown = {}) {
    await forageStorage.Init()
    const storage = forageStorage.realStorage
    const identity = () => `${storage.syncTransaction ?? ''}\u0000${storage.transferTransaction ?? ''}`
    const started = identity(), ordinary = !storage.syncTransaction && !storage.transferTransaction, until = Date.now() + 30_000
    for (;;) {
        try { return await post(`/remote/${kind}/${operation}`, input) }
        catch (error: any) {
            // Only retry a pre-handler rejection: never replay a network failure or a durable apply transaction.
            if (error.status !== 423 || error.code !== 'NAS_SYNC_BUSY' || error.transaction || !ordinary || identity() !== started || Date.now() >= until) throw error
            transferStatus.set('동기화 작업이 끝나면 전송을 계속해요…')
            await new Promise(resolve => setTimeout(resolve, 500))
            if (identity() !== started) throw error
        }
    }
}
export async function refreshTransfers() { transferQueue.set(await (await transferRequest()).json()) }
/** 0.9.103-ver4: the running play-set step (display only): { stage, bytes, bytesTotal, items, itemsTotal, elapsedMs, stageElapsedMs } or null. */
export const playTransferProgress = async (signal?: AbortSignal) => (await transferRequest('/progress', { signal })).json()
export type TransferProgress = { stage: string; bytes: number; bytesTotal: number | null; items: number; itemsTotal: number | null; elapsedMs: number; stageElapsedMs: number }
/** Step names shown for the server's play-set stages (user wording: what is happening now). */
export const TRANSFER_STAGES: Record<string, string> = {
    collect: '대화·Wiki·저장 슬롯·그림을 모으는 중', pack: '전송 파일로 묶는 중', hash: '전송 파일 확인값 계산 중',
    upload: '올리는 중', 'upload-check': '올린 파일을 다시 받아 확인하는 중', 'upload-finish': '올린 파일 이름 정리 중',
    receive: '파일을 받는 중', native: '기기에서 받은 파일 확인 중', verify: '받은 파일 검증 중', check: '받은 파일 내용 확인 중',
    copy: '그림 꺼내는 중', memory: 'Wiki·저장 슬롯 준비 중', install: '그림 저장 중', finish: 'Wiki·저장 슬롯 옮기는 중',
}
const mb = (n: number) => (n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)
const clock = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s >= 3600 ? `${Math.floor(s / 3600)}시간 ${Math.floor(s % 3600 / 60)}분` : s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초` }
/** One progress line from a server step ({@link TransferProgress}) or a native send ({ state, sent, total }), display only. percent is
 *  null when no total is known (indeterminate bar). Speed and remaining time are the stage average, shown after 2 s and 1 MB. */
export function transferProgressView(progress: TransferProgress | null, native: { state: string; sent?: number; total?: number; error?: string } | null = null, fallback = '') {
    if (progress) {
        const byBytes = !!progress.bytesTotal, byItems = !byBytes && !!progress.itemsTotal
        const done = byBytes ? Math.min(progress.bytes, progress.bytesTotal!) : byItems ? Math.min(progress.items, progress.itemsTotal!) : 0
        const total = byBytes ? progress.bytesTotal! : byItems ? progress.itemsTotal! : 0
        const percent = total ? Math.min(100, Math.floor(done / total * 100)) : null
        const parts: string[] = []
        if (progress.bytesTotal) parts.push(`${mb(Math.min(progress.bytes, progress.bytesTotal))}/${mb(progress.bytesTotal)} MB`)
        else if (progress.bytes > 0) parts.push(`${mb(progress.bytes)} MB`)
        if (progress.itemsTotal) parts.push(`${Math.min(progress.items, progress.itemsTotal)}/${progress.itemsTotal}개`)
        else if (progress.items > 0) parts.push(`${progress.items}개`)
        const seconds = progress.stageElapsedMs / 1000
        if (progress.bytes >= 1_000_000 && seconds >= 2) {
            const speed = progress.bytes / seconds
            parts.push(`${mb(speed)} MB/s`)
            if (progress.bytesTotal && progress.bytes < progress.bytesTotal) parts.push(`남은 시간 약 ${clock((progress.bytesTotal - progress.bytes) / speed * 1000)}`)
        }
        parts.push(`경과 ${clock(progress.elapsedMs)}`)
        return { label: TRANSFER_STAGES[progress.stage] ?? (fallback || '처리 중'), percent, detail: parts.join(' · '), tone: 'running' as const }
    }
    if (native) {
        const total = native.total ?? 0, sent = Math.min(native.sent ?? 0, total)
        const finished = ['delivered', 'applied'].includes(native.state), failed = ['failed', 'cancelled', 'unknown'].includes(native.state)
        // Direction-neutral: the Windows USB 「기기에서 받기」 loop writes the same store. `unknown` = the state could not be read, not a failure.
        const label = native.state === 'applied' ? '받는 쪽에서 가져오기 완료' : native.state === 'delivered' ? '전달 완료 · 받는 쪽에서 가져오기 대기'
            : native.state === 'unknown' ? '상대 기기 상태를 확인하지 못했어요' : failed ? '전송 실패' : native.state === 'ready' ? 'USB 전송 준비 완료 · PC 전송기에서 받아 주세요' : native.state === 'preparing' ? 'USB 전송 준비 중' : 'Wi-Fi·USB로 전송 중'
        return { label, percent: finished ? 100 : total ? Math.min(100, Math.floor(sent / total * 100)) : null, detail: failed ? native.error ?? '' : total ? `${mb(sent)}/${mb(total)} MB` : '',
            tone: finished ? 'done' as const : failed ? 'failed' as const : 'running' as const }
    }
    return { label: fallback || '처리 중', percent: null, detail: '', tone: 'running' as const }
}
/** The same line as text with a 10-cell bar, for the modal overlay (App.svelte shows only the status text): no host change needed. */
export function transferProgressText(progress: TransferProgress) {
    const view = transferProgressView(progress)
    const bar = view.percent === null ? '' : ` ${'█'.repeat(Math.round(view.percent / 10))}${'░'.repeat(10 - Math.round(view.percent / 10))} ${view.percent}%`
    return `${view.label}${bar} · ${view.detail}`
}
/** While a step behind the modal overlay runs, its status line carries the server step's progress (polled every second). Text another
 *  writer sets stays the base line; when no server step runs, the base line is shown again. Returns the stop function. */
function overlayProgress() {
    let base = get(transferStatus), mine = '', stopped = false, controller: AbortController | undefined
    const timer = setInterval(() => {
        if (controller) return
        // A hung request is cut after 5 s (like the panel line), so the next tick can ask again; stop() cancels it.
        const c = controller = new AbortController(), limit = setTimeout(() => c.abort(), 5000)
        void playTransferProgress(c.signal).then((progress: TransferProgress | null) => {
            if (stopped) return
            const current = get(transferStatus)
            if (current !== mine) base = current
            mine = progress ? transferProgressText(progress) : base
            if (mine !== current) transferStatus.set(mine)
        }).catch(() => {}).finally(() => { clearTimeout(limit); if (controller === c) controller = undefined })
    }, 1000)
    return () => { stopped = true; clearInterval(timer); controller?.abort(); if (mine && get(transferStatus) === mine && mine !== base) transferStatus.set(base) }
}
export function transferUnavailable() {
    return get(transferBusy) || get(syncSaveHold) || get(doingChat) || get(isAnyGenerating) || get(importSession).phase !== 'idle'
        || getDatabase().characters.some(c => c.chats.some(ch => ch.isStreaming || ch.risuBardWikiReboot))
}
export async function queueTransferFile(file: File) {
    transferStatus.set('파일을 받는 중…')
    try {
        await transferRequest('/incoming', { method: 'POST', body: file, headers: { 'content-type': 'application/octet-stream', 'x-transfer-name': encodeURIComponent(file.name) } })
        transferStatus.set('받기 완료 · 가져오기 대기')
    } catch (error) { transferStatus.set(String(error)); throw error }
    finally { await refreshTransfers() }
}
export async function exportTransfer(chatIds: string[], compatibility = false) {
    if (transferUnavailable()) throw new Error('진행 중인 생성이나 가져오기가 끝난 뒤 다시 보내 주세요.')
    transferBusy.set(true); transferStatus.set('보낼 자료를 확인하고 묶는 중…')
    const stopProgress = overlayProgress()
    try {
        const char = getCurrentCharacter()
        if (!char) throw new Error('보낼 캐릭터를 먼저 열어 주세요.')
        for (const id of chatIds) if (!await ensureChatHydrated(char.chats, char.chats.findIndex(ch => ch.id === id), char.chaId)) throw new Error('대화 내용을 읽지 못했어요.')
        await requestImmediateSave({ flushServer: 'canonical', rejectOnFailure: true })
        const result = await post('/export', { characterId: char.chaId, chatIds, primaryChatId: chatIds.includes(char.chats[char.chatPage]?.id) ? char.chats[char.chatPage].id : chatIds[0], compatibility })
        if (result.registry) {
            Object.assign(getDatabase(), { risuPlaySets: result.registry })
            await requestImmediateSave({ flushServer: 'canonical', rejectOnFailure: true })
        }
        stopProgress()
        transferStatus.set(result.missing.length ? '필요한 자료가 빠져 있어요. 아래 목록을 확인해 주세요.' : '파일 준비 완료 · 보낼 방법을 선택해 주세요.')
        return result
    } finally { stopProgress(); transferBusy.set(false); await refreshTransfers() }
}
/** Persona transfer: bundles the chosen personas (saved values) as one file for any transfer method. */
export async function exportPersonaTransfer(personaIds: string[]) {
    if (transferUnavailable()) throw new Error('진행 중인 생성이나 가져오기가 끝난 뒤 다시 보내 주세요.')
    if (!personaIds.length) throw new Error('보낼 페르소나를 골라 주세요.')
    transferBusy.set(true); transferStatus.set('보낼 페르소나를 묶는 중…')
    try {
        // The selected persona is edited through the active fields; write them back to its row first (upstream saveUserPersona).
        ;(await import('../persona')).saveUserPersona()
        await requestImmediateSave({ flushServer: 'canonical', rejectOnFailure: true })
        const result = await post('/persona-export', { personaIds })
        transferStatus.set(result.excluded?.length ? '일부 파일을 빼고 묶었어요. 아래 목록을 확인해 주세요.' : '파일 준비 완료 · 보낼 방법을 선택해 주세요.')
        return result
    } finally { transferBusy.set(false); await refreshTransfers() }
}
/** Applies a received persona file after the user confirms: a unique same name → updated in place (id kept), otherwise added.
 *  Only names are read before asking; pictures come after the answer. */
export async function receivePersonaTransfer(key: string, automatic = false, inspected?: { personas?: { name: string }[] }) {
    if (transferUnavailable()) { transferStatus.set('기존 작업이 끝나면 가져올 수 있어요. 받은 파일은 보관됩니다.'); return }
    if (automatic) personaAutoAsked.add(key)
    const names = (inspected ?? await (await transferRequest(`/${key}/inspect`)).json()).personas ?? []
    if (!await alertConfirm(personaPlanText(planPersonas(getDatabase(), names)))) {
        // An automatic (NAS "앱으로 받기") apply that was declined is not asked again every poll; the entry stays in the list.
        if (automatic) await post(`/${key}/apply-request`, { requested: false }).catch(() => {})
        transferStatus.set('페르소나 가져오기를 미뤘어요. 수신 목록에서 다시 가져올 수 있어요.')
        await refreshTransfers()
        return
    }
    if (transferUnavailable()) return
    transferBusy.set(true); transferStatus.set('페르소나를 가져오는 중…')
    // Like any other edit, an applied import is not undone when its save does not confirm: the app's normal save keeps retrying
    // it, and the received file stays in the list until it is marked applied. Applying the file again is safe: it updates the
    // same personas (those it added are found by their stable ids) and adds nothing twice.
    let applied = false
    try {
        const received = await (await transferRequest(`/${key}/personas`)).json()
        const [database, inlays, globalApi, uuid] = await Promise.all([import('../storage/database.svelte'), import('../process/files/inlays'), import('../globalApi.svelte'), import('uuid')])
        const io = {
            saveImage: (bytes: Uint8Array) => database.saveImage(bytes), reencodeImage: (bytes: Uint8Array) => inlays.reencodeImage(bytes),
            saveAsset: (bytes: Uint8Array, customId: string, fileName: string) => globalApi.saveAsset(bytes, customId, fileName), newId: () => uuid.v4(),
        }
        const rows = received.personas as ReceivedPersona[], planned = planPersonas(getDatabase(), rows, io.newId)
        // Recorded first, so applying this file again reaches the same personas even after one is renamed.
        await post(`/${key}/persona-map`, { map: personaTargetMap(getDatabase(), rows, planned) })
        const plan = await applyReceivedPersonas(getDatabase(), rows, received.blobs ?? {}, io, planned)
        applied = true
        await requestImmediateSave({ flushServer: 'canonical', rejectOnFailure: true })
        await post(`/${key}/persona-applied`)
        transferStatus.set(`페르소나를 가져왔어요.${plan.updated.length ? ` 바꿈 ${plan.updated.length}개` : ''}${plan.added.length ? ` · 추가 ${plan.added.length}개` : ''}`)
    } catch (error) {
        if (!applied) { transferStatus.set(String(error)); throw error }
        // The server may have recorded "applied" and only the answer was lost: say which it is.
        await refreshTransfers().catch(() => {})
        const done = get(transferQueue).find(entry => entry.id === key)?.state === 'applied'
        transferStatus.set(done
            ? `페르소나를 가져왔어요. 저장 확인 응답만 받지 못했어요. 앱이 저장을 다시 시도해요. ${String(error)}`
            : `페르소나는 가져왔지만 저장이나 완료 표시를 확인하지 못했어요. 앱이 저장을 다시 시도해요. 받은 파일은 수신 목록에 남겨 두었고, 다시 가져와도 같은 페르소나가 두 번 생기지 않아요. ${String(error)}`)
    } finally { transferBusy.set(false); await refreshTransfers() }
}
export async function receiveTransfer(key: string, automatic = false) {
    if (transferUnavailable()) { transferStatus.set('기존 작업이 끝나면 가져올 수 있어요. 받은 파일은 보관됩니다.'); return }
    const inspection = await (await transferRequest(`/${key}/inspect`)).json()
    if (inspection.kind === 'persona') return receivePersonaTransfer(key, automatic, inspection)
    const targets: Record<string, string> = {}
    for (const c of inspection.characters) if (c.candidates.length > 1) {
        if (automatic) { await post(`/${key}/apply-request`, { requested: false }); transferStatus.set('같은 이름의 캐릭터가 여러 개예요. 수신 목록에서 대상을 선택해 주세요.'); await refreshTransfers(); return }
        const choice = await alertSelect(c.candidates.map((item: { name: string; id: string }) => `${item.name} (${item.id.slice(0, 8)})`), `${c.name}의 대화를 받을 캐릭터`)
        if (choice === undefined || Number(choice) < 0 || !c.candidates[Number(choice)]) return
        targets[c.id] = c.candidates[Number(choice)].id
    }
    if (transferUnavailable()) return
    transferBusy.set(true); transferStatus.set('자료 검증 · 가져오기 준비 중…')
    let prepared = false
    const stopProgress = overlayProgress()
    try {
        await requestImmediateSave({ flushServer: 'canonical', rejectOnFailure: true })
        const plan = await post(`/${key}/prepare`, { targets }); prepared = true
        const db = getDatabase()
        for (const addition of plan.added as { characterId: string; chat: Chat }[]) {
            const target = db.characters.find(c => c.chaId === addition.characterId) ?? plan.newCharacters.find((c: character) => c.chaId === addition.characterId)
            const previousIndex = target.chatPage ?? 0
            const previous = target.chats[previousIndex] ? await ensureChatHydrated(target.chats, previousIndex, target.chaId) : undefined
            const defaults = { ...newChatModelDefaults(target, previous), ...previous } as Chat
            applyMemorySavePromptSettings(addition.chat, defaults)
            if (addition.chat.GLGlobalVariables) addition.chat.useLocallySetGlobalVariables = true
            addition.chat = normalizeChat(addition.chat)
        }
        await post(`/${key}/arm`, { transaction: plan.transaction, added: plan.added })
        forageStorage.realStorage.transferTransaction = plan.transaction
        transferStatus.set('채팅을 저장하는 중…')
        db.characters.push(...plan.newCharacters)
        for (const addition of plan.added) db.characters.find(c => c.chaId === addition.characterId)!.chats.push(addition.chat)
        // 0.9.103-ver4: Asset Maid pictures of a chat received into an existing card: add only the names the card does not have yet.
        for (const row of (plan.characterAssets ?? []) as { characterId: string; name: string; path: string; ext: string }[]) {
            const target = db.characters.find(c => c.chaId === row.characterId)
            if (target && !(target.additionalAssets ?? []).some(entry => entry?.[0] === row.name)) (target.additionalAssets ??= []).push([row.name, row.path, row.ext])
        }
        Object.assign(db, { risuPlaySets: plan.registry })
        checkCharOrder()
        await requestImmediateSave({ chats: plan.added.map((row: { characterId: string; chat: Chat }) => [row.characterId, row.chat.id!]), flushServer: 'canonical', rejectOnFailure: true })
        await post(`/${key}/finish`, { confirmed: true })
        stopProgress()
        transferStatus.set(plan.duplicate ? '이미 받은 동일한 자료예요. 중복으로 추가하지 않았어요.' : '가져오기 완료 · 기존 캐릭터 목록에서 확인해 주세요.')
    } catch (error) {
        stopProgress()
        transferStatus.set(String(error))
        if (prepared) {
            // Reload reads the durable app revision before any recovery decision; never roll back a live DB copy.
            location.reload()
            return
        }
        throw error
    } finally { stopProgress(); forageStorage.realStorage.transferTransaction = undefined; transferBusy.set(false); await refreshTransfers() }
}
export async function recoverTransfers() {
    const pending = await (await transferRequest('/recovery')).json()
    if (!pending.length) return
    transferBusy.set(true)
    try {
        // This runs before autosave, plugins and generation. Server rechecks the same durable chat hashes.
        for (const record of pending) {
            try {
                const registry = (getDatabase() as any).risuPlaySets
                const committed = !!registry?.transactions?.[record.transaction]
                for (const expected of record.expected) {
                    const c = getDatabase().characters.find(c => c.chaId === expected.characterId)
                    const chat = c ? await ensureChatHydrated(c.chats, c.chats.findIndex(ch => ch.id === expected.chatId), c.chaId) : undefined
                    if (committed && (!chat || expected.fields.some((key: string) => (chat as any)[key] === undefined) || await hashLocalJson(Object.fromEntries(expected.fields.map((key: string) => [key, (chat as any)[key]]))) !== expected.hash)) {
                        throw new Error('저장된 채팅이 적용 기록과 달라 복구를 보류했어요. 받은 파일과 복구 기록은 보관돼 있어요.')
                    }
                }
                await post(`/${record.id}/finish`)
            } catch (error) {
                transferStatus.set(String(error))
                if (!await alertConfirm('가져오기 복구를 완료하지 못했어요. 현재 대화·수신 원본·복구 자료를 보관한 채 이번 복구를 보류하고 앱을 열까요? 받은 대화의 기억·저장 슬롯은 완성되지 않았을 수 있어요.\n' + String(error))) throw error
                await post(`/${record.id}/hold-recovery`, { confirmed: true })
                transferStatus.set('복구를 보류했어요. 현재 대화와 수신 원본, 복구 자료를 모두 보관했어요.')
            }
        }
    } finally { transferBusy.set(false) }
}
export async function cancelTransfer(key: string) { await post(`/${key}/cancel`); await refreshTransfers() }
export async function uploadLegacyChat() {
    if (transferUnavailable()) throw new Error('진행 중인 작업이 끝난 뒤 다시 보내 주세요.')
    transferBusy.set(true)
    try {
        const character = getCurrentCharacter()
        if (!character) throw new Error('보낼 캐릭터를 먼저 열어 주세요.')
        const chat = await ensureChatHydrated(character.chats, character.chatPage, character.chaId)
        if (!chat?.id) throw new Error('현재 대화를 읽지 못했어요.')
        await requestImmediateSave({ flushServer: 'canonical', rejectOnFailure: true })
        const input = { characterId: character.chaId, chatId: chat.id, promptConflict: true }
        const result = await post('/remote/github/legacy-upload', input)
        if (!result.conflictSha) return result
        if (!await alertConfirm('기존 GitHub 백업과 대화가 다르게 수정됐어요. 현재 기기의 대화로 최신 백업을 바꿀까요? 이전 Git 이력은 유지됩니다.')) return { cancelled: true }
        return await post('/remote/github/legacy-upload', { ...input, replaceSha: result.conflictSha })
    } finally { transferBusy.set(false) }
}
let polling = false
/** A structured write-gate answer (server 423 with one of these codes) that a background poll must not report as an error. */
const GATE_CODES = ['NAS_SYNC_BUSY', 'TRANSFER_BUSY']
const gateRace = (error: any) => error?.status === 423 && GATE_CODES.includes(error?.code)
export function startTransferInbox() {
    if (polling) return
    polling = true
    // While a NAS sync apply or a manual transfer holds the write gate, native polling would only collect 423s (and overwrite the
    // status text with them): skip the tick, and re-check after every awaited step because the gate can close mid-tick.
    const gateHeld = () => get(transferBusy) || get(syncSaveHold)
    const poll = async () => {
        try {
            try {
                if (get(loadedStore) && playSetAvailable() && !document.hidden && !gateHeld()) {
                    await playNative('network.start'); if (gateHeld()) return
                    await playNative('usb.start'); if (gateHeld()) return
                    const incoming = await playNative<{ id: string }[]>('inbox.list')
                    for (const entry of incoming) {
                        if (gateHeld()) return
                        try { await handleNativeInboxEntry(entry, { post, native: playNative, send: sendNative }) }
                        catch (error: any) { if (!gateRace(error)) transferStatus.set(String(error)) }
                    }
                    if (gateHeld()) return
                    await refreshTransfers(); if (gateHeld()) return
                    await playNative('state.write', { key: 'queue', value: get(transferQueue).filter(entry => entry.nativeId).map(entry => ({ id: entry.nativeId, state: entry.state })) })
                }
            } catch (error: any) { if (!gateRace(error)) transferStatus.set(String(error)) } // A USB/Wi-Fi bridge failure must not block NAS/GitHub's durable inbox.
            if (get(loadedStore) && !transferUnavailable() && get(alertStore).type === 'none') {
                await refreshTransfers()
                // A persona file changes existing personas, so it is applied on its own only when the user asked for it (NAS "앱으로 받기"),
                // never just because a registered Wi-Fi device sent it; it still asks before changing anything.
                const next = get(transferQueue).find(item => item.direction === 'receive' && item.state === 'waiting' && (item.kind === 'persona' ? item.applyRequested === true && !personaAutoAsked.has(item.id) : (item.applyRequested ?? item.trusted)))
                if (next) await receiveTransfer(next.id, true)
            }
        } catch (error: any) { if (!gateRace(error)) transferStatus.set(String(error)) } // a gate race is expected and silent; real network/IO errors are shown as before
        finally { setTimeout(poll, 3000) }
    }
    void poll()
}
