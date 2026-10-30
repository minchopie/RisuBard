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

export interface TransferEntry { id: string; name: string; direction: 'send' | 'receive'; state: string; bytes?: number; error?: string; trusted?: boolean; applyRequested?: boolean; nativeId?: string }
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
        transferStatus.set(result.missing.length ? '필요한 자료가 빠져 있어요. 아래 목록을 확인해 주세요.' : '파일 준비 완료 · 보낼 방법을 선택해 주세요.')
        return result
    } finally { transferBusy.set(false); await refreshTransfers() }
}
export async function receiveTransfer(key: string, automatic = false) {
    if (transferUnavailable()) { transferStatus.set('기존 작업이 끝나면 가져올 수 있어요. 받은 파일은 보관됩니다.'); return }
    const inspection = await (await transferRequest(`/${key}/inspect`)).json()
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
        Object.assign(db, { risuPlaySets: plan.registry })
        checkCharOrder()
        await requestImmediateSave({ chats: plan.added.map((row: { characterId: string; chat: Chat }) => [row.characterId, row.chat.id!]), flushServer: 'canonical', rejectOnFailure: true })
        await post(`/${key}/finish`, { confirmed: true })
        transferStatus.set(plan.duplicate ? '이미 받은 동일한 자료예요. 중복으로 추가하지 않았어요.' : '가져오기 완료 · 기존 캐릭터 목록에서 확인해 주세요.')
    } catch (error) {
        transferStatus.set(String(error))
        if (prepared) {
            // Reload reads the durable app revision before any recovery decision; never roll back a live DB copy.
            location.reload()
            return
        }
        throw error
    } finally { forageStorage.realStorage.transferTransaction = undefined; transferBusy.set(false); await refreshTransfers() }
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
                const next = get(transferQueue).find(item => item.direction === 'receive' && item.state === 'waiting' && (item.applyRequested ?? item.trusted))
                if (next) await receiveTransfer(next.id, true)
            }
        } catch (error: any) { if (!gateRace(error)) transferStatus.set(String(error)) } // a gate race is expected and silent; real network/IO errors are shown as before
        finally { setTimeout(poll, 3000) }
    }
    void poll()
}
