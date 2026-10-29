import { beforeEach, expect, it, vi } from 'vitest'
import { writable } from 'svelte/store'
import type { Database } from '../storage/database.svelte'
import { createPainterChatData } from './types'

const mocks = vi.hoisted(() => ({ db: {} as Database, request: vi.fn(), save: vi.fn() }))
vi.mock('../stores.svelte', () => ({ DBState: { db: mocks.db }, selectedCharID: writable(0), selIdState: { selId: 0 }, ReloadChatPointer: writable(0) }))
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

const lore = (id: string, content: string) => ({ id, key: '', comment: id, content, mode: 'normal' as const, insertorder: 100, alwaysActive: false, secondkey: '', selective: false })
const kisuke = '@@dont_activate\n[bardpainter character: kisuke]\nname: 야가미 키스케\n[appearance]\n1boy, black hair\n[outfit: uniform | 교복]\nschool uniform'

beforeEach(() => {
    vi.clearAllMocks()
    const data = createPainterChatData()
    Object.assign(data.settings.context, { characterDescription: false, characterLorebook: false, before: 0, after: 0 })
    Object.assign(mocks.db, {
        modules: [{ id: 'mod', name: '학원 모듈', lorebook: [] }], enabledModules: ['mod'],
        characters: [{ type: 'character', chaId: 'bot', name: 'Story', chatPage: 0, globalLore: [lore('k', kisuke)],
            chats: [{ id: 'chat', localLore: [], message: [{ chatId: 'm1', role: 'char', data: '키스케가 하품을 했다.' }], bardPainter: data }] }],
        loreBookToken: 500, loreBookDepth: 3, username: 'User', personas: [], personaPrompt: '',
    })
    mocks.save.mockResolvedValue(undefined)
    mocks.request.mockResolvedValue({ type: 'success', result: JSON.stringify({ targets: [
        { id: 'kisuke', name: '키스케', aliases: [], appearance: '', outfits: [{ id: 'pajamas', name: '잠옷', clothing: 'striped pajamas' }] },
        { id: 'haru', name: '하루', aliases: ['User'], appearance: '1girl, short hair', outfits: [] }] }) })
})

it('analyzes named characters from the latest message and saves outfits and new presets to the chosen lorebooks', async () => {
    const session = new PainterSession('bot', 'chat')
    const items = await session.analyzeCharacters('하루/야가미 키스케의 잠옷을 만들어 줘')
    expect(session.state.error).toBe('')
    const payload = JSON.parse(mocks.request.mock.calls[0][0].formated[1].content)
    expect(payload.references[0]).toEqual({ name: '최근 메시지', content: '키스케가 하품을 했다.' })
    expect(payload.existingPresets.map((item: { name: string }) => item.name)).toEqual(['야가미 키스케'])
    expect(items!.map(item => [item.name, item.action, item.destination])).toEqual([['야가미 키스케', 'outfit', 'character'], ['하루', 'create', 'character']])
    items![1].destination = 'module:mod'
    expect(await session.saveCharacterAnalysis(items!)).toBe(true)
    const char = mocks.db.characters[0]
    expect(char.globalLore[0].content).toBe(`${kisuke}\n[outfit: pajamas | 잠옷]\nstriped pajamas`)
    expect(mocks.db.modules[0].lorebook).toHaveLength(1)
    expect(mocks.db.modules[0].lorebook[0]).toMatchObject({ key: '', comment: '바드페인터: 하루' })
    expect(session.identities.map(item => item.name).sort()).toEqual(['야가미 키스케', '하루'])
    expect(session.outfitsFor('lore:kisuke').map(item => item.name)).toEqual(['교복', '잠옷'])
})

it('does not write anything when a matched lore entry changed after analysis', async () => {
    const session = new PainterSession('bot', 'chat')
    const items = await session.analyzeCharacters('키스케 잠옷')
    mocks.db.characters[0].globalLore = [lore('k', kisuke)]
    expect(await session.saveCharacterAnalysis(items!)).toBe(false)
    expect(session.state.error).toContain('다시 분석')
    expect(mocks.db.modules[0].lorebook).toEqual([])
})
