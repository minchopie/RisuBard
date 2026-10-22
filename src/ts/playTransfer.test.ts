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
import { receiveTransfer, recoverTransfers, exportTransfer, uploadLegacyChat, transferBusy } from './playTransfer'
import { isAnyGenerating } from './process/generationState'
import { importSession } from './importSession'
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
beforeEach(() => {
    f.db = { characters: [{ chaId: 'existing', name: 'Keep', chatPage: 0, chats: [{ id: 'old', name: 'Keep', message: [], modelBinding: { main: 'receiver-model' } }] }], enabledModules: ['local-module'], apiKey: 'fixture-only' }
    transferBusy.set(false); (isAnyGenerating as any).set(false); importSession.set({ phase: 'idle' } as any)
    f.save.mockReset(); f.save.mockResolvedValue(undefined); f.request.mockReset(); f.normalized.mockReset(); f.defaults.mockReset(); f.defaults.mockReturnValue({ modelBinding: { main: 'receiver-model' } })
    f.select.mockReset()
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
