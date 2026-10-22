import { afterEach, expect, it, vi } from 'vitest'

const { createQueuedSaveDebounce } = require('./queued-save-debounce.cjs')
afterEach(() => vi.useRealTimers())

it('captures scope only inside the writer queue and ignores a timer already flushed', async () => {
    vi.useFakeTimers()
    const timers: Record<string, any> = {}
    const queued: (() => Promise<void>)[] = []
    const queue = (operation: () => Promise<void>) => { queued.push(operation); return Promise.resolve() }
    const write = vi.fn()
    const schedule = createQueuedSaveDebounce({ timers, queue, delay: 5, onError: vi.fn() })
    schedule('db', write)
    await vi.advanceTimersByTimeAsync(5)
    expect(write).not.toHaveBeenCalled()
    delete timers.db // a queued read/flush drained the pending save first
    await queued.shift()!()
    expect(write).not.toHaveBeenCalled()
    schedule('db', write)
    await vi.advanceTimersByTimeAsync(5)
    await queued.shift()!()
    expect(write).toHaveBeenCalledTimes(1)
    expect(timers.db).toBeUndefined()
})

it('does not run superseded callbacks or delete their replacement timer', async () => {
    vi.useFakeTimers()
    const timers: Record<string, any> = {}
    const queued: (() => Promise<void>)[] = []
    const queue = (operation: () => Promise<void>) => { queued.push(operation); return Promise.resolve() }
    const first = vi.fn()
    const second = vi.fn()
    const schedule = createQueuedSaveDebounce({ timers, queue, delay: 5, onError: vi.fn() })
    schedule('db', first)
    await vi.advanceTimersByTimeAsync(5)
    schedule('db', second)
    const replacement = timers.db
    await queued.shift()!()
    expect(first).not.toHaveBeenCalled()
    expect(timers.db).toBe(replacement)
    await vi.advanceTimersByTimeAsync(5)
    await queued.shift()!()
    expect(second).toHaveBeenCalledOnce()
})

function gateError(code: string, status = 423) { const error: any = new Error('gate'); error.status = status; error.code = code; return error }
/** The real writer queue checks the write gate before running the operation; a refusal rejects without ever calling it. */
function gatedQueue(state: { closed: any }) {
    return (operation: () => Promise<void>) => state.closed ? Promise.reject(state.closed) : operation()
}

it('a 423 NAS_SYNC_BUSY / TRANSFER_BUSY refusal before persist starts reschedules the save (no onError), and the save persists once the gate opens', async () => {
    for (const code of ['NAS_SYNC_BUSY', 'TRANSFER_BUSY']) {
        vi.useFakeTimers()
        const timers: Record<string, any> = {}, state = { closed: gateError(code) as any }
        const write = vi.fn(), onError = vi.fn(), onDeferred = vi.fn()
        const schedule = createQueuedSaveDebounce({ timers, queue: gatedQueue(state), delay: 5, onError, onDeferred })
        schedule('db', write)
        const first = timers.db
        await vi.advanceTimersByTimeAsync(5) // refused by the gate
        expect(write).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled()
        expect(onDeferred).toHaveBeenCalledWith(state.closed, 1)
        expect(timers.db).toBeDefined(); expect(timers.db).not.toBe(first) // still pending: a flush sees the dirty save
        await vi.advanceTimersByTimeAsync(5) // still closed → second deferral, counted
        expect(onDeferred).toHaveBeenLastCalledWith(state.closed, 2); expect(onError).not.toHaveBeenCalled()
        state.closed = null
        await vi.advanceTimersByTimeAsync(5)
        expect(write).toHaveBeenCalledTimes(1); expect(timers.db).toBeUndefined(); expect(onError).not.toHaveBeenCalled()
        vi.useRealTimers()
    }
})

it('any other refusal (423 with another code, or a non-423 error) before persist starts is a failure: onError, no retry, timer left for the flush', async () => {
    for (const closed of [gateError('OTHER_LOCK'), gateError('NAS_SYNC_BUSY', 500), Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' })]) {
        vi.useFakeTimers()
        const timers: Record<string, any> = {}, state = { closed }
        const write = vi.fn(), onError = vi.fn(), onDeferred = vi.fn()
        const schedule = createQueuedSaveDebounce({ timers, queue: gatedQueue(state), delay: 5, onError, onDeferred })
        schedule('db', write)
        const first = timers.db
        await vi.advanceTimersByTimeAsync(5)
        expect(onError).toHaveBeenCalledWith(closed); expect(onDeferred).not.toHaveBeenCalled()
        expect(timers.db).toBe(first) // unchanged: the stale timer keeps the acknowledged dirty cache visible to the flush
        await vi.advanceTimersByTimeAsync(20)
        expect(write).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalledTimes(1) // no self-retry
        vi.useRealTimers()
    }
})

it('a genuine persist failure is never retried even when it carries a gate-shaped error: onError, timer released', async () => {
    vi.useFakeTimers()
    const timers: Record<string, any> = {}
    const io = Object.assign(new Error('EIO'), { code: 'EIO' }), disguised = gateError('NAS_SYNC_BUSY')
    const onError = vi.fn(), onDeferred = vi.fn()
    const schedule = createQueuedSaveDebounce({ timers, queue: gatedQueue({ closed: null }), delay: 5, onError, onDeferred })
    for (const failure of [io, disguised]) {
        const write = vi.fn(async () => { throw failure })
        schedule('db', write)
        await vi.advanceTimersByTimeAsync(5)
        expect(write).toHaveBeenCalledTimes(1); expect(onError).toHaveBeenLastCalledWith(failure); expect(timers.db).toBeUndefined()
        await vi.advanceTimersByTimeAsync(20)
        expect(write).toHaveBeenCalledTimes(1) // no retry of a persist that ran and failed
    }
    expect(onDeferred).not.toHaveBeenCalled(); expect(onError).toHaveBeenCalledTimes(2)
})

it('a gate refusal of a timer that a flush already drained or a newer schedule replaced neither retries nor warns', async () => {
    vi.useFakeTimers()
    // 1. drained by a flush while waiting for the writer: the gate still answers for the obsolete run
    let timers: Record<string, any> = {}
    const pending: (() => Promise<void>)[] = []
    const holdQueue = (_operation: () => Promise<void>) => new Promise<void>((resolve, reject) => { pending.push(() => Promise.reject(gateError('NAS_SYNC_BUSY')).then(resolve, reject)) })
    const write = vi.fn(), onError = vi.fn(), onDeferred = vi.fn()
    let schedule = createQueuedSaveDebounce({ timers, queue: holdQueue, delay: 5, onError, onDeferred })
    schedule('db', write)
    await vi.advanceTimersByTimeAsync(5)
    delete timers.db // flushPendingDbWithinQueue persisted the cache and removed the timer
    await pending.shift()!().catch(() => {}); await vi.advanceTimersByTimeAsync(0)
    expect(timers.db).toBeUndefined(); expect(onError).not.toHaveBeenCalled(); expect(onDeferred).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(20); expect(write).not.toHaveBeenCalled() // nothing rescheduled
    // 2. replaced by a newer schedule before the gate answered: the replacement stays, the obsolete refusal is dropped
    timers = {}
    const replacementWrite = vi.fn()
    const state = { closed: gateError('NAS_SYNC_BUSY') as any }
    const slowGate = (operation: () => Promise<void>) => new Promise<void>((resolve, reject) => { pending.push(() => (state.closed ? Promise.reject(state.closed) : operation()).then(resolve, reject)) })
    schedule = createQueuedSaveDebounce({ timers, queue: slowGate, delay: 5, onError, onDeferred })
    schedule('db', write)
    await vi.advanceTimersByTimeAsync(5) // first run is waiting for the writer
    schedule('db', replacementWrite)
    const replacement = timers.db
    await pending.shift()!().catch(() => {}); await vi.advanceTimersByTimeAsync(0) // gate refuses the obsolete run
    expect(timers.db).toBe(replacement); expect(onError).not.toHaveBeenCalled(); expect(onDeferred).not.toHaveBeenCalled()
    state.closed = null
    await vi.advanceTimersByTimeAsync(5); await pending.shift()!(); await vi.advanceTimersByTimeAsync(0)
    expect(replacementWrite).toHaveBeenCalledTimes(1); expect(write).not.toHaveBeenCalled(); expect(timers.db).toBeUndefined()
})
