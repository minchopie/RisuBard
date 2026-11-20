// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mount, tick, unmount, untrack } from 'svelte'
import { writable } from 'svelte/store'
import { SvelteMap } from 'svelte/reactivity'
import Chat from './Chat.svelte'
import Chats from './Chats.svelte'
import { DBState, ReloadChatPointer, ReloadGUIPointer, selIdState } from 'src/ts/stores.svelte'
import { ParseMarkdown, trimMarkdown } from 'src/ts/parser/parser.svelte'

vi.mock('src/ts/stores.svelte', () => ({
    DBState: { db: {} },
    selIdState: { selId: 0 },
    selectedCharID: writable(0),
    ReloadChatPointer: writable({}),
    ReloadGUIPointer: writable(0),
    CurrentTriggerIdStore: writable(null),
    popupStore: writable([]),
    HideIconStore: writable(false),
    createSimpleCharacter: vi.fn((character) => character),
}))
vi.mock('src/ts/globalApi.svelte', () => ({
    aiLawApplies: vi.fn(() => false),
    changeChatTo: vi.fn(),
    foldChatToMessage: vi.fn(),
    getFileSrc: vi.fn(),
    createChatCopyName: vi.fn(),
    forageStorage: { createAuth: vi.fn() },
    requestImmediateSave: vi.fn(),
}))
vi.mock('src/ts/risubard/memoryWiki', () => ({ retractWikiEventsBySourceMessages: vi.fn() }))
vi.mock('src/ts/risubard/memoryEvents', async importOriginal => ({
    ...await importOriginal<typeof import('src/ts/risubard/memoryEvents')>(),
    announceRisuBardMemoryUpdated: vi.fn(),
}))
vi.mock('src/ts/risubard/memoryWikiFork', () => ({ completeMemoryWikiFork: vi.fn(), forkMemoryWiki: vi.fn() }))
vi.mock('src/ts/gui/colorscheme', () => ({ ColorSchemeTypeStore: writable('dark') }))
vi.mock('src/ts/model/modellist', () => ({ getModelInfo: vi.fn(() => null) }))
vi.mock('src/ts/process/scriptings', () => ({ runLuaButtonTrigger: vi.fn() }))
vi.mock('src/ts/process/scripts', () => ({ risuChatParser: vi.fn((value: string) => value) }))
vi.mock('src/ts/process/triggers', () => ({ runTrigger: vi.fn() }))
vi.mock('src/ts/process/tts', () => ({ sayTTS: vi.fn() }))
vi.mock('src/ts/util', () => ({
    capitalize: (value: string) => value,
    getUserIcon: vi.fn(),
    getUserName: vi.fn(),
    sleep: vi.fn(),
}))
vi.mock('src/ts/characters', () => ({ getCharImage: vi.fn(async () => '') }))
vi.mock('src/lang', () => ({ language: new Proxy({}, { get: (_, key) => String(key) }) }))
vi.mock('src/ts/alert', () => ({
    alertClear: vi.fn(), alertConfirm: vi.fn(), alertConfirmMulti: vi.fn(), alertInput: vi.fn(),
    alertRequestData: vi.fn(), alertWait: vi.fn(), notifyError: vi.fn(), notifyInfo: vi.fn(), notifySuccess: vi.fn(),
}))
vi.mock('src/ts/parser/parser.svelte', () => ({
    ParseMarkdown: vi.fn(async (value: string) => value),
    addMetadataToElement: vi.fn((value: string) => value),
    getDistance: vi.fn(),
    postTranslationParse: vi.fn((value: string) => value),
    resolveInlayPlaceholders: vi.fn((value: string) => value),
    trimMarkdown: vi.fn((value: string) => value),
}))
vi.mock('src/ts/translator/translator', () => ({ getLLMCache: vi.fn(), setLLMCache: vi.fn(), translateHTML: vi.fn() }))
vi.mock('src/ts/storage/database.svelte', () => ({
    getCurrentCharacter: vi.fn(() => DBState.db.characters[0]),
    getCurrentChat: vi.fn(() => DBState.db.characters[0].chats[0]),
    setCurrentChat: vi.fn(),
}))

describe('keyed chat body height', () => {
    test.each(['commit', 'error', 'destroy', 'deadline'] as const)('restores the previous inline minimum after %s', async end => {
        expect(document.querySelector('.chattext')).toBeNull()
        mounted = mount(Chat, { target: document.body, props: {
            message: '<p>Before</p>', name: 'Character', isLastMemory: false, idx: 0, role: 'char',
        } })
        await tick(); await tick(); await tick()

        const body = document.querySelector<HTMLElement>('.chattext')!
        const oldContent = body.querySelector('p')
        expect(oldContent?.textContent).toBe('Before')
        expect(body.style.minHeight).toBe('')
        const box = body.parentElement!
        body.style.display = 'inline'
        box.style.display = 'block'
        box.style.boxSizing = 'border-box'
        box.style.setProperty('min-height', '12px', 'important')
        Object.defineProperty(box, 'offsetHeight', { value: 216 })
        let resolve!: (html: string) => void
        const pending = new Promise<string>(done => { resolve = done })
        const parser = vi.mocked(ParseMarkdown)
        const format = vi.mocked(trimMarkdown)
        const log = vi.spyOn(console, 'error').mockImplementation(() => {})
        parser.mockImplementation(() => pending)
        if (end === 'deadline') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        try {
            if (end === 'commit') ReloadChatPointer.update(value => ({ ...value, 0: (value[0] ?? 0) + 1 }))
            else ReloadGUIPointer.update(value => value + 1)
            await tick()
            expect(body.querySelector('[data-painter-body] p')).toBeNull()
            const snapshot = body.querySelector('[data-chat-body-snapshot][inert][aria-hidden="true"]')
            expect(snapshot?.querySelector('p')?.textContent).toBe('Before')
            expect(snapshot?.querySelector('p')).not.toBe(oldContent)
            expect(body.style.minHeight).toBe('')
            expect(box.style.minHeight).toBe('216px')

            if (end === 'destroy') {
                await unmount(mounted!)
                mounted = undefined
            } else if (end === 'deadline') {
                vi.advanceTimersByTime(3000)
                expect(box.style.minHeight).toBe('12px')
                expect(body.querySelector('[data-chat-body-snapshot]')).toBeNull()
                expect(body.querySelector('[data-painter-body] p')).toBeNull()
                resolve('<p>After</p>')
                await tick(); await tick(); await tick()
                expect(body.querySelector('[data-painter-body]')?.innerHTML).toBe('<p>After</p>')
            } else {
                if (end === 'error') format.mockImplementationOnce(() => { throw new Error('bad format') })
                resolve('<p>After</p>')
                await tick(); await tick(); await tick()
                if (end === 'commit') {
                    expect(body.querySelector('p')?.textContent).toBe('After')
                    expect(body.querySelector('p')).not.toBe(oldContent)
                } else {
                    expect(log).toHaveBeenCalledWith('Failed to render chat HTML', expect.any(Error))
                }
            }
            expect(body.querySelector('[data-chat-body-snapshot]')).toBeNull()
            expect(box.style.minHeight).toBe('12px')
            expect(box.style.getPropertyPriority('min-height')).toBe('important')
        } finally {
            if (end === 'deadline') vi.useRealTimers()
            log.mockRestore()
            parser.mockImplementation(async value => value)
        }
    })

    test('shows the translation loading indicator instead of an old body snapshot', async () => {
        DBState.db.translator = 'en'
        DBState.db.showTranslationLoading = true
        const { translateHTML } = await import('src/ts/translator/translator')
        const translate = vi.mocked(translateHTML)
        translate.mockResolvedValue('<p>Translated</p>')
        try {
            mounted = mount(Chat, { target: document.body, props: {
                message: '<p>Before</p>', name: 'Character', isLastMemory: false, idx: 0, role: 'char',
            } })
            await vi.waitFor(() => expect(document.querySelector('.chattext')?.textContent).toContain('Before'))
            document.querySelector<HTMLButtonElement>('.button-icon-translate')!.click()
            await vi.waitFor(() => expect(document.querySelector('.chattext')?.textContent).toContain('Translated'))
            const body = document.querySelector('.chattext')!
            DBState.db.autoTranslate = true
            translate.mockImplementationOnce(() => new Promise(() => {}))
            ReloadGUIPointer.update(value => value + 1)
            await vi.waitFor(() => expect(body.querySelector('[data-chat-body-pending] style')?.textContent).toContain('@keyframes spin'))
            expect(body.querySelector('[data-chat-body-snapshot]')).toBeNull()
        } finally {
            translate.mockReset()
        }
    })

    test('skips raw streaming content when the GUI reloads', async () => {
        mounted = mount(Chat, { target: document.body, props: {
            message: 'before', name: 'Character', isLastMemory: false, idx: 0, role: 'char',
            isOptimizedStreamingMessage: true, streamingOptimizationMode: 'strong', rawStreamingText: 'raw',
        } })
        await tick()
        const body = document.querySelector<HTMLElement>('.chattext')!
        expect(body.textContent).toContain('raw')
        const box = body.parentElement!
        box.style.display = 'block'
        body.style.display = 'inline'
        Object.defineProperty(box, 'offsetHeight', { value: 216 })
        ReloadGUIPointer.update(value => value + 1)
        await tick()
        expect(box.style.minHeight).toBe('')
    })
})
describe('message container remount', () => {
    test.each(['commit', 'error', 'deadline', 'unmount', 'edit'] as const)('holds only the replaced index until %s', async end => {
        const currentCharacter = DBState.db.characters[0]
        const state = new SvelteMap<string, any>([['messages', [{
            role: 'char', data: '<p>Before</p><iframe></iframe><video autoplay src="old.mp4"><source src="old.mp4"></video>', chatId: 'reply',
        }]]])
        mounted = mount(Chats, { target: document.body, props: {
            get messages() { return state.get('messages') },
            get pageEnd() { return state.get('messages').length },
            currentCharacter, currentUsername: 'User', userIcon: '', pageStart: 0,
            onReroll: vi.fn(), unReroll: vi.fn(),
        } })
        await tick(); await tick(); await tick()

        const container = (index: number) => document.querySelector(`[data-chat-index="${index}"]`)!
            .closest<HTMLDivElement>('.chat-message-container')!
        const old = container(0)
        const height = vi.fn(() => 612)
        Object.defineProperty(old, 'offsetHeight', { get: height })
        const newMessage = { role: 'user', data: '<p>New index</p>', chatId: 'next' }
        state.set('messages', [...state.get('messages'), newMessage])
        await tick(); await tick(); await tick()
        expect(container(1).style.minHeight).toBe('')
        expect(container(0)).toBe(old)
        expect(height).not.toHaveBeenCalled()

        let resolve!: (html: string) => void
        const pending = new Promise<string>(done => { resolve = done })
        const parser = vi.mocked(ParseMarkdown)
        const log = vi.spyOn(console, 'error').mockImplementation(() => {})
        parser.mockImplementation(() => pending)
        if (end === 'deadline') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
        try {
            ReloadChatPointer.update(value => ({ ...value, 0: (value[0] ?? 0) + 1 }))
            await tick()
            const fresh = container(0)
            expect(fresh).not.toBe(old)
            expect(height).toHaveBeenCalledOnce()
            expect(fresh.style.minHeight).toBe('612px')
            const snapshot = fresh.querySelector('[data-chat-body-snapshot][inert][aria-hidden="true"]')
            expect(snapshot?.querySelector('p')?.textContent).toBe('Before')
            expect(snapshot?.querySelector('iframe, video[src], video[autoplay], source')).toBeNull()
            expect(fresh.querySelector('[data-painter-body]')?.innerHTML).toBe('')
            expect(container(1).style.minHeight).toBe('')

            if (end === 'deadline') vi.advanceTimersByTime(3000)
            else if (end === 'edit') {
                fresh.querySelector<HTMLButtonElement>('.button-icon-edit')!.click()
                await tick()
                expect(fresh.querySelector('.message-edit-area')).not.toBeNull()
            } else if (end === 'unmount') {
                await unmount(mounted!)
                mounted = undefined
            } else {
                if (end === 'error') vi.mocked(trimMarkdown).mockImplementationOnce(() => { throw new Error('bad format') })
                resolve('<p>After</p>')
                await tick(); await tick(); await tick()
                if (end === 'error') expect(log).toHaveBeenCalledWith('Failed to render chat HTML', expect.any(Error))
                else expect(fresh.querySelector('[data-painter-body]')?.innerHTML).toBe('<p>After</p>')
            }
            expect(fresh.style.minHeight).toBe('')
            expect(fresh.querySelector('[data-chat-body-snapshot]')).toBeNull()
        } finally {
            if (end === 'deadline') vi.useRealTimers()
            log.mockRestore()
            parser.mockImplementation(async value => value)
        }
    })
})

test('refreshes the former last message while keeping the latest UI unique', async () => {
    const currentCharacter = DBState.db.characters[0]
    const state = new SvelteMap<string, any>()
    const messages = Array.from({ length: 8 }, (_, i) => ({ role: 'char', data: `<p>Message ${i}</p>`, chatId: 'message-' + i }))
    state.set('messages', messages)
    const parse = vi.mocked(ParseMarkdown)
    const ui = '<aside class="last-message-ui">Controls</aside>'
    parse.mockImplementation(async (value, _character, _mode, index) =>
        value + (index === untrack(() => state.get('messages').length) - 1 ? ui : ''))
    try {
        mounted = mount(Chats, { target: document.body, props: {
            get messages() { return state.get('messages') },
            get pageEnd() { return state.get('messages').length },
            currentCharacter, currentUsername: 'User', userIcon: '', pageStart: 0,
            onReroll: vi.fn(), unReroll: vi.fn(),
        } })
        await tick(); await tick(); await tick()
        expect(document.querySelectorAll('.last-message-ui')).toHaveLength(1)
        const oldBodies = Array.from(document.querySelectorAll('[data-painter-body]'))
        expect(oldBodies).toHaveLength(8)
        parse.mockClear()
        state.set('messages', [...messages, { role: 'char', data: '<p>Streaming reply</p>', chatId: 'stream' }])
        await tick(); await tick(); await tick()
        expect(parse.mock.calls.map(call => call[3]).sort()).toEqual([7, 8])
        expect(document.querySelectorAll('.last-message-ui')).toHaveLength(1)
        expect(document.querySelector('[data-chat-index="8"] .last-message-ui')).not.toBeNull()
        for (const index of [0, 1, 2, 3, 4, 5, 6]) {
            expect(document.querySelector(`[data-chat-index="${index}"] [data-painter-body]`)).toBe(oldBodies[7 - index])
        }
    } finally {
        parse.mockImplementation(async value => value)
    }
})

let mounted: ReturnType<typeof mount> | undefined

beforeEach(() => {
    DBState.db = {
        theme: '',
        zoomsize: 100,
        lineHeight: 1.25,
        iconsize: 100,
        roundIcons: false,
        nodeOnlyStandardChatWidth: 'normal',
        translator: '',
        clickToEdit: false,
        enableBlockPartialEdit: false,
        enableDragPartialEdit: false,
        characters: [{
            chaId: 'character-1',
            chatPage: 0,
            chats: [{ message: [{ role: 'user', data: 'editable message', chatId: 'message-1' }] }],
            ttsMode: 'none',
        }],
    } as unknown as typeof DBState.db
    selIdState.selId = 0
})

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
})

describe('message edit button', () => {
    test('mobile keeps translation inside the flyout and saves quick edits', async () => {
        const originalWidth = window.innerWidth
        window.innerWidth = 390
        DBState.db.translator = 'en'
        try {
            mounted = mount(Chat, { target: document.body, props: {
                message: 'editable message', name: 'Character', isLastMemory: false, idx: 0, role: 'user',
            } })
            await tick(); await tick()
            expect(document.querySelector('.button-icon-translate')).toBeNull()
            const edit = document.querySelector<HTMLButtonElement>('.button-icon-edit')!
            edit.click()
            await tick()
            const editor = document.querySelector<HTMLTextAreaElement>('.message-edit-area')!
            editor.value = '수정한 메시지'
            editor.dispatchEvent(new Event('input', { bubbles: true }))
            edit.click()
            await tick(); await tick()
            expect(DBState.db.characters[0].chats[0].message[0].data).toBe('수정한 메시지')
            document.querySelector<HTMLButtonElement>('.button-icon-menu')!.click()
            await tick(); await tick()
            expect(document.querySelector('.button-icon-translate')?.textContent).toContain('axModelTranslate')
            expect(document.querySelectorAll('.button-icon-edit')).toHaveLength(1)
        } finally {
            window.innerWidth = originalWidth
        }
    })
    test.each(['normal', 'ambiguous', 'streaming'] as const)('removes only the chosen inlay and active swipe safely (%s)', async (mode) => {
        const data = 'Before {{inlay::scene}} middle {{inlay::scene}} after'
        const msg = { role: 'char', data, chatId: 'message-1', swipes: ['untouched swipe', data], swipeId: 1 }
        const chat = DBState.db.characters[0].chats[0]
        chat.message = [msg] as any
        chat.isStreaming = mode === 'streaming'
        DBState.db.clickToEdit = true
        vi.mocked(ParseMarkdown).mockImplementation(async () => '<p><img data-inlay-image-id="scene" data-inlay-occurrence="0" src="/scene.png">'
            + (mode === 'ambiguous' ? '' : '<img data-inlay-image-id="scene" data-inlay-occurrence="1" src="/scene.png">') + '</p>')
        try {
            mounted = mount(Chat, { target: document.body, props: { message: data, name: 'Character', isLastMemory: false, idx: 0, role: 'char' } })
            await tick(); await tick(); await tick()
            await new Promise(resolve => setTimeout(resolve, 0))
            const buttons = document.querySelectorAll<HTMLButtonElement>('.inlay-image-remove')
            if (mode === 'streaming') {
                expect(buttons).toHaveLength(0)
            } else {
                buttons[buttons.length - 1]!.click()
                await tick()
            }
            expect(msg.data).toBe(mode === 'normal' ? 'Before {{inlay::scene}} middle  after' : data)
            expect(msg.swipes).toEqual(['untouched swipe', msg.data])
            expect(document.querySelector('.message-edit-area')).toBeNull()
        } finally {
            vi.mocked(ParseMarkdown).mockImplementation(async value => value)
        }
    })
    test.each([true, false])('retains the previous reply when sending input with preserveReadingPosition=%s', async (preserve) => {
        DBState.db.preserveChatScrollPosition = preserve
        const character = DBState.db.characters[0]
        const reply = { role: 'char', chatId: 'reply', data: '<p>First line</p><p>Reading here</p>', swipes: ['old', 'current'], swipeId: 1 }
        const state = new SvelteMap<string, any>([['messages', [reply]]])
        const chat = { id: 'room', get message() { return state.get('messages') } }
        character.chats = [chat] as any
        const nextSwipe = vi.fn()
        mounted = mount(Chats, {
            target: document.body,
            props: {
                get messages() { return chat.message }, currentCharacter: character,
                onReroll: vi.fn(), onNextSwipe: nextSwipe, unReroll: vi.fn(),
                currentUsername: 'User', userIcon: '', pageStart: 0,
                get pageEnd() { return chat.message.length },
            },
        })
        await tick(); await tick(); await tick()
        const previousReply = document.querySelector('[data-chat-index="0"]')!
        const paragraph = previousReply.querySelector('.chattext p')!
        expect(paragraph.textContent).toBe('First line')
        expect(previousReply.querySelector('[data-hotkey-action="reroll"]')).not.toBeNull()

        state.set('messages', [reply, { role: 'user', chatId: 'input', data: 'Next input' }])
        await tick(); await tick(); await tick()
        expect(document.querySelector('[data-chat-index="0"]')).toBe(previousReply)
        expect(previousReply.querySelector('.chattext p')).toBe(paragraph)
        expect(previousReply.querySelector('.chattext p')?.outerHTML).toBe(paragraph?.outerHTML)
        expect(previousReply.querySelector('[data-hotkey-action="reroll"]')).toBeNull()
        expect(document.querySelector('[data-chat-index="1"]')?.textContent).toContain('Next input')

        // Removing the new input makes the retained reply the reroll target again.
        state.set('messages', [reply])
        await tick(); await tick(); await tick()
        expect(document.querySelector('[data-chat-index="0"]')).toBe(previousReply)
        expect(previousReply.querySelector('.chattext p')).toBe(paragraph)
        expect(previousReply.querySelector('.chattext p')?.outerHTML).toBe(paragraph?.outerHTML)
        expect(previousReply.textContent).toContain('2/2')
        previousReply.querySelector<HTMLButtonElement>('.button-icon-reroll')!.click()
        expect(nextSwipe).toHaveBeenCalledOnce()
    })

    test('strong continuation replaces the old formatted body without reinserting its released snapshot', async () => {
        DBState.db.preserveChatScrollPosition = false
        DBState.db.streamingDisplayOptimizationMode = 'strong'
        const character = DBState.db.characters[0]
        const state = new SvelteMap<string, any>([['streaming', false], ['text', '<p>Before</p>']])
        const chat = { id: 'room', get isStreaming() { return state.get('streaming') }, message: [{
            role: 'char', chatId: 'reply', get data() { return state.get('text') },
        }] }
        character.chats = [chat] as any
        mounted = mount(Chats, { target: document.body, props: {
            messages: chat.message as any, currentCharacter: character,
            onReroll: vi.fn(), unReroll: vi.fn(), currentUsername: 'User', userIcon: '',
            pageStart: 0, pageEnd: 1,
        } })
        await tick(); await tick(); await tick()
        const before = document.querySelector('.chattext')!
        expect(before.querySelector('[data-painter-body] p')?.textContent).toBe('Before')
        Object.defineProperty(before.closest('.chat-message-container')!, 'offsetHeight', { value: 216 })

        state.set('streaming', true)
        state.set('text', '<p>Before</p> continued')
        await tick(); await tick(); await tick()
        const after = document.querySelector('.chattext')!
        expect(after).not.toBe(before)
        expect(after.querySelector('[data-chat-body-snapshot]')).toBeNull()
        expect(after.querySelector('[data-chat-raw-body]')?.textContent).toBe('<p>Before</p> continued')
        expect(after.closest<HTMLElement>('.chat-message-container')?.style.minHeight).toBe('')
    })

    test.each([
        ['balanced', true], ['strong', true], ['off', true], ['balanced', false],
    ] as const)('finishes %s streaming with preserveReadingPosition=%s', async (mode, preserve) => {
        DBState.db.preserveChatScrollPosition = preserve
        DBState.db.streamingDisplayOptimizationMode = mode
        const character = DBState.db.characters[0]
        const state = new SvelteMap<string, any>([
            ['streaming', true], ['text', '<p>Reading here</p><p>Partial</p>'],
        ])
        const message = {
            role: 'char', chatId: 'reply',
            get data() { return state.get('text') },
            get risubardMemoryConfirmed() { return state.get('confirmed') ?? false },
        }
        const chat = { get id() { return state.get('room') ?? 'room' }, get isStreaming() { return state.get('streaming') }, message: [message] }
        character.chats = [chat] as any
        mounted = mount(Chats, {
            target: document.body,
            props: {
                messages: chat.message as any, currentCharacter: character,
                onReroll: vi.fn(), unReroll: vi.fn(), currentUsername: 'User', userIcon: '',
                pageStart: 0, pageEnd: 1,
            },
        })
        await tick(); await tick(); await tick()
        const messageElement = document.querySelector('[data-chat-index="0"]')
        const readingParagraph = messageElement?.querySelector('.chattext p')
        expect(messageElement).not.toBeNull()
        const parse = vi.mocked(ParseMarkdown)
        let complete!: () => void
        parse.mockClear()
        parse.mockImplementationOnce((value) => new Promise(resolve => {
            complete = () => resolve(value + '<p>Completed response</p>')
        }))
        // The final chunk is identical. No GUI pointer is advanced on this path.
        state.set('streaming', false)
        await tick(); await tick(); await tick()
        const completedElement = document.querySelector('[data-chat-index="0"]')
        expect(parse.mock.calls.map(call => call[3])).toEqual([0])
        expect(completedElement?.textContent).toContain('Reading here')
        expect(completedElement?.textContent).not.toContain('Completed response')
        if (!preserve) expect(completedElement?.querySelector('[data-chat-body-snapshot][inert]')).not.toBeNull()
        if (mode === 'strong') expect(completedElement?.querySelector('.chattext .whitespace-pre-wrap')?.textContent).toContain('<p>Reading here</p>')
        complete()
        await tick(); await tick(); await tick()
        expect(completedElement?.textContent).toContain('Completed response')
        expect(completedElement?.querySelector('[data-chat-body-snapshot]')).toBeNull()
        if (preserve) {
            expect(completedElement).toBe(messageElement)
            if (mode !== 'strong') expect(completedElement?.querySelector('.chattext p')).toBe(readingParagraph)
            // Output post-processing and memory status can arrive after the last token.
            state.set('confirmed', true)
            state.set('text', '<p>Reading here</p><p>Post-processed response</p>')
            await tick(); await tick(); await tick()
            expect(document.querySelector('[data-chat-index="0"]')).toBe(messageElement)
            expect(messageElement?.textContent).toContain('Post-processed response')
        } else {
            expect(completedElement).not.toBe(messageElement)
            expect(completedElement?.textContent).toContain('Completed response')
        }
        document.querySelector<HTMLButtonElement>('.button-icon-edit')!.click()
        await tick()
        expect(document.querySelector<HTMLTextAreaElement>('.message-edit-area')?.value)
            .toBe(preserve ? '<p>Reading here</p><p>Post-processed response</p>' : '<p>Reading here</p><p>Partial</p>')
        if (preserve) {
            state.set('room', 'another-room')
            await tick(); await tick(); await tick()
            expect(document.querySelector('[data-chat-index="0"]')).not.toBe(messageElement)
            expect(document.querySelector('.message-edit-area')).toBeNull()
        }
    })

    test('opens the message textarea when the pencil button is clicked', async () => {
        mounted = mount(Chat, {
            target: document.body,
            props: {
                message: 'editable message',
                name: 'User',
                isLastMemory: false,
                idx: 0,
                role: 'user',
            },
        })
        await tick()

        document.querySelector<HTMLButtonElement>('.button-icon-edit')!.click()
        await tick()

        const editor = document.querySelector<HTMLTextAreaElement>('.message-edit-area')
        expect(editor).not.toBeNull()
        expect(editor?.value).toBe('editable message')
        expect(document.activeElement).toBe(editor)

        editor!.value = 'Unsaved draft'
        editor!.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        ;(mounted as any).updateStreamingDisplay({
            isOptimizedStreamingMessage: false,
            streamingOptimizationMode: 'off',
            rawStreamingText: 'editable message',
        })
        await tick()
        expect(editor?.value).toBe('Unsaved draft')
    })

    test('keeps the editor open inside the live message list', async () => {
        const currentCharacter = DBState.db.characters[0]
        mounted = mount(Chats, {
            target: document.body,
            props: {
                messages: currentCharacter.chats[0].message,
                currentCharacter,
                onReroll: vi.fn(),
                unReroll: vi.fn(),
                currentUsername: 'User',
                userIcon: '',
                pageStart: 0,
                pageEnd: 1,
            },
        })
        await tick()

        document.querySelector<HTMLButtonElement>('.button-icon-edit')!.click()
        await tick()

        expect(document.querySelector<HTMLTextAreaElement>('.message-edit-area')).not.toBeNull()
    })
})
