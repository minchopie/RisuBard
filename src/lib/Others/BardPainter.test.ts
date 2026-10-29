import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { tick } from 'svelte'
import { createClassComponent } from 'svelte/legacy'
import { createPainterChatData, type PainterDraft, type PainterResult } from 'src/ts/bardPainter/types'
import BardPainter from './BardPainter.svelte'
import { painterTestState } from './BardPainterTestState.svelte'
import { painterSelection, painterInsertionRequest } from 'src/ts/bardPainter/selectionState'
import { get } from 'svelte/store'
import { DBState } from 'src/ts/stores.svelte'
import { normalizeTagAutocompleteSettings } from 'src/ts/tagAutocomplete/settings'

vi.mock('src/ts/stores.svelte', () => ({ DBState: { db: {} }, botMakerMode: { set: vi.fn() }, CharConfigSubMenu: { set: vi.fn() }, risuBardGalleryOpen: { set: vi.fn() }, MobileSideBar: { set: vi.fn() } }))
vi.mock('src/ts/bardPainter/gallery', async () => { const { writable } = await import('svelte/store'); return { painterGalleryRequested: writable(null) } })

const runtime = vi.hoisted(() => ({ current: null as any }))
vi.mock('src/ts/bardPainter/runtime.svelte', () => ({ getPainterSession: () => runtime.current }))
const tagSearch = vi.hoisted(() => vi.fn())
vi.mock('src/ts/tagAutocomplete/client', () => ({ searchTags: tagSearch }))

let component: ReturnType<typeof createClassComponent> | undefined
const anchor = { characterId: 'bot', chatId: 'chat', messageId: 'message', start: 4, end: 11, text: '붉은 보석함' }
const draft = (): PainterDraft => ({ rendering: 'watercolor', scene: 'night, indoors', negative: '', subjects: [
    { id: 'aria', name: '아리아', aliases: ['아리'], kind: 'character', appearance: 'black hair', clothing: 'white shirt', state: 'wet clothes', pose: 'standing', negative: '' },
] })
const result = (id = 'result'): PainterResult => ({
    id, assetId: id, createdAt: 1, anchor: { ...anchor }, draft: draft(),
    style: { id: 'ink', name: '잉크', artist: 'artist style', rendering: 'ink', negative: '', steps: 28, scale: 5, cfgRescale: 0, sampler: 'k_euler_ancestral' },
    settings: createPainterChatData().settings, seed: 42,
})
function mount(visible = true) {
    component = createClassComponent({ component: BardPainter, target: document.body, props: { characterId: 'bot', chatId: 'chat', visible } })
}
function button(label: string) {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(el => el.getAttribute('aria-label') === label || el.textContent?.trim() === label)
    expect(found, `button: ${label}`).toBeDefined()
    return found!
}
const exists = (label: string) => [...document.querySelectorAll('button')].some(el => el.getAttribute('aria-label') === label || el.textContent?.trim() === label)
beforeEach(() => {
    DBState.db.tagAutocomplete = normalizeTagAutocompleteSettings()
    tagSearch.mockReset().mockResolvedValue([{ word: 'blue hair', category: 0, frequency: 200, redirect: 'null' }])
    window.getSelection()?.removeAllRanges()
    painterSelection.set(null)
    painterInsertionRequest.set(null)
    const data = createPainterChatData()
    const style = result().style
    runtime.current = painterTestState({
        data, get settings() { return this.data.settings }, chat: { isStreaming: false }, bot: { identities: [] as any[], outfits: [] }, get identities() { return this.bot.identities }, refreshLorePresets: vi.fn(async () => {}), style, styles: [style],
        get botCatalog() { return this.bot }, unreflectedGlobalIdentities: [] as any[], generationSettingsPinned: false, hasGenerationOverrides: false,
        promptPreset: { id: 'current' }, imagePreset: undefined,
        imagePresets: [{ index: 0, preset: { name: 'Image', values: { toggle_detail: '0' } } }], applyImagePreset: vi.fn().mockResolvedValue(true),
        state: { status: 'idle', error: '', notice: '', wikiDocs: [], loadingWiki: false, pendingImage: false },
        outfitChoices: () => [], globalMatchFor: () => undefined, fragments: [],
        ...Object.fromEntries(['prepare', 'generate', 'retrySave', 'cancel', 'insert', 'loadWiki', 'persist', 'saveOutfit', 'applyOutfit', 'rememberIdentity', 'removeResult', 'downloadOriginal', 'restoreDraft', 'clearConversation', 'resetWorkspace', 'autoPruneBlankIdentities', 'changeScene', 'addSubject', 'linkSubject', 'updateContext', 'setReference'].map(name => [name, vi.fn()])),
    })
    data.settings.styleId = style.id
})
afterEach(() => { component?.$destroy(); component = undefined; document.body.replaceChildren() })

describe('BardPainter workspace', () => {
    test('shows the preset frame as labeled tiles and cleans up blank presets once on open', async () => {
        mount(); await tick()
        expect([...document.querySelectorAll('nav[aria-label="바드페인터 도구"] button')].map(el => el.getAttribute('aria-label'))).toEqual(['화풍 프리셋', '캐릭터 프리셋', '생성 설정'])
        expect(document.querySelector('nav[aria-label="바드페인터 도구"]')?.textContent).toContain('잉크')
        expect(button('작업 리셋').textContent?.trim()).toBe('초기화')
        expect(button('캐릭터 분석기').textContent?.trim()).toBe('캐릭터 분석')
        expect(runtime.current.autoPruneBlankIdentities).toHaveBeenCalledOnce()
        expect(document.querySelector('[aria-label="이전 메시지 수"]')).toBeNull()
    })
    test('chooses context in the main panel through the session', async () => {
        mount(); await tick()
        const persona = [...document.querySelectorAll<HTMLButtonElement>('.chip')].find(el => el.textContent?.trim() === '페르소나')!
        expect(persona.getAttribute('aria-pressed')).toBe('false')
        persona.click(); await tick()
        expect(runtime.current.updateContext).toHaveBeenCalledWith({ persona: true })
        button('이전 메시지 늘리기').click(); await tick()
        expect(runtime.current.updateContext).toHaveBeenLastCalledWith({ before: 3 })
        const wiki = [...document.querySelectorAll<HTMLButtonElement>('.chip')].find(el => el.textContent?.includes('바드위키'))!
        wiki.click(); await tick()
        expect(runtime.current.loadWiki).toHaveBeenCalledOnce()
        runtime.current.state.wikiDocs = [{ id: 'w1', title: '아리아 문서', content: '' }]; await tick()
        const check = document.querySelector<HTMLInputElement>('.wiki input')!
        check.checked = true; check.dispatchEvent(new Event('change', { bubbles: true })); await tick()
        expect(runtime.current.updateContext).toHaveBeenLastCalledWith({ wikiIds: ['w1'] })
        runtime.current.state.status = 'prompt'; await tick()
        expect(persona.disabled).toBe(true)
    })
    test('adds person, object and preset blocks before any prompt exists', async () => {
        runtime.current.bot.identities = [{ id: 'seb', name: '세바스찬', aliases: [], appearance: 'black hair' }]
        runtime.current.unreflectedGlobalIdentities = [{ id: 'g-aria', name: '아리아', aliases: [], appearance: 'silver hair' }]
        mount(); await tick()
        expect(runtime.current.data.draft).toBeUndefined()
        button('빈 인물 블록 추가').click(); button('빈 사물 블록 추가').click(); await tick()
        expect(runtime.current.addSubject.mock.calls).toEqual([[{ kind: 'character' }], [{ kind: 'object' }]])
        const select = document.querySelector<HTMLSelectElement>('[aria-label="캐릭터 프리셋으로 블록 추가"]')!
        expect([...select.querySelectorAll('optgroup')].map(group => group.label)).toEqual(['이 봇', '글로벌 (고르면 이 봇에 반영)'])
        select.value = 'global:g-aria'; select.dispatchEvent(new Event('change', { bubbles: true })); await tick()
        expect(runtime.current.addSubject).toHaveBeenLastCalledWith({ globalId: 'g-aria' })
        expect(select.value).toBe('')
        select.value = 'bot:seb'; select.dispatchEvent(new Event('change', { bubbles: true })); await tick()
        expect(runtime.current.addSubject).toHaveBeenLastCalledWith({ identityId: 'seb' })
    })
    test('creates a draft from main-block text and edits the scene of an existing draft', async () => {
        mount(); await tick()
        const main = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="메인 프롬프트"]')!
        main.value = 'garden'; main.dispatchEvent(new Event('input', { bubbles: true })); await tick()
        expect(runtime.current.data.draft).toMatchObject({ scene: 'garden', subjects: [] })
        main.value = 'garden, night'; main.dispatchEvent(new Event('input', { bubbles: true })); await tick()
        expect(runtime.current.data.draft.scene).toBe('garden, night')
    })
    test('keeps fragments as removable chips and style text collapsed', async () => {
        runtime.current.data.draft = { ...draft(), fragments: [{ id: 'light', name: '빛', prompt: 'rim light' }] }
        runtime.current.style.negative = 'blur'
        mount(); await tick()
        expect(document.querySelector<HTMLDetailsElement>('details.style')!.open).toBe(false)
        expect(document.querySelector('details.style')!.textContent).toContain('blur')
        button('빛').click(); await tick()
        const editor = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="표현 조각 빛"]')!
        editor.value = 'soft glow'; editor.dispatchEvent(new Event('input', { bubbles: true })); await tick()
        expect(runtime.current.data.draft.fragments[0].prompt).toBe('soft glow')
        button('표현 조각 빛 빼기').click(); await tick()
        expect(runtime.current.data.draft.fragments).toEqual([])
        button('표현 조각 관리').click(); await tick()
        expect(document.querySelector('[data-painter-tools="fragments"]')).not.toBeNull()
    })
    test('shows the active style, canvas and model in the header', async () => {
        mount(); await tick()
        const meta = () => document.querySelector('[aria-label="현재 화풍과 이미지 형식"]')?.textContent
        expect(meta()).toContain('잉크')
        expect(meta()).toContain('AI 결정')
        runtime.current.data.settings.sizeMode = 'fixed'
        runtime.current.data.settings.width = 1216; runtime.current.data.settings.height = 832
        runtime.current.style.name = '수채화'
        await tick()
        expect(meta()).toContain('1216×832')
        expect(meta()).toContain('수채화')
    })
    test('applies an image preset only on button click', async () => {
        runtime.current.imagePreset = { name: 'Saved image', promptPresetId: 'current', values: {} }
        mount(); await tick()
        const select = document.querySelector<HTMLSelectElement>('[aria-label="이미지 프리셋"]')!
        expect(select.selectedOptions[0].textContent).toContain('Saved image')
        select.value = '0'; select.dispatchEvent(new Event('change', { bubbles: true })); await tick()
        expect(runtime.current.applyImagePreset).not.toHaveBeenCalled()
        button('적용').click(); await tick(); await tick()
        expect(runtime.current.applyImagePreset).toHaveBeenCalledWith(0)
        expect(runtime.current.prepare).not.toHaveBeenCalled()
    })
    test('saves perspective without editing the draft', async () => {
        delete runtime.current.data.settings.perspective
        runtime.current.data.draft = draft()
        const previous = JSON.stringify(runtime.current.data.draft)
        mount(); await tick()
        const group = document.querySelector('[aria-label="그림 시점"]')!
        expect([...group.querySelectorAll('button')].map(el => [el.textContent, el.getAttribute('aria-pressed')])).toEqual([['1인칭', 'false'], ['3인칭', 'true']])
        button('1인칭').click(); await tick()
        expect(runtime.current.data.settings.perspective).toBe('first-person')
        expect(runtime.current.persist).toHaveBeenCalledOnce()
        expect(JSON.stringify(runtime.current.data.draft)).toBe(previous)
    })
    test('previews a fresh selection and fixes it as the scene through the session', async () => {
        mount(); await tick()
        const choose = button('본문에서 선택한 부분을 장면으로 정하기')
        expect(choose.disabled).toBe(true)
        painterSelection.set({ characterId: 'bot', chatId: 'other', anchor: { ...anchor } }); await tick()
        expect(choose.disabled).toBe(true)
        painterSelection.set({ characterId: 'bot', chatId: 'chat', anchor: { ...anchor } }); await tick()
        expect(document.querySelector('blockquote.pending')?.textContent).toBe(anchor.text)
        expect(choose.disabled).toBe(false)
        choose.click(); await tick()
        expect(runtime.current.changeScene).toHaveBeenCalledWith(anchor)
        runtime.current.chat.isStreaming = true; await tick()
        expect(choose.disabled).toBe(true)
    })
    test('replaces a planned scene at once and edits the fixed scene as plain text', async () => {
        runtime.current.data.anchor = { ...anchor }; runtime.current.data.draft = draft()
        painterSelection.set({ characterId: 'bot', chatId: 'chat', anchor: { ...anchor } })
        mount(); await tick()
        const editor = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="장면 글"]')!
        expect(editor.value).toBe(anchor.text)
        editor.value = '고친 장면'; editor.dispatchEvent(new Event('input', { bubbles: true })); await tick()
        expect(runtime.current.data.anchor.text).toBe('고친 장면')
        // Editing the text is not a new selection.
        expect(button('본문에서 새로 선택한 부분으로 장면 바꾸기').disabled).toBe(true)
        const next = { ...anchor, start: 20, end: 28, text: '새 장면' }
        painterSelection.set({ characterId: 'bot', chatId: 'chat', anchor: next }); await tick()
        button('본문에서 새로 선택한 부분으로 장면 바꾸기').click(); await tick()
        expect(runtime.current.changeScene).toHaveBeenCalledWith(next)
    })
    test('confirms workspace reset and clears the selection on success', async () => {
        const current = runtime.current
        current.data.anchor = { ...anchor }; current.data.draft = draft(); current.data.results = [result()]
        current.resetWorkspace.mockImplementation(async () => { current.data.anchor = undefined; current.data.draft = undefined; current.data.results = []; return true })
        mount(); await tick()
        const range = document.createRange()
        range.selectNodeContents(document.querySelector('[aria-label="그릴 장면"] h3')!)
        window.getSelection()!.addRange(range)
        button('작업 리셋').click(); await tick()
        expect(document.body.textContent).toContain('갤러리 이미지')
        expect(current.resetWorkspace).not.toHaveBeenCalled()
        button('취소').click(); await tick()
        button('작업 리셋').click(); await tick()
        button('리셋').click(); await tick(); await tick()
        expect(current.resetWorkspace).toHaveBeenCalledOnce()
        expect(window.getSelection()?.rangeCount).toBe(0)
        expect(document.querySelector('[data-painter-result]')).toBeNull()
        expect(button('프롬프트 작성').disabled).toBe(true)
    })
    test('prevents resetting during streaming', async () => {
        runtime.current.chat.isStreaming = true
        mount(); await tick()
        expect(button('작업 리셋').disabled).toBe(true)
    })
    test('copies only prompt text and reports clipboard failure', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
        runtime.current.data.draft = draft()
        mount(); await tick()
        button('프롬프트 원문 복사').click(); await tick(); await tick()
        expect(writeText).toHaveBeenCalledWith('night, indoors\n\nartist style\n\nink\nwatercolor\n\nblack hair\n\nwhite shirt, wet clothes\n\nstanding')
        expect(document.querySelector('[role="status"]')?.textContent).toContain('복사')
        writeText.mockRejectedValueOnce(new Error('clipboard denied'))
        button('프롬프트 원문 복사').click(); await tick(); await tick()
        expect(document.querySelector('.error[role="alert"]')?.textContent).toContain('복사')
    })
    test('opens the conversation log on demand and clears it only after confirmation', async () => {
        const current = runtime.current
        current.data.anchor = { ...anchor }; current.data.draft = draft()
        current.data.conversation = [{ id: 'request', role: 'user', text: 'earlier request' }]
        current.clearConversation.mockImplementation(async () => { current.data.conversation = []; return true })
        mount(); await tick()
        expect(document.querySelector('[role="log"]')).toBeNull()
        button('대화 기록 1개 보기').click(); await tick()
        expect(document.querySelector('[role="log"]')?.textContent).toContain('earlier request')
        button('프롬프트 대화 비우기').click(); await tick()
        expect(current.clearConversation).not.toHaveBeenCalled()
        button('비우기').click(); await tick(); await tick()
        expect(current.clearConversation).toHaveBeenCalledOnce()
        expect(document.querySelector('[role="log"]')).toBeNull()
        expect(exists('프롬프트 대화 비우기')).toBe(false)
    })
    test('keeps the clear confirmation visible after a failed clear', async () => {
        runtime.current.data.conversation = [{ id: 'request', role: 'user', text: 'keep request' }]
        runtime.current.clearConversation.mockImplementation(async () => { runtime.current.state.error = '저장 실패'; return false })
        mount(); await tick()
        button('프롬프트 대화 비우기').click(); await tick()
        button('비우기').click(); await tick(); await tick()
        expect(document.querySelector('.error')?.textContent).toContain('저장 실패')
        expect(button('비우기').disabled).toBe(false)
    })
    test('inserts the latest image above, below or at a chosen position', async () => {
        runtime.current.data.anchor = { ...anchor }
        runtime.current.data.draft = draft()
        runtime.current.data.results = [result()]
        mount(); await tick()
        button('원문 위에 삽입').click()
        expect(runtime.current.insert).toHaveBeenCalledWith('result', 'before', anchor)
        button('본문에서 삽입 위치 지정').click(); await tick()
        expect(get(painterInsertionRequest)).toMatchObject({ characterId: 'bot', chatId: 'chat', resultId: 'result', messageId: 'message' })
        const position = { ...anchor, start: 7, end: 7 }
        await get(painterInsertionRequest)!.insert(position)
        expect(runtime.current.insert).toHaveBeenLastCalledWith('result', 'after', position)
    })
    test('enables preparation on the first highlight and generation only for a planned scene', async () => {
        mount(); await tick()
        expect(button('프롬프트 작성').disabled).toBe(true)
        expect(button('이미지 생성').disabled).toBe(true)
        painterSelection.set({ characterId: 'bot', chatId: 'chat', anchor: { ...anchor } }); await tick()
        expect(button('프롬프트 작성').disabled).toBe(false)
        button('프롬프트 작성').click()
        expect(runtime.current.prepare).toHaveBeenCalledWith(anchor, expect.objectContaining({ fresh: false }))
        runtime.current.data.anchor = { ...anchor }; runtime.current.data.draft = draft(); await tick()
        expect(button('이미지 생성').disabled).toBe(false)
        expect(exists('처음부터 새로 작성')).toBe(true)
    })
    test('keeps the scene pinned while a new selection becomes the insertion destination', async () => {
        runtime.current.data.anchor = { ...anchor }
        runtime.current.data.draft = draft()
        runtime.current.data.results = [result()]
        mount()
        const destination = { ...anchor, messageId: 'elsewhere', start: 0, end: 20, text: '다른 삽입 위치', insertionUnavailable: true }
        painterSelection.set({ characterId: 'bot', chatId: 'chat', anchor: destination }); await tick()
        expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="장면 글"]')?.value).toBe(anchor.text)
        button('원문 아래에 삽입').click()
        expect(runtime.current.insert).toHaveBeenCalledWith('result', 'after', destination)
    })
    test('sends refinement instructions and rewrites only after confirmation', async () => {
        runtime.current.data.anchor = { ...anchor }; runtime.current.data.draft = draft()
        mount()
        const composer = document.querySelector<HTMLTextAreaElement>('[aria-label="프롬프트 대화 입력"]')!
        composer.value = '구도를 가깝게'
        composer.dispatchEvent(new Event('input', { bubbles: true })); await tick()
        button('초안 개선').click()
        expect(runtime.current.prepare).toHaveBeenCalledWith(anchor, { instruction: '구도를 가깝게', fresh: false })
        button('처음부터 새로 작성').click(); await tick()
        expect(runtime.current.prepare).toHaveBeenCalledOnce()
        button('새로 작성').click(); await tick()
        expect(runtime.current.prepare).toHaveBeenLastCalledWith(anchor, expect.objectContaining({ fresh: true }))
        expect(runtime.current.generate).not.toHaveBeenCalled()
    })
    test('formats composer weights and accepts suggestions without submitting', async () => {
        runtime.current.data.anchor = { ...anchor }
        mount(); await tick()
        const composer = document.querySelector<HTMLTextAreaElement>('[aria-label="프롬프트 대화 입력"]')!
        composer.focus(); composer.value = '1.5::blu::'; composer.setSelectionRange(8, 8)
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'u' }))
        await tick(); await new Promise(resolve => setTimeout(resolve, 0))
        expect(composer.parentElement?.querySelector('[data-tone="strong"]')?.textContent).toContain('blu')
        expect(tagSearch).toHaveBeenCalledWith('blu', expect.any(AbortSignal))
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
        await tick()
        expect(runtime.current.data.settings.instruction).toBe('1.5::blue hair::')
        expect(runtime.current.prepare).not.toHaveBeenCalled()
        for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
            composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...modifier }))
            await tick()
        }
        expect(runtime.current.prepare).toHaveBeenCalledTimes(2)
        expect(runtime.current.prepare).toHaveBeenLastCalledWith(anchor, { instruction: '1.5::blue hair::', fresh: false })
    })
    test('gives configured autocomplete shortcuts priority over prompt submission', async () => {
        DBState.db.tagAutocomplete = normalizeTagAutocompleteSettings({ hotkeys: { accept: [{ key: 'Enter', ctrl: true, alt: false, shift: false, meta: false }] } })
        runtime.current.data.anchor = { ...anchor }
        mount(); await tick()
        const composer = document.querySelector<HTMLTextAreaElement>('[aria-label="프롬프트 대화 입력"]')!
        composer.focus(); composer.value = 'blu'; composer.setSelectionRange(3, 3)
        composer.dispatchEvent(new InputEvent('input', { bubbles: true, data: 'u' }))
        await tick(); await new Promise(resolve => setTimeout(resolve, 0))
        composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
        await tick()
        expect(composer.value).toBe('blue hair')
        expect(runtime.current.prepare).not.toHaveBeenCalled()
    })
    test('keeps IME confirmation and composer submission from triggering outer shortcuts', async () => {
        runtime.current.data.anchor = { ...anchor }
        mount(); await tick()
        const composer = document.querySelector<HTMLTextAreaElement>('[aria-label="프롬프트 대화 입력"]')!
        const outer = vi.fn()
        document.body.addEventListener('keydown', outer)
        try {
            composer.focus()
            composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true }))
            expect(runtime.current.prepare).not.toHaveBeenCalled()
            composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
            expect(runtime.current.prepare).toHaveBeenCalledOnce()
            expect(outer).not.toHaveBeenCalled()
        } finally { document.body.removeEventListener('keydown', outer) }
    })
    test('renders only the latest of many results and opens the gallery', () => {
        runtime.current.data.results = Array.from({ length: 300 }, (_, i) => ({ ...result(`result-${i}`), createdAt: i }))
        mount()
        expect(document.querySelectorAll('img')).toHaveLength(1)
        expect(document.querySelector('[data-painter-result]')?.getAttribute('data-painter-result')).toBe('result-299')
        expect(button('갤러리 열기')).toBeDefined()
    })
    test('does not insert incomplete compressed images and keeps recovery actions', () => {
        runtime.current.state.pendingImage = true
        runtime.current.data.results = [{ ...result(), compressionPending: true }]
        mount()
        expect(button('원문 아래에 삽입').disabled).toBe(true)
        button('저장 다시 시도').click(); button('원본 다운로드').click()
        expect(runtime.current.retrySave).toHaveBeenCalledOnce()
        expect(runtime.current.downloadOriginal).toHaveBeenCalledOnce()
    })
    test('unmounts preview images when the painter view is hidden', async () => {
        runtime.current.data.results = [result()]
        mount()
        expect(document.querySelectorAll('img')).toHaveLength(1)
        component!.$set({ visible: false }); await tick()
        expect(document.querySelectorAll('img')).toHaveLength(0)
    })
})
