// Coordinator lifecycle on fake timers with the REAL save-settled store and the real hold/busy stores. Non-interrupting contract:
// publish/pull in the background (even while generating), snapshot only when settled and not generating, apply ONLY in a safe window
// opened by a lifecycle event (startup / foreground / chat open / manual) whose interaction epoch is captured at the event and voided
// by any later pointer/keyboard/input; timer, save, send and reconnect cycles never apply. Received work waits durably and is applied
// when the chat is (re)opened — also when that event arrives while a cycle is running (kept with its own epoch, never renewed).
import { beforeEach, afterEach, test, expect, vi } from 'vitest'
import { get, writable } from 'svelte/store'
import { readFileSync } from 'node:fs'
const f = vi.hoisted(() => ({ unavailable: vi.fn(() => false), activity: vi.fn(() => false), alert: { type: 'none' }, chat: 'card/chat', selected: null as any }))
vi.mock('./transfer-sync/playTransfer', () => ({ transferUnavailable: () => f.unavailable() }))
vi.mock('./transfer-sync/nasSync', () => ({ activityBlocksSync: () => f.activity(), retrySyncApply: vi.fn(), applySync: vi.fn(), pullSync: vi.fn(), publishSync: vi.fn(), snapshotSync: vi.fn(), syncStatus: vi.fn(), reportSyncNetwork: vi.fn(async () => {}), pendingRootsSync: vi.fn(), releaseSyncPlan: vi.fn(), activeChatSignature: () => f.chat }))
vi.mock('./platform', () => ({ isNodeServer: true }))
vi.mock('./stores.svelte', () => { const selectedCharID = writable(0); f.selected = selectedCharID; return { alertStore: writable(f.alert), selectedCharID } })
import { createSyncCoordinator } from './nasSyncCoordinator'
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

test('generation in progress: publish and pull still run, the snapshot is skipped, nothing is applied even in a foreground window; the next settled save snapshots', async () => {
    const h = harness(); h.setPending(1)
    await h.c.start(); await vi.advanceTimersByTimeAsync(1_000); await flush(); h.calls.length = 0
    f.activity.mockReturnValue(true)
    canonicalSaveSettled.set(Date.now()); await vi.advanceTimersByTimeAsync(5_000); await flush()
    expect(h.calls).toEqual(['status', 'publish', 'pull', 'preview']); h.calls.length = 0 // no snapshot of a streaming state, no apply
    document.dispatchEvent(new Event('visibilitychange')); await flush()
    expect(h.calls).toEqual(['status', 'publish', 'pull', 'preview']); expect(h.c.state.lastOutcome).toBe('pulled'); expect(get(transferBusy)).toBe(false); h.calls.length = 0
    f.activity.mockReturnValue(false)
    canonicalSaveSettled.set(Date.now()); await vi.advanceTimersByTimeAsync(5_000); await flush()
    expect(h.calls).toEqual(['status', 'snapshot', 'publish', 'pull', 'preview']) // settled → snapshot; still no apply on a save cycle
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
