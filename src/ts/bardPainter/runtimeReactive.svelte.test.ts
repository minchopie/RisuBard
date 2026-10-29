import { afterEach, expect, it, vi } from 'vitest'
import { flushSync } from 'svelte'

// Runs the painter session under real Svelte runes: the screen reads session.data
// and session.bot inside $derived, where writing state throws state_unsafe_mutation.
const mocks = vi.hoisted(() => ({ state: { db: null as any } }))
vi.mock('../stores.svelte', () => ({ DBState: mocks.state, ReloadChatPointer: { update: vi.fn() } }))
vi.mock('../globalApi.svelte', () => ({ requestImmediateSave: vi.fn(), globalFetch: vi.fn(), forageStorage: { createAuth: vi.fn() } }))
vi.mock('../process/request/request', () => ({ requestChatData: vi.fn() }))
vi.mock('../loreBuilder', () => ({ collectLoreBuilderSources: vi.fn(), matchLoreBuilderCharacterLorebook: vi.fn() }))
vi.mock('../risubard/memoryWiki', () => ({ loadNarrativeMemoryWiki: vi.fn() }))
vi.mock('../process/files/inlays', () => ({ setInlayAsset: vi.fn(), getInlayAssetBlob: vi.fn() }))
vi.mock('./image', () => ({ compressPainterImage: vi.fn() }))
vi.mock('./gallery', () => ({ savePainterGalleryRecord: vi.fn() }))
vi.mock('./reference', () => ({ loadPainterReference: vi.fn() }))
vi.mock('../storage/chatStorage', () => ({ ensureChatHydrated: vi.fn() }))
import { getPainterSession } from './runtime.svelte'

let stop: (() => void) | undefined
afterEach(() => { stop?.(); stop = undefined })

it('reads painter data in derived state after the chat and bot data were replaced', () => {
    const db = $state<any>({ bardPainterStyles: [], characters: [{ chaId: 'bot', chatPage: 0, chats: [{ id: 'chat', message: [] }] }] })
    mocks.state.db = db
    const session = getPainterSession('bot', 'chat')
    // A server reload swaps in objects that never held painter data; the cached session stays.
    const character = mocks.state.db.characters[0]
    character.chats[0] = { id: 'chat', message: [] }
    delete character.bardPainter

    let results: unknown
    let identities: unknown
    stop = $effect.root(() => {
        const data = $derived(session.data)
        const bot = $derived(session.bot)
        $effect(() => { results = data.results; identities = bot.identities })
    })
    flushSync()

    expect(results).toEqual([])
    expect(identities).toEqual([])
    // Created data is attached to the live chat, so later edits are saved.
    session.data.settings.instruction = 'kept'
    expect(character.chats[0].bardPainter.settings.instruction).toBe('kept')
    expect(character.bardPainter).toEqual({ identities: [], outfits: [] })
})
