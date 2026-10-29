import { beforeEach, describe, expect, test, vi } from 'vitest'

const { selectedCharID } = vi.hoisted(() => {
    let value = 0
    return {
        selectedCharID: {
            subscribe: (run: (value: number) => void) => { run(value); return () => {} },
            set: (next: number) => { value = next },
            update: () => {},
        },
    }
})

vi.mock('../stores.svelte', () => ({
    DBState: { db: {} },
    selectedCharID,
    selIdState: { selId: 0 },
}))
vi.mock('../globalApi.svelte', () => ({
    forageStorage: { realStorage: null },
    downloadFile: () => {},
    saveAsset: () => Promise.resolve(''),
}))
vi.mock('../alert', () => ({ notifySuccess: () => {}, alertError: () => {} }))
vi.mock('../../lang', () => ({ language: {}, changeLanguage: () => {} }))

const {
    ensureChatOwnsToggleValues,
    getChatToggleScope,
    getDatabase,
    loadChatBindings,
    newChatModelDefaults,
    setDatabase,
    setNewChatTogglePreset,
} = await import('./database.svelte')

function chat(id: string, extra: Record<string, unknown> = {}) {
    return { id, message: [], note: '', name: id, localLore: [], modules: [], ...extra } as any
}

function load(chats: any[]) {
    setDatabase({
        characters: [{ chaId: 'bot', name: 'Bot', chats, chatPage: 0, modules: [], risuBardWikiGuide: '' }],
        customPromptTemplateToggle: 'one=Toggle One\ntwo=Toggle Two=text',
        globalChatVariables: { toggle_one: '1', toggle_two: 'global', unrelated: 'x' },
        togglePresets: [
            { name: 'Story', values: { toggle_one: '0', toggle_two: 'story' } },
            { name: 'Battle', values: { toggle_one: '1', toggle_two: 'battle' } },
        ],
        modules: [], enabledModules: [], moduleIntergration: '',
        formatingOrder: ['main'], loreBook: [], personas: [{ name: 'User', icon: '', personaPrompt: '' }],
        selectedPersona: 0, username: 'User', userIcon: '', userNote: '',
    } as any)
    return getDatabase()
}

describe('chat-owned toggle values', () => {
    beforeEach(() => selectedCharID.set(0))

    test('a legacy unpinned chat takes over the global values when opened, without changing them', () => {
        const db = load([chat('a')])
        const current = db.characters[0].chats[0]

        loadChatBindings(current)

        expect(current.useLocallySetGlobalVariables).toBe(true)
        expect(current.GLGlobalVariables).toEqual({ toggle_one: '1', toggle_two: 'global' })
        expect(current.togglePresetBaseline).toEqual({ values: { toggle_one: '1', toggle_two: 'global' } })
        expect(db.globalChatVariables).toEqual({ toggle_one: '1', toggle_two: 'global', unrelated: 'x' })
    })

    test('changing a toggle in one chat leaves another chat alone', () => {
        const db = load([chat('a'), chat('b')])
        const [a, b] = db.characters[0].chats
        loadChatBindings(a)
        a.GLGlobalVariables!.toggle_one = '0'

        db.characters[0].chatPage = 1
        loadChatBindings(b)

        expect(b.GLGlobalVariables).toEqual({ toggle_one: '1', toggle_two: 'global' })
        expect(getChatToggleScope(b, db).toggle_one).toBe('1')
        expect(getChatToggleScope(a, db).toggle_one).toBe('0')
    })

    test('placeholder chats and the shared RisuAI mode are never migrated', () => {
        const db = load([chat('a', { _placeholder: true })])
        expect(ensureChatOwnsToggleValues(db.characters[0].chats[0], db, db.characters[0])).toBe(false)
        expect(db.characters[0].chats[0].useLocallySetGlobalVariables).toBeUndefined()

        const shared = load([chat('b')])
        shared.disableToggleBinding = true
        expect(ensureChatOwnsToggleValues(shared.characters[0].chats[0], shared, shared.characters[0])).toBe(false)
    })

    test('a new chat copies the chat that was open, including a legacy unpinned one', () => {
        const db = load([chat('a', {
            useLocallySetGlobalVariables: true,
            GLGlobalVariables: { toggle_one: '0', toggle_two: 'mine' },
            togglePresetBaseline: { name: 'Story', values: { toggle_one: '0', toggle_two: 'story' } },
        }), chat('legacy')])
        const [owned, legacy] = db.characters[0].chats

        expect(newChatModelDefaults(db.characters[0], owned)).toMatchObject({
            useLocallySetGlobalVariables: true,
            GLGlobalVariables: { toggle_one: '0', toggle_two: 'mine' },
            togglePresetBaseline: { name: 'Story', values: { toggle_one: '0', toggle_two: 'story' } },
        })
        expect(newChatModelDefaults(db.characters[0], legacy)).toMatchObject({
            useLocallySetGlobalVariables: true,
            GLGlobalVariables: { toggle_one: '1', toggle_two: 'global' },
        })
    })

    test('a new bot starts from the toggle values that were last in use', () => {
        const db = load([chat('a', {
            useLocallySetGlobalVariables: true,
            GLGlobalVariables: { toggle_one: '0', toggle_two: 'last' },
        })])

        const defaults = newChatModelDefaults()

        expect(defaults.useLocallySetGlobalVariables).toBe(true)
        expect(defaults.GLGlobalVariables).toEqual({ toggle_one: '0', toggle_two: 'last' })
        expect(db.globalChatVariables.toggle_two).toBe('global')
    })

    test('a toggle preset marked for new chats overrides inheritance for new chats and bots', () => {
        const db = load([chat('a', {
            useLocallySetGlobalVariables: true,
            GLGlobalVariables: { toggle_one: '0', toggle_two: 'mine' },
        })])
        setNewChatTogglePreset(db.togglePresets![1], db)
        setNewChatTogglePreset(db.togglePresets![0], db)

        expect(db.togglePresets!.filter(preset => preset.applyToNewChats)).toHaveLength(1)
        for (const defaults of [newChatModelDefaults(db.characters[0], db.characters[0].chats[0]), newChatModelDefaults()]) {
            expect(defaults.GLGlobalVariables).toEqual({ toggle_one: '0', toggle_two: 'story' })
            expect(defaults.togglePresetBaseline).toEqual({ name: 'Story', values: { toggle_one: '0', toggle_two: 'story' } })
        }

        setNewChatTogglePreset(null, db)
        expect(db.togglePresets!.some(preset => preset.applyToNewChats)).toBe(false)
    })

    test('the shared RisuAI mode seeds no chat-owned values', () => {
        const db = load([chat('a')])
        db.disableToggleBinding = true
        setNewChatTogglePreset(db.togglePresets![0], db)

        const defaults = newChatModelDefaults(db.characters[0], db.characters[0].chats[0])

        expect(defaults.useLocallySetGlobalVariables).toBeUndefined()
        expect(defaults.GLGlobalVariables).toBeUndefined()
    })

    test('the toggle scope prefers chat-owned values over globals', () => {
        const db = load([chat('a', { useLocallySetGlobalVariables: true, GLGlobalVariables: { toggle_one: '0' } })])
        expect(getChatToggleScope(db.characters[0].chats[0], db)).toEqual({ toggle_one: '0', toggle_two: 'global', unrelated: 'x' })
        db.disableToggleBinding = true
        expect(getChatToggleScope(db.characters[0].chats[0], db).toggle_one).toBe('1')
    })
})
