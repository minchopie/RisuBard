// Coordinator lifecycle on fake timers with the REAL save-settled store and the real hold/busy stores. Non-interrupting contract:
// publish/pull in the background (even while generating), snapshot only when settled and not generating, apply ONLY in a safe window
// opened by a lifecycle event (startup / foreground / chat open / manual) whose interaction epoch is captured at the event and voided
// by any later pointer/keyboard/input; timer, save, send and reconnect cycles never apply. Received work waits durably and is applied
// when the chat is (re)opened — also when that event arrives while a cycle is running (kept with its own epoch, never renewed).
import { beforeEach, afterEach, test, expect, vi } from 'vitest'
import { get, writable } from 'svelte/store'
import { readFileSync } from 'node:fs'
const f = vi.hoisted(() => ({ unavailable: vi.fn(() => false), activity: vi.fn(() => false), addLog: vi.fn(), alert: { type: 'none' }, chat: 'card/chat', selected: null as any }))
vi.mock('./log', () => ({ addLog: f.addLog }))
vi.mock('./transfer-sync/playTransfer', () => ({ transferUnavailable: () => f.unavailable() }))
vi.mock('./transfer-sync/nasSync', () => ({ activityBlocksSync: () => f.activity(), retrySyncApply: vi.fn(), applySync: vi.fn(), pullSync: vi.fn(), publishSync: vi.fn(), snapshotSync: vi.fn(), syncStatus: vi.fn(), reportSyncNetwork: vi.fn(async () => {}), pendingRootsSync: vi.fn(), releaseSyncPlan: vi.fn(), activeChatSignature: () => f.chat }))
vi.mock('./platform', () => ({ isNodeServer: true }))
vi.mock('./stores.svelte', () => { const selectedCharID = writable(0); f.selected = selectedCharID; return { alertStore: writable(f.alert), selectedCharID } })
import { createSyncCoordinator, preSendSync, pluginWindowOpen, syncCoordinator, DEFAULT_CADENCE } from './nasSyncCoordinator'
import { canonicalSaveSettled, transferBusy, transferStatus, syncSaveHold } from './transferState'

/** The real apply's admission contract, modelled on the stores: hold+busy are set at arm and released on a pre-arm abort/failure; once
 *  "armed" they are released only by its own verdict (never by the coordinator). `guard.interacted()` is consulted like the product does. */
function applyModel(calls: string[], behaviour: { hang?: boolean; armed?: boolean; result?: any; touchesActiveChat?: boolean } = {}, guards: any[] = []) {
    return vi.fn(async (_auto: boolean, signal?: AbortSignal, guard?: any) => {
        calls.push('apply'); guards.push(guard)
        guard?.planReady?.()
        if (behaviour.hang) {
            try { await new Promise<void>((_resolve, reject) => { if (signal?.aborted) return reject(signal.reason); signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted'))) }) }
            catch (error) {
                if (behaviour.armed) { transferBusy.set(true); syncSaveHold.set(true); return { state: 'finish-pending' } } // armed: keeps its hold; settles through finish/recovery
                throw error // the product apply's pre-arm failure path: nothing was held
            }
        }
        if (guard?.interacted()) return { state: 'deferred', deferred: ['activity'] } // the product releases the plan when the user interacted
        if (behaviour.touchesActiveChat && guard && !['startup', 'reopen', 'manual'].includes(guard.window)) return { state: 'deferred-active-chat' }
        transferBusy.set(true); syncSaveHold.set(true); syncSaveHold.set(false); transferBusy.set(false) // the armed stage, instantaneous here
        return behaviour.result ?? { state: 'applied' }
    })
}
const STATUS = () => ({ enabled: true, role: 'authority', vault: { origin: null, missing: false } })
function harness(overrides: any = {}) {
    const calls: string[] = [], guards: any[] = []
    const step = (name: string, value: () => any, delay = () => 0) => vi.fn(async (signal?: AbortSignal) => { calls.push(name); const d = delay(); if (d) await new Promise(r => setTimeout(r, d)); if (signal?.aborted) throw signal.reason; return value() })
    let pending = 0
    const io = { status: step('status', STATUS), snapshot: step('snapshot', () => ({ committed: null })), publish: step('publish', () => ({ stored: [], failed: [] })), pull: step('pull', () => ({ admitted: [] })), pendingRoots: step('preview', () => ({ roots: Array.from({ length: pending }, (_, i) => ({ domain: 'play', type: 'chat', root: 'r' + i })), plan: null })), apply: applyModel(calls, {}, guards) }
    let visible = true, online = true, interactions = 0
    const c = createSyncCoordinator({ ...io, visible: () => visible, online: () => online, supported: () => true, interactions: () => interactions, ...overrides })
    return { c, calls, guards, io, step, setVisible: (v: boolean) => { visible = v }, setOnline: (v: boolean) => { online = v }, interact: () => { interactions += 1 }, setPending: (n: number) => { pending = n } }
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
beforeEach(() => { vi.useFakeTimers(); canonicalSaveSettled.set(0); transferBusy.set(false); syncSaveHold.set(false); f.unavailable.mockReturnValue(false); f.activity.mockReturnValue(false); f.alert.type = 'none'; f.chat = 'card/chat'; f.selected.set(0) })
afterEach(() => { vi.useRealTimers() })

test.each([
    ['getaddrinfo ENOTFOUND fixture.nas.invalid', 'ENOTFOUND', 'ENOTFOUND'],
    ['user=qa password=a,b;c | alias: sample@fixture.invalid', 'SNAPSHOT_MISSING', 'SNAPSHOT_MISSING'],
    ['https://fixture.invalid/path 192.0.2.10 2001:db8::1 ' + 'a'.repeat(45), 'A'.repeat(40), 'UNKNOWN'],
])('records fixed diagnostics for %s and retains the existing screen message', async (message, code, expectedCode) => {
    f.addLog.mockClear()
    const h = harness(); await h.c.start()
    h.io.snapshot.mockRejectedValueOnce(Object.assign(new Error(message), { code }))
    try {
        expect(await h.c.uploadNow()).toBe('error')
        expect(h.c.state.lastError).toBe(message)
        expect(f.addLog).toHaveBeenCalledExactlyOnceWith({
            level: 'error', source: 'nas-sync', description: 'stage=snapshot code=' + expectedCode,
            message: 'NAS 동기화 단계에서 오류가 발생했습니다.',
        })
    } finally { h.c.stop() }
})

test('missing media is a last-cycle notice, then publish, pull, preview and apply still run', async () => {
    const h = harness(); await h.c.start(); h.calls.length = 0; h.setPending(1); f.addLog.mockClear()
    const notices = [{ kind: 'asset', key: 'assets/missing.png', records: [{ type: 'module', id: 'module-id', name: 'private row name' }] }]
    h.io.snapshot.mockImplementationOnce(async () => { h.calls.push('snapshot'); return { skippedMedia: notices } })
    try {
        expect(await h.c.retryNow()).toBe('applied')
        expect(h.calls).toEqual(['status', 'snapshot', 'publish', 'pull', 'preview', 'apply'])
        expect(h.c.state).toMatchObject({ skippedMedia: notices, failures: 0, lastError: '', offline: false })
        expect(f.addLog).toHaveBeenCalledExactlyOnceWith({
            level: 'info', source: 'nas-sync', description: 'stage=snapshot code=MEDIA_SKIPPED count=1',
            message: 'NAS 동기화에서 그림을 건너뛰었습니다.',
        })
        await h.c.retryNow()
        expect(h.c.state.skippedMedia).toEqual([])
        expect(f.addLog).toHaveBeenCalledTimes(1)
    } finally { h.c.stop() }
})

test.each(['retryNow', 'uploadNow', 'downloadNow'] as const)('%s retries a failed startup probe before deciding sync is idle', async action => {
    const h = harness(); h.io.status.mockRejectedValueOnce(new Error('sync network deadline'))
    await h.c.start(); h.setPending(1)
    expect(h.c.state).toMatchObject({ enabled: false, probed: false, lastError: 'sync network deadline' })
    expect(await h.c[action]()).toBe(action === 'uploadNow' ? 'uploaded' : 'applied')
    expect(h.c.state).toMatchObject({ enabled: true, probed: true, lastError: '' })
    expect(h.io.snapshot).toHaveBeenCalledTimes(1)
    h.c.stop()
})

test('interaction during a manual recovery probe still voids the captured safe window', async () => {
    const h = harness(); h.io.status.mockRejectedValueOnce(new Error('sync network deadline'))
    await h.c.start(); h.setPending(1)
    h.io.status.mockImplementationOnce(async () => { h.interact(); return STATUS() })
    expect(await h.c.downloadNow()).toBe('pulled')
    expect(h.io.apply).not.toHaveBeenCalled()
    expect(get(syncSaveHold)).toBe(false); expect(get(transferBusy)).toBe(false)
    h.c.stop()
})

test('manual upload only snapshots and publishes; manual download protects local edits but never publishes', async () => {
    const h = harness(); await h.c.start(); h.calls.length = 0; h.setPending(1)
    expect(await h.c.uploadNow()).toBe('uploaded')
    expect(h.calls).toEqual(['status', 'snapshot', 'publish', 'status'])
    h.calls.length = 0
    h.io.publish.mockRejectedValue(new Error('must not upload'))
    expect(await h.c.downloadNow()).toBe('applied')
    expect(h.calls).toEqual(['status', 'snapshot', 'pull', 'preview', 'apply'])
    expect(h.guards[0].window).toBe('manual')
    h.c.stop()
})

test('a dialog opened while the plan is prepared (a content update question) defers the automatic apply', async () => {
    const h = harness(); await h.c.start(); h.setPending(1)
    h.io.apply.mockImplementation(async (_auto: boolean, _signal?: AbortSignal, guard?: any) => {
        f.alert.type = 'confirmMulti' // the question opens during the plan wait
        return guard?.interacted() ? { state: 'deferred', deferred: ['activity'] } : { state: 'applied' }
    })
    expect(await h.c.downloadNow()).toBe('deferred')
    h.c.stop()
})

test('0.9.92-ver7: the running step is kept in the state for the progress display and cleared when the cycle ends', async () => {
    const h = harness(); await h.c.start(); h.setPending(1)
    const seen: string[] = []
    for (const name of ['snapshot', 'pull', 'pendingRoots', 'apply'] as const) {
        const original = (h.io as any)[name].getMockImplementation()
        ;(h.io as any)[name].mockImplementation(async (...args: any[]) => { seen.push(String(h.c.state.stage)); return original(...args) })
    }
    expect(await h.c.downloadNow()).toBe('applied')
    expect(seen).toEqual(['snapshot', 'pull', 'preview', 'apply'])
    expect(h.c.state.stage).toBe('')
    expect(h.c.state.running).toBe(false)
    h.c.stop()
})

test('a slow non-blocking server plan does not consume the client preparation deadline', async () => {
    const h = harness(); await h.c.start(); h.setPending(1)
    h.io.apply.mockImplementation(async (_auto: boolean, signal?: AbortSignal, guard?: any) => {
        await new Promise(r => setTimeout(r, 20_000))
        if (signal?.aborted) throw signal.reason
        guard?.planReady?.()
        return { state: 'applied' }
    })
    const running = h.c.downloadNow()
    await vi.advanceTimersByTimeAsync(19_999)
    expect(h.c.state.running).toBe(true)
    expect(get(syncSaveHold)).toBe(false); expect(get(transferBusy)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await running).toBe('applied')
    h.c.stop()
})

test('a hydration deadline returned as deferred uses the same honest pending status as a rejected flush', async () => {
    const h = harness(); await h.c.start(); h.setPending(1)
    h.io.apply.mockImplementation(async (_auto: boolean, _signal?: AbortSignal, guard?: any) => {
        guard?.planReady?.()
        await new Promise(r => setTimeout(r, 10_001))
        transferStatus.set('Error: sync apply cancelled')
        return { state: 'deferred' }
    })
    const running = h.c.downloadNow()
    await vi.advanceTimersByTimeAsync(10_001)
    expect(await running).toBe('pulled')
    expect(get(transferStatus)).toBe('받은 변경은 보관 중이에요. 다음 적용 기회에 다시 시도해요.')
    expect(h.c.state.lastError).toBe('')
    expect(get(syncSaveHold)).toBe(false); expect(get(transferBusy)).toBe(false)
    h.c.stop()
})

test('direction buttons use the same running lane as automatic sync and do nothing during generation or pause', async () => {
    const h = harness(); await h.c.start(); h.calls.length = 0
    f.activity.mockReturnValue(true)
    expect(await h.c.uploadNow()).toBe('deferred'); expect(h.calls).toEqual([])
    h.setPending(1); expect(await h.c.downloadNow()).toBe('pulled'); expect(h.calls).toEqual(['status', 'pull', 'preview']); h.calls.length = 0
    f.activity.mockReturnValue(false)
    h.c.pause(true); expect(await h.c.downloadNow()).toBe('idle'); expect(h.calls).toEqual([])
    h.c.pause(false)
    let release!: () => void
    h.io.publish.mockImplementationOnce(async () => { h.calls.push('publish'); await new Promise<void>(r => { release = r }); return { stored: [], failed: [] } })
    const first = h.c.uploadNow(); await flush()
    expect(h.c.state.running).toBe(true)
    expect(await h.c.downloadNow()).toBe('running'); expect(await h.c.cycle('timer')).toBe('running')
    release(); expect(await first).toBe('uploaded'); expect(h.calls).not.toContain('pull')
    h.c.stop()
})

test('manual upload failures, pending outbox and missing keys never claim completion or start a download', async () => {
    const h = harness(); await h.c.start(); h.calls.length = 0
    h.io.publish.mockResolvedValueOnce({ failed: [{ error: 'NAS unavailable' }] })
    expect(await h.c.uploadNow()).toBe('publish-failed'); expect(h.calls).not.toContain('pull')
    h.io.status.mockResolvedValue({ ...STATUS(), sync: { outbox: { pending: [{}] } } } as any)
    expect(await h.c.uploadNow()).toBe('upload-pending')
    h.io.status.mockResolvedValue({ enabled: true, role: 'joining', vault: { origin: null, missing: true } } as any)
    h.calls.length = 0
    h.io.status.mockClear(); expect(await h.c.uploadNow()).toBe('key-pending:idle'); expect(h.io.status).toHaveBeenCalledTimes(1); expect(h.calls).toEqual([])
    h.c.stop()
})

test('startup window: the first cycle applies waiting work; a settled save runs snapshot → publish → pull → preview WITHOUT apply; polling (30 s) never applies; nothing while hidden; foreground opens a window', async () => {
    const h = harness(); h.setPending(1)
    expect(await h.c.start()).toBe(true); expect(await h.c.start()).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000); await flush()
    expect(h.calls).toEqual(['status', 'status', 'snapshot', 'publish', 'pull', 'preview', 'apply']); expect(h.guards[0].window).toBe('startup'); expect(h.c.state.lastOutcome).toBe('applied'); h.calls.length = 0
    h.setPending(1) // new incoming arrives later
    canonicalSaveSettled.set(Date.now()); await vi.advanceTimersByTimeAsync(2_000); canonicalSaveSettled.set(Date.now()) // two saves inside the window → one cycle
    await vi.advanceTimersByTimeAsync(4_999); expect(h.calls).toEqual([])
    await vi.advanceTimersByTimeAsync(1); await flush()
    expect(h.calls).toEqual(['status', 'snapshot', 'publish', 'pull', 'preview']); expect(h.c.state.lastOutcome).toBe('pulled'); expect(h.c.state.deferredForChat).toBe('card/chat'); h.calls.length = 0
    await vi.advanceTimersByTimeAsync(30_000); await flush(); expect(h.calls).not.toContain('apply'); expect(h.c.state.lastOutcome).toBe('pulled'); h.calls.length = 0 // timer: network only
    h.setVisible(false); await vi.advanceTimersByTimeAsync(90_000); await flush(); expect(h.calls).toEqual([]) // hidden: nothing, no background promise
    h.setVisible(true); document.dispatchEvent(new Event('visibilitychange')); await flush()
    expect(h.calls.filter(x => x === 'apply')).toHaveLength(1); expect(h.guards.at(-1).window).toBe('foreground'); expect(h.c.state.deferredForChat).toBe('')
    expect(get(syncSaveHold)).toBe(false); expect(get(transferBusy)).toBe(false)
    h.c.stop()
})

test('a NAS that never answers never touches local play: publish hangs across saves, no hold, no busy; a chat opened meanwhile is applied right after the cycle ends, with the epoch of the open event (typing in between voids it)', async () => {
    const h = harness(); h.setPending(1)
    let releasePublish: (() => void) | null = null
    let hangOnce = true
    h.io.publish = vi.fn(async () => { h.calls.push('publish'); if (hangOnce) { hangOnce = false; await new Promise<void>(r => { releasePublish = r }) } return { stored: [{ sequence: 1 }], failed: [] } })
    const c = createSyncCoordinator({ ...h.io, visible: () => true, online: () => true, supported: () => true, interactions: () => h.guards.length >= 0 ? interactions : 0 })
    let interactions = 0
    await c.start(); await vi.advanceTimersByTimeAsync(1_000); await flush()
    expect(h.calls).toEqual(['status', 'status', 'snapshot', 'publish']) // the upload is in progress
    for (let i = 0; i < 10; i++) { canonicalSaveSettled.set(Date.now()); await vi.advanceTimersByTimeAsync(60_000) } // ten minutes of play while the NAS hangs
    expect(get(syncSaveHold)).toBe(false); expect(get(transferBusy)).toBe(false); expect(c.state.running).toBe(true); expect(h.calls.filter(x => x === 'apply')).toEqual([])
    window.dispatchEvent(new CustomEvent('risubard-chat-opened')) // the user opens a chat while the upload still hangs: kept with its epoch
    interactions += 1 // ... and starts typing
    releasePublish!(); await flush(); await flush()
    expect(h.calls.slice(-7)).toEqual(['pull', 'preview', 'status', 'snapshot', 'publish', 'pull', 'preview']) // the queued window ran right after; no apply: the user typed after opening
    expect(c.state.lastOutcome).toBe('pulled'); expect(c.state.deferredForChat).toBe('card/chat'); h.calls.length = 0
    window.dispatchEvent(new CustomEvent('risubard-chat-opened')); await flush() // a quiet reopen applies
    expect(h.calls.at(-1)).toBe('apply'); expect(h.guards.at(-1).window).toBe('reopen'); expect(c.state.lastOutcome).toBe('applied')
    c.stop()
})

test('0.9.92-ver10: while a model request runs no automatic cycle starts (save, foreground, chat open, poll, download direction); its end resumes sync after the save debounce without a save or a full poll', async () => {
    const generatingChanged = writable(false)
    const h = harness({ generatingChanged }); h.setPending(1)
    await h.c.start(); await vi.advanceTimersByTimeAsync(1_000); await flush(); h.calls.length = 0
    f.activity.mockReturnValue(true); generatingChanged.set(true)
    canonicalSaveSettled.set(Date.now()); await vi.advanceTimersByTimeAsync(5_000); await flush()
    expect(h.calls).toEqual([]); expect(h.c.state).toMatchObject({ lastOutcome: 'deferred', running: false })
    document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new CustomEvent('risubard-chat-opened')); await flush(); expect(h.calls).toEqual([])
    expect(await h.c.cycle('timer', undefined, null, 'download')).toBe('deferred'); expect(h.calls).toEqual([])
    await vi.advanceTimersByTimeAsync(30_000); await flush(); expect(h.calls).toEqual([]) // the fallback poll waits again
    f.activity.mockReturnValue(false); generatingChanged.set(false)
    await vi.advanceTimersByTimeAsync(4_999); expect(h.calls).toEqual([])
    await vi.advanceTimersByTimeAsync(1); await flush()
    expect(h.calls).toEqual(['status', 'snapshot', 'publish', 'pull', 'preview']); expect(h.c.state.lastOutcome).toBe('pulled') // resumed (timer cycle: no window, no apply)
    expect(get(transferBusy)).toBe(false); expect(get(syncSaveHold)).toBe(false)
    h.c.stop()
})

test('0.9.92-ver10: a generation that starts during a running automatic cycle stops it at the next step boundary (the step in flight finishes, the next never starts, no apply, no hold); the end resumes it', async () => {
    for (const at of ['status', 'snapshot', 'publish', 'pull', 'preview'] as const) {
        const generatingChanged = writable(false)
        const h = harness({ generatingChanged }); h.setPending(1)
        const name = at === 'preview' ? 'pendingRoots' : at
        const original = (h.io as any)[name].getMockImplementation()
        ;(h.io as any)[name].mockImplementation(async (...args: any[]) => { const value = await original(...args); if (h.c.state.running) { f.activity.mockReturnValue(true); generatingChanged.set(true) } return value })
        await h.c.start(); await vi.advanceTimersByTimeAsync(1_000); await flush() // the startup cycle (a safe window: it would apply)
        expect(h.calls.at(-1)).toBe(at); expect(h.calls).not.toContain('apply')
        expect(h.c.state).toMatchObject({ running: false, lastOutcome: 'deferred', failures: 0, lastError: '' })
        expect(get(syncSaveHold)).toBe(false); expect(get(transferBusy)).toBe(false)
        ;(h.io as any)[name].mockImplementation(original); f.activity.mockReturnValue(false); generatingChanged.set(false)
        h.calls.length = 0; await vi.advanceTimersByTimeAsync(5_000); await flush()
        expect(h.calls).toEqual(['status', 'snapshot', 'publish', 'pull', 'preview'])
        h.c.stop()
    }
})

test('0.9.92-ver10: an apply that gives way to a generation started while it was preparing (returns deferred) also resumes after the generation ends, not only at the next poll (Codex C1)', async () => {
    const generatingChanged = writable(false)
    const h = harness({ generatingChanged }); h.setPending(1)
    h.io.apply.mockImplementationOnce(async () => { h.calls.push('apply'); f.activity.mockReturnValue(true); generatingChanged.set(true); return { state: 'deferred' } })
    await h.c.start(); await vi.advanceTimersByTimeAsync(1_000); await flush()
    expect(h.calls.at(-1)).toBe('apply'); expect(h.c.state).toMatchObject({ running: false, lastOutcome: 'deferred' })
    f.activity.mockReturnValue(false); generatingChanged.set(false)
    h.calls.length = 0; await vi.advanceTimersByTimeAsync(5_000); await flush()
    expect(h.calls).toEqual(['status', 'snapshot', 'publish', 'pull', 'preview'])
    h.c.stop()
})

test('0.9.92-ver10: an apply already armed when a generation starts is never interrupted; it settles through its own verdict', async () => {
    const generatingChanged = writable(false)
    const h = harness({ generatingChanged }); h.setPending(1)
    let finish!: () => void
    h.io.apply.mockImplementation(async (_auto: boolean, _signal?: AbortSignal, guard?: any) => {
        h.calls.push('apply'); guard?.planReady?.()
        transferBusy.set(true); syncSaveHold.set(true) // armed
        f.activity.mockReturnValue(true); generatingChanged.set(true) // a send starts meanwhile
        await new Promise<void>(r => { finish = r })
        syncSaveHold.set(false); transferBusy.set(false)
        return { state: 'applied' }
    })
    await h.c.start(); await vi.advanceTimersByTimeAsync(1_000); await flush()
    expect(h.calls.at(-1)).toBe('apply')
    await vi.advanceTimersByTimeAsync(3_000); await flush(); expect(h.c.state.running).toBe(true); expect(get(syncSaveHold)).toBe(true)
    finish(); await flush()
    expect(h.c.state).toMatchObject({ running: false, lastOutcome: 'applied' }); expect(get(syncSaveHold)).toBe(false); expect(get(transferBusy)).toBe(false)
    h.c.stop()
})

test('received on a timer, applied when the user opens a chat (event) or switches character (store): no foreground or manual step in between; the store\'s subscribe-time emission is not an event', async () => {
    const h = harness()
    await h.c.start(); await vi.advanceTimersByTimeAsync(1_000); await flush()
    expect(h.calls.filter(x => x === 'status')).toHaveLength(2) // probe + ONE startup cycle: the subscribe-time emission did not start another
    h.calls.length = 0
    h.setPending(2); await vi.advanceTimersByTimeAsync(30_000); await flush()
    expect(h.calls).toEqual(['status', 'snapshot', 'publish', 'pull', 'preview']); expect(h.c.state).toMatchObject({ lastOutcome: 'pulled', deferredForChat: 'card/chat', pendingRoots: 2 }); h.calls.length = 0
    f.chat = 'card/other'; window.dispatchEvent(new CustomEvent('risubard-chat-opened')); await flush()
    expect(h.calls).toEqual(['status', 'snapshot', 'publish', 'pull', 'preview', 'apply']); expect(h.guards.at(-1).window).toBe('reopen'); expect(h.c.state).toMatchObject({ lastOutcome: 'applied', deferredForChat: '' })
    h.calls.length = 0; h.setPending(1); await vi.advanceTimersByTimeAsync(30_000); await flush(); h.calls.length = 0
    f.selected.set(1); await flush() // switching the character is a reopen too (synchronous at the click)
    expect(h.calls.at(-1)).toBe('apply'); expect(h.guards.at(-1).window).toBe('reopen')
    h.c.stop()
})

test('interaction voids a window: typing after the window opened (even in the same tick) means no apply; a window is never re-opened by the timer; reconnect is network-only', async () => {
    const h = harness(); h.setPending(1)
    await h.c.start(); h.interact() // the user touches the app during the first second: the startup window is void
    await vi.advanceTimersByTimeAsync(1_000); await flush()
    expect(h.calls).toEqual(['status', 'status', 'snapshot', 'publish', 'pull', 'preview']); expect(h.c.state.lastOutcome).toBe('pulled'); h.calls.length = 0
    document.dispatchEvent(new Event('visibilitychange')); h.interact(); await flush() // same tick as the window: the live count moved past the epoch → no plan is even requested
    expect(h.calls).toEqual(['status', 'snapshot', 'publish', 'pull', 'preview']); expect(h.c.state.lastOutcome).toBe('pulled'); expect(get(transferBusy)).toBe(false); h.calls.length = 0
    window.dispatchEvent(new Event('online')); await flush() // reconnect while reading: publish/pull only, no window
    expect(h.calls).toEqual(['status', 'snapshot', 'publish', 'pull', 'preview']); expect(h.c.state.lastOutcome).toBe('pulled'); h.calls.length = 0
    await vi.advanceTimersByTimeAsync(300_000); await flush(); expect(h.calls.filter(x => x === 'apply')).toEqual([]) // no timer ever re-opens a window
    document.dispatchEvent(new Event('visibilitychange')); await flush(); expect(h.calls.at(-1)).toBe('apply'); expect(h.c.state.lastOutcome).toBe('applied') // a quiet foreground return applies
    h.c.stop()
})

test('startup: a pointer event before the probe finishes voids the startup window (epoch captured at start, listeners attached before the probe); the real document listener counts it', async () => {
    const h = harness(); h.setPending(1)
    h.io.status = h.step('status', STATUS, () => 3_000)
    const c = createSyncCoordinator({ ...h.io, visible: () => true, online: () => true, supported: () => true }) // real document listener counts interactions
    const starting = c.start(); await vi.advanceTimersByTimeAsync(1_000)
    document.dispatchEvent(new Event('pointerdown')) // during the slow probe
    await vi.advanceTimersByTimeAsync(2_000); expect(await starting).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000 + 3_000); await flush()
    expect(h.calls.filter(x => x === 'apply')).toEqual([]); expect(c.state.lastOutcome).toBe('pulled')
    c.stop()
    const g = harness(); g.setPending(1); await g.c.start(); await vi.advanceTimersByTimeAsync(1_000); await flush(); expect(g.calls.at(-1)).toBe('apply'); g.c.stop() // control: quiet start applies
})

test('mouse-wheel reading counts as interaction: a real document WheelEvent after the foreground window opened voids it (no timer advance, guard true, no apply)', async () => {
    const h = harness(); h.setPending(1)
    let releasePlan: (() => void) | null = null
    h.io.apply = vi.fn(async (_auto: boolean, signal?: AbortSignal, guard?: any) => { h.calls.push('apply'); h.guards.push(guard); await new Promise<void>(r => { releasePlan = r }); if (guard.interacted()) return { state: 'deferred', deferred: ['activity'] }; transferBusy.set(true); transferBusy.set(false); return { state: 'applied' } })
    const c = createSyncCoordinator({ ...h.io, visible: () => true, online: () => true, supported: () => true }) // real document listener
    await c.start(); await vi.advanceTimersByTimeAsync(1_000); await flush(); expect(h.calls.at(-1)).toBe('apply'); releasePlan!(); await flush(); h.calls.length = 0 // startup applied quietly
    h.setPending(1); document.dispatchEvent(new Event('visibilitychange')); await flush(); expect(h.calls.at(-1)).toBe('apply') // the plan is being prepared in a foreground window
    document.dispatchEvent(new WheelEvent('wheel', { deltaY: 120 })) // the reader scrolls while /plan is pending
    expect(h.guards.at(-1).interacted()).toBe(true) // the guard already reports it, before any timer advances
    releasePlan!(); await flush()
    expect(c.state.lastOutcome).toBe('deferred'); expect(get(transferBusy)).toBe(false); expect(get(syncSaveHold)).toBe(false)
    c.stop()
})

test('a plan whose real targets are the chat on screen is deferred in a foreground window and applied on reopen; the pre-arm wait is bounded (plan released at the deadline, no hold left); an armed apply is never unlocked by the deadline', async () => {
    const h = harness(); h.setPending(1)
    h.io.apply = applyModel(h.calls, { touchesActiveChat: true }, h.guards)
    const c = createSyncCoordinator({ ...h.io, visible: () => true, online: () => true, supported: () => true, interactions: () => 0 })
    await c.start(); await vi.advanceTimersByTimeAsync(1_000); await flush(); h.calls.length = 0 // startup window applied (startup may touch the open chat)
    document.dispatchEvent(new Event('visibilitychange')); await flush()
    expect(h.calls.at(-1)).toBe('apply'); expect(c.state).toMatchObject({ lastOutcome: 'deferred-active-chat', deferredForChat: 'card/chat' }); h.calls.length = 0
    window.dispatchEvent(new CustomEvent('risubard-chat-opened')); await flush()
    expect(h.calls.at(-1)).toBe('apply'); expect(c.state).toMatchObject({ lastOutcome: 'applied', deferredForChat: '' }); h.calls.length = 0
    h.io.apply.mockImplementation((auto: boolean, signal?: AbortSignal, guard?: any) => applyModel(h.calls, { hang: true }, h.guards)(auto, signal, guard))
    document.dispatchEvent(new Event('visibilitychange')); await flush(); expect(h.calls.at(-1)).toBe('apply')
    await vi.advanceTimersByTimeAsync(9_999); expect(c.state.running).toBe(true); expect(get(syncSaveHold)).toBe(false); expect(get(transferBusy)).toBe(false)
    await vi.advanceTimersByTimeAsync(1); await flush()
    expect(c.state).toMatchObject({ running: false, lastOutcome: 'pulled', failures: 0, lastError: '' }); expect(get(syncSaveHold)).toBe(false); expect(get(transferBusy)).toBe(false)
    h.io.apply.mockImplementation((auto: boolean, signal?: AbortSignal, guard?: any) => applyModel(h.calls, { hang: true, armed: true }, h.guards)(auto, signal, guard))
    document.dispatchEvent(new Event('visibilitychange')); await flush(); await vi.advanceTimersByTimeAsync(10_000); await flush()
    expect(c.state.lastOutcome).toBe('finish-pending'); expect(get(syncSaveHold)).toBe(true); expect(get(transferBusy)).toBe(true)
    syncSaveHold.set(false); transferBusy.set(false); c.stop()
})

test('the real chat-open producer is wired: changing the open chat dispatches risubard-chat-opened right after the page index is set', () => {
    const source = readFileSync('src/ts/globalApi.svelte.ts', 'utf8')
    const at = source.indexOf('char.chatPage = index'); expect(at).toBeGreaterThan(0)
    expect(source.slice(at, at + 400)).toMatch(/dispatchEvent\(new CustomEvent\('risubard-chat-opened'\)\)/)
})

test('pull.repairFailed is a cycle failure like publish.failed: no apply, outcome repair-failed naming the hash and reason, backoff, then a clean pull proceeds', async () => {
    const h = harness(); let fail = true
    h.io.pull.mockImplementation(async () => { h.calls.push('pull'); return fail ? { admitted: [], repaired: [], repairFailed: [{ hash: 'a'.repeat(64), reason: 'absent on NAS' }] } : { admitted: [], repaired: [], repairFailed: [] } })
    expect(await h.c.start()).toBe(true); await vi.advanceTimersByTimeAsync(1_000); await flush()
    expect(h.calls).toEqual(['status', 'status', 'snapshot', 'publish', 'pull'])
    expect(h.c.state).toMatchObject({ failures: 1, lastOutcome: 'repair-failed', running: false }); expect(h.c.state.lastError).toMatch(/aaaaaaaa absent on NAS/)
    h.calls.length = 0; await vi.advanceTimersByTimeAsync(4_999); expect(h.calls).toEqual([])
    fail = false; await vi.advanceTimersByTimeAsync(1); await flush()
    expect(h.calls).toEqual(['status', 'snapshot', 'publish', 'pull', 'preview']); expect(h.c.state).toMatchObject({ failures: 0, lastOutcome: 'empty', lastError: '' })
    h.c.stop()
})

test('failures back off 5/15/60 s capped at 5 min and clear on success; publish reports are inspected (failed uploads, ACK-only failure, rotation and held/quarantined attention)', async () => {
    const h = harness(); let failPublish = true
    h.io.publish = h.step('publish', () => failPublish ? { stored: [], failed: [{ sequence: 9, error: 'PUT 500' }] } : { stored: [], failed: [] })
    const c = createSyncCoordinator({ ...h.io, visible: () => true, online: () => true, supported: () => true, interactions: () => 0 })
    await c.start(); await vi.advanceTimersByTimeAsync(1_000); await flush()
    expect(c.state).toMatchObject({ failures: 1, lastOutcome: 'publish-failed' }); expect(c.state.lastError).toContain('PUT 500'); expect(h.calls).not.toContain('pull')
    const publishes = () => h.calls.filter(x => x === 'publish').length; const base = publishes()
    await vi.advanceTimersByTimeAsync(4_999); expect(publishes()).toBe(base); await vi.advanceTimersByTimeAsync(1); await flush(); expect(publishes()).toBe(base + 1)
    await vi.advanceTimersByTimeAsync(14_999); expect(publishes()).toBe(base + 1); await vi.advanceTimersByTimeAsync(1); await flush(); expect(publishes()).toBe(base + 2)
    await vi.advanceTimersByTimeAsync(60_000); await flush(); expect(publishes()).toBe(base + 3)
    await vi.advanceTimersByTimeAsync(299_999); expect(publishes()).toBe(base + 3); await vi.advanceTimersByTimeAsync(1); await flush(); expect(publishes()).toBe(base + 4)
    failPublish = false; await vi.advanceTimersByTimeAsync(300_000); await flush()
    expect(c.state).toMatchObject({ failures: 0, lastOutcome: 'empty' })
    h.io.publish.mockResolvedValueOnce({ stored: [], failed: [{ ack: true, error: 'ack PUT failed' }] })
    await vi.advanceTimersByTimeAsync(30_000); await flush(); expect(c.state).toMatchObject({ lastOutcome: 'publish-failed', failures: 1 })
    h.io.publish.mockResolvedValueOnce({ stored: [{ sequence: 3 }], failed: [], rotated: { from: 'a', to: 'b' } }); h.io.pull.mockResolvedValueOnce({ admitted: [], held: [{ sequence: 9 }], quarantined: [] })
    await vi.advanceTimersByTimeAsync(5_000); await flush()
    expect(c.state).toMatchObject({ lastOutcome: 'review-needed', failures: 0, attention: 'rotated,incoming-review' })
    c.stop()
})

test('disable/pause/stop invalidate a cycle in flight: a late pull response never reaches preview/apply and nothing is rescheduled; busy gates postpone; stop removes every listener (restart does not duplicate wakes)', async () => {
    const h = harness()
    let releasePull: (() => void) | null = null
    h.io.pull.mockImplementationOnce(async () => { h.calls.push('pull'); await new Promise<void>(r => { releasePull = r }); return { admitted: [{ sequence: 1 }] } })
    await h.c.start(); await vi.advanceTimersByTimeAsync(1_000); await flush()
    expect(h.calls.at(-1)).toBe('pull'); expect(h.c.state.running).toBe(true)
    h.c.enabled(false)
    releasePull!(); await flush()
    expect(h.calls).not.toContain('preview'); expect(h.c.state).toMatchObject({ running: false, lastOutcome: 'cancelled', enabled: false, nextAt: 0 })
    await vi.advanceTimersByTimeAsync(600_000); await flush(); expect(h.calls.filter(x => x === 'status')).toHaveLength(2)
    h.calls.length = 0
    h.c.enabled(true); f.unavailable.mockReturnValue(true); await vi.advanceTimersByTimeAsync(500); await flush(); expect(h.calls).toEqual([]); expect(h.c.state.lastOutcome).toBe('busy')
    f.unavailable.mockReturnValue(false); await vi.advanceTimersByTimeAsync(5_000); await flush(); expect(h.calls).toContain('preview'); h.calls.length = 0
    h.c.stop(); canonicalSaveSettled.set(Date.now()); await vi.advanceTimersByTimeAsync(60_000); await flush(); window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new CustomEvent('risubard-chat-opened')); f.selected.set(3); await flush(); expect(h.calls).toEqual([])
    await h.c.start(); await vi.advanceTimersByTimeAsync(1_000); await flush(); h.calls.length = 0
    document.dispatchEvent(new Event('visibilitychange')); await flush(); expect(h.calls.filter(x => x === 'status')).toHaveLength(1) // one cycle per event after a restart
    h.c.stop()
})

test('stop during the start probe wins: no listeners, no timers, nothing enabled; a failed start probe recovers on reconnect/visible', async () => {
    const h = harness()
    h.io.status = h.step('status', STATUS, () => 3_000)
    const c = createSyncCoordinator({ ...h.io, visible: () => true, online: () => true, supported: () => true })
    const starting = c.start(); await vi.advanceTimersByTimeAsync(1_000); c.stop(); await vi.advanceTimersByTimeAsync(2_000)
    expect(await starting).toBe(false); expect(c.state.enabled).toBe(false)
    canonicalSaveSettled.set(Date.now()); await vi.advanceTimersByTimeAsync(60_000); await flush(); window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); await flush()
    expect(h.calls).toEqual(['status'])
    const g = harness(); g.io.status = vi.fn(async () => { g.calls.push('status'); throw new Error('Failed to fetch') })
    const d = createSyncCoordinator({ ...g.io, visible: () => true, online: () => true, supported: () => true })
    expect(await d.start()).toBe(true); expect(d.state).toMatchObject({ enabled: false, probed: false }); expect(d.state.lastError).toContain('Failed to fetch')
    canonicalSaveSettled.set(Date.now()); await vi.advanceTimersByTimeAsync(60_000); await flush(); expect(g.calls.filter(x => x === 'preview')).toEqual([])
    g.io.status.mockImplementation(async () => { g.calls.push('status'); return STATUS() })
    window.dispatchEvent(new Event('online')); await flush(); await vi.advanceTimersByTimeAsync(500); await flush()
    expect(d.state).toMatchObject({ enabled: true, probed: true }); expect(g.calls).toContain('preview')
    d.stop()
})

test('a joining device without the shared key (or with the key missing) pulls but publishes nothing of its own until the key arrives', async () => {
    const h = harness(); h.setPending(1)
    h.io.status.mockImplementation(async () => { h.calls.push('status'); return { enabled: true, role: 'joining', vault: { origin: null, missing: false } } })
    await h.c.start(); await vi.advanceTimersByTimeAsync(1_000); await flush()
    expect(h.calls.filter(x => x === 'snapshot' || x === 'publish')).toEqual([]); expect(h.calls).toContain('pull'); expect(h.c.state.lastOutcome).toMatch(/^key-pending:/)
    h.io.status.mockImplementation(async () => { h.calls.push('status'); return { enabled: true, role: 'authority', vault: { origin: 'generated', missing: true } } }); h.calls.length = 0
    await vi.advanceTimersByTimeAsync(30_000); await flush(); expect(h.calls.filter(x => x === 'snapshot' || x === 'publish')).toEqual([])
    h.io.status.mockImplementation(async () => { h.calls.push('status'); return { enabled: true, role: 'joining', vault: { origin: 'shared', missing: false } } }); h.calls.length = 0
    await vi.advanceTimersByTimeAsync(30_000); await flush(); expect(h.calls).toEqual(['status', 'snapshot', 'publish', 'pull', 'preview'])
    h.c.stop()
})

test('unsupported runtime (not the Node server) never starts', async () => {
    const h = harness({ supported: () => false })
    expect(await h.c.start()).toBe(false); canonicalSaveSettled.set(Date.now()); await vi.advanceTimersByTimeAsync(60_000); await flush(); expect(h.calls).toEqual([])
})

test('browser-faithful host timers: Window timers throw "Illegal invocation" when called with another receiver; the defaults are wrapped, start never leaves the singleton stuck and is retryable (Codex 30)', async () => {
    vi.useRealTimers()
    const realSet = globalThis.setTimeout, realClear = globalThis.clearTimeout
    function strictSet(this: unknown, fn: () => void, ms?: number) { if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation'); return realSet(fn, ms) }
    function strictClear(this: unknown, t: any) { if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation'); return realClear(t) }
    vi.stubGlobal('setTimeout', strictSet); vi.stubGlobal('clearTimeout', strictClear)
    try {
        expect(() => ({ setTimer: globalThis.setTimeout as any }).setTimer(() => {}, 0)).toThrow('Illegal invocation')
        const calls: string[] = []
        const status = vi.fn(async () => { calls.push('status'); return { enabled: true, role: 'authority', vault: { origin: 'generated', missing: false } } })
        const c = createSyncCoordinator({ status, snapshot: async () => ({ committed: null }), publish: async () => ({ stored: [], failed: [] }), pull: async () => ({ admitted: [] }), pendingRoots: async () => ({ roots: [], plan: null }), apply: async () => ({ state: 'empty' }), supported: () => true, visible: () => true, online: () => true, blocked: () => false })
        expect(await c.start()).toBe(true)
        await new Promise(r => realSet(r, 1_200)); expect(c.state.lastOutcome).toBe('empty'); expect(calls.length).toBeGreaterThanOrEqual(2)
        c.stop()
        let broken = true
        const d = createSyncCoordinator({ status: async () => ({ enabled: false }), supported: () => true, setTimer: ((fn: any, ms: any) => { if (broken) throw new TypeError('Illegal invocation'); return realSet(fn, ms) }) as any, clearTimer: ((t: any) => realClear(t)) as any })
        await expect(d.start()).rejects.toThrow('Illegal invocation'); broken = false
        expect(await d.start()).toBe(true); d.stop()
    } finally { vi.unstubAllGlobals() }
})

test('every cycle refreshes the network view for the home/external route before status; a failing report never stops the cycle', async () => {
    const h = harness(); let fail = false
    const network = vi.fn(async () => { if (fail) throw new Error('bridge unavailable') })
    const c = createSyncCoordinator({ ...h.io, network, visible: () => true, online: () => true, supported: () => true })
    await c.start(); await vi.advanceTimersByTimeAsync(1_000); await flush()
    expect(network).toHaveBeenCalledTimes(1); expect(h.calls.slice(0, 3)).toEqual(['status', 'status', 'snapshot'])
    fail = true; await vi.advanceTimersByTimeAsync(30_000); await flush()
    expect(network).toHaveBeenCalledTimes(2); expect(c.state.lastOutcome).toBe('empty'); expect(c.state.failures).toBe(0)
    c.stop()
})

test('a status/snapshot race waits without a false error or transfer, then releases the late prepared plan on retry', async () => {
    const h = harness(); let pending = false
    h.io.status = h.step('status', () => ({ ...STATUS(), plan: pending ? { transaction: 'late-tx', phase: 'prepared' } : null }))
    h.io.snapshot.mockImplementationOnce(async () => { h.calls.push('snapshot'); pending = true; throw Object.assign(new Error('Finish the pending sync apply before taking a snapshot'), { code: 'NAS_SYNC_PLAN_PENDING' }) })
    const release = vi.fn(async () => { pending = false; return { state: 'rolled-back' } })
    const c = createSyncCoordinator({ ...h.io, release, visible: () => true, online: () => true, supported: () => true })
    await c.start(); h.calls.length = 0
    expect(await c.uploadNow()).toBe('deferred')
    expect(h.calls).toEqual(['status', 'snapshot']); expect(c.state).toMatchObject({ failures: 0, lastError: '', lastOutcome: 'deferred' })
    expect(await c.uploadNow()).toBe('uploaded'); expect(release).toHaveBeenCalledTimes(1)
    expect(h.calls).not.toContain('pull'); expect(h.calls).not.toContain('apply'); c.stop()
})

test('late prepared plan: the bounded pre-arm wait gives up before /plan answers and the server keeps a prepared journal → the next cycle releases it (unconfirmed finish) before snapshot and proceeds; an ARMED journal (saving/committed) is never released and the cycle does no local work', async () => {
    const h = harness(); h.setPending(1)
    let planPhase: string | null = null
    h.io.status = h.step('status', () => ({ ...STATUS(), plan: planPhase ? { transaction: 'tx-late', phase: planPhase } : null }))
    const release = vi.fn(async (transaction: string) => { h.calls.push('release:' + transaction); planPhase = null; return { state: 'rolled-back' } })
    h.io.apply = applyModel(h.calls, { hang: true }, h.guards)
    const c = createSyncCoordinator({ ...h.io, release, visible: () => true, online: () => true, supported: () => true, interactions: () => 0 })
    await c.start(); await vi.advanceTimersByTimeAsync(1_000); await flush(); expect(h.calls.at(-1)).toBe('apply')
    await vi.advanceTimersByTimeAsync(10_000); await flush(); expect(c.state.lastOutcome).toBe('pulled') // the client gave up; the plan answer is lost
    planPhase = 'prepared' // ... but the server did prepare it
    h.calls.length = 0; await vi.advanceTimersByTimeAsync(30_000); await flush()
    expect(h.calls.slice(0, 3)).toEqual(['status', 'release:tx-late', 'snapshot']); expect(c.state.failures).toBe(0); expect(c.state.lastOutcome).not.toBe('error') // released, then an ordinary cycle
    planPhase = 'saving'; h.calls.length = 0; await vi.advanceTimersByTimeAsync(30_000); await flush()
    expect(h.calls).toEqual(['status']); expect(release).toHaveBeenCalledTimes(1); expect(c.state).toMatchObject({ lastOutcome: 'recovery-pending', attention: 'recovery-pending', failures: 0 }) // armed: only finish/recovery may settle it
    planPhase = null; h.calls.length = 0; await vi.advanceTimersByTimeAsync(30_000); await flush(); expect(h.calls.slice(0, 2)).toEqual(['status', 'snapshot']) // settled elsewhere: normal cycles resume
    c.stop()
})


test('manual receive during generation stays receive-only even if generation ends during the pull', async () => {
    f.activity.mockReturnValue(true)
    const h = harness(); await h.c.start(); h.calls.length = 0; h.setPending(1)
    h.io.pull.mockImplementation(async () => { h.calls.push('pull'); f.activity.mockReturnValue(false); return { admitted: [] } })
    expect(await h.c.downloadNow()).toBe('pulled')
    expect(h.calls).toEqual(['status', 'pull', 'preview'])
    h.calls.length = 0
    expect(await h.c.downloadNow()).toBe('applied')
    expect(h.calls).toEqual(['status', 'snapshot', 'pull', 'preview', 'apply'])
    h.c.stop()
})

test('partial apply counts survive the coordinator, held receipts never say no changes, and retry never starts a transfer', async () => {
    const retryApply = vi.fn(async () => ({ state: 'applied-pending' as const, pending: [{}], keptDeletions: [{ kind: 'chat' as const, id: 'kept' }] }))
    const h = harness({ retryApply }); await h.c.start(); h.calls.length = 0
    h.io.pull.mockResolvedValueOnce({ held: [{}] } as any)
    expect(await h.c.downloadNow()).toBe('review-needed')
    h.setPending(1); h.io.apply.mockResolvedValueOnce({ state: 'applied-pending', pending: [{}, {}], keptDeletions: [{ kind: 'chat', id: 'kept' }] } as any)
    expect(await h.c.downloadNow()).toBe('applied-pending')
    expect(h.c.state).toMatchObject({ pendingReview: 2, keptDeletions: 1 })
    h.c.pause(true); h.calls.length = 0; syncSaveHold.set(true)
    expect(await h.c.retryApply()).toBe('applied-pending'); expect(h.calls).toEqual([])
    expect(h.c.state).toMatchObject({ pendingReview: 1, keptDeletions: 1, paused: true, running: false })
    h.c.stop()
})


test('a queued lifecycle cycle does not erase the completed manual partial-apply counts before the UI reads them', async () => {
    const h = harness(); await h.c.start(); h.setPending(1)
    let statuses = 0
    h.io.status.mockImplementation(async (signal?: AbortSignal) => {
        if (++statuses > 1) await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason)))
        return STATUS()
    })
    h.io.apply.mockImplementationOnce(async () => {
        h.c.chatOpened()
        return { state: 'applied-pending', pending: [{}, {}], keptDeletions: [{ kind: 'chat', id: 'kept' }] } as any
    })
    expect(await h.c.downloadNow()).toBe('applied-pending')
    expect(h.c.state).toMatchObject({ pendingReview: 2, keptDeletions: 1 })
    h.c.stop(); await flush()
})


test('a receive-only manual download never snapshots if generation ends while status is awaited', async () => {
    const h = harness(); await h.c.start(); h.calls.length = 0; h.setPending(1); f.activity.mockReturnValue(true)
    h.io.status.mockImplementation(async () => { h.calls.push('status'); f.activity.mockReturnValue(false); return STATUS() })
    expect(await h.c.downloadNow()).toBe('pulled')
    expect(h.calls).toEqual(['status', 'pull', 'preview'])
    h.c.stop()
})

test('recovery completion restarts the automatic timer consumed during a slow explicit retry', async () => {
    const retryApply = vi.fn(async () => { await new Promise(r => setTimeout(r, 6_000)); return { state: 'applied' as const } })
    const h = harness({ retryApply }); await h.c.start(); h.calls.length = 0
    const retry = h.c.retryApply()
    await vi.advanceTimersByTimeAsync(6_000); expect(await retry).toBe('applied')
    expect(h.calls).toEqual([])
    await vi.advanceTimersByTimeAsync(5_000); await flush()
    expect(h.calls).toEqual(['status', 'snapshot', 'publish', 'pull', 'preview'])
    h.c.stop()
})

test('2026-11-07 join adoption: an upload the server withheld (adopting joining device) is reported as adoption, never as uploaded', async () => {
    const adopting = () => ({ enabled: true, role: 'joining', adopting: true, vault: { origin: 'shared', missing: false } })
    const h = harness({ status: vi.fn(async () => adopting()) }); await h.c.start(); h.calls.length = 0
    h.io.snapshot.mockImplementation(async () => ({ committed: null, adopting: true })); h.io.publish.mockImplementation(async () => ({ stored: [], failed: [], adopting: true }))
    expect(await h.c.uploadNow()).toBe('adopting')
    h.c.stop()
})

// ── 0.9.96-ver10: automatic sync cadence = 5 answers or 1 hour, whichever comes first (user 2026-11-18, choice c: 「답 생성 5번(리롤 포함)」) ──
// An answer = a sendChat that registers its generation. Like the real sendChat, each helper send awaits preSendSync(signal) and then
// registers the generation in that continuation; an auto-continue / internal resend restarts sendChat with the SAME signal (whatever
// the chat looks like by then, however long it waited); every new send (composer, reroll, command, plugin sendChat('')) has a new one.
const CADENCE = { chats: 5, intervalMs: 60 * 60_000, applyRetryMs: 5 * 60_000 }
function cadenced(options: { stored?: any; overrides?: any } = {}) {
    let saved: any = options.stored ?? null, editing = false, preview = false
    const generations = writable(new Map<string, unknown>())
    const store = { load: vi.fn(() => saved), save: vi.fn((tally: any) => { saved = JSON.parse(JSON.stringify(tally)) }) }
    const h = harness({ cadence: CADENCE, cadenceStore: store, generations, editing: () => editing, previewing: () => preview, ...options.overrides })
    /** sendChat: await preSendSync(signal) → startGeneration(chat) … endGeneration(chat). */
    const generate = async (chat = 'A', signal: AbortSignal = new AbortController().signal) => {
        expect(await preSendSync(signal, h.c)).toBe(true)
        generations.set(new Map([[chat, { kind: 'live' }]])); await flush(); generations.set(new Map()); await flush()
    }
    return {
        ...h, store, generations, generate, saved: () => saved,
        /** Any new send: composer send, reroll, manual continue, command/multisend line, plugin sendChat (also ''). */
        send: (chat = 'A') => generate(chat),
        /** One answer whose sendChat restarts `restarts` times with its signal (auto-continue / internal resend), after `waitMs` each. */
        sendWithRestarts: async (chat = 'A', restarts = 2, waitMs = 0) => { const signal = new AbortController().signal; await generate(chat, signal); for (let i = 0; i < restarts; i++) { vi.setSystemTime(Date.now() + waitMs); await generate(chat, signal) } },
        /** A send admitted by preSendSync but refused before it registers (the chat is already generating, a transfer started). */
        refused: async () => { expect(await preSendSync(new AbortController().signal, h.c)).toBe(true) },
        /** jobRecovery reattaching a server job after a restart: a background registration, no sendChat. */
        reattach: async (chat = 'C') => { generations.set(new Map([[chat, { kind: 'background' }]])); await flush(); generations.set(new Map()); await flush() },
        setEditing: (value: boolean) => { editing = value }, setPreview: (value: boolean) => { preview = value },
    }
}
const settle = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); await flush() }
const lifecycleEvents = async () => {
    document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online'))
    window.dispatchEvent(new CustomEvent('risubard-chat-opened')); f.selected.set(Number(get(f.selected)) + 1); await flush()
}
const CYCLE = ['status', 'snapshot', 'publish', 'pull', 'preview']

test('0.9.96-ver10 cadence: four answers (with their saves, foreground, focus, reconnect, chat open, character switch) start nothing; the fifth answer starts one cycle', async () => {
    const h = cadenced(); await h.c.start(); await settle(1_000)
    expect(h.calls).toContain('snapshot') // app start is kept and counts as the last cycle
    h.calls.length = 0
    expect(h.c.cadenceState()).toMatchObject({ chats: 0, due: false })
    for (let i = 1; i <= 4; i++) {
        await h.send()
        canonicalSaveSettled.set(Date.now()); await settle(40_000) // the old cadence: a cycle 5 s after every save and every 30 s
        await lifecycleEvents()
        expect(h.c.cadenceState().chats).toBe(i)
    }
    await settle(10 * 60_000)
    expect(h.calls).toEqual([])
    expect(h.saved()).toMatchObject({ chats: 4 }) // persisted on every count
    await h.send(); canonicalSaveSettled.set(Date.now())
    await settle(5_000)
    expect(h.calls).toEqual(CYCLE)
    expect(h.c.cadenceState()).toMatchObject({ chats: 0, due: false }); expect(h.saved()).toMatchObject({ chats: 0, lastAt: Date.now() })
    h.calls.length = 0; await settle(30_000); await lifecycleEvents(); expect(h.calls).toEqual([]) // counting starts again
    h.c.stop()
})

test('0.9.96-ver10 cadence: with no chats, one cycle an hour after the last one (and the poll is never 30 s)', async () => {
    const h = cadenced(); await h.c.start(); await settle(1_000); h.calls.length = 0
    expect(h.c.state.nextAt).toBe(Date.now() + CADENCE.intervalMs) // the routine timer: an hour after the start cycle began
    await settle(CADENCE.intervalMs - 2_000); expect(h.calls).toEqual([])
    await settle(2_000); expect(h.calls).toEqual(CYCLE)
    h.calls.length = 0; await settle(CADENCE.intervalMs - 1_000); expect(h.calls).toEqual([])
    await settle(1_000); expect(h.calls).toEqual(CYCLE)
    h.c.stop()
})

test('0.9.96-ver10 cadence: whichever comes first — three chats then the hour starts it, and the chat count restarts from zero', async () => {
    const h = cadenced(); await h.c.start(); await settle(1_000); h.calls.length = 0
    for (let i = 0; i < 3; i++) await h.send()
    await settle(CADENCE.intervalMs); expect(h.calls).toEqual(CYCLE)
    expect(h.c.cadenceState().chats).toBe(0); h.calls.length = 0
    for (let i = 0; i < 4; i++) await h.send()
    await settle(60_000); expect(h.calls).toEqual([])
    await h.send(); await settle(5_000); expect(h.calls).toEqual(CYCLE)
    h.c.stop()
})

test('0.9.96-ver10 cadence (c): every answer counts — new message, reroll, resend, manual continue, command lines, plugin sendChat, another chat, back to back; auto-continue / internal resend restarts are the same answer however long they waited; a preview, a refused send or a reattached job is not', async () => {
    const h = cadenced(); await h.c.start(); await settle(1_000); h.calls.length = 0
    await h.send('A'); await h.send('A'); await h.send('A') // a message, its reroll right away, a manual continue
    expect(h.c.cadenceState().chats).toBe(3)
    await h.sendWithRestarts('B', 2, 30_000) // one answer (assistant, plugin, or a trigger cutting and resending) restarted twice after 30 s waits
    expect(h.c.cadenceState().chats).toBe(4)
    h.setPreview(true); await h.send('A'); h.setPreview(false) // DevTool / hotkey prompt preview (alertWait open)
    await h.refused(); await h.reattach('C')
    expect(h.c.cadenceState().chats).toBe(4)
    await settle(60_000); expect(h.calls).toEqual([])
    await h.send('P'); expect(h.c.cadenceState().chats).toBe(5) // e.g. plugin sendChat('') on a chat ending with the character's answer
    await settle(5_000); expect(h.calls).toEqual(CYCLE)
    h.calls.length = 0
    for (let i = 0; i < 4; i++) await h.send('M') // /multisend lines back to back
    expect(h.c.cadenceState().chats).toBe(4)
    h.c.stop()
})

test('0.9.96-ver10 cadence (c): with the real generation registry and preSendSync — sendChat-shaped sequences, refused sends next to other chats in the same task', async () => {
    const { registerAbort, startGeneration, endGeneration } = await import('./process/generationState')
    let saved: any = null
    const h = harness({ cadence: CADENCE, cadenceStore: { load: () => saved, save: (t: any) => { saved = t } }, previewing: () => false })
    await h.c.start(); await settle(1_000)
    const send = async (chat: string, signal: AbortSignal, id: string) => { if (await preSendSync(signal, h.c)) startGeneration(chat, id); await flush() }
    const composer = new AbortController(); registerAbort('chat-x', composer)
    await send('chat-x', composer.signal, 'g1'); endGeneration('chat-x', { keepPendingAbort: true }); await flush() // auto-continue …
    await send('chat-x', composer.signal, 'g2'); endGeneration('chat-x', { keepPendingAbort: true }); await flush() // … and a trigger resend
    await send('chat-x', composer.signal, 'g3'); endGeneration('chat-x'); await flush()
    expect(h.c.cadenceState().chats).toBe(1)
    const plugin = new AbortController().signal // sendChat's own signal when the caller passes none
    await send('chat-x', plugin, 'g4'); endGeneration('chat-x', { keepPendingAbort: true }); await flush()
    await send('chat-x', plugin, 'g5'); endGeneration('chat-x'); await flush()
    expect(h.c.cadenceState().chats).toBe(2)
    // A send refused by the per-chat guard, then — in the same task, no timer in between — another chat's send and its restart.
    const busy = new AbortController().signal, b = new AbortController().signal
    await send('chat-y', busy, 'g6') // chat-y generating (counted: 3)
    if (await preSendSync(new AbortController().signal, h.c)) { /* the guard: chat-y is generating → return false, nothing registered */ }
    await send('chat-b', b, 'g7'); endGeneration('chat-b', { keepPendingAbort: true }); await flush() // chat-b: a new answer (4) …
    await vi.advanceTimersByTimeAsync(5_000)
    await send('chat-b', b, 'g8'); endGeneration('chat-b'); await flush() // … and its auto-continue: the same answer
    expect(h.c.cadenceState().chats).toBe(4)
    // The reverse: a counted answer's signal refused (a restart that found the chat busy), then a new send still counts.
    if (await preSendSync(b, h.c)) { /* refused */ }
    await send('chat-c', new AbortController().signal, 'g9'); endGeneration('chat-c'); await flush()
    expect(h.c.cadenceState().chats).toBe(5)
    endGeneration('chat-y'); await flush()
    startGeneration('chat-q', 'g10'); await flush(); endGeneration('chat-q'); await flush() // a registration with no send admitted before it
    expect(h.c.cadenceState().chats).toBe(5)
    h.c.stop()
})

test('0.9.96-ver10 cadence: a restart keeps the device tally — the count and the hour carry over until a cycle runs; a missing/garbage/future record counts from now', async () => {
    let visible = false
    const four = cadenced({ stored: { chats: 4, lastAt: Date.now() - 10 * 60_000 }, overrides: { visible: () => visible } })
    await four.c.start(); await settle(1_000)
    expect(four.c.state.lastOutcome).toBe('hidden'); expect(four.calls).toEqual(['status']) // only the start probe; the hidden start cycle did no work
    expect(four.c.cadenceState()).toMatchObject({ chats: 4, due: false })
    await four.send(); expect(four.c.cadenceState()).toMatchObject({ chats: 5, due: true }) // counted across the restart
    visible = true; four.calls.length = 0
    document.dispatchEvent(new Event('visibilitychange')); await flush()
    expect(four.calls).toEqual(CYCLE); expect(four.c.cadenceState().chats).toBe(0)
    four.c.stop()

    visible = false
    const stale = cadenced({ stored: { chats: 0, lastAt: Date.now() - 2 * CADENCE.intervalMs }, overrides: { visible: () => visible } })
    await stale.c.start(); await settle(1_000); stale.calls.length = 0
    expect(stale.c.cadenceState().due).toBe(true) // the hour passed while the app was closed
    visible = true; document.dispatchEvent(new Event('visibilitychange')); await flush()
    expect(stale.calls).toEqual(CYCLE)
    stale.c.stop()

    for (const stored of [null, { chats: 'x', lastAt: Date.now() + 86_400_000 }]) {
        const fresh = cadenced({ stored, overrides: { visible: () => false } })
        expect(fresh.c.cadenceState()).toEqual({ chats: 0, lastAt: Date.now(), due: false })
    }
})

test('0.9.96-ver10 cadence: a retry that came due while the app was hidden runs when it comes back, before the hour', async () => {
    let visible = true
    const g = cadenced({ overrides: { visible: () => visible } }); await g.c.start(); await settle(1_000); g.calls.length = 0
    g.io.publish.mockRejectedValueOnce(new Error('server error'))
    await g.send(); await g.send(); await g.send(); await g.send(); await g.send(); await settle(5_000)
    expect(g.c.state.lastOutcome).toBe('error'); expect(g.c.state.failures).toBe(1) // backoff 5 s
    visible = false; await settle(5_000); expect(g.c.state.lastOutcome).toBe('hidden')
    g.calls.length = 0; await settle(10 * 60_000); expect(g.calls).toEqual([]) // nothing while hidden
    visible = true; document.dispatchEvent(new Event('visibilitychange')); await flush()
    expect(g.calls).toEqual(CYCLE); expect(g.c.state.failures).toBe(0)
    g.c.stop()
})

test('0.9.96-ver10 cadence: chats counted while a cycle runs make the next one start right after it, not an hour later', async () => {
    const h = cadenced(); await h.c.start(); await settle(1_000); h.calls.length = 0
    let releasePull: () => void
    h.io.pull.mockImplementationOnce(async () => { h.calls.push('pull'); await new Promise<void>(r => { releasePull = r }); return { admitted: [] } })
    expect(h.c.retryNow()).toBeInstanceOf(Promise); await flush()
    expect(h.c.state.running).toBe(true)
    for (let i = 0; i < 5; i++) await h.send()
    releasePull!(); await flush(); h.calls.length = 0
    await settle(5_000); expect(h.calls).toEqual(CYCLE)
    h.c.stop()
})

test('0.9.96-ver10 cadence: a manual sync runs at once whatever the count, and the count restarts from it', async () => {
    const h = cadenced(); await h.c.start(); await settle(1_000); h.calls.length = 0
    await h.send(); await h.send(); await settle(60_000)
    expect(await h.c.retryNow()).toBe('empty'); expect(h.c.cadenceState()).toMatchObject({ chats: 0, lastAt: Date.now() })
    expect(await h.c.uploadNow()).toBe('uploaded')
    expect(h.calls.filter(x => x === 'snapshot')).toHaveLength(2)
    h.c.stop()
})

test('0.9.96-ver10: while a fullscreen plugin window (Asset Maid) is open no automatic cycle starts; it runs once the window closes', async () => {
    const h = cadenced(); await h.c.start(); await settle(1_000); h.calls.length = 0
    h.setEditing(true)
    for (let i = 0; i < 5; i++) await h.send()
    canonicalSaveSettled.set(Date.now()); await settle(5 * 60_000); await lifecycleEvents(); await settle(61 * 60_000)
    expect(h.calls).toEqual([]); expect(h.c.state.lastOutcome).toBe('deferred')
    expect(h.c.cadenceState()).toMatchObject({ chats: 5, due: true }) // still owed
    h.setEditing(false); await settle(30_000)
    expect(h.calls).toEqual(CYCLE)
    expect(h.c.cadenceState().chats).toBe(0)
    h.c.stop()
})

test('0.9.96-ver10: a fullscreen plugin window opened during a cycle keeps received work from being applied (its frame hides the user\'s interaction)', async () => {
    const h = cadenced(); await h.c.start(); await settle(1_000); h.calls.length = 0; h.setPending(1)
    for (let i = 0; i < 5; i++) await h.send()
    h.io.pendingRoots.mockImplementationOnce(async () => { h.calls.push('preview'); h.setEditing(true); return { roots: [{ domain: 'play', type: 'chat', root: 'r0' }], plan: null } })
    window.dispatchEvent(new CustomEvent('risubard-chat-opened')); await flush() // due: the reopen window cycle
    expect(h.calls).toEqual(CYCLE); expect(h.io.apply).not.toHaveBeenCalled()
    expect(h.c.state.lastOutcome).toBe('pulled')
    h.setEditing(false); h.calls.length = 0
    let seen = false // the plan guard sees it too (window opened after the apply started)
    h.io.apply.mockImplementationOnce(async (_auto: boolean, _signal?: AbortSignal, guard?: any) => { h.calls.push('apply'); h.setEditing(true); seen = guard.interacted(); return { state: 'deferred', deferred: ['activity'] } })
    expect(await h.c.downloadNow()).toBe('deferred'); expect(seen).toBe(true)
    h.c.stop()
})

test('0.9.96-ver10 cadence: received work that waits for a window may use one lifecycle event per 5 minutes; events queued meanwhile do not add cycles', async () => {
    const h = cadenced(); await h.c.start(); await settle(1_000); h.calls.length = 0; h.setPending(1)
    for (let i = 0; i < 5; i++) await h.send()
    await settle(5_000) // windowless (chat count) cycle: received, waits
    expect(h.c.state.lastOutcome).toBe('pulled'); expect(h.io.apply).not.toHaveBeenCalled(); h.calls.length = 0
    window.dispatchEvent(new CustomEvent('risubard-chat-opened')); await flush(); expect(h.calls).toEqual([]) // within 5 minutes
    await settle(CADENCE.applyRetryMs)
    let releaseStatus: () => void
    h.io.status.mockImplementationOnce(async () => { h.calls.push('status'); await new Promise<void>(r => { releaseStatus = r }); return STATUS() })
    window.dispatchEvent(new CustomEvent('risubard-chat-opened')); await flush()
    window.dispatchEvent(new CustomEvent('risubard-chat-opened')); f.selected.set(9); await flush() // arrive while it runs
    h.setPending(0); h.io.pendingRoots.mockImplementationOnce(async () => { h.calls.push('preview'); return { roots: [{ domain: 'play', type: 'chat', root: 'r0' }], plan: null } })
    releaseStatus!(); await flush(); await settle(1_000)
    expect(h.calls).toEqual([...CYCLE, 'apply']); expect(h.guards.at(-1).window).toBe('reopen')
    h.calls.length = 0; await settle(CADENCE.applyRetryMs)
    window.dispatchEvent(new CustomEvent('risubard-chat-opened')); await flush(); expect(h.calls).toEqual([]) // applied: nothing waits any more
    h.c.stop()
})

test('0.9.96-ver10 cadence: a reconnect after a failed cycle still retries at once', async () => {
    const h = cadenced(); await h.c.start(); await settle(1_000); h.calls.length = 0
    h.io.publish.mockRejectedValueOnce(new Error('Failed to fetch'))
    expect(await h.c.retryNow()).toBe('offline'); h.calls.length = 0
    window.dispatchEvent(new Event('online')); await flush()
    expect(h.calls).toEqual(CYCLE)
    h.c.stop()
})

test('0.9.96-ver10: a fullscreen plugin container is recognised from the DOM the API v3 showContainer/hideContainer leave', () => {
    const frame = document.createElement('iframe'); document.body.appendChild(frame)
    try {
        expect(pluginWindowOpen()).toBe(false) // a plugin frame that was never shown
        frame.style.setProperty('display', 'block', 'important'); frame.style.position = 'fixed' // showContainer('fullscreen')
        expect(pluginWindowOpen()).toBe(true)
        frame.style.zIndex = '30'; expect(pluginWindowOpen()).toBe(true) // behind an app dialog it is still open
        frame.style.setProperty('display', 'none', 'important') // hideContainer()
        expect(pluginWindowOpen()).toBe(false)
    } finally { frame.remove() }
})

test('0.9.96-ver10: the app coordinator (singleton) uses the 5-chat / 1-hour cadence; createSyncCoordinator() alone keeps the old one', () => {
    expect(DEFAULT_CADENCE).toEqual({ chats: 5, intervalMs: 3_600_000, applyRetryMs: 300_000 })
    expect(syncCoordinator().cadence).toBe(DEFAULT_CADENCE)
    expect(createSyncCoordinator({ supported: () => false }).cadence).toBeNull()
})
