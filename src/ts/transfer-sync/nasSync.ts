import { themePresetLocalFields } from '../../../shared/play-set/protocol'
import { get } from 'svelte/store'
import { forageStorage, requestImmediateSave, checkCharOrder, pendingTrackedChanges } from '../globalApi.svelte'
import { getDatabase, normalizeChat, type Chat, type character } from '../storage/database.svelte'
import { ensureChatHydrated } from '../storage/chatStorage'
import { alertConfirm } from '../alert'
import { selectedCharID } from '../stores.svelte'
import { transferUnavailable } from './playTransfer'
import { playNative, androidTransferAvailable } from './transferNative'
import { doingChat, isAnyGenerating } from '../process/generationState'
import { importSession } from '../importSession'
import { transferBusy, transferStatus, syncSaveHold, syncBusyOwned } from './transferState'
import { safeStructuredClone } from '../polyfill'

/**
 * Client side of NAS sync. The server never writes the live database; this module drives the plan through the ordinary
 * save flow in this order: plan → arm (server write gate moves to this transaction, header set) → mutate in place →
 * canonical save → finish. Existing chat objects keep their identity (drafts/screen bindings), selection is restored by
 * id (never by index), an open chat that the remote deleted is kept with inline restore state, and a failure is handled
 * by outcome: before the save everything is rolled back from this client's own snapshot; after a successful save nothing
 * is rewound and the server plan stays for recovery. No reload. No scheduler/UI yet: `applySync`/`recoverSync` are the
 * entry points for later wiring.
 */
export interface SyncPlanChat { characterId: string; chat: Chat; update: boolean; root: string; head: string }
export interface SyncDeletion { kind: 'chat' | 'character' | 'module' | 'plugin'; characterId?: string; id: string }
export interface SyncPlan {
    empty?: boolean; transaction: string; phase: string; settings: Record<string, unknown>; pluginEnabled: Record<string, boolean> | null
    characters: { chaId: string; fields: Record<string, unknown>; chatIds: string[] }[]; newCharacters: (character & { chatIds?: string[] })[]; chats: SyncPlanChat[]
    modules: any[]; plugins: any[]; deletions: SyncDeletion[]; pending: unknown[]
}
export interface SyncApplyOutcome { state: 'busy' | 'empty' | 'applied' | 'review-needed' | 'save-failed' | 'finish-pending' | 'deferred' | 'deferred-active-chat'; transaction?: string; pending?: unknown[]; keptDeletions?: SyncDeletion[]; error?: string; deferred?: string[] }
/** Work that must not be interrupted by an apply: generation, import, streaming or Wiki reboot. Re-checked after every network wait. */
export function activityBlocksSync() {
    return get(doingChat) || get(isAnyGenerating) || get(importSession).phase !== 'idle' || getDatabase().characters.some(c => c.chats.some(ch => ch.isStreaming || ch.risuBardWikiReboot))
}
export async function syncRequest(path = '', init: RequestInit = {}) {
    await forageStorage.Init()
    const response = await forageStorage.realStorage.syncRequest(path, init)
    if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw Object.assign(new Error(data.error || `동기화 요청 실패 (${response.status})`), { code: data.code, status: response.status })
    }
    return response
}
const post = async (path: string, body: unknown = {}, signal?: AbortSignal) => (await syncRequest(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal })).json()
export const syncStatus = async (signal?: AbortSignal) => (await syncRequest('/status', { signal })).json()
export const enableSync = (workspaceId: string, role: 'authority' | 'joining' = 'authority') => post('/enable', { workspaceId, role })
export const disableSync = () => post('/disable')
export const snapshotSync = (signal?: AbortSignal) => post('/snapshot', {}, signal)
export const publishSync = (signal?: AbortSignal) => post('/publish', {}, signal)
export const pullSync = (signal?: AbortSignal) => post('/pull', {}, signal)
/** Release a plan the server still holds in `prepared` phase (e.g. the client's bounded wait gave up before the /plan answer arrived):
 *  an unconfirmed finish of a prepared plan is a pure rollback — nothing was armed, no data touched. Armed plans are never released this way. */
export const releaseSyncPlan = (transaction: string, signal?: AbortSignal) => post('/finish', { transaction, confirmed: false }, signal)
export const bootstrapSync = (authorityDevice: string) => post('/bootstrap', { authorityDevice })
export const syncNetwork = async (signal?: AbortSignal) => (await syncRequest('/network', { signal })).json()
/** Home/external route input. Android: the native bridge's live Wi-Fi view (foreground location consent; unknown → external) is
 *  reported before every cycle. Windows: the server detects its own adapter, nothing is reported. */
export async function reportSyncNetwork(signal?: AbortSignal) {
    if (!androidTransferAvailable()) return syncNetwork(signal)
    const info = await playNative<{ transport?: string; ssid?: string | null }>('wifi.ssid').catch(() => ({ transport: 'unknown', ssid: null }))
    return post('/network', { transport: info.transport ?? 'unknown', ssid: info.ssid ?? null }, signal)
}
/** Register the Wi-Fi this device is on as a home network (Android asks for the foreground location permission first). */
export async function registerHomeNetwork() {
    if (androidTransferAvailable()) { const state = await playNative<string>('wifi.permission').catch(() => 'unavailable'); if (state === 'requested') return { requested: true }; await reportSyncNetwork() }
    return post('/network/register')
}
export const forgetHomeNetwork = (ssid: string) => post('/network/forget', { ssid })
export const shareRequestSync = () => post('/share/request')
export const acceptSharedKey = () => post('/share/accept', { replace: true })
export const discardShareSync = (id: string) => post('/share/discard', { id })
export const syncConflicts = async () => (await syncRequest('/conflicts')).json()
export const syncOverview = async () => (await syncRequest('/overview')).json()
export const resolveSyncConflict = (root: string, keep: string) => post('/resolve', { root, keep })
export const syncTrash = async () => (await syncRequest('/trash')).json()
export const restoreSyncTrash = (id: string) => post('/trash/restore', { id })
/** The chat kept open through a remote deletion: restore it (its state is published first) or accept the deletion locally. */
/** Both actions mutate the open chat across awaits: they are admitted only when nothing else is running (generation, import,
 *  transfer, apply) and they own the busy state while they run, so no generation or apply starts underneath them. */
async function ownedChatAction<T>(work: () => Promise<T>): Promise<T> {
    if (transferUnavailable()) throw new Error('진행 중인 작업이 끝난 뒤 다시 시도해 주세요.')
    transferBusy.set(true)
    try { return await work() } finally { transferBusy.set(false) }
}
export function restoreOpenDeletion(characterId: string, chatId: string) {
    return ownedChatAction(async () => {
        await requestImmediateSave({ flushServer: 'canonical', rejectOnFailure: true }) // the server publishes the saved state first
        const result = await post('/open-deletion/restore', { chatId })
        const chat = (getDatabase() as any).characters.find((c: any) => c.chaId === characterId)?.chats?.find((ch: any) => ch.id === chatId)
        if (chat) delete chat.risuSyncDeleted
        await requestImmediateSave({ flushServer: 'canonical', rejectOnFailure: true })
        return result
    })
}
export function acceptOpenDeletion(characterId: string, chatId: string) {
    return ownedChatAction(async () => {
        await post('/open-deletion/accept', { chatId })
        const db = getDatabase() as any, character = db.characters.find((c: any) => c.chaId === characterId)
        if (character) { const index = character.chats.findIndex((ch: any) => ch.id === chatId); if (index >= 0) { character.chats.splice(index, 1); character.chatPage = Math.max(0, Math.min(character.chatPage, character.chats.length - 1)) } }
        await requestImmediateSave({ flushServer: 'canonical', rejectOnFailure: true })
    })
}

/** Replace an object's fields in place so the same object stays bound to the open screen, draft and scroll position. */
function assignInPlace(target: Record<string, unknown>, source: Record<string, unknown>) {
    for (const key of Object.keys(target)) if (!(key in source)) delete target[key]
    Object.assign(target, source)
}
const deletionKey = (d: SyncDeletion) => `${d.kind}:${d.characterId ?? ''}:${d.id}`
/** Roots the admitted-but-unapplied commits would touch (server view, no plan, nothing consumed): the coordinator's safe-window input. */
export const pendingRootsSync = async (signal?: AbortSignal): Promise<{ roots: { domain: string; type: string; root: string; chatIds?: string[] }[]; plan: string | null }> => (await syncRequest('/pending-roots', { signal })).json()
/** "<characterId>/<open chat id>" of the chat on screen ('' when none): the unit that incoming chat changes must not splice into while it is open. */
export function activeChatSignature(): string {
    const s = captureSelection()
    return s.characterId ? `${s.characterId}/${s.chatIds.get(s.characterId) ?? ''}` : ''
}
/** Selection captured by id before any list changes, restored as indexes afterwards. */
function captureSelection() {
    const db = getDatabase() as any, index = get(selectedCharID)
    const character = index >= 0 ? db.characters[index] : undefined
    return { characterId: character?.chaId as string | undefined, chatIds: new Map<string, string | undefined>((db.characters as any[]).map(c => [c.chaId, c.chats?.[c.chatPage]?.id])) }
}
function restoreSelection(selection: ReturnType<typeof captureSelection>) {
    const db = getDatabase() as any
    for (const c of db.characters) { const wanted = selection.chatIds.get(c.chaId); const index = wanted ? (c.chats ?? []).findIndex((ch: any) => ch.id === wanted) : -1; c.chatPage = index >= 0 ? index : Math.min(c.chatPage ?? 0, Math.max(0, (c.chats?.length ?? 1) - 1)) }
    if (selection.characterId !== undefined) { const index = db.characters.findIndex((c: any) => c.chaId === selection.characterId); if (index >= 0 && index !== get(selectedCharID)) selectedCharID.set(index) }
}
/** Exact snapshot of everything this transaction may touch, taken by the client itself for a complete targeted rollback. */
function captureBefore(plan: SyncPlan) {
    const db = getDatabase() as any
    // The live database is Svelte $state (proxies): structuredClone throws DataCloneError on it, so values are snapshotted with
    // the app's own proxy-safe clone while the original references stay in place for the in-place apply.
    const clone = <T>(v: T): T => safeStructuredClone(v)
    const chats = new Map<string, Chat>()
    for (const row of plan.chats) { const chat = db.characters.find((c: any) => c.chaId === row.characterId)?.chats?.find((ch: any) => ch.id === row.chat.id); if (chat) chats.set(`${row.characterId}/${row.chat.id}`, clone(chat)) }
    return {
        settings: Object.fromEntries(Object.keys(plan.settings).map(k => [k, k in db ? clone(db[k]) : undefined])),
        modules: clone(db.modules ?? null), plugins: clone(db.plugins ?? null),
        characters: (db.characters as any[]).map(c => { const { chats: _chats, ...rest } = c; return { ref: c, snapshot: clone(rest), chats: [...(c.chats ?? [])], chatPage: c.chatPage } }),
        chats,
    }
}
function restoreBefore(before: ReturnType<typeof captureBefore>) {
    const db = getDatabase() as any
    for (const [k, v] of Object.entries(before.settings)) { if (v === undefined) delete db[k]; else db[k] = v }
    if (before.modules !== null) db.modules = before.modules; else delete db.modules
    if (before.plugins !== null) db.plugins = before.plugins; else delete db.plugins
    db.characters = before.characters.map(({ ref, snapshot, chats, chatPage }) => { assignInPlace(ref, { ...snapshot, chats, chatPage }); return ref })
    for (const [key, snapshot] of before.chats) { const [characterId, chatId] = key.split('/'); const chat = db.characters.find((c: any) => c.chaId === characterId)?.chats?.find((ch: any) => ch.id === chatId); if (chat) assignInPlace(chat, snapshot as any) }
}
/** Applies the plan in place. Returns the deletions deliberately kept (the currently open chat keeps its draft). */
/** Planned theme-preset entries + this device's layout fields from the entry at the same position (presets are positional). */
export function withLocalThemeLayout(planned: any[], local: any[] | undefined): any[] {
    return planned.map((entry, index) => {
        const mine = local?.[index]
        if (!entry || typeof entry !== 'object' || !mine || typeof mine !== 'object') return entry
        return { ...entry, ...Object.fromEntries(themePresetLocalFields.filter(field => field in mine).map(field => [field, mine[field]])) }
    })
}
function applyPlanToDatabase(plan: SyncPlan, selection: ReturnType<typeof captureSelection>): SyncDeletion[] {
    const db = getDatabase() as any
    for (const [key, value] of Object.entries(plan.settings)) { if (value === null) delete db[key]; else db[key] = value }
    for (const item of plan.modules) { const list = (db.modules ??= []); const index = list.findIndex((m: any) => m.id === item.id); if (index >= 0) list[index] = item; else list.push(item) }
    for (const item of plan.plugins) { const list = (db.plugins ??= []); const index = list.findIndex((p: any) => p.name === item.name); if (index >= 0) list[index] = item; else list.push(item) }
    if (plan.pluginEnabled) for (const plugin of db.plugins ?? []) if (plugin.name in plan.pluginEnabled) plugin.enabled = plan.pluginEnabled[plugin.name]
    for (const added of plan.newCharacters) if (!db.characters.some((c: any) => c.chaId === added.chaId)) { const { chatIds: _ids, ...rest } = added as any; db.characters.push({ ...rest, chats: [], chatPage: 0 }) }
    for (const update of plan.characters) {
        const target = db.characters.find((c: any) => c.chaId === update.chaId); if (!target) continue
        const keep = Object.fromEntries(['chatPage', 'viewScreen', 'inlayViewScreen', 'lastInteraction', 'trashTime', 'chats'].filter(k => k in target).map(k => [k, target[k]]))
        assignInPlace(target, { ...update.fields, ...keep, chaId: update.chaId })
    }
    for (const row of plan.chats) {
        const target = db.characters.find((c: any) => c.chaId === row.characterId); if (!target) continue
        target.chats ??= []
        const existing = target.chats.find((ch: any) => ch.id === row.chat.id)
        if (existing) assignInPlace(existing, row.chat as any); else target.chats.push(row.chat)
    }
    for (const update of [...plan.characters, ...plan.newCharacters.map(c => ({ chaId: c.chaId, chatIds: (c as any).chatIds ?? [] }))]) {
        const target = db.characters.find((c: any) => c.chaId === update.chaId); if (!target) continue
        // Remote membership order first, then chats only this device knows (sibling branches, local-only chats): never dropped.
        const byId = new Map((target.chats ?? []).map((ch: any) => [ch.id, ch]))
        const ordered = update.chatIds.map((id: string) => byId.get(id)).filter(Boolean)
        target.chats = [...ordered, ...(target.chats ?? []).filter((ch: any) => !ordered.includes(ch))]
    }
    const kept: SyncDeletion[] = []
    for (const deletion of plan.deletions) {
        if (deletion.kind === 'chat') {
            const target = db.characters.find((c: any) => c.chaId === deletion.characterId); if (!target) continue
            const open = selection.characterId === deletion.characterId && selection.chatIds.get(deletion.characterId) === deletion.id
            if (open) { const chat = target.chats.find((ch: any) => ch.id === deletion.id); if (chat) chat.risuSyncDeleted = { transaction: plan.transaction, restorable: true }; kept.push(deletion); continue }
            target.chats = target.chats.filter((ch: any) => ch.id !== deletion.id)
        } else if (deletion.kind === 'character') {
            if (selection.characterId === deletion.id) { kept.push(deletion); continue }
            db.characters = db.characters.filter((c: any) => c.chaId !== deletion.id)
        } else if (deletion.kind === 'module') db.modules = (db.modules ?? []).filter((m: any) => m.id !== deletion.id)
        else if (deletion.kind === 'plugin') db.plugins = (db.plugins ?? []).filter((p: any) => p.name !== deletion.id)
    }
    return kept
}
/**
 * Entities this plan would write or remove that the user edited in memory after the pre-plan drain. The save runtime tracks
 * every edit it has not persisted yet (the hold only blocks persistence, not edit controls); the tracked set is empty right
 * after the drain, so anything in it arrived during the plan/hydration/arm waits.
 */
function localEditsOverlap(plan: SyncPlan): string[] {
    const tracked = pendingTrackedChanges(); if (!tracked) return []
    const hits = new Set<string>()
    const chats = new Set([...plan.chats.map(r => `${r.characterId}/${r.chat.id}`), ...plan.deletions.filter(d => d.kind === 'chat').map(d => `${d.characterId}/${d.id}`)])
    const characters = new Set([...plan.characters.map(c => c.chaId), ...plan.newCharacters.map(c => c.chaId), ...plan.deletions.filter(d => d.kind === 'character').map(d => d.id)])
    for (const [characterId, chatId] of tracked.chat) if (chats.has(`${characterId}/${chatId}`)) hits.add(`chat:${characterId}/${chatId}`)
    for (const characterId of tracked.character) if (characters.has(characterId)) hits.add(`character:${characterId}`)
    if ((tracked.root || tracked.botPreset) && (Object.keys(plan.settings).length || plan.pluginEnabled)) hits.add('settings')
    if (tracked.modules && (plan.modules.length || plan.deletions.some(d => d.kind === 'module'))) hits.add('modules')
    if ((tracked.plugins || tracked.pluginCustomStorage) && (plan.plugins.length || plan.pluginEnabled || plan.deletions.some(d => d.kind === 'plugin'))) hits.add('plugins')
    return [...hits]
}
let applying: Promise<SyncApplyOutcome> | null = null
/** Busy state this module set itself; a manual transfer's busy state is never released here. */
let syncOwnsBusy = false
/** A busy flag held by someone else (manual transfer, import): never this apply's own hold, which transferUnavailable() counts. */
const foreignBusy = () => get(transferBusy) && !syncOwnsBusy
/**
 * Apply admitted remote commits. Outcome-aware: a failure before the canonical save rolls back this client's own snapshot
 * and lets the server roll back its staged media; after a successful save nothing is rewound — the write gate stays on
 * this transaction (header kept) and finish is retried, otherwise the plan is left for startup recovery.
 */
/**
 * Safe-window guard handed in by the coordinator for automatic applies. `window`: why this moment is safe (startup / foreground /
 * reopen / manual). `interacted()`: true once the user touched the app (pointer/keyboard/input) since the window opened — re-asked after
 * every wait, so a plan prepared while the user started playing is released, never armed. Plans whose actual targets include the chat
 * on screen are applied only in a window where that chat was just (re)opened or the user asked (startup/reopen/manual).
 */
export interface SyncApplyGuard { window: 'startup' | 'foreground' | 'reopen' | 'manual'; interacted: () => boolean }
export function applySync(automatic = false, signal?: AbortSignal, guard?: SyncApplyGuard): Promise<SyncApplyOutcome> { return applying ??= applySyncOnce(automatic, signal, guard).finally(() => { applying = null }) }
/** True when the plan's actual targets (chat rows or deletions) include the chat currently on screen. */
export function planTouchesActiveChat(plan: SyncPlan): boolean {
    const s = captureSelection(); if (!s.characterId) return false
    const open = s.chatIds.get(s.characterId); if (!open) return false
    return plan.chats.some(r => r.characterId === s.characterId && r.chat.id === open) || plan.deletions.some(d => (d.kind === 'chat' && d.characterId === s.characterId && d.id === open) || (d.kind === 'character' && d.id === s.characterId))
}
async function applySyncOnce(automatic: boolean, signal?: AbortSignal, guard?: SyncApplyGuard): Promise<SyncApplyOutcome> {
    if (transferUnavailable()) { if (!automatic) transferStatus.set('기존 작업이 끝나면 동기화를 적용할 수 있어요.'); return { state: 'busy' } }
    // Before arming nothing is mutated and edits made meanwhile are protected by the overlap/recheck rules below, so the app stays
    // usable: the app-wide busy (inert overlay) starts only at arm. Slow plan/hydration on a large library no longer locks the screen.
    transferStatus.set('동기화 변경을 확인하는 중…')
    let plan: SyncPlan | undefined, before: ReturnType<typeof captureBefore> | undefined, resolved = false, tookBusy = false
    try {
        await requestImmediateSave({ flushServer: 'canonical', rejectOnFailure: true, flushSignal: signal }) // drain whatever save is in flight first; pause/disable cancels the flush wait
        if (signal?.aborted) throw new Error('sync apply cancelled') // nothing held yet: a paused/disabled coordinator stops here
        // No hold during the plan wait: the plan runs in the server's exclusive lane (behind a snapshot, possibly for seconds) and local
        // play must keep saving meanwhile. A save that lands between prepare and arm is caught by the server (NAS_SYNC_REPLAN) and by
        // `localEditsOverlap` below; the hold starts only right before arm (after a fresh drain), for the armed stage alone.
        const openedBefore = activeChatSignature()
        plan = await post('/plan', {}, signal)
        // Safe-window re-check after the wait: the user opened another chat (or character) meanwhile → this plan was prepared for a view
        // that is gone; it is released and the coordinator decides again from the new selection.
        if (!plan!.empty && activeChatSignature() !== openedBefore) throw Object.assign(new Error('대화를 바꿔서 동기화 적용을 다음 기회로 미뤘어요.'), { code: 'SYNC_RECHECK', transaction: plan!.transaction })
        // The user started interacting while the plan was prepared: this is no longer a safe window. Released, nothing held, nothing shown.
        if (!plan!.empty && guard?.interacted()) throw Object.assign(new Error('사용 중이어서 동기화 적용을 미뤘어요.'), { code: 'SYNC_RECHECK', transaction: plan!.transaction })
        // Actual targets, not the preview: a plan that would splice into the chat on screen waits for that chat to be reopened (or startup/manual).
        if (!plan!.empty && guard && !['startup', 'reopen', 'manual'].includes(guard.window) && planTouchesActiveChat(plan!)) throw Object.assign(new Error('열어 둔 대화에 받은 변경이 있어 다시 열 때 적용해요.'), { code: 'SYNC_RECHECK', reason: 'active-chat', transaction: plan!.transaction })
        // The synced form of themePresets carries no device-local layout fields; this device keeps its own (per entry) so the
        // echo sent to arm, the bytes saved and the server's verification all describe the same entries.
        if (!plan!.empty && Array.isArray(plan!.settings?.themePresets)) plan!.settings = { ...plan!.settings, themePresets: withLocalThemeLayout(plan!.settings.themePresets, (getDatabase() as any).themePresets) }
        if (plan!.empty) { resolved = true; const waiting = !!plan!.pending?.length; transferStatus.set(waiting ? '받은 변경 중 차이를 확인할 자료가 있어요. 기존 자료는 유지돼요.' : '적용할 동기화 변경이 없어요.'); return { state: waiting ? 'review-needed' : 'empty', pending: plan!.pending } }
        const db = getDatabase()
        for (const row of plan!.chats) {
            const target = db.characters.find(c => c.chaId === row.characterId), index = target?.chats.findIndex(ch => ch.id === row.chat.id) ?? -1
            if (target && index >= 0) await ensureChatHydrated(target.chats, index, target.chaId)
            row.chat = normalizeChat(row.chat)
        }
        // A late response is re-checked against the present: generation/import/streaming started meanwhile, or the caller gave up
        // (disable, deadline) → the prepared plan is released, nothing applied.
        if (signal?.aborted || activityBlocksSync() || foreignBusy()) { throw Object.assign(new Error(signal?.aborted ? 'sync apply cancelled' : '다른 작업이 시작돼 동기화 적용을 미뤘어요.'), { code: 'SYNC_RECHECK', transaction: plan!.transaction }) }
        // The user's own edits win over the plan: a plan that would overwrite something edited during the waits is abandoned before
        // any mutation. The server releases its staged media/journal only after proving nothing of it was saved; the edits stay
        // tracked for the next ordinary save, and the caller plans again (the saved edit then meets the remote head as a branch).
        const defer = async (dirty: string[], armed: boolean): Promise<SyncApplyOutcome> => {
            const verdict = await finishWithRetry(plan!.transaction, false)
            if (verdict?.state === 'rolled-back' || !armed) {
                // Not armed: the server write gate never moved to this plan, so ordinary saves may flow even if the release call failed.
                resolved = true; transferStatus.set('적용 중 수정된 항목이 있어 동기화 적용을 미뤘어요. 수정 내용을 먼저 저장합니다.')
                return { state: 'deferred', transaction: plan!.transaction, deferred: dirty, error: verdict?.state === 'rolled-back' ? undefined : String(verdict?.error ?? 'release unconfirmed') }
            }
            transferStatus.set('동기화 적용을 미루는 중 서버 확인에 실패했어요. 복구 기록을 보관한 채 다음 시작 때 복구합니다.')
            return { state: 'finish-pending', transaction: plan!.transaction, error: String(verdict?.error ?? 'unreachable'), deferred: dirty }
        }
        let dirty = localEditsOverlap(plan!)
        if (dirty.length) return await defer(dirty, false)
        const selection = captureSelection()
        const kept = plan!.deletions.filter(d => (d.kind === 'chat' && selection.characterId === d.characterId && selection.chatIds.get(d.characterId!) === d.id) || (d.kind === 'character' && selection.characterId === d.id))
        // Arm first: from here the server admits only saves carrying this transaction, so no autosave can persist a half-applied state.
        // The hold and the app-wide busy start here and end with the verdict: the armed stage is the only one that must not be interleaved.
        await requestImmediateSave({ flushServer: 'canonical', rejectOnFailure: true, flushSignal: signal }) // a save queued during the plan wait persists first (arm then sees it as REPLAN if it touched the plan)
        if (signal?.aborted || activityBlocksSync() || foreignBusy()) throw Object.assign(new Error(signal?.aborted ? 'sync apply cancelled' : '다른 작업이 시작돼 동기화 적용을 미뤘어요.'), { code: 'SYNC_RECHECK', transaction: plan!.transaction })
        if (guard?.interacted() || (!plan!.empty && activeChatSignature() !== openedBefore)) throw Object.assign(new Error('사용 중이어서 동기화 적용을 미뤘어요.'), { code: 'SYNC_RECHECK', transaction: plan!.transaction }) // last check before anything is held or shown
        syncSaveHold.set(true) // from here only this transaction's own saves may persist
        tookBusy = true; syncOwnsBusy = true; transferBusy.set(true); syncBusyOwned.set(true)
        try {
            await post('/arm', { transaction: plan!.transaction, chats: plan!.chats.map(row => ({ characterId: row.characterId, chat: row.chat })), settings: plan!.settings,
                characters: [...plan!.characters.map(c => ({ chaId: c.chaId, fields: c.fields })), ...plan!.newCharacters.map(c => { const { chatIds: _i, chats: _c, chatPage: _p, ...fields } = c as any; return { chaId: c.chaId, fields: { ...fields, chaId: c.chaId } } })],
                modules: plan!.modules, plugins: plan!.plugins, pluginEnabled: plan!.pluginEnabled, keptDeletions: kept })
        } catch (error: any) {
            if (error.code === 'NAS_SYNC_REPLAN') return await defer(['baseline-changed'], false) // a legitimate write reached a planned entity after prepare
            throw error
        }
        dirty = localEditsOverlap(plan!)
        if (dirty.length) return await defer(dirty, true) // edited while arming: still nothing mutated, the gate is released by the verdict
        forageStorage.realStorage.syncTransaction = plan!.transaction
        // From here every failure (snapshot, mutation, selection, ordering, save) is settled by the server, which compares each
        // planned entity with its pre-apply baseline: a rejected or thrown step is never proof that nothing was persisted.
        let saveError: unknown = null
        try {
            before = captureBefore(plan!)
            applyPlanToDatabase(plan!, selection)
            restoreSelection(selection)
            checkCharOrder()
            transferStatus.set('동기화 변경을 저장하는 중…')
            await requestImmediateSave({ chats: plan!.chats.map(row => [row.characterId, row.chat.id!] as [string, string]), flushServer: 'canonical', rejectOnFailure: true, syncOwned: true })
        } catch (error) { saveError = error }
        const result = await finishWithRetry(plan!.transaction, saveError === null)
        if (result?.state === 'applied') {
            resolved = true; forageStorage.realStorage.syncTransaction = undefined
            transferStatus.set(result.pending?.length ? `동기화 적용 완료 · 보류 ${result.pending.length}건` : '동기화 적용 완료')
            return { state: result.pending?.length ? 'review-needed' : 'applied', transaction: plan!.transaction, pending: result.pending, keptDeletions: result.keptDeletions }
        }
        if (result?.state === 'rolled-back') {
            // Server proved every planned entity untouched: only now is the in-memory rewind safe.
            if (before) restoreBefore(before)
            resolved = true; forageStorage.realStorage.syncTransaction = undefined
            transferStatus.set('동기화 변경을 저장하지 못해 되돌렸어요. ' + String(saveError ?? ''))
            return { state: 'save-failed', transaction: plan!.transaction, error: String(saveError ?? result.error ?? '') }
        }
        // Mixed/unknown (partial save, finish unreachable, server error after commit): keep the local state and the journal. The
        // transaction header is dropped so no autosave can pass the server gate, and the local save hold stays until recovery settles it.
        forageStorage.realStorage.syncTransaction = undefined
        transferStatus.set('동기화 변경의 저장 결과를 확인하지 못했어요. 자료와 복구 기록을 보관한 채 다음 시작 때 복구합니다.')
        return { state: 'finish-pending', transaction: plan!.transaction, error: String(saveError ?? result?.error ?? '') }
    } catch (error: any) {
        // Failure before the plan was armed: nothing was mutated, nothing to rewind; the hold is released. A prepared plan is released
        // on the server too (best effort: the next plan call returns the same prepared plan otherwise).
        transferStatus.set(String(error))
        if (!forageStorage.realStorage.syncTransaction) {
            resolved = true
            if (error?.code === 'SYNC_RECHECK') { await finishWithRetry(error.transaction, false).catch(() => null); return { state: error.reason === 'active-chat' ? 'deferred-active-chat' : 'deferred', transaction: error.transaction, deferred: [error.reason ?? 'activity'], error: String(error) } }
        }
        else {
            // Armed but the outcome never reached the server verdict path (e.g. the finish call itself threw): keep hold and journal.
            forageStorage.realStorage.syncTransaction = undefined
            transferStatus.set('동기화 적용 결과를 확인하지 못했어요. 자료와 복구 기록을 보관한 채 다음 시작 때 복구합니다.')
            return { state: 'finish-pending', transaction: plan?.transaction, error: String(error) }
        }
        throw error
    } finally {
        if (resolved) syncSaveHold.set(false)
        // Busy ownership: only a busy this apply took (at arm) is released or kept here; a foreign transfer that began before arm keeps its own flag.
        syncOwnsBusy = tookBusy && !resolved && !!plan && !plan.empty
        if (tookBusy) { transferBusy.set(syncOwnsBusy); syncBusyOwned.set(syncOwnsBusy) }
    }
}
/** Ask the server to settle the transaction. Returns the server verdict, or null when it stayed unreachable. */
async function finishWithRetry(transaction: string, confirmed: boolean) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try { return await post('/finish', { transaction, confirmed }) }
        catch (error: any) {
            if (error.code === 'NAS_SYNC_PARTIAL') return { state: 'partial', error: String(error) }
            if (error.status && error.status !== 423 && error.status < 500) return { state: 'retained', error: String(error) }
            await new Promise(r => setTimeout(r, 300 * (attempt + 1)))
        }
    }
    return null
}
/** Startup: right after manual-transfer recovery, before autosave/plugins/generation. */
export async function recoverSync() {
    let pending: { transaction: string; phase: string }[] = []
    // Fail closed: only a server without the endpoint (legacy build) may be bypassed; a transient failure retries, then stops startup.
    for (let attempt = 0; ; attempt++) {
        try { pending = await (await syncRequest('/recovery')).json(); break }
        catch (error: any) {
            if (error.status === 404) return
            if (attempt >= 2) { transferStatus.set('동기화 복구 상태를 확인하지 못했어요. 서버 연결을 확인한 뒤 다시 열어 주세요.'); throw new Error('NAS 동기화 복구 상태를 확인할 수 없어요: ' + String(error)) }
            await new Promise(r => setTimeout(r, 300 * (attempt + 1)))
        }
    }
    if (!pending.length) { syncSaveHold.set(false); if (syncOwnsBusy) { syncOwnsBusy = false; transferBusy.set(false); syncBusyOwned.set(false) } return } // the server completed everything (e.g. a lost finish response); an own busy is released with its owned flag
    const tookBusy = syncOwnsBusy || !get(transferBusy) // never release a manual transfer's busy state
    if (tookBusy) { transferBusy.set(true); syncOwnsBusy = true; syncBusyOwned.set(true) }
    syncSaveHold.set(true)
    try {
        for (const record of pending) {
            try { forageStorage.realStorage.syncTransaction = record.transaction; await post('/finish', { transaction: record.transaction }) }
            catch (error) {
                transferStatus.set(String(error))
                // The confirmation dialog renders inside the inert <main>: release the own app-wide busy while the user decides (the
                // save hold stays, so nothing persists meanwhile) and take it back for the hold request. A manual transfer's busy is untouched.
                if (tookBusy) { transferBusy.set(false); syncBusyOwned.set(false) }
                let holdInstead: boolean
                try { holdInstead = await alertConfirm('동기화 적용 복구를 완료하지 못했어요. 현재 대화와 복구 자료를 보관한 채 이번 복구를 보류하고 앱을 열까요?\n' + String(error)) }
                finally { if (tookBusy) { transferBusy.set(true); syncBusyOwned.set(true) } }
                if (!holdInstead) throw error
                await post('/hold', { transaction: record.transaction, confirmed: true })
                transferStatus.set('동기화 복구를 보류했어요. 현재 대화와 복구 자료는 그대로 보관돼요.')
            } finally { forageStorage.realStorage.syncTransaction = undefined }
        }
        syncSaveHold.set(false) // every pending plan was finished or explicitly held
    } finally { if (tookBusy) { syncOwnsBusy = false; transferBusy.set(false); syncBusyOwned.set(false) } }
}
export { transferBusy as syncBusy, transferStatus as syncStatusText }
