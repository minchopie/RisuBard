import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { afterEach, expect, test, vi } from 'vitest'
import { get, writable } from 'svelte/store'

afterEach(() => vi.unstubAllGlobals())

const source = readFileSync(resolve(process.cwd(), 'src/ts/globalApi.svelte.ts'), 'utf8')
const start = source.indexOf('    async function triggerSave(')
const end = source.indexOf('    let savetrys = 0', start)
const controller = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 })
const tracking = ts.transpile(source.slice(source.indexOf('    function hasTrackedChanges('), source.indexOf('    async function flushServerDbNow(')), { target: ts.ScriptTarget.ES2022 })
const requeue = ts.transpile(source.slice(source.indexOf('    function requeueTrackedChanges('), source.indexOf('    function collectChatsToPersist(')), { target: ts.ScriptTarget.ES2022 })
const collect = new Function('knownChatIdsByCharacter', ts.transpile(source.slice(source.indexOf('    function collectChatsToPersist('), source.indexOf('    function updateKnownChatsAfterSuccessfulSave(')), { target: ts.ScriptTarget.ES2022 }) + '\nreturn collectChatsToPersist;')

function fixture(dirty = true) {
    const sync = vi.fn(async () => {})
    const save = vi.fn(async (_changes: any) => 'saved')
    const flush = vi.fn(async () => {})
    const create = new Function('syncLiveFilesNow', 'persistTrackedChanges', 'flushServerDbNow', 'initialDirty', 'get', 'syncSaveHold', 'canonicalSaveSettled', `
        let saveInFlight = null, requestImmediateSaveImpl, savetrys = 0, changed = false, forceFullWriteOnRetry = false, gotChannel = false, untrackedSweepPending = false, lastImmediateSaveAt = 0;
        const supportsPatchSync = true, saving = {}, lastLiveError = '';
        const saveRuntime = { isActive: () => true }, language = { sessionSavePausedTitle: 'paused' };
        const changeTracker = { root: initialDirty, character: [], chat: [], botPreset: false, modules: false, plugins: false, pluginCustomStorage: false };
        const safeStructuredClone = structuredClone;
        ${tracking}
        ${requeue}
        const tick = async () => {}, refreshThisRuntime = syncLiveFilesNow;
        const sleep = async () => {}, alertError = () => {}, sessionHandoff = { show() {} };
        ${controller}
        return { request: requestImmediateSaveImpl, changeTracker };
    `)
    return { sync, save, flush, ...create(sync, save, flush, dirty, get, writable(false), writable(0)) }
}

test('a preset-only save does not retransmit the chat or character already saved', async () => {
    const f = fixture()
    f.changeTracker.character.push('bot')
    f.changeTracker.chat.push(['bot', 'chat'])
    await f.request({ flushServer: 'canonical', rejectOnFailure: true })
    f.changeTracker.root = true
    await f.request({ flushServer: 'canonical', rejectOnFailure: true })
    expect(f.save.mock.calls[0][0]).toMatchObject({ chat: [['bot', 'chat']], character: ['bot'] })
    expect(f.save.mock.calls[1][0]).toMatchObject({ root: true, chat: [], character: [] })
})

test('an import saves explicitly named off-screen characters through the existing dirty batch', async () => {
    const f = fixture(false)
    await f.request({ chats: [['incoming', 'new'], ['existing-off-screen', 'appended'], ['incoming', 'new']], flushServer: 'canonical', rejectOnFailure: true })
    expect(f.save).toHaveBeenCalledOnce()
    expect(f.save.mock.calls[0][0].character).toEqual(['incoming', 'existing-off-screen'])
    const db = { characters: [
        { chaId: 'incoming', chats: [{ id: 'new' }] },
        { chaId: 'existing-off-screen', chats: [{ id: 'old', _placeholder: true }, { id: 'appended' }] },
        { chaId: 'unrelated', chats: [{ id: 'keep' }] },
    ] }
    // A concurrent metadata save may already have made the incoming IDs known.
    expect(collect(new Map([['incoming', new Set(['new'])], ['existing-off-screen', new Set(['old', 'appended'])]]))(db, f.save.mock.calls[0][0]))
        .toEqual([['incoming', 'new'], ['existing-off-screen', 'appended']])
    expect(f.flush).toHaveBeenCalledWith(false, true, undefined)
})

test('edits made during a save remain dirty and a failed save requeues its batch', async () => {
    const f = fixture()
    f.changeTracker.chat.push(['bot', 'first'])
    f.save.mockImplementationOnce(async () => {
        f.changeTracker.chat.push(['bot', 'second'])
        throw new Error('write failed')
    })
    await expect(f.request({ rejectOnFailure: true })).rejects.toThrow('write failed')
    await f.request({ rejectOnFailure: true })
    expect(f.save.mock.calls[1][0].chat).toEqual(expect.arrayContaining([['bot', 'first'], ['bot', 'second']]))
    expect(f.changeTracker.chat).toEqual([])
})

test('immediate saves reconcile live files once before writing and then await a canonical flush', async () => {
    const f = fixture()
    await f.request({ flushServer: 'canonical', rejectOnFailure: true })
    expect(f.sync).toHaveBeenCalledOnce()
    expect(f.save).toHaveBeenCalledOnce()
    expect(f.flush).toHaveBeenCalledWith(false, true, undefined)
    expect(f.sync.mock.invocationCallOrder[0]).toBeLessThan(f.save.mock.invocationCallOrder[0])
    expect(f.save.mock.invocationCallOrder[0]).toBeLessThan(f.flush.mock.invocationCallOrder[0])
})

test('an immediate save still refreshes external files when there are no local changes', async () => {
    const f = fixture(false)
    await f.request({ rejectOnFailure: true })
    expect(f.sync).toHaveBeenCalledOnce()
    expect(f.save).not.toHaveBeenCalled()
})

test('failed preflight prevents a write and failed flush rejects the save', async () => {
    const f = fixture()
    f.sync.mockRejectedValueOnce(new Error('external conflict'))
    await expect(f.request({ flushServer: 'canonical', rejectOnFailure: true })).rejects.toThrow('external conflict')
    expect(f.save).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    f.flush.mockRejectedValueOnce(new Error('disk full'))
    await expect(f.request({ flushServer: 'canonical', rejectOnFailure: true })).rejects.toThrow('disk full')
})

test('embedded Android save waits for disk persistence and retries a failed flush without losing the batch', async () => {
    vi.stubGlobal('navigator', { userAgent: 'RisuBardAndroid/0.9.72' })
    const f = fixture()
    let finish!: () => void
    f.flush.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    let complete = false
    const pending = f.request({ rejectOnFailure: true }).then(() => { complete = true })
    await vi.waitFor(() => expect(f.flush).toHaveBeenCalledWith(false, true))
    expect(complete).toBe(false)
    finish(); await pending
    expect(complete).toBe(true)
    f.changeTracker.chat.push(['bot', 'new-chat'])
    f.flush.mockRejectedValueOnce(new Error('disk full'))
    await expect(f.request({ rejectOnFailure: true })).rejects.toThrow('disk full')
    expect(f.changeTracker.chat).toEqual([['bot', 'new-chat']])
    await f.request({ rejectOnFailure: true })
    expect(f.changeTracker.chat).toEqual([])
})

test('ordinary browser save keeps its existing deferred persistence contract', async () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0' })
    const f = fixture()
    await f.request({ rejectOnFailure: true })
    expect(f.flush).not.toHaveBeenCalled()
})

test('page hide flushes already uploaded data immediately and Android flushes once more after pending uploads', async () => {
    const begin = source.indexOf('        function flushImmediate()')
    const body = source.slice(begin, source.indexOf('        const handleVisibilityFlush', begin))
    for (const android of [false, true]) {
        vi.stubGlobal('navigator', { userAgent: android ? 'RisuBardAndroid/test' : 'Mozilla/5.0' })
        let finish!: () => void
        const pending = new Promise<void>(resolve => { finish = resolve })
        const flush = vi.fn(async () => {})
        const hide = new Function('triggerSave', 'flushServerDbKeepalive', `let changed = false, saveTimeout = null; ${body}; return flushImmediate;`)(() => pending, flush)
        hide()
        expect(flush).toHaveBeenCalledTimes(1)
        finish(); await pending; await Promise.resolve()
        expect(flush).toHaveBeenCalledTimes(android ? 2 : 1)
    }
})
