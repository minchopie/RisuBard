import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { afterEach, expect, test, vi } from 'vitest'
import { get, writable } from 'svelte/store'

vi.mock('./database.svelte', () => ({}))
vi.mock('./chatStorage', () => ({ chatToStub: (c: any) => c }))
vi.mock('../globalApi.svelte', () => ({ forageStorage: { realStorage: null } }))
const { RisuSavePatcher } = await import('./risuSave')
const { applyPatch } = await import('fast-json-patch')

// Execute the production retry controller without mounting the entire app.
// Transport uses the real patcher, so its eagerly advanced baseline is retained
// after a network failure, exactly as it is in the running save loop.
const source = readFileSync(resolve(process.cwd(), 'src/ts/globalApi.svelte.ts'), 'utf8')
const start = source.indexOf('    async function triggerSave(')
const end = source.indexOf('    requestImmediateSaveImpl =', start)
const controller = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 })

afterEach(() => vi.unstubAllGlobals())

test.each(['preflight', 'chat-write'] as const)('retains edits and stops retrying after a %s handoff', async (failure) => {
    const create = new Function('get', 'syncSaveHold', 'canonicalSaveSettled', 'alertStore', `
        let saveInFlight = null, savetrys = 0, changed = false, forceFullWriteOnRetry = false, saveFailureNotified = false, gotChannel = false, untrackedSweepPending = false, lastImmediateSaveAt = 0;
        const supportsPatchSync = true, saving = {}, lastLiveError = '';
        const saveRuntime = { isActive: () => true }, language = { sessionSavePausedTitle: 'Saving paused' };
        const changeTracker = { chat: [['character', 'chat']] };
        let requests = 0;
        const hasTrackedChanges = value => value.chat.length > 0;
        const takeTrackedChanges = () => { const result = {chat: [...changeTracker.chat]}; changeTracker.chat = []; return result; };
        const requeueTrackedChanges = value => { changeTracker.chat.push(...value.chat); };
        const rejectSession = () => { gotChannel = true; throw Object.assign(new Error('inactive'), {code: 'LIVE_FILES_INACTIVE'}); };
        const syncLiveFilesNow = async () => { requests++; if (${JSON.stringify(failure)} === 'preflight') rejectSession(); };
        const persistTrackedChanges = async () => { requests++; rejectSession(); };
        const sleep = async () => {}, alertError = () => {};
        ${controller}
        return { trigger: triggerSave, pending: () => changeTracker.chat, requests: () => requests };
    `)
    const state = create(get, writable(false), writable(0), writable({ type: 'none' }))
    await state.trigger()
    expect(state.pending()).toEqual([['character', 'chat']])
    const requests = state.requests()
    await state.trigger()
    await state.trigger()
    expect(state.requests()).toBe(requests)
    await expect(state.trigger({rejectOnFailure: true})).rejects.toThrow('Saving paused')
    expect(state.pending()).toEqual([['character', 'chat']])
})

test.each([
    ['network', false], ['noop', false], ['network', true],
] as const)('retains preset edits after %s (full retry also fails: %s)', async (failure, failFullRetry) => {
    const initial = {
        characters: [], modules: [], botPresetsId: 0,
        botPresets: [{ id: 'original', name: 'Original', promptTemplate: [{ text: 'ooc response' }] }],
    }
    const edited = structuredClone(initial)
    edited.botPresets.unshift({ id: 'copy', name: 'test', promptTemplate: [{ text: 'ooc response!' }] })
    let server = structuredClone(initial)
    const patcher = new RisuSavePatcher()
    await patcher.init(server)
    let attempts = 0
    let fullAttempts = 0
    const modes: string[] = []
    const persist = async (toSave: any, options: any) => {
        if (options?.forceFullWrite) {
            modes.push('full')
            if (failFullRetry && ++fullAttempts === 1) throw new Error('full write also failed')
            server = structuredClone(edited)
            await patcher.init(server)
            return 'saved'
        }
        modes.push('patch')
        const result = await patcher.set(edited, toSave)
        if (++attempts === 1) {
            expect(result.patch.length).toBeGreaterThan(0)
            if (failure === 'network') throw new Error('connection lost before server accepted patch')
            return 'noop'
        }
        server = applyPatch(server, result.patch).newDocument
        return 'saved'
    }
    const create = new Function('get', 'syncSaveHold', 'canonicalSaveSettled', 'persistTrackedChanges', 'alertStore', `
        let saveInFlight = null, savetrys = 0, changed = false, forceFullWriteOnRetry = false, saveFailureNotified = false, gotChannel = false, untrackedSweepPending = false, lastImmediateSaveAt = 0;
        const supportsPatchSync = true;
        const saveRuntime = { isActive: () => true }, externalEditMode = { active: false }, saving = {};
        const flags = { character: [], chat: [], root: true, botPreset: true, modules: false, plugins: false, pluginCustomStorage: false };
        let dirty = true;
        const changeTracker = { get root() { return dirty }, get botPreset() { return dirty } };
        const syncLiveFilesNow = async () => {}, lastLiveError = '';
        const takeTrackedChanges = () => { const value = dirty ? {...flags} : {...flags, root: false, botPreset: false}; dirty = false; return value; };
        const hasTrackedChanges = value => value.root || value.botPreset;
        const requeueTrackedChanges = () => { dirty = true; };
        const sleep = async () => {}, alertError = () => {}, console = { error() {} };
        ${controller}
        return { trigger: triggerSave, markDirty: () => { dirty = true; } };
    `)
    const { trigger, markDirty } = create(get, writable(false), writable(0), persist, writable({ type: 'none' }))
    await trigger()
    expect(server).toEqual(initial)
    await trigger()
    if (failFullRetry) {
        expect(server).toEqual(initial)
        await trigger()
    }
    expect(server).toEqual(edited)
    expect(modes).toEqual(failFullRetry ? ['patch', 'full', 'full'] : ['patch', 'full'])
    // Successful recovery restores the ordinary patch lane for later edits.
    edited.botPresets[0].promptTemplate[0].text += ' next edit'
    markDirty()
    await trigger()
    expect(server).toEqual(edited)
    expect(modes.at(-1)).toBe('patch')
})

// NAS sync save hold, on the same production controller: an ordinary save is held with its edits still tracked, a save that
// queued behind an in-flight save before the hold does not resume with stale admission, the sync-owned save passes, and the
// held edits drain through the ordinary path once the hold lifts.
function holdFixture() {
    const hold = writable(false)
    let release: (() => void) | null = null
    const persisted: any[] = []
    const persist = vi.fn(async (toSave: any) => { persisted.push(toSave); await new Promise<void>(r => { release = r }); return 'saved' })
    const create = new Function('get', 'syncSaveHold', 'canonicalSaveSettled', 'persistTrackedChanges', 'alertStore', `
        let saveInFlight = null, savetrys = 0, changed = false, forceFullWriteOnRetry = false, saveFailureNotified = false, gotChannel = false, untrackedSweepPending = false, lastImmediateSaveAt = 0;
        const supportsPatchSync = false, saving = {}, lastLiveError = '';
        let channel = null; // no broadcast channel in the harness
        const saveRuntime = { isActive: () => true }, language = { sessionSavePausedTitle: 'Saving paused' };
        const changeTracker = { chat: [] };
        const hasTrackedChanges = value => value.chat.length > 0;
        const takeTrackedChanges = () => { const result = { chat: [...changeTracker.chat] }; changeTracker.chat = []; return result; };
        const requeueTrackedChanges = value => { changeTracker.chat.push(...value.chat); };
        const syncLiveFilesNow = async () => {};
        const sleep = async () => {}, alertError = () => {};
        ${controller}
        return { trigger: triggerSave, changeTracker };
    `)
    const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
    const settled = writable(0)
    return { hold, persist, persisted, settle, settled, release: () => { const r = release; release = null; r?.() }, ...create(get, hold, settled, persist, writable({ type: 'none' })) }
}

test('NAS sync hold: held saves keep their edits tracked, a save queued before the hold does not resume, the sync-owned save passes, the queue drains after release', async () => {
    const f = holdFixture()
    f.changeTracker.chat.push(['character', 'first'])
    const first = f.trigger(); await f.settle(); expect(f.persisted).toHaveLength(1)
    f.changeTracker.chat.push(['character', 'second'])
    const queued = f.trigger(); await f.settle() // admitted before the hold, now waiting behind the in-flight save
    f.hold.set(true)
    f.release(); await first; await queued
    expect(get(f.settled)).toBeGreaterThan(0) // the real success path announced the settled ordinary save (NAS sync trigger)
    f.settled.set(0)
    expect(f.persisted).toHaveLength(1) // the queued save re-checked the hold after waiting and did not persist
    expect(f.changeTracker.chat).toEqual([['character', 'second']]) // still tracked: nothing dropped
    await f.trigger(); expect(f.persisted).toHaveLength(1) // held outright
    await expect(f.trigger({ rejectOnFailure: true })).resolves.toBeUndefined() // being held is not a failure
    const owned = f.trigger({ syncOwned: true }); await f.settle()
    expect(f.persisted).toHaveLength(2); expect(f.persisted[1].chat).toEqual([['character', 'second']]) // the sync apply's own save takes the tracked batch
    f.release(); await owned
    expect(get(f.settled)).toBe(0) // the sync-owned save is not a trigger: no echo cycle
    f.changeTracker.chat.push(['character', 'third'])
    await f.trigger(); expect(f.persisted).toHaveLength(2) // still held
    f.hold.set(false)
    const drained = f.trigger(); await f.settle(); expect(f.persisted).toHaveLength(3); expect(f.persisted[2].chat).toEqual([['character', 'third']])
    f.release(); await drained; expect(f.changeTracker.chat).toEqual([])
})

function outageFixture() {
    const sync = vi.fn(async () => {})
    const persist = vi.fn(async (_changes: any, _options: any) => 'saved')
    const flush = vi.fn(async () => {})
    const notify = vi.fn(), modal = vi.fn(), errors = vi.fn(), sleep = vi.fn(async (_delay: number) => {})
    const hold = writable(false)
    const alerts = writable({ type: 'none' })
    const create = new Function('get', 'syncSaveHold', 'canonicalSaveSettled', 'syncLiveFilesNow', 'persistTrackedChanges', 'flushServerDbNow', 'notifyError', 'alertError', 'sleep', 'alertStore', 'logError', `
        let saveInFlight = null, savetrys = 0, changed = true, forceFullWriteOnRetry = false, saveFailureNotified = false, gotChannel = false, untrackedSweepPending = false, lastImmediateSaveAt = 0;
        const supportsPatchSync = true, saving = {}, lastLiveError = '';
        const saveRuntime = { isActive: () => true }, language = { sessionSavePausedTitle: 'Saving paused' };
        const changeTracker = { root: true };
        const hasTrackedChanges = value => value.root;
        const takeTrackedChanges = () => { const result = { root: changeTracker.root }; changeTracker.root = false; return result; };
        const requeueTrackedChanges = value => { changeTracker.root ||= value.root; };
        const console = { error: logError };
        ${controller}
        return {
            trigger: triggerSave,
            cycle: async () => { if (!changed || gotChannel || get(syncSaveHold)) return; changed = false; await triggerSave(); },
            edit: () => { changeTracker.root = true; changed = true; },
            state: () => ({ dirty: changeTracker.root, changed, forceFullWriteOnRetry, saveFailureNotified, savetrys }),
        };
    `)
    return { sync, persist, flush, notify, modal, sleep, hold, alerts, errors, ...create(get, hold, writable(0), sync, persist, flush, notify, modal, sleep, alerts, errors) }
}

test('a prolonged preflight disconnect retries without a new edit, notifies once, recovers, then permits a new outage notice', async () => {
    const f = outageFixture()
    const cause = new TypeError('Failed to fetch')
    const failure = Object.assign(new TypeError('앱 서버에 연결하지 못했습니다', { cause }), { code: 'APP_SERVER_FETCH' })
    f.sync.mockRejectedValue(failure)
    for (let i = 0; i < 12; i++) {
        await f.cycle()
        expect(f.state()).toMatchObject({ dirty: true, changed: true, forceFullWriteOnRetry: true })
    }
    expect(f.persist).not.toHaveBeenCalled()
    expect(f.modal).not.toHaveBeenCalled()
    expect(f.notify).toHaveBeenCalledOnce()
    expect(f.notify).toHaveBeenCalledWith('아직 저장하지 못했습니다. 편집 내용은 앱에 남아 있으며 자동으로 재시도합니다.', { source: 'save-retry' })
    expect(f.notify.mock.calls[0][1].description).toBeUndefined()
    expect(f.errors).toHaveBeenNthCalledWith(5, failure, cause)
    expect(f.errors).toHaveBeenCalledTimes(5)
    expect(f.sleep.mock.calls.map(call => call[0])).toEqual([500, 1000, 1500, 2000, 2500, 3000, 3000, 3000, 3000, 3000, 3000, 3000])
    f.sync.mockResolvedValue(undefined)
    await f.cycle()
    expect(f.persist).toHaveBeenCalledExactlyOnceWith({ root: true }, expect.objectContaining({ forceFullWrite: true }))
    expect(f.state()).toMatchObject({ dirty: false, saveFailureNotified: false, savetrys: 0, forceFullWriteOnRetry: false })
    f.edit()
    f.sync.mockRejectedValue(failure)
    for (let i = 0; i < 5; i++) await f.cycle()
    expect(f.notify).toHaveBeenCalledTimes(2)
    expect(f.modal).not.toHaveBeenCalled()
})

test('a non-transport preflight exception retains the existing full recovery policy and resumes without another edit', async () => {
    const f = outageFixture()
    f.sync.mockRejectedValue(new Error('snapshot application failed'))
    for (let i = 0; i < 7; i++) await f.cycle()
    expect(f.notify).toHaveBeenCalledOnce()
    expect(f.state()).toMatchObject({ dirty: true, changed: true, forceFullWriteOnRetry: true })
    f.sync.mockResolvedValue(undefined)
    await f.cycle()
    expect(f.persist).toHaveBeenCalledExactlyOnceWith({ root: true }, expect.objectContaining({ forceFullWrite: true }))
    expect(f.state().dirty).toBe(false)
})

test('an immediate preflight failure rejects unchanged and leaves the background retry scheduled', async () => {
    const f = outageFixture(), failure = new Error('connection lost')
    f.sync.mockRejectedValue(failure)
    await expect(f.trigger({ rejectOnFailure: true })).rejects.toBe(failure)
    expect(f.state()).toMatchObject({ dirty: true, changed: true, forceFullWriteOnRetry: true })
    expect(f.notify).not.toHaveBeenCalled()
    f.sync.mockResolvedValue(undefined)
    await f.cycle()
    expect(f.persist).toHaveBeenCalledOnce()
    expect(f.state().dirty).toBe(false)
})

test('a noop does not clear the outage notice or consume unsaved edits before a durable success', async () => {
    const f = outageFixture(), failure = new Error('write failed')
    f.persist.mockRejectedValue(failure)
    for (let i = 0; i < 5; i++) await f.cycle()
    expect(f.notify).toHaveBeenCalledOnce()
    f.persist.mockResolvedValueOnce('noop')
    await f.cycle()
    expect(f.state()).toMatchObject({ dirty: true, changed: true, saveFailureNotified: true })
    for (let i = 0; i < 5; i++) await f.cycle()
    expect(f.notify).toHaveBeenCalledOnce()
    f.persist.mockResolvedValue('saved')
    await f.cycle()
    expect(f.state()).toMatchObject({ dirty: false, saveFailureNotified: false })
})

test('Android flush failures keep both the batch and outage notice until the disk flush succeeds', async () => {
    vi.stubGlobal('navigator', { userAgent: 'RisuBardAndroid/test' })
    const f = outageFixture()
    f.flush.mockRejectedValue(new Error('disk full'))
    for (let i = 0; i < 7; i++) await f.cycle()
    expect(f.state()).toMatchObject({ dirty: true, changed: true, forceFullWriteOnRetry: true, saveFailureNotified: true })
    expect(f.notify).toHaveBeenCalledOnce()
    f.flush.mockResolvedValue(undefined)
    await f.cycle()
    expect(f.persist).toHaveBeenLastCalledWith({ root: true }, expect.objectContaining({ forceFullWrite: true }))
    expect(f.state()).toMatchObject({ dirty: false, saveFailureNotified: false, forceFullWriteOnRetry: false })
    expect(f.modal).not.toHaveBeenCalled()
})

test.each(['wait', 'wait2', 'progress'])('defers the save notice during %s without clearing progress or stopping retries', async type => {
    const f = outageFixture(), failure = new Error('write unavailable')
    f.alerts.set({ type })
    f.sync.mockRejectedValue(failure)
    for (let i = 0; i < 8; i++) await f.cycle()
    expect(f.state()).toMatchObject({ dirty: true, changed: true, saveFailureNotified: false })
    expect(f.sync).toHaveBeenCalledTimes(8)
    expect(f.notify).not.toHaveBeenCalled()
    expect(get(f.alerts)).toEqual({ type })
    f.alerts.set({ type: 'none' })
    await f.cycle()
    expect(f.notify).toHaveBeenCalledOnce()
    expect(f.errors).toHaveBeenLastCalledWith(failure)
    expect(f.state()).toMatchObject({ changed: true, saveFailureNotified: true })
    await f.cycle()
    expect(f.notify).toHaveBeenCalledOnce()
    expect(f.modal).not.toHaveBeenCalled()
})

test.each(['wait', 'wait2', 'progress'])('recovery during %s completes without a stale outage notice', async type => {
    const f = outageFixture()
    f.alerts.set({ type })
    f.sync.mockRejectedValue(new Error('write unavailable'))
    for (let i = 0; i < 7; i++) await f.cycle()
    f.sync.mockResolvedValue(undefined)
    await f.cycle()
    expect(f.state()).toMatchObject({ dirty: false, saveFailureNotified: false, forceFullWriteOnRetry: false })
    expect(f.notify).not.toHaveBeenCalled()
    expect(get(f.alerts)).toEqual({ type })
    f.alerts.set({ type: 'none' })
    await f.cycle()
    expect(f.notify).not.toHaveBeenCalled()
})
