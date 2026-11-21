import { get, writable, type Readable, type Unsubscriber } from 'svelte/store'
import { canonicalSaveSettled, transferStatus, syncSaveHold } from './transferState'
import { applySync, retrySyncApply, pullSync, publishSync, snapshotSync, syncStatus, clearMissingSyncMedia, activityBlocksSync, reportSyncNetwork, pendingRootsSync, activeChatSignature, releaseSyncPlan, type SyncApplyGuard } from './nasSync'
import { transferUnavailable } from './playTransfer'
import { isNodeServer } from '../platform'
import { isAnyGenerating, generationStates } from '../process/generationState'
import { alertStore, selectedCharID } from '../stores.svelte'
import { addLog } from '../log'
import { nasDiagnosticDescription, nasDiagnosticMessage } from '../../../shared/play-set/nas-diagnostic'

/**
 * The single foreground coordinator of automatic NAS sync. It runs only on the Node/embedded runtime and only after sync was
 * enabled on the server; it is a client of the same entry points the UI uses, never a second authority.
 *
 * Non-interrupting contract (local play first):
 * - Local play and sending never wait for the NAS. `preSendSync` refuses only while an apply is left unresolved (hold kept).
 * - Every cycle is status → [snapshot → publish] → pull → pending preview. 0.9.92-ver10: while a model request runs
 *   (`generating`) no automatic cycle starts and a running one stops at its next step boundary; the snapshot (which takes the server's exclusive lane for a consistent capture) runs only when nothing is
 *   generating/importing and after the save settled (5 s debounce). Pulled commits are durable in the store ("received, applied later").
 * - Apply (plan → arm → save → finish) happens only in a SAFE WINDOW opened by a lifecycle event: app start, coming to the foreground
 *   (visibilitychange/focus), the user (re)opening a chat (`risubard-chat-opened`, character switch), or an explicit manual run.
 *   Never on the timer, after a save, on reconnect, or on "idle" — reading is playing. Each window carries the INTERACTION EPOCH
 *   captured at the event itself (a monotonic counter of pointer/keyboard/input/touch/wheel events); any later interaction voids it, the apply
 *   re-asks after every wait and releases its plan instead of arming. A window is never re-opened by a timer or a late response.
 *   A plan whose actual targets include the chat on screen is applied only in a reopen/startup/manual window; otherwise it is
 *   released, reported as deferred for that chat, and applied when a chat-open event arrives. Client preparation after the plan is bounded
 *   (deadlineMs): past it the plan is released. An ARMED apply is never interrupted and settles through finish/recovery.
 * - Failures back off 5 → 15 → 60 s, capped at 5 min; reports (failed uploads, rotation, held/quarantined, repair failures) are never
 *   shown as "up to date". Disabling cancels future cycles only: outbox, store and data stay. Nothing runs while hidden.
 * - 0.9.96-ver10 cadence (the app singleton; `cadence` option): the routine starts — the poll after a finished cycle, a settled save,
 *   foreground/focus, chat open/character switch, reconnect — run only once `chats` chats were sent since the last cycle started or
 *   `intervalMs` passed, whichever comes first. A chat = an answer the user gets: every sendChat that registers a
 *   generation (a new message, a reroll, a resend, a manual continue, an answer through the character assistant, a command/multisend
 *   line, a plugin's sendChat). The answer's identity is the abort signal sendChat runs under: its auto-continue and internal resend
 *   restart sendChat with the SAME signal (whatever the chat looks like by then), every new send gets a new one. preSendSync (in every
 *   sendChat, with no await before startGeneration) hands the signal over; the generation registration that follows takes the last one
 *   handed over (a send its guard refused is replaced by the next send's). Two sends whose preSendSync both resolve before either
 *   registers (parallel sends to two chats in the same microtask turn) could pair crosswise — not done by the app's own send paths.
 *   Not counted: a restart with a signal already counted, a prompt preview (DevTool/hotkey run it under alertWait), a background job
 *   reattached after a restart (no sendChat), a send refused before it registers, and model calls that never register a chat
 *   generation (BardWiki sub calls, plugin helper requests, memory/translation).
 *   App start, manual runs, enabling/resuming, and the existing
 *   retries (failure backoff, busy, waiting for a generation, recovery; one owed while hidden runs when visible) are unchanged. Received
 *   work that still waits may use one lifecycle window per `applyRetryMs`. The tally is device-local (localStorage, never synced) and
 *   survives a restart. While a fullscreen plugin window (Asset Maid's workspace) is open
 *   no automatic cycle starts and nothing is applied: interaction inside its sandboxed frame is invisible to the interaction epoch.
 */
export interface CoordinatorOptions {
    debounceMs?: number; pollMs?: number; deadlineMs?: number; backoffMs?: number[]
    now?: () => number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout
    visible?: () => boolean; online?: () => boolean; supported?: () => boolean
    status?: typeof syncStatus; snapshot?: typeof snapshotSync; publish?: typeof publishSync; pull?: typeof pullSync; apply?: typeof applySync; pendingRoots?: typeof pendingRootsSync; release?: typeof releaseSyncPlan
    network?: (signal?: AbortSignal) => Promise<unknown>
    retryApply?: typeof retrySyncApply
    /** Manual transfer/import in progress or an unresolved hold: no sync work at all. */
    blocked?: () => boolean
    /** Generation/streaming/import: no snapshot, no apply. 0.9.92-ver10: no automatic cycle at all (a running one stops at its next step
     *  boundary); manual upload defers, manual download stays receive-only. */
    generating?: () => boolean
    /** Generation on/off; its end resumes a cycle deferred by `generating` after the save debounce (default: isAnyGenerating). */
    generatingChanged?: Readable<boolean>
    /** A modal alert is open: no apply (nothing may change under it); network still runs. */
    alerting?: () => boolean
    /** Monotonic count of real user interactions (pointer/keyboard/input/touch); the coordinator's own document listener when omitted. */
    interactions?: () => number
    /** "<character>/<chat>" on screen (for the deferred-chat bookkeeping). */
    activeChat?: () => string
    /** 0.9.96-ver10: routine cadence; omitted/null keeps the pre-ver10 cadence (the machinery tests). The app singleton uses DEFAULT_CADENCE. */
    cadence?: SyncCadence | null
    /** Device-local persistence of the cadence tally (default: localStorage). */
    cadenceStore?: { load(): CadenceTally | null; save(tally: CadenceTally): void }
    /** Per-chat generation registry (keys = chat ids); a new key = a generation started for that chat (default: generationStates). */
    generations?: Readable<Map<string, { kind?: string } | unknown>>
    /** A prompt preview is generating (DevTool/hotkey run it under alertWait('Loading...')): not a chat. */
    previewing?: () => boolean
    /** A fullscreen plugin window (Asset Maid's workspace) is open: no automatic cycle starts and nothing is applied. */
    editing?: () => boolean
}
/** 0.9.96-ver10 (user, 2026-11-18: 「동기화를 5채팅 혹은 1시간으로 늘려줘」). */
export interface SyncCadence { chats: number; intervalMs: number; applyRetryMs: number }
export interface CadenceTally { chats: number; lastAt: number }
export const DEFAULT_CADENCE: SyncCadence = { chats: 5, intervalMs: 60 * 60_000, applyRetryMs: 5 * 60_000 }
const CADENCE_KEY = 'risubard-nas-sync-cadence'
/** Browser storage of this device only (each device's WebView/browser profile); never part of the synced database. */
export const localCadenceStore = {
    load(): CadenceTally | null { try { const raw = globalThis.localStorage?.getItem(CADENCE_KEY); return raw ? JSON.parse(raw) : null } catch { return null } },
    save(tally: CadenceTally) { try { globalThis.localStorage?.setItem(CADENCE_KEY, JSON.stringify(tally)) } catch { /* private mode/blocked storage: the tally lives in memory */ } },
}
/** A plugin's fullscreen container (API v3 `showContainer('fullscreen')`: a fixed iframe on <body>, display:block) is shown. */
export function pluginWindowOpen(doc: Document | undefined = typeof document === 'undefined' ? undefined : document): boolean {
    try { return Array.from(doc?.body?.children ?? []).some(el => el.tagName === 'IFRAME' && (el as HTMLElement).style.position === 'fixed' && (el as HTMLElement).style.getPropertyValue('display') === 'block') } catch { return false }
}
function loadTally(stored: CadenceTally | null, now: number): CadenceTally {
    const chats = Number.isFinite(stored?.chats) && stored!.chats > 0 ? Math.floor(stored!.chats) : 0
    // No record yet (first start of ver10) or a clock that moved back: count from now.
    const lastAt = Number.isFinite(stored?.lastAt) && stored!.lastAt > 0 && stored!.lastAt <= now ? stored!.lastAt : now
    return { chats, lastAt }
}
export interface CoordinatorState { enabled: boolean; running: boolean; paused: boolean; offline: boolean; failures: number; lastCycleAt: number; lastError: string; nextAt: number; lastOutcome: string; generation: number; attention: string; probed: boolean; deferredForChat?: string; pendingRoots?: number; lastWindow?: string; direction?: 'both' | 'upload' | 'download'; pendingReview?: number; keptDeletions?: number; stage?: string; stageAt?: number }
export type SafeWindow = { window: SyncApplyGuard['window']; epoch: number }
const DEFAULT_BACKOFF = [5_000, 15_000, 60_000, 300_000]
let instance: ReturnType<typeof createSyncCoordinator> | null = null
/** Reactive snapshot of the singleton coordinator's state for the UI (the state object itself is plain). */
export const coordinatorState = writable<CoordinatorState | null>(null)
class Cancelled extends Error { constructor(reason: string) { super(reason); this.name = 'SyncCycleCancelled' } }

function logCycleError(stage: string, code: unknown, missingFiles?: unknown) {
    try { addLog({ level: 'error', source: 'nas-sync', message: nasDiagnosticMessage, description: nasDiagnosticDescription(stage, code, missingFiles) }) }
    catch { /* Diagnostics must not interrupt backoff. */ }
}

export function createSyncCoordinator(options: CoordinatorOptions = {}) {
    let interactions = 0
    const o = {
        debounceMs: 5_000, pollMs: 30_000, deadlineMs: 10_000, backoffMs: DEFAULT_BACKOFF, now: Date.now,
        // Wrapped, never the bare Window functions: called as `o.setTimer(...)` the receiver would be the options object and Chromium
        // throws "Illegal invocation" (Node and fake timers do not, which hid it).
        setTimer: ((fn: () => void, ms: number) => setTimeout(fn, ms)) as typeof setTimeout, clearTimer: ((t: ReturnType<typeof setTimeout>) => clearTimeout(t)) as typeof clearTimeout,
        visible: () => typeof document === 'undefined' || !document.hidden, online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
        supported: () => isNodeServer, status: syncStatus, snapshot: snapshotSync, publish: publishSync, pull: pullSync, apply: applySync, retryApply: retrySyncApply, pendingRoots: pendingRootsSync, release: releaseSyncPlan, network: reportSyncNetwork,
        // A foreign manual transfer/import or an unresolved hold blocks everything; generation alone does not (handled by `generating`).
        blocked: () => (transferUnavailable() && !activityBlocksSync()) || get(syncSaveHold),
        generating: () => activityBlocksSync(), generatingChanged: isAnyGenerating, alerting: () => get(alertStore).type !== 'none',
        interactions: () => interactions, activeChat: () => { try { return activeChatSignature() } catch { return '' } },
        cadence: null as SyncCadence | null, cadenceStore: localCadenceStore as NonNullable<CoordinatorOptions['cadenceStore']>,
        generations: generationStates as Readable<Map<string, unknown>>, editing: () => pluginWindowOpen(),
        previewing: () => get(alertStore).type === 'wait',
        ...options,
    }
    const cadence = o.cadence ?? null
    const tally: CadenceTally = loadTally(cadence ? o.cadenceStore.load() : null, o.now())
    /** The routine may start: always without a cadence; with it, after `chats` chats or `intervalMs`, whichever first. */
    const due = () => !cadence || tally.chats >= cadence.chats || o.now() - tally.lastAt >= cadence.intervalMs
    /** A cycle started: the next routine one counts from here (manual and retries included). */
    const counted = () => { owedWhenVisible = false; if (!cadence) return; tally.chats = 0; tally.lastAt = o.now(); o.cadenceStore.save({ ...tally }) }
    /** Delay of the routine poll after a finished cycle: chats counted meanwhile may already have made it due. */
    const routineDelay = () => !cadence ? o.pollMs : due() ? o.debounceMs : Math.max(1_000, tally.lastAt + cadence.intervalMs - o.now())
    /** A start (routine timer, retry) that found the app hidden: the next foreground event runs it. */
    let owedWhenVisible = false
    /** A lifecycle event (foreground, focus, chat open, character switch) may open a window: when due, or — rate limited — when received
     *  work still waits for one. */
    /** The signal of the send preSendSync admitted last (a restart's too). sendChat's registration follows it with no await in between;
     *  a send refused by its guard is simply replaced by the next send's signal (no registration happens without one). */
    let admitted: AbortSignal | null = null
    /** Signals of answers already counted: a restart (auto-continue / internal resend) runs under the same one. */
    const answered = new WeakSet<AbortSignal>()
    const waiting = () => !!state.pendingRoots && ['pulled', 'deferred', 'deferred-active-chat'].includes(state.lastOutcome.replace(/^key-pending:/, ''))
    const lifecycleAllowed = () => !cadence || due() || owedWhenVisible || (waiting() && o.now() - state.lastCycleAt >= cadence.applyRetryMs)
    const state: CoordinatorState = { enabled: false, running: false, paused: false, offline: false, failures: 0, lastCycleAt: 0, lastError: '', nextAt: 0, lastOutcome: '', generation: 0, attention: '', probed: false, deferredForChat: '', pendingRoots: 0, lastWindow: '' }
    const publish = () => { if (instance && instance.state === state) coordinatorState.set({ ...state }) }
    let started = false, timer: ReturnType<typeof setTimeout> | null = null, debounce: ReturnType<typeof setTimeout> | null = null
    let unsubscribe: Unsubscriber | null = null, unsubscribeSelection: Unsubscriber | null = null, controller: AbortController | null = null, current: Promise<string> | null = null
    let startupWindow: SafeWindow | null = null // captured at start(), consumed by the first cycle; voided by any interaction before it
    let resumeAfterGeneration = false // 0.9.92-ver10: an automatic cycle waited for a generation; its end schedules sync again
    let pendingWindow: SafeWindow | null = null // a lifecycle event that arrived while a cycle ran: kept with ITS epoch and run right after (never renewed)
    const listeners: Array<{ target: EventTarget; type: string; handler: EventListener; capture: boolean }> = []
    const listen = (target: EventTarget | undefined, type: string, handler: EventListener, capture = false) => { if (!target) return; target.addEventListener(type, handler, { capture, passive: true }); listeners.push({ target, type, handler, capture }) }
    const active = () => started && state.enabled && !state.paused
    /** A safe window opens at the lifecycle event: the epoch is the interaction count right then, never refreshed later. */
    const openWindow = (window: SyncApplyGuard['window']): SafeWindow => ({ window, epoch: o.interactions() })
    /** Any change that must invalidate in-flight work: a new generation, and the running cycle's controller aborted. */
    const invalidate = (reason: string) => { state.generation += 1; controller?.abort(new Cancelled(reason)); controller = null }
    const stopTimers = () => { if (timer) { o.clearTimer(timer); timer = null } if (debounce) { o.clearTimer(debounce); debounce = null } state.nextAt = 0 }
    const schedule = (delay: number) => { if (!active()) return; if (timer) o.clearTimer(timer); state.nextAt = o.now() + delay; timer = o.setTimer(() => { timer = null; void cycle('timer') }, delay) }
    /** 0.9.92-ver10: a model request is in progress: automatic sync waits (the poll stays as a fallback; the generation's end resumes sooner). */
    const deferForGeneration = () => { resumeAfterGeneration = true; state.lastOutcome = 'deferred'; schedule(o.pollMs); return 'deferred' }
    /** Bounded status probe: start, and recovery after a failed start probe (reconnect/visible/focus). */
    async function probe(): Promise<boolean> {
        const generation = state.generation, ctl = new AbortController(), deadline = o.setTimer(() => ctl.abort(new Error('sync network deadline')), o.deadlineMs)
        try { const status = await o.status(ctl.signal); if (generation !== state.generation || !started) return false; state.enabled = !!status?.enabled; state.probed = true; state.lastError = ''; return true }
        catch (error: any) { if (started && generation === state.generation) { state.probed = false; state.lastError = String(error?.message ?? error).slice(0, 200) } return false }
        finally { o.clearTimer(deadline) }
    }
    /**
     * One cycle. `safe` is the window opened by the triggering lifecycle event (null for timer/save/send/reconnect cycles, which never
     * apply). Its epoch is compared with the live interaction count at every decision point; a count that moved means the user is playing.
     */
    async function cycle(reason: string, external?: AbortSignal, safe: SafeWindow | null = null, direction: 'both' | 'upload' | 'download' = 'both'): Promise<string> {
        // A failed startup probe leaves enabled unknown; an explicit retry must recheck it instead of silently returning idle forever.
        if (reason === 'manual' && started && !state.probed && !state.paused) await probe()
        if (!active()) return 'idle'
        if (state.running) return 'running'
        if (!o.visible()) { owedWhenVisible = true; state.lastOutcome = 'hidden'; return 'hidden' } // no background work; the visibility listener resumes
        if (o.blocked()) { state.lastOutcome = 'busy'; schedule(Math.min(o.pollMs, 5_000)); return 'busy' } // manual transfer/import or an unresolved hold: try again shortly
        if (reason !== 'manual' && o.generating()) { deferForGeneration(); publish(); return 'deferred' } // 0.9.92-ver10: no automatic sync while a model request runs
        if (reason !== 'manual' && o.editing()) { state.lastOutcome = 'deferred'; schedule(o.pollMs); publish(); return 'deferred' } // 0.9.96-ver10: a fullscreen plugin window (Asset Maid) is open: look again later
        if (direction === 'upload' && o.generating()) { state.lastOutcome = 'deferred'; publish(); return 'deferred' } // upload must capture settled local edits first; download can receive and wait
        const generation = state.generation, mine = controller = new AbortController(), signal = mine.signal
        const onExternal = () => mine.abort(new Cancelled('cancelled'))
        if (external) { if (external.aborted) onExternal(); else external.addEventListener('abort', onExternal, { once: true }) }
        // Boundary guard: a late response after disable/pause/stop (new generation) or an abort never proceeds to the next step.
        const boundary = () => { if (generation !== state.generation || !active()) throw new Cancelled('sync cycle invalidated'); if (signal.aborted) throw signal.reason ?? new Error('sync network deadline'); if (reason !== 'manual' && o.generating()) throw new Cancelled('generating') }
        const interacted = () => !safe || o.interactions() > safe.epoch
        let receiveOnly = direction === 'download' && o.generating()
        state.running = true; state.direction = direction; state.lastWindow = safe?.window ?? ''; counted(); publish()
        let stage = 'status', deadline: ReturnType<typeof setTimeout> | null = null
        let missingMediaChecked: string | undefined
        const clearMissingMedia = async () => {
            if (missingMediaChecked && !signal.aborted) await clearMissingSyncMedia(missingMediaChecked, signal).catch(() => {})
        }
        // 0.9.92-ver7: the cycle's current step for the progress display (NasSyncProgress.svelte); display only.
        const enter = (next: string) => { stage = next; state.stage = next; state.stageAt = o.now(); publish() }
        state.stage = 'status'; state.stageAt = o.now()
        const run = (async () => {
            try {
                // Fresh network view for the home/external route (the Wi-Fi can change while the app stays open); best effort.
                try { await o.network?.(signal) } catch { /* the server falls back to its own detection or external */ }
                boundary()
                const status = await o.status(signal); boundary()
                if (!status.enabled) { state.enabled = false; stopTimers(); state.lastOutcome = 'disabled'; return 'disabled' }
                if (direction === 'upload' && o.generating()) { state.lastOutcome = 'deferred'; schedule(o.pollMs); return 'deferred' }
                receiveOnly ||= direction === 'download' && o.generating()
                // A plan the server still holds: `prepared` means nothing was armed (typically our bounded wait gave up before the /plan answer
                // arrived) — release it now so snapshot/preview are not wedged; `saving`/`committed` is an ARMED journal that only finish/recovery
                // may settle — this cycle does no local work and reports it, never a rollback.
                if (status.plan?.transaction) {
                    if (status.plan.phase === 'prepared') { enter('release'); await o.release(status.plan.transaction, signal); boundary() }
                    else { state.lastOutcome = 'recovery-pending'; state.attention = 'recovery-pending'; state.lastCycleAt = o.now(); if (generation === state.generation) schedule(o.pollMs); return state.lastOutcome }
                }
                receiveOnly ||= direction === 'download' && o.generating()
                // A lost protected master (status.vault.missing) is never worked around: nothing is published until a trusted re-share.
                const role = status.role ?? null, vaultOrigin = status.vault?.origin ?? null, keyReady = !status.vault?.missing && (role === 'authority' || vaultOrigin === 'shared')
                let attention = ''
                if (keyReady) {
                    // Settled local edits become causal revisions before anything incoming is applied; the joining device waits for the shared key
                    // before publishing its own encrypted history. The snapshot is skipped (not the publish) while a generation/import runs: the
                    // next settled save schedules it; edits made meanwhile are simply part of that later snapshot.
                    if (!receiveOnly && !o.generating()) { enter('snapshot'); missingMediaChecked = (await o.snapshot(signal))?.missingMediaChecked; boundary() }
                    if (direction !== 'download') {
                        enter('publish'); const report = await o.publish(signal); boundary()
                        if (report?.rotated) attention = 'rotated'
                        if (report?.failed?.length) throw Object.assign(new Error('publish failed: ' + report.failed.map((x: any) => x.error ?? x.sequence ?? x).join('; ')), { code: 'PUBLISH_FAILED', report })
                    }
                }
                if (direction === 'upload') {
                    const remaining = keyReady ? await o.status(signal) : null; boundary()
                    if (missingMediaChecked) { await clearMissingMedia(); boundary() }
                    // 2026-11-07 join adoption: the server withheld this device's changes; that is not an upload.
                    state.lastOutcome = !keyReady ? 'key-pending:idle' : (remaining ?? status)?.role === 'joining' && (remaining ?? status)?.adopting ? 'adopting' : attention || remaining?.sync?.outbox?.pending?.length ? 'upload-pending' : 'uploaded'
                    state.attention = attention; state.failures = 0; state.offline = false; state.lastError = ''; state.lastCycleAt = o.now()
                    schedule(routineDelay())
                    return state.lastOutcome
                }
                enter('pull'); const pulled = await o.pull(signal); boundary()
                // A blob pinned by an admitted revision could not be re-fetched: that is lost material, not an "up to date" cycle. Like a failed
                // publish it fails the cycle (no apply) and backs off; the next pull retries the repair.
                if (pulled?.repairFailed?.length) throw Object.assign(new Error('blob repair failed: ' + pulled.repairFailed.map((x: any) => `${String(x.hash).slice(0, 8)} ${x.reason}`).join('; ')), { code: 'REPAIR_FAILED', report: pulled })
                if ((pulled?.held?.length ?? 0) || (pulled?.quarantined?.length ?? 0)) attention = attention ? attention + ',incoming-review' : 'incoming-review'
                // Received work waits (durably, in the store) for a safe window. The preview only tells whether anything waits and lets the
                // reopen listener know; it is never the authority for the active-chat decision (the apply checks the plan's real targets).
                enter('preview'); const preview = await o.pendingRoots(signal); boundary()
                state.pendingRoots = preview.roots.length + (preview.plan ? 1 : 0)
                let outcome = 'pulled'
                if (!state.pendingRoots) { outcome = attention.includes('incoming-review') || status.conflicts ? 'review-needed' : 'empty'; state.deferredForChat = '' }
                else if (!safe) { outcome = 'pulled'; state.deferredForChat ||= o.activeChat() || '-' } // waits for a lifecycle window (chat open, foreground, manual)
                else if (receiveOnly || o.generating() || o.alerting() || interacted() || o.editing()) { outcome = 'pulled'; state.deferredForChat ||= o.activeChat() || '-' }
                else {
                    enter('apply')
                    // Large Wiki plans may take longer without blocking play. Bound client preparation after the server answers.
                    // 0.9.92-ver5: a dialog opened while the plan was prepared (e.g. a content update question) ends the safe window like a touch does.
                    const result = await o.apply(true, signal, { window: safe.window, interacted: () => interacted() || !!o.alerting?.() || o.editing(), planReady: () => { deadline = o.setTimer(() => mine.abort(new Error('sync apply deadline')), o.deadlineMs) } })
                    if (result.error && (result.state === 'save-failed' || result.state === 'finish-pending')) logCycleError(stage, result.state.replace('-', '_').toUpperCase())
                    if (result.state === 'deferred' && signal.aborted && /deadline/i.test(String(signal.reason))) throw signal.reason
                    if (result.state === 'deferred' && o.generating()) resumeAfterGeneration = true // the apply gave way to a model request that started meanwhile: resume when it ends, like a cycle stopped between steps
                    outcome = result.state
                    state.pendingReview = result.pending?.length ?? 0; state.keptDeletions = result.keptDeletions?.length ?? 0
                    if (result.state === 'deferred-active-chat') state.deferredForChat = o.activeChat() || '-'
                    else if (result.state === 'applied' || result.state === 'applied-pending' || result.state === 'empty') state.deferredForChat = ''
                }
                if (missingMediaChecked && outcome !== 'save-failed' && outcome !== 'finish-pending') { await clearMissingMedia(); boundary() }
                state.lastOutcome = (keyReady ? '' : 'key-pending:') + outcome
                state.attention = attention; state.failures = 0; state.offline = false; state.lastError = ''; state.lastCycleAt = o.now()
                if (!keyReady) transferStatus.set('동기화 키를 기다리는 중 · 권한 기기에 키 요청을 보내 주세요.')
                if (generation === state.generation) schedule(routineDelay())
                return state.lastOutcome
            } catch (error: any) {
                if (error instanceof Cancelled && error.message === 'generating' && generation === state.generation && active()) return deferForGeneration() // stopped between steps (never inside the apply)
                if (error instanceof Cancelled || generation !== state.generation || !active()) { state.lastOutcome = 'cancelled'; return 'cancelled' } // never reschedule a stopped/disabled/paused coordinator
                if (stage === 'snapshot' && error?.code === 'NAS_SYNC_PLAN_PENDING') { state.lastOutcome = 'deferred'; state.lastError = ''; schedule(o.pollMs); return state.lastOutcome }
                if (stage === 'apply' && /deadline/i.test(String(error?.message ?? error))) { state.lastOutcome = 'pulled'; state.lastError = ''; state.deferredForChat ||= o.activeChat() || '-'; transferStatus.set('받은 변경은 보관 중이에요. 다음 적용 기회에 다시 시도해요.'); if (generation === state.generation) schedule(o.pollMs); return state.lastOutcome } // plan released; incoming stays received
                // Offline/server/publish error: local play continues (an un-armed apply released its hold), retry with backoff.
                state.failures += 1
                const message = String(error?.message ?? error)
                const missing = stage === 'snapshot' && error?.code === 'SNAPSHOT_MISSING'
                if (!missing || error.detail?.logged !== true) logCycleError(stage, error?.code, missing ? error.detail?.missingFiles : undefined)
                state.offline = !o.online() || /deadline|abort|fetch|network/i.test(message)
                state.lastError = message.slice(0, 200)
                state.lastOutcome = error?.code === 'PUBLISH_FAILED' ? 'publish-failed' : error?.code === 'REPAIR_FAILED' ? 'repair-failed' : state.offline ? 'offline' : 'error'
                schedule(o.backoffMs[Math.min(state.failures, o.backoffMs.length) - 1])
                return state.lastOutcome
            } finally {
                if (deadline) o.clearTimer(deadline); external?.removeEventListener('abort', onExternal); if (controller === mine) controller = null; state.running = false; state.stage = ''; current = null; publish(); void reason
                const queued = pendingWindow; pendingWindow = null
                // 0.9.96-ver10: with a cadence the queued event runs only if it is still owed — due, or work this windowless cycle received waits.
                const stillOwed = !cadence || due() || owedWhenVisible || (!safe && waiting())
                if (queued && active() && generation === state.generation && stillOwed) void cycle(queued.window, undefined, queued) // the event that arrived mid-cycle, with its own epoch
            }
        })()
        current = run
        return run
    }
    /** A lifecycle event opens a safe window with the epoch taken NOW. If a cycle is running, the window is kept (same epoch) and the cycle
     *  runs right after; interactions in between void it exactly like any other, so received work is never applied under a renewed window. */
    const lifecycle = (window: SyncApplyGuard['window'], reason: string) => { if (!active() || !lifecycleAllowed()) return; const safe = openWindow(window); if (state.running) { pendingWindow = pendingWindow ?? safe; return } void cycle(reason, undefined, safe) }
    return {
        state, cycle, cadence,
        /** Device-local cadence tally (read only; for the UI and tests). */
        cadenceState: () => ({ ...tally, due: due() }),
        /** 0.9.96-ver10: a generation was registered for `chatKey` (see the cadence note at the top); the cadence's `chats`-th answer
         *  schedules the cycle (it then waits for the generation like any automatic cycle). */
        /** 0.9.96-ver10: called by preSendSync once a send is admitted; synchronously after it sendChat registers its generation. */
        sendAdmitted(signal: AbortSignal) { if (cadence) admitted = signal },
        chatStarted(_chatKey: string, entry?: unknown) {
            if (!cadence || (entry as { kind?: string } | undefined)?.kind === 'background') return // reattached job: no sendChat
            const signal = admitted; admitted = null
            if (!signal || answered.has(signal)) return // not a send / auto-continue or internal resend: the same answer
            answered.add(signal)
            if (o.previewing()) return // prompt preview

            tally.chats += 1; o.cadenceStore.save({ ...tally })
            if (active() && !state.running && tally.chats >= cadence.chats && (!timer || state.nextAt > o.now() + o.debounceMs)) schedule(o.debounceMs)
        },
        /** Explicit retry remains available while paused/held; it only settles the same transaction, never starts a new transfer. */
        async retryApply() {
            if (state.running) return 'running'
            state.running = true; publish()
            try {
                const result = await o.retryApply()
                state.lastOutcome = result.state; state.pendingReview = result.pending?.length ?? 0; state.keptDeletions = result.keptDeletions?.length ?? 0
                state.lastError = result.error ?? ''; state.lastCycleAt = o.now()
                return result.state
            } finally { state.running = false; publish(); schedule(Math.min(o.pollMs, 5_000)) }
        },
        /** The user (re)opened a chat: a safe window for that chat (and anything else waiting). Wired to `risubard-chat-opened` and character switches. */
        chatOpened() { lifecycle('reopen', 'reopen') },
        /** Idempotent: a second start is a no-op (no timer or listener duplication). A stop during the initial probe wins. */
        async start() {
            if (started || !o.supported()) return false
            started = true
            // The startup window opens here, before the probe and listeners: interaction during start-up (probe, first second) voids it.
            if (typeof document !== 'undefined') for (const type of ['pointerdown', 'keydown', 'input', 'touchstart', 'wheel']) listen(document, type, () => { interactions += 1 }, true) // wheel: reading by mouse scroll is interaction too
            startupWindow = openWindow('startup')
            // Retryable initialization: an exception here (a broken host timer, an unexpected probe failure) leaves nothing half-started.
            try { await probe() } catch (error) { this.stop(); throw error }
            if (!started) return false // stopped while probing: no listeners, no timers, nothing enabled
            try {
                const unsubscribeGenerating = o.generatingChanged.subscribe(on => { if (on || !resumeAfterGeneration || !active()) return; resumeAfterGeneration = false; schedule(o.debounceMs) })
                const unsubscribeSave = canonicalSaveSettled.subscribe(at => { if (!at || !active() || !due()) return; if (debounce) o.clearTimer(debounce); debounce = o.setTimer(() => { debounce = null; if (due()) void cycle('save') }, o.debounceMs) })
                // 0.9.96-ver10: answers are counted where the send path registers its generation (the real target chat); keys present at
                // subscription are not new starts.
                let live: Set<string> | null = null
                const unsubscribeChats = o.generations.subscribe(map => {
                    const keys = new Set(map.keys())
                    if (live) for (const key of keys) if (!live.has(key)) this.chatStarted(key, map.get(key))
                    live = keys
                })
                unsubscribe = () => { unsubscribeSave(); unsubscribeGenerating(); unsubscribeChats() }
                // Foreground: visible/focus open a window (epoch at the event). Reconnect is network-only: it never opens a window.
                const wake = (why: string, window: SyncApplyGuard['window'] | null) => { if (!started || state.paused) return; if (!state.probed) { void probe().then(ok => { if (ok && active()) schedule(500) }); return } if (!active()) return; if (window) { lifecycle(window, why); return } if (!state.running && (due() || owedWhenVisible || state.failures > 0 || state.offline)) void cycle(why, undefined, null) }
                if (typeof document !== 'undefined') listen(document, 'visibilitychange', () => { if (o.visible()) wake('visible', 'foreground') })
                if (typeof window !== 'undefined') {
                    listen(window, 'online', () => wake('online', null))
                    listen(window, 'focus', () => { if (!state.probed || o.now() - state.lastCycleAt > o.pollMs) wake('focus', 'foreground') })
                    listen(window, 'risubard-chat-opened', () => lifecycle('reopen', 'reopen'))
                }
                let initialEmission = true
                unsubscribeSelection = selectedCharID.subscribe(() => { if (initialEmission) { initialEmission = false; return } lifecycle('reopen', 'reopen') }) // character switch (synchronous at the click); the subscribe-time emission is not an event
                if (state.enabled) { const first = startupWindow; startupWindow = null; if (timer) o.clearTimer(timer); state.nextAt = o.now() + 1_000; timer = o.setTimer(() => { timer = null; void cycle('startup', undefined, first) }, 1_000) }
            } catch (error) { this.stop(); throw error } // nothing half-registered survives a failed start; the next start begins clean
            publish()
            return true
        },
        /**
         * Kept for callers that want a bounded wait for the running cycle (the send path no longer uses it): joins the cycle in flight
         * for at most the budget or runs a network-only cycle. Never applies (no safe window).
         */
        async latestCheck(external?: AbortSignal): Promise<string> {
            if (!active()) return 'idle'
            if (external?.aborted) return 'cancelled'
            if (state.running && current) {
                return new Promise<string>(resolve => {
                    const done = (value: string) => { o.clearTimer(t); external?.removeEventListener('abort', onAbort); resolve(value) }
                    const onAbort = () => done('cancelled'), t = o.setTimer(() => done('deadline'), o.deadlineMs)
                    external?.addEventListener('abort', onAbort, { once: true })
                    void current!.then(v => done(v), () => done('error'))
                })
            }
            return cycle('send', external)
        },
        /** After the server-side enable/disable: picks the state up; disabling invalidates in-flight work (an armed apply still settles). */
        enabled(value: boolean) { state.enabled = value; state.probed = true; state.paused = false; if (value) schedule(500); else { invalidate('sync disabled'); stopTimers(); state.deferredForChat = '' } publish() },
        pause(value: boolean) { state.paused = value; if (value) { invalidate('sync paused'); stopTimers() } else if (state.enabled) schedule(500); publish() },
        /** The user asked: a manual window (its epoch is now; typing right after still voids it). */
        retryNow: () => { state.failures = 0; return cycle('manual', undefined, openWindow('manual')) },
        uploadNow: () => { state.failures = 0; return cycle('manual', undefined, openWindow('manual'), 'upload') },
        downloadNow: () => { state.failures = 0; return cycle('manual', undefined, openWindow('manual'), 'download') },
        stop() { started = false; startupWindow = null; pendingWindow = null; invalidate('sync stopped'); stopTimers(); unsubscribe?.(); unsubscribe = null; unsubscribeSelection?.(); unsubscribeSelection = null; for (const l of listeners) l.target.removeEventListener(l.type, l.handler, { capture: l.capture }); listeners.length = 0 },
    }
}
/** Process-wide singleton used by bootstrap, the send path and the settings UI. */
export function syncCoordinator() { return instance ??= createSyncCoordinator({ cadence: DEFAULT_CADENCE }) }
export async function startSyncCoordinator() { return syncCoordinator().start() }
/**
 * Called by the real send path after the local send preparation (which keeps its own unlimited, cancel-only wait). It never waits
 * for the NAS: the only refusal is an apply left unresolved (hold kept), which the caller reports instead of forcing the lock open.
 * Publish/pull of the new turn happen in the background once the save settles.
 */
export async function preSendSync(signal?: AbortSignal, _coordinator: unknown = instance): Promise<boolean> {
    if (signal?.aborted) return false // a cancelled send never reaches generation or scripts
    if (get(syncSaveHold)) return false
    // 0.9.96-ver10: the sync cadence counts answers; sendChat registers its generation synchronously after this resolves.
    if (signal) try { (_coordinator as ReturnType<typeof createSyncCoordinator> | null)?.sendAdmitted?.(signal) } catch { /* counting never blocks a send */ }
    return true
}
