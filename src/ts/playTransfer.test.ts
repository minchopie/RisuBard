import { beforeEach, test, expect, vi } from 'vitest'
import { get, writable } from 'svelte/store'
import { hashLocalJson } from '../../shared/play-set/protocol'
const f = vi.hoisted(() => ({ db: {} as any, request: vi.fn(), save: vi.fn(), defaults: vi.fn(), normalized: vi.fn(), select: vi.fn() }))
vi.mock('./globalApi.svelte', () => ({ forageStorage: { Init: async () => {}, realStorage: { transferRequest: (...args: any[]) => f.request(...args) } }, requestImmediateSave: (...args: any[]) => f.save(...args), checkCharOrder: () => {} }))
vi.mock('./storage/database.svelte', () => ({ getDatabase: () => f.db, getCurrentCharacter: () => f.db.characters[0], newChatModelDefaults: (...args: any[]) => f.defaults(...args), normalizeChat: (chat: any) => { f.normalized(chat); return chat } }))
vi.mock('./storage/chatStorage', () => ({ ensureChatHydrated: async (chats: any[], index: number) => chats[index] }))
vi.mock('./process/generationState', () => ({ doingChat: writable(false), isAnyGenerating: writable(false) }))
vi.mock('./importSession', () => ({ importSession: writable({ phase: 'idle' }) }))
vi.mock('./stores.svelte', () => ({ loadedStore: writable(true), alertStore: writable({ type: 'none' }) }))
vi.mock('./alert', () => ({ alertSelect: (...args: any[]) => f.select(...args), alertConfirm: (...args: any[]) => f.select(...args) }))
vi.mock('./risubard/memorySaveSlots', () => ({ applyMemorySavePromptSettings: (chat: any, current: any) => { chat.modelBinding = current.modelBinding; delete chat.bindedPersona } }))
import { receiveTransfer, recoverTransfers, exportTransfer, uploadLegacyChat, transferBusy, requestRemoteTransfer } from './playTransfer'
import { forageStorage } from './globalApi.svelte'
import { isAnyGenerating } from './process/generationState'
import { importSession } from './importSession'
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
beforeEach(() => {
    f.db = { characters: [{ chaId: 'existing', name: 'Keep', chatPage: 0, chats: [{ id: 'old', name: 'Keep', message: [], modelBinding: { main: 'receiver-model' } }] }], enabledModules: ['local-module'], apiKey: 'fixture-only' }
    transferBusy.set(false); (isAnyGenerating as any).set(false); importSession.set({ phase: 'idle' } as any)
    f.save.mockReset(); f.save.mockResolvedValue(undefined); f.request.mockReset(); f.normalized.mockReset(); f.defaults.mockReset(); f.defaults.mockReturnValue({ modelBinding: { main: 'receiver-model' } })
    f.select.mockReset()
    forageStorage.realStorage.syncTransaction = undefined; forageStorage.realStorage.transferTransaction = undefined
})

test('automatic direct receive with ambiguous targets defers durably without a selection popup or save', async () => {
    f.request.mockImplementation(async (path: string) => reply(path.endsWith('/inspect') ? { characters: [{ id: 'card', name: 'Keep', candidates: [{ id: 'a' }, { id: 'b' }] }] } : []))
    await receiveTransfer('in', true)
    expect(f.request).toHaveBeenCalledWith('/in/apply-request', expect.objectContaining({ body: JSON.stringify({ requested: false }) }))
    expect(f.select).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled()
})

test('remote requests wait only for transient pre-handler NAS gates, stop at the deadline and keep durable transaction errors', async () => {
    vi.useFakeTimers()
    const gate = (transaction?: string) => new Response(JSON.stringify({ error: 'busy', code: 'NAS_SYNC_BUSY', ...(transaction ? { transaction } : {}) }), { status: 423 })
    try {
        f.request.mockResolvedValueOnce(gate()).mockResolvedValueOnce(reply({ state: 'waiting', applyRequested: true }))
        const success = requestRemoteTransfer('nas', 'download', { name: 'fixture.risuplay', applyRequested: true })
        await vi.advanceTimersByTimeAsync(500)
        expect(await success).toMatchObject({ applyRequested: true })
        expect(f.request.mock.calls[0]).toEqual(f.request.mock.calls[1])
        f.request.mockReset(); f.request.mockResolvedValue(gate('durable-transaction'))
        await expect(requestRemoteTransfer('nas', 'upload', { id: 'out' })).rejects.toMatchObject({ transaction: 'durable-transaction', status: 423 })
        expect(f.request).toHaveBeenCalledTimes(1)
        f.request.mockReset(); f.request.mockImplementation(async () => gate())
        const bounded = expect(requestRemoteTransfer('nas', 'download')).rejects.toMatchObject({ code: 'NAS_SYNC_BUSY' })
        await vi.advanceTimersByTimeAsync(30_000); await bounded
        expect(f.request).toHaveBeenCalledTimes(61)
        f.request.mockReset(); f.request.mockRejectedValue(new Error('network failed'))
        await expect(requestRemoteTransfer('nas', 'upload')).rejects.toThrow('network failed')
        expect(f.request).toHaveBeenCalledTimes(1)
        f.request.mockReset(); f.request.mockImplementation(async () => gate())
        const changed = expect(requestRemoteTransfer('nas', 'upload')).rejects.toMatchObject({ status: 423 })
        await vi.advanceTimersByTimeAsync(100)
        forageStorage.realStorage.syncTransaction = 'new-apply'
        await vi.advanceTimersByTimeAsync(400); await changed
        expect(f.request).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers(); forageStorage.realStorage.syncTransaction = undefined }
})

test('legacy backup asks before replacing a diverged revision and carries the confirmed hash', async () => {
    f.db.characters[0].chatPage = 0
    f.request.mockImplementation(async (_path: string, init: RequestInit) => reply(JSON.parse(init.body as string).replaceSha ? { state: 'delivered' } : { conflictSha: 'a'.repeat(40) }))
    f.select.mockResolvedValue(false)
    expect(await uploadLegacyChat()).toEqual({ cancelled: true })
    expect(f.request).toHaveBeenCalledTimes(1)
    f.request.mockClear(); f.select.mockResolvedValue(true)
    expect(await uploadLegacyChat()).toEqual({ state: 'delivered' })
    expect(JSON.parse(f.request.mock.calls[1][1].body).replaceSha).toBe('a'.repeat(40))
    expect(get(transferBusy)).toBe(false)
})
test('append does not select or overwrite old chats/global settings and arms before save/finish', async () => {
    const old = structuredClone(f.db.characters[0].chats[0]), order: string[] = []
    f.save.mockImplementation(async () => { order.push('save') })
    f.request.mockImplementation(async (path: string) => {
        order.push(path)
        if (path.endsWith('/inspect')) return reply({ characters: [{ id: 'card', name: 'Keep', candidates: [{ id: 'existing', name: 'Keep' }] }] })
        if (path.endsWith('/prepare')) return reply({ transaction: 'tx', added: [{ characterId: 'existing', chat: { id: 'incoming', message: [], modelBinding: { main: 'foreign-model' }, scriptstate: { n: 4 } } }], newCharacters: [], registry: { transactions: { tx: 'instance' } } })
        return reply([])
    })
    await receiveTransfer('in')
    expect(f.db.characters[0].chats[0]).toEqual(old); expect(f.db.characters[0].chatPage).toBe(0)
    expect(f.db.characters[0].chats[1].modelBinding).toEqual({ main: 'receiver-model' })
    expect(f.db.characters[0].chats[1].scriptstate).toEqual({ n: 4 })
    expect(f.db.enabledModules).toEqual(['local-module']); expect(f.db.apiKey).toBe('fixture-only')
    expect(order.slice(0, 6)).toEqual(['/in/inspect', 'save', '/in/prepare', '/in/arm', 'save', '/in/finish'])
    expect(f.save).toHaveBeenLastCalledWith({ chats: [['existing', 'incoming']], flushServer: 'canonical', rejectOnFailure: true })
    expect(get(transferBusy)).toBe(false)
})

test.each([false, true])('receiving into an off-screen character explicitly saves its new chat (new=%s)', async (newCharacter) => {
    const target = { chaId: 'offscreen', name: 'Received', chatPage: 0, chats: [] }
    if (!newCharacter) f.db.characters.push(target)
    f.request.mockImplementation(async (path: string) => {
        if (path.endsWith('/inspect')) return reply({ characters: [] })
        if (path.endsWith('/prepare')) return reply({ transaction: 'tx', added: [{ characterId: 'offscreen', chat: { id: 'incoming', message: [{ role: 'user', data: 'preserve' }] } }], newCharacters: newCharacter ? [target] : [], registry: {} })
        return reply([])
    })
    await receiveTransfer('in')
    expect(f.db.characters[0].chaId).toBe('existing')
    expect(f.db.characters[1].chats[0].message[0].data).toBe('preserve')
    expect(f.save).toHaveBeenLastCalledWith({ chats: [['offscreen', 'incoming']], flushServer: 'canonical', rejectOnFailure: true })
})
test('background generation and an existing import defer reception without touching the queue', async () => {
    ;(isAnyGenerating as any).set(true)
    await receiveTransfer('in'); expect(f.request).not.toHaveBeenCalled()
    await expect(exportTransfer(['old'])).rejects.toThrow('진행 중')
    ;(isAnyGenerating as any).set(false); importSession.set({ phase: 'applying' } as any)
    await receiveTransfer('in'); expect(f.request).not.toHaveBeenCalled()
})

test('a manual click racing the background receiver prepares and appends only once', async () => {
    f.request.mockImplementation(async (path: string) => {
        if (path.endsWith('/inspect')) return reply({ characters: [] })
        if (path.endsWith('/prepare')) return reply({ transaction: 'tx', newCharacters: [], added: [{ characterId: 'existing', chat: { id: 'incoming', message: [] } }], registry: {} })
        return reply([])
    })
    await Promise.all([receiveTransfer('in'), receiveTransfer('in', true)])
    expect(f.request.mock.calls.filter(c => c[0] === '/in/prepare')).toHaveLength(1)
    expect(f.db.characters[0].chats.map((chat: any) => chat.id)).toEqual(['old', 'incoming'])
})
test('startup recovery independently verifies committed client chat before server publication', async () => {
    f.db.risuPlaySets = { transactions: { tx: 'instance' } }
    const chat = f.db.characters[0].chats[0]
    const expected = { characterId: 'existing', chatId: 'old', fields: Object.keys(chat), hash: await hashLocalJson(chat) }
    f.request.mockImplementation(async (path: string) => reply(path === '/recovery' ? [{ id: 'in', transaction: 'tx', expected: [expected] }] : {}))
    await recoverTransfers(); expect(f.request).toHaveBeenCalledWith('/in/finish', expect.anything())
    f.request.mockClear(); chat.name = 'changed'
    await expect(recoverTransfers()).rejects.toThrow('복구를 보류')
    expect(f.request).toHaveBeenCalledTimes(1)
    f.select.mockResolvedValue(true); f.request.mockClear()
    await recoverTransfers()
    expect(f.request).toHaveBeenCalledWith('/in/hold-recovery', expect.objectContaining({ body: JSON.stringify({ confirmed: true }) }))
    expect(chat.name).toBe('changed')
})
