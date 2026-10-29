import { beforeEach, expect, it, vi } from 'vitest'
import { writable } from 'svelte/store'
import type { Database } from '../storage/database.svelte'
import { createPainterChatData } from './types'

const mocks = vi.hoisted(() => ({ db: {} as Database, request: vi.fn(), save: vi.fn() }))
vi.mock('../stores.svelte', () => ({ DBState: { db: mocks.db }, selectedCharID: writable(0), selIdState: { selId: 0 }, ReloadChatPointer: writable({} as Record<number, number>) }))
vi.mock('../storage/database.svelte', () => ({ appVer: 'test', getCurrentCharacter: () => mocks.db.characters[0], getDatabase: () => mocks.db }))
vi.mock('../globalApi.svelte', () => ({ requestImmediateSave: mocks.save, trackCharacterForSave: vi.fn(), globalFetch: vi.fn(), forageStorage: { createAuth: vi.fn() }, getFileSrc: async () => '', downloadFile: vi.fn() }))
vi.mock('../process/request/request', () => ({ requestChatData: mocks.request }))
vi.mock('../risubard/memoryWiki', () => ({ loadNarrativeMemoryWiki: vi.fn() }))
vi.mock('../storage/chatStorage', () => ({ ensureChatHydrated: vi.fn() }))
vi.mock('../process/files/inlays', () => ({ setInlayAsset: vi.fn(), getInlayAssetBlob: vi.fn(), getInlayInfosBatch: () => [] }))
vi.mock('../process/modules', () => ({ getModuleAssets: () => [], getModuleLorebooks: () => [], getModuleLorebooksWithSources: () => [], getModules: () => [] }))
vi.mock('../parser/parser.svelte', () => ({ risuChatParser: (text: string) => text }))
vi.mock('../tokenizer', () => ({ tokenize: async (text: string) => text.length }))
vi.mock('../util', async (importOriginal) => ({ ...await importOriginal<typeof import('../util')>(), findCharacterbyId: vi.fn(), pickHashRand: () => 0 }))
vi.mock('src/lang', () => ({ language: {}, getCurrentLocale: () => 'en' }))
import { PainterSession } from './runtime.svelte'


beforeEach(() => {
    vi.clearAllMocks()
    const data = createPainterChatData()
    data.anchor = { characterId: 'bot', chatId: 'chat', messageId: 'm1', start: 42, end: 46, text: 'Last' }
    data.results = [
        { id: 'new', assetId: 'new-image-id', createdAt: 2, anchor: { ...data.anchor }, draft: { rendering: '', scene: '', negative: '', subjects: [] }, style: {} as never, settings: data.settings, seed: 1 },
        { id: 'old', assetId: 'old', createdAt: 1, anchor: { ...data.anchor }, draft: { rendering: '', scene: '', negative: '', subjects: [] }, style: {} as never, settings: data.settings, seed: 1, inserted: 'after' },
    ]
    Object.assign(mocks.db, { characters: [{ type: 'character', chaId: 'bot', name: 'Story', chatPage: 0, globalLore: [],
        chats: [{ id: 'chat', localLore: [], message: [{ chatId: 'm1', role: 'char', data: 'First {{inlay::old}} and\n\n{{inlay::old}}\n\nLast', swipes: ['x'], swipeId: 0 }], bardPainter: data }] }] })
    mocks.save.mockResolvedValue(undefined)
})

it('replaces only the chosen occurrence of an image and shifts the scene after it', async () => {
    const session = new PainterSession('bot', 'chat')
    const replaced = await session.replaceInlay('new', { messageId: 'm1', inlayId: 'old', occurrence: 1 })
    expect(session.state.error).toBe('')
    expect(replaced).toBe(true)
    const message = mocks.db.characters[0].chats[0].message[0]
    expect(message.data).toBe('First {{inlay::old}} and\n\n{{inlay::new-image-id}}\n\nLast')
    expect(message.swipes).toEqual([message.data])
    expect(session.data.anchor).toMatchObject({ start: 51, end: 55 })
    expect(session.data.results.find(item => item.id === 'old')?.inserted).toBe('after')
    expect(await session.replaceInlay('new', { messageId: 'm1', inlayId: 'old', occurrence: 3 })).toBe(false)
    expect(session.state.error).toContain('찾지 못했습니다')
})
