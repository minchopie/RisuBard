import { beforeEach, expect, test, vi } from 'vitest'
import { applyPatch } from 'fast-json-patch'

// All data and transports in this suite are synthetic. The production patcher,
// binary codec and chat-to-stub conversion run unchanged; no app runtime starts.
const f = vi.hoisted(() => ({
    db: null as any,
    server: null as any,
    order: [] as string[],
    realStorage: { syncTransaction: 'tx', transferTransaction: undefined as string | undefined, sessionId: 'existing-session' },
    read: vi.fn(), patch: vi.fn(), flush: vi.fn(), etag: vi.fn(), baseline: vi.fn(),
    hydrate: vi.fn(), chat: vi.fn(), validate: vi.fn(),
    dangerous: false,
}))

vi.mock('../globalApi.svelte', () => ({
    forageStorage: {
        realStorage: f.realStorage,
        getItemWithEtag: f.read,
        patchItem: f.patch,
        flushDatabase: f.flush,
        setDbEtag: f.etag,
    },
    setPatchSyncBaseline: f.baseline,
}))
vi.mock('./database.svelte', async () => ({
    getDatabase: () => f.db,
    isChatStub: (await import('./chatStub')).isChatStub,
}))
vi.mock('./chatStorage', async importOriginal => ({
    ...await importOriginal<typeof import('./chatStorage')>(),
    ensureChatHydrated: f.hydrate,
    saveChatToServer: f.chat,
}))
vi.mock('./risuSave', async importOriginal => {
    const actual = await importOriginal<typeof import('./risuSave')>()
    return {
        ...actual,
        findDangerousChatOps: (patch: any[]) => f.dangerous
            ? [{ op: 'remove', path: '/characters/0/chats/0/message', field: 'message' }]
            : actual.findDangerousChatOps(patch),
    }
})

import { RisuSavePatcher, encodeRisuSaveLegacy } from './risuSave'
import { chatToStub } from './chatStorage'
import { writePartialSyncResume } from './syncRecoveryWriter'

const copy = <T>(value: T): T => structuredClone(value)
const request = (characters = ['card'], chats: [string, string][] = []) => ({ transaction: 'tx', characters, chats })

function initial() {
    return {
        characters: [{ chaId: 'card', name: 'Synthetic card', chats: [] }],
        botPresets: [], modules: [], plugins: [], pluginCustomStorage: {},
        aiModel: 'existing-device-model', personaPrompt: 'synthetic local persona',
    }
}

async function hash(db: any) {
    const patcher = new RisuSavePatcher()
    await patcher.init(db)
    return patcher.hash()
}

function missingCardFields() {
    f.db.characters[0].bardLore = { version: 1, entries: [{ id: 'synthetic-entry', content: 'preserved synthetic lore' }] }
    f.db.characters[0].reloadKeys = 7
}

beforeEach(() => {
    vi.clearAllMocks()
    f.server = initial()
    f.db = copy(f.server)
    f.order = []
    f.realStorage.syncTransaction = 'tx'
    f.realStorage.transferTransaction = undefined
    f.realStorage.sessionId = 'existing-session'
    f.dangerous = false
    f.validate.mockImplementation(async () => { f.order.push('validate') })
    f.read.mockImplementation(async (key: string) => {
        f.order.push('read')
        expect(key).toBe('database/database.bin')
        return { value: encodeRisuSaveLegacy(copy(f.server)), etag: 'fresh-etag' }
    })
    f.patch.mockImplementation(async (key: string, input: any) => {
        f.order.push('patch')
        expect(key).toBe('database/database.bin')
        expect(f.realStorage.syncTransaction).toBe('tx')
        expect(input.expectedHash).toBe(await hash(f.server))
        f.server = applyPatch(copy(f.server), input.patch, true).newDocument
        return { success: true, etag: 'patched-etag' }
    })
    f.flush.mockImplementation(async (...args: any[]) => {
        f.order.push('flush')
        expect(args.slice(0, 2)).toEqual([false, true])
        expect(f.realStorage.syncTransaction).toBe('tx')
    })
    f.baseline.mockImplementation(() => { f.order.push('baseline') })
    f.hydrate.mockImplementation(async (chats: any[], index: number) => {
        f.order.push('hydrate')
        return chats[index]
    })
    f.chat.mockImplementation(async (characterId: string, index: number, chatId: string, chat: any) => {
        f.order.push('chat')
        expect(f.realStorage.syncTransaction).toBe('tx')
        expect(chatId).toBe(chat.id)
        f.server.characters.find((character: any) => character.chaId === characterId).chats[index] = chatToStub(chat)
    })
})

test('the actual patcher sends exactly the two absent card fields and establishes a matching next baseline', async () => {
    missingCardFields()
    await writePartialSyncResume(request(), f.validate)
    const input = f.patch.mock.calls[0][1]
    expect(input.patch).toHaveLength(2)
    expect(input.patch).toEqual(expect.arrayContaining([
        { op: 'add', path: '/characters/0/bardLore', value: f.db.characters[0].bardLore },
        { op: 'add', path: '/characters/0/reloadKeys', value: 7 },
    ]))
    expect(f.server).toEqual(f.db)
    expect(f.order).toEqual(['read', 'validate', 'patch', 'flush', 'baseline'])
    expect(f.etag).toHaveBeenCalledWith('patched-etag')
    expect(f.baseline).toHaveBeenCalledOnce()
    expect(await hash(f.baseline.mock.calls[0][0])).toBe(await hash(f.server))
    const next = new RisuSavePatcher()
    await next.init(f.baseline.mock.calls[0][0])
    const nextSave = await next.set(f.db, { root: true, botPreset: true, modules: true, plugins: true, pluginCustomStorage: true, character: ['card'], chat: [] })
    expect(nextSave.expectedHash).toBe(await hash(f.server))
    expect(nextSave.patch).toEqual([])
})

test('zero patch still waits for canonical disk flush before advancing the baseline', async () => {
    let release!: () => void
    f.flush.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
    const pending = writePartialSyncResume(request(), f.validate)
    await vi.waitFor(() => expect(f.flush).toHaveBeenCalledOnce())
    expect(f.patch).not.toHaveBeenCalled()
    expect(f.baseline).not.toHaveBeenCalled()
    release()
    await pending
    expect(f.baseline).toHaveBeenCalledOnce()
})

test('reads its raw baseline after saving explicit off-screen chat metadata, so expectedHash matches the server', async () => {
    const chat = { id: 'chat', name: 'Updated chat name', message: [{ role: 'user', data: 'synthetic message' }], scriptstate: { synthetic: 1 } }
    f.db.characters[0].chats = [copy(chat)]
    f.server.characters[0].chats = [{ id: 'chat', name: 'Old chat name', _stub: true }]
    missingCardFields()
    await writePartialSyncResume(request(['card'], [['card', 'chat']]), f.validate)
    expect(f.hydrate).toHaveBeenCalledWith(f.db.characters[0].chats, 0, 'card')
    expect(f.chat).toHaveBeenCalledWith('card', 0, 'chat', chat)
    expect(f.order).toEqual(['read', 'validate', 'hydrate', 'chat', 'read', 'validate', 'patch', 'flush', 'baseline'])
    expect(f.patch.mock.calls[0][1].patch.every((op: any) => !op.path.includes('/chats/'))).toBe(true)
})

test('marks settings, presets, modules, plugins and plugin storage for the existing patcher without sweeping an unrelated character', async () => {
    f.server.characters.push({ chaId: 'untouched', name: 'Unrelated existing card', chats: [] })
    f.db = copy(f.server)
    f.db.characters[1].name = 'Unrelated in-memory edit'
    missingCardFields()
    f.db.aiModel = 'synthetic-recovered-model'
    f.db.botPresets = [{ id: 'preset', name: 'Synthetic preset' }]
    f.db.modules = [{ id: 'module', name: 'Synthetic module' }]
    f.db.plugins = [{ name: 'Synthetic plugin', data: 'synthetic' }]
    f.db.pluginCustomStorage = { synthetic: { value: 1 } }
    await writePartialSyncResume(request(), f.validate)
    expect(f.server.aiModel).toBe(f.db.aiModel)
    expect(f.server.botPresets).toEqual(f.db.botPresets)
    expect(f.server.modules).toEqual(f.db.modules)
    expect(f.server.plugins).toEqual(f.db.plugins)
    expect(f.server.pluginCustomStorage).toEqual(f.db.pluginCustomStorage)
    expect(f.server.characters[1].name).toBe('Unrelated existing card')
})

test('retry after an applied patch and lost flush response reads a fresh baseline and flushes an empty patch', async () => {
    missingCardFields()
    f.flush.mockRejectedValueOnce(new TypeError('synthetic lost flush response'))
    await expect(writePartialSyncResume(request(), f.validate)).rejects.toMatchObject({ message: expect.stringContaining('lost flush'), persisted: true })
    expect(f.server).toEqual(f.db)
    expect(f.baseline).not.toHaveBeenCalled()
    await writePartialSyncResume(request(), f.validate)
    expect(f.read).toHaveBeenCalledTimes(2)
    expect(f.validate).toHaveBeenCalledTimes(2)
    expect(f.patch).toHaveBeenCalledOnce()
    expect(f.flush).toHaveBeenCalledTimes(2)
    expect(f.baseline).toHaveBeenCalledOnce()
    expect(await hash(f.baseline.mock.calls[0][0])).toBe(await hash(f.server))
})

test('retry after a lost applied patch response also reloads the current server baseline', async () => {
    missingCardFields()
    f.patch.mockImplementationOnce(async (_key: string, input: any) => {
        f.server = applyPatch(copy(f.server), input.patch, true).newDocument
        throw new TypeError('synthetic lost patch response')
    })
    await expect(writePartialSyncResume(request(), f.validate)).rejects.toMatchObject({ message: expect.stringContaining('lost patch'), persisted: true })
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.baseline).not.toHaveBeenCalled()
    await writePartialSyncResume(request(), f.validate)
    expect(f.patch).toHaveBeenCalledOnce()
    expect(f.flush).toHaveBeenCalledOnce()
    expect(f.baseline).toHaveBeenCalledOnce()
})

test.each([
    { success: false },
    { success: true, chatGuardRejected: true },
    { success: true, externalEditMode: true },
    { success: true, externalChangesPending: true },
    { success: true, canonicalFilesChanged: true },
])('a refused or conflicting patch never flushes or advances the baseline: %j', async response => {
    missingCardFields()
    f.patch.mockResolvedValueOnce(response)
    const before = copy(f.db)
    await expect(writePartialSyncResume(request(), f.validate)).rejects.toMatchObject({ persisted: true })
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.baseline).not.toHaveBeenCalled()
    expect(f.db).toEqual(before)
    expect(f.realStorage.syncTransaction).toBe('tx')
})

test.each([401, 423])('session/auth failure %i stays a failure without acquiring a new session', async status => {
    missingCardFields()
    const ownership = copy(f.realStorage)
    f.patch.mockRejectedValueOnce(Object.assign(new Error('synthetic session refusal'), { status }))
    await expect(writePartialSyncResume(request(), f.validate)).rejects.toMatchObject({ message: expect.stringContaining('session refusal'), persisted: true })
    expect(f.realStorage).toEqual(ownership)
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.baseline).not.toHaveBeenCalled()
})

test('a missing or different owning transaction is refused before any I/O', async () => {
    for (const transaction of [undefined, 'foreign-transaction']) {
        f.realStorage.syncTransaction = transaction as any
        await expect(writePartialSyncResume(request(), f.validate)).rejects.toMatchObject({ persisted: false })
    }
    expect(f.read).not.toHaveBeenCalled()
    expect(f.patch).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.baseline).not.toHaveBeenCalled()
    expect(f.realStorage.syncTransaction).toBe('foreign-transaction')
})

test.each(['read', 'validate', 'patch', 'flush'])('a changed owner after %s is never acknowledged as a completed save', async stage => {
    missingCardFields()
    const mocked = stage === 'read' ? f.read : stage === 'validate' ? f.validate : stage === 'patch' ? f.patch : f.flush
    const original = mocked.getMockImplementation()!
    mocked.mockImplementationOnce(async (...args: any[]) => {
        const result = await original(...args)
        f.realStorage.syncTransaction = 'different-owner'
        return result
    })
    await expect(writePartialSyncResume(request(), f.validate)).rejects.toMatchObject({
        message: expect.stringMatching(/ownership/i), persisted: stage === 'patch' || stage === 'flush',
    })
    expect(f.baseline).not.toHaveBeenCalled()
    expect(f.realStorage.syncTransaction).toBe('different-owner')
    if (stage === 'read' || stage === 'validate') expect(f.patch).not.toHaveBeenCalled()
    if (stage !== 'flush') expect(f.flush).not.toHaveBeenCalled()
})

test('dangerous patch operations fail closed without a full-write replacement', async () => {
    missingCardFields()
    f.dangerous = true
    await expect(writePartialSyncResume(request(), f.validate)).rejects.toMatchObject({ persisted: false })
    expect(f.patch).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.baseline).not.toHaveBeenCalled()
})

test.each(['absent', 'placeholder', 'failed-hydration', 'chat-write'])('unavailable chat is not persisted as empty: %s', async mode => {
    const chat: any = { id: 'chat', name: 'Synthetic chat', message: [{ role: 'user', data: 'keep synthetic content' }] }
    f.db.characters[0].chats = mode === 'absent' ? [] : [chat]
    if (mode === 'placeholder') chat._placeholder = true
    if (mode === 'failed-hydration') f.hydrate.mockResolvedValueOnce(null)
    if (mode === 'chat-write') f.chat.mockRejectedValueOnce(new Error('synthetic chat failure'))
    const before = copy(f.db)
    await expect(writePartialSyncResume(request(['card'], [['card', 'chat']]), f.validate)).rejects.toMatchObject({ persisted: mode === 'chat-write' })
    expect(f.read).toHaveBeenCalledOnce()
    expect(f.patch).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.baseline).not.toHaveBeenCalled()
    expect(f.db).toEqual(before)
})

test('a raw startup ChatStub is refused before it can be treated as a full empty chat', async () => {
    f.db.characters[0].chats = [{ id: 'chat', name: 'Synthetic unloaded chat', _stub: true }]
    await expect(writePartialSyncResume(request(['card'], [['card', 'chat']]), f.validate)).rejects.toMatchObject({ message: expect.stringMatching(/body.*unavailable/i), persisted: false })
    expect(f.hydrate).not.toHaveBeenCalled()
    expect(f.chat).not.toHaveBeenCalled()
    expect(f.read).toHaveBeenCalledOnce()
    expect(f.baseline).not.toHaveBeenCalled()
})

test('a normally hydrated placeholder uses the real body and is saved before baseline acquisition', async () => {
    const full = { id: 'chat', name: 'Synthetic chat', message: [{ role: 'user', data: 'synthetic recovered body' }] }
    f.db.characters[0].chats = [{ id: 'chat', name: 'Synthetic chat', _placeholder: true, message: [] }]
    f.server.characters[0].chats = [{ id: 'chat', name: 'Synthetic chat', _stub: true }]
    f.hydrate.mockImplementationOnce(async (chats: any[], index: number) => {
        f.order.push('hydrate')
        chats[index] = full
        return full
    })
    await writePartialSyncResume(request(['card'], [['card', 'chat']]), f.validate)
    expect(f.chat).toHaveBeenCalledWith('card', 0, 'chat', full)
    expect(f.order).toEqual(['read', 'validate', 'hydrate', 'chat', 'read', 'validate', 'flush', 'baseline'])
    expect(f.patch).not.toHaveBeenCalled()
})

test('a failed canonical baseline read preserves memory and never advances the baseline', async () => {
    missingCardFields()
    f.read.mockRejectedValueOnce(new TypeError('synthetic read failure'))
    const before = copy(f.db)
    await expect(writePartialSyncResume(request(), f.validate)).rejects.toMatchObject({ message: expect.stringContaining('read failure'), persisted: false })
    expect(f.db).toEqual(before)
    expect(f.patch).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.baseline).not.toHaveBeenCalled()
})

test('an empty baseline is not interpreted as an empty database', async () => {
    f.read.mockResolvedValueOnce({ value: null, etag: null })
    await expect(writePartialSyncResume(request(), f.validate)).rejects.toMatchObject({ persisted: false })
    expect(f.patch).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.baseline).not.toHaveBeenCalled()
})

test('the first decoded baseline is validated before any chat or patch write', async () => {
    const chat = { id: 'chat', name: 'Synthetic chat', note: '', localLore: [], message: [{ role: 'char' as const, data: 'preserve synthetic body' }] }
    f.db.characters[0].chats = [chat]
    f.server.characters[0].chats = [chatToStub(chat)]
    const current = copy(f.server)
    f.validate.mockImplementationOnce(async raw => {
        expect(raw).toEqual(current)
        throw new Error('synthetic third value appeared after finish classification')
    })
    const local = copy(f.db)
    await expect(writePartialSyncResume(request(['card'], [['card', 'chat']]), f.validate)).rejects.toMatchObject({ message: expect.stringContaining('third value'), persisted: false })
    expect(f.hydrate).not.toHaveBeenCalled()
    expect(f.chat).not.toHaveBeenCalled()
    expect(f.patch).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.baseline).not.toHaveBeenCalled()
    expect(f.server).toEqual(current)
    expect(f.db).toEqual(local)
})

test('a pending baseline validator blocks both chat saving and patching until its decision', async () => {
    const chat = { id: 'chat', name: 'Synthetic chat', note: '', localLore: [], message: [] }
    f.db.characters[0].chats = [chat]
    f.server.characters[0].chats = [chatToStub(chat)]
    let accept!: () => void
    f.validate.mockImplementationOnce(() => new Promise<void>(resolve => { accept = resolve }))
    const pending = writePartialSyncResume(request(['card'], [['card', 'chat']]), f.validate)
    await vi.waitFor(() => expect(f.validate).toHaveBeenCalledOnce())
    expect(f.hydrate).not.toHaveBeenCalled()
    expect(f.chat).not.toHaveBeenCalled()
    expect(f.patch).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    accept()
    await pending
    expect(f.validate).toHaveBeenCalledTimes(2)
    expect(f.chat).toHaveBeenCalledOnce()
    expect(f.flush).toHaveBeenCalledOnce()
})

test('the post-chat baseline is read and validated again before the patcher can persist card changes', async () => {
    const chat = { id: 'chat', name: 'Updated metadata', message: [] }
    f.db.characters[0].chats = [chat]
    f.server.characters[0].chats = [{ id: 'chat', name: 'Old metadata', _stub: true }]
    missingCardFields()
    const seen: any[] = []
    f.validate.mockImplementation(async raw => {
        f.order.push('validate')
        seen.push(copy(raw))
        if (seen.length === 2) throw new Error('synthetic post-chat baseline no longer matches classification')
    })
    await expect(writePartialSyncResume(request(['card'], [['card', 'chat']]), f.validate)).rejects.toMatchObject({ message: expect.stringContaining('post-chat baseline'), persisted: true })
    expect(seen).toHaveLength(2)
    expect(seen[0].characters[0].chats[0].name).toBe('Old metadata')
    expect(seen[1].characters[0].chats[0].name).toBe('Updated metadata')
    expect(f.chat).toHaveBeenCalledOnce()
    expect(f.patch).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.baseline).not.toHaveBeenCalled()
    expect(f.server.characters[0]).not.toHaveProperty('bardLore')
})

test('chat recovery retry validates fresh pre-chat and post-chat snapshots even after a lost flush response', async () => {
    const chat = { id: 'chat', name: 'Synthetic chat', note: '', localLore: [], message: [{ role: 'char' as const, data: 'synthetic body' }] }
    f.db.characters[0].chats = [chat]
    f.server.characters[0].chats = [chatToStub(chat)]
    missingCardFields()
    f.flush.mockRejectedValueOnce(new Error('synthetic lost flush'))
    await expect(writePartialSyncResume(request(['card'], [['card', 'chat']]), f.validate)).rejects.toMatchObject({ message: expect.stringContaining('lost flush'), persisted: true })
    expect(f.baseline).not.toHaveBeenCalled()
    await writePartialSyncResume(request(['card'], [['card', 'chat']]), f.validate)
    expect(f.read).toHaveBeenCalledTimes(4)
    expect(f.validate).toHaveBeenCalledTimes(4)
    expect(f.patch).toHaveBeenCalledOnce()
    expect(f.flush).toHaveBeenCalledTimes(2)
    expect(f.baseline).toHaveBeenCalledOnce()
})

test('an empty patch followed by a failed flush is still marked as possibly persisted', async () => {
    f.flush.mockRejectedValueOnce(new Error('synthetic zero-patch flush response lost'))
    await expect(writePartialSyncResume(request(), f.validate)).rejects.toMatchObject({
        message: 'synthetic zero-patch flush response lost', persisted: true,
    })
    expect(f.patch).not.toHaveBeenCalled()
    expect(f.flush).toHaveBeenCalledOnce()
    expect(f.baseline).not.toHaveBeenCalled()
})
