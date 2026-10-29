import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tick } from 'svelte'
import { createClassComponent } from 'svelte/legacy'
import BardPainterGallery from './BardPainterGallery.svelte'
import { painterTestState } from './BardPainterTestState.svelte'
import { createPainterChatData } from 'src/ts/bardPainter/types'

const mocks = vi.hoisted(() => ({
    list: vi.fn(), blob: vi.fn(), remove: vi.fn(), load: vi.fn(), preserve: vi.fn(), confirm: vi.fn(), error: vi.fn(), success: vi.fn(), copy: vi.fn(), busy: vi.fn(), save: vi.fn(), getSession: vi.fn(), setReference: vi.fn(),
}))
vi.mock('src/ts/process/files/inlays', () => ({ listInlayExplorerItems: mocks.list, getInlayAssetBlob: mocks.blob, removeInlayAsset: mocks.remove }))
vi.mock('src/ts/alert', () => ({ alertConfirm: mocks.confirm, notifyError: mocks.error, notifySuccess: mocks.success }))
vi.mock('src/ts/globalApi.svelte', () => ({ requestImmediateSave: mocks.save }))
vi.mock('src/ts/bardPainter/runtime.svelte', () => ({ isPainterChatBusy: mocks.busy, getPainterSession: mocks.getSession }))
vi.mock('src/ts/storage/nodeStorage', () => ({ NodeStorage: class {} }))
vi.mock('src/ts/bardPainter/gallery', async (original) => ({ ...await original<any>(), loadPainterGalleryRecord: mocks.load, preservePainterChatsGallery: mocks.preserve }))
let component: ReturnType<typeof createClassComponent> | undefined
let bot: any
const item = (n: number, chatId = 'chat') => ({ id: `image-${n}`, name: `Image ${n}`, ext: 'webp', type: 'image', hasMeta: true, meta: { charId: 'bot', chatId, createdAt: n + 1, updatedAt: n + 1 } })
const record = () => ({ version: 1, chatName: '예시 챗', result: { draft: { rendering: '', scene: 'quiet garden', negative: 'blur', subjects: [] }, style: { artist: '', rendering: '', negative: '', steps: 28, scale: 5, sampler: 'k_euler_ancestral', name: '기본' }, settings: { model: 'nai-diffusion-5-full', width: 832, height: 1216 }, seed: 42 } })
async function settle() { for (let i = 0; i < 5; i++) { await Promise.resolve(); await tick() } }
async function mount(items: any[], props: Record<string, unknown> = {}) {
    mocks.list.mockResolvedValue(items)
    component = createClassComponent({ component: BardPainterGallery, target: document.body, props: { bot, ...props } })
    await settle()
}
beforeEach(() => {
    vi.resetAllMocks()
    bot = painterTestState({ chaId: 'bot', chatPage: 0, chats: [{ id: 'chat', name: '예시 챗', message: [] }, { id: 'empty', name: '빈 챗', message: [] }] })
    mocks.load.mockResolvedValue(null); mocks.blob.mockResolvedValue(null); mocks.confirm.mockResolvedValue(true); mocks.remove.mockResolvedValue(undefined)
    mocks.busy.mockReturnValue(false); mocks.save.mockResolvedValue(undefined)
    mocks.setReference.mockResolvedValue(true)
    mocks.getSession.mockImplementation((characterId: string, chatId: string) => {
        const chat = bot.chats.find((entry: any) => entry.id === chatId)
        chat.bardPainter ??= createPainterChatData()
        return {
            characterId, chatId, data: chat.bardPainter, state: { status: 'idle', error: '', pendingImage: false },
            async setReference(assetId: string) {
                const saved = await mocks.setReference(assetId)
                if (saved) { chat.bardPainter.settings.context.referenceAssetId = assetId; chat.bardPainter.settings.context.referenceId = '' }
                return saved
            },
        }
    })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: mocks.copy.mockResolvedValue(undefined) } })
})
afterEach(() => { component?.$destroy(); component = undefined; document.body.replaceChildren() })

describe('BardPainter gallery UI', () => {
    it('deletes one card in one click without opening the viewer or confirmation and clears its saved references', async () => {
        const data = createPainterChatData()
        data.results = [{ id: 'old', assetId: 'image-1' }, { id: 'keep', assetId: 'image-2' }] as any
        data.settings.context.referenceId = 'old'
        bot.chats[0].bardPainter = data
        bot.chats[1].bardPainter = createPainterChatData()
        bot.chats[1].bardPainter.settings.context.referenceAssetId = 'image-1'
        await mount([item(1), item(2)])
        const button = document.querySelector<HTMLButtonElement>('[data-gallery-delete="image-1"]')
        expect(button).not.toBeNull()
        button!.click()
        await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce())
        expect(mocks.remove).toHaveBeenCalledExactlyOnceWith('image-1')
        expect(mocks.confirm).not.toHaveBeenCalled()
        expect(document.querySelector('[role="dialog"]')).toBeNull()
        expect(document.querySelector('[data-gallery-image="image-1"]')).toBeNull()
        expect(document.querySelector('[data-gallery-image="image-2"]')).not.toBeNull()
        expect(bot.chats[0].bardPainter.results.map((result: any) => result.assetId)).toEqual(['image-2'])
        expect(bot.chats[0].bardPainter.settings.context.referenceId).toBe('')
        expect(bot.chats[1].bardPainter.settings.context.referenceAssetId).toBe('')
    })
    it('retains a card and its record after deletion fails', async () => {
        bot.chats[0].bardPainter = createPainterChatData()
        bot.chats[0].bardPainter.results = [{ id: 'old', assetId: 'image-1' }]
        mocks.remove.mockRejectedValueOnce(new Error('disk unavailable'))
        await mount([item(1)])
        const button = document.querySelector<HTMLButtonElement>('[data-gallery-delete="image-1"]')
        expect(button).not.toBeNull()
        button!.click()
        await vi.waitFor(() => expect(mocks.error).toHaveBeenCalled())
        expect(document.querySelector('[data-gallery-image="image-1"]')).not.toBeNull()
        expect(bot.chats[0].bardPainter.results).toHaveLength(1)
        expect(mocks.save).not.toHaveBeenCalled()
        expect(mocks.success).not.toHaveBeenCalled()
    })
    it('prevents repeated deletion while the selected image is being removed', async () => {
        let finish!: () => void
        mocks.remove.mockImplementationOnce(() => new Promise<void>(resolve => finish = resolve))
        await mount([item(1), item(2)])
        const button = document.querySelector<HTMLButtonElement>('[data-gallery-delete="image-1"]')
        expect(button).not.toBeNull()
        button!.click(); button!.click()
        await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledOnce())
        expect(document.querySelector<HTMLButtonElement>('[data-gallery-delete="image-2"]')!.disabled).toBe(true)
        expect(document.querySelector<HTMLButtonElement>('[aria-label="갤러리 새로고침"]')!.disabled).toBe(true)
        finish()
        await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce())
        expect(mocks.remove).toHaveBeenCalledOnce()
    })
    it('returns to the preceding page when its last image is deleted', async () => {
        await mount(Array.from({ length: 25 }, (_, n) => item(n)))
        document.querySelector<HTMLButtonElement>('[aria-label="다음 그림 페이지"]')!.click(); await settle()
        const button = document.querySelector<HTMLButtonElement>('[data-gallery-delete="image-0"]')
        expect(button).not.toBeNull()
        button!.click()
        await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce())
        await settle()
        expect(document.querySelectorAll('[data-gallery-image]')).toHaveLength(24)
        expect(document.querySelector('[aria-label="그림 갤러리 페이지"]')?.textContent).toContain('1 / 1')
    })
    it.each(['source', 'reference', 'compression'])('keeps an image while %s work depends on it', async mode => {
        if (mode === 'reference') {
            bot.chats[1].bardPainter = createPainterChatData()
            bot.chats[1].bardPainter.settings.context.referenceAssetId = 'image-1'
            mocks.busy.mockImplementation((_bot, chatId) => chatId === 'empty')
        } else if (mode === 'compression') {
            bot.chats[0].bardPainter = createPainterChatData()
            bot.chats[0].bardPainter.results = [{ id: 'old', assetId: 'image-1', compressionPending: true }]
        } else mocks.busy.mockReturnValue(true)
        await mount([item(1)])
        const button = document.querySelector<HTMLButtonElement>('[data-gallery-delete="image-1"]')
        expect(button).not.toBeNull()
        button!.click()
        await vi.waitFor(() => expect(mocks.error).toHaveBeenCalled())
        expect(mocks.remove).not.toHaveBeenCalled()
    })
    it('assigns an enlarged image to the current chat, independently of its source and gallery filter', async () => {
        mocks.load.mockResolvedValue(record())
        bot.chatPage = 1
        await mount([item(1)])
        const filter = document.querySelector<HTMLSelectElement>('[aria-label="갤러리 챗"]')!
        filter.value = 'chat'; filter.dispatchEvent(new Event('change', { bubbles: true })); await settle()
        document.querySelector<HTMLButtonElement>('[data-gallery-image]')!.click(); await settle()
        expect(document.body.textContent).toContain('현재 챗: 빈 챗')
        document.querySelector<HTMLButtonElement>('[data-gallery-reference]')!.click()
        await vi.waitFor(() => expect(mocks.setReference).toHaveBeenCalledWith('image-1'))
        expect(mocks.getSession).toHaveBeenCalledWith('bot', 'empty')
        await vi.waitFor(() => expect(document.body.textContent).toContain('참고 삽화로 지정했습니다.'))
        expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    })
    it('keeps the viewer action synchronized when the current-chat reference is assigned and cleared', async () => {
        mocks.load.mockResolvedValue(record())
        const session = mocks.getSession('bot', 'chat')
        await mount([item(1)])
        document.querySelector<HTMLButtonElement>('[data-gallery-image]')!.click(); await settle()
        document.querySelector<HTMLButtonElement>('[data-gallery-reference]')!.click()
        await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-gallery-reference]')!.disabled).toBe(true))
        await session.setReference('')
        await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('[data-gallery-reference]')!.disabled).toBe(false))
        expect(document.querySelector<HTMLButtonElement>('[data-gallery-reference]')!.textContent).toContain('참고 삽화 지정')
        expect(document.body.textContent).not.toContain('참고 삽화로 지정했습니다.')
    })
    it('disables reference assignment for images without generation information', async () => {
        await mount([item(1)])
        document.querySelector<HTMLButtonElement>('[data-gallery-image]')!.click(); await settle()
        expect(document.querySelector<HTMLButtonElement>('[data-gallery-reference]')!.disabled).toBe(true)
        expect(document.body.textContent).toContain('생성 정보가 없는 그림은 참고 삽화로 지정할 수 없습니다.')
        expect(mocks.getSession).not.toHaveBeenCalled()
    })
    it('recognizes a legacy reference and does not assign it twice', async () => {
        mocks.load.mockResolvedValue(record())
        bot.chats[0].bardPainter = { settings: { context: { referenceId: 'previous' } }, results: [{ id: 'previous', assetId: 'image-1' }] }
        await mount([item(1)])
        document.querySelector<HTMLButtonElement>('[data-gallery-image]')!.click(); await settle()
        const button = document.querySelector<HTMLButtonElement>('[data-gallery-reference]')!
        expect(button.disabled).toBe(true)
        expect(button.textContent).toContain('참고 삽화로 지정됨')
    })
    it.each(['placeholder', 'streaming', 'missing', 'disabled'])('disables reference assignment when current chat is %s', async mode => {
        mocks.load.mockResolvedValue(record())
        if (mode === 'placeholder') bot.chats[0]._placeholder = true
        if (mode === 'streaming') bot.chats[0].isStreaming = true
        if (mode === 'missing') bot.chatPage = 9
        await mount([item(1)])
        document.querySelector<HTMLButtonElement>('[data-gallery-image]')!.click(); await settle()
        if (mode === 'disabled') { component!.$set({ disabled: true }); await tick() }
        expect(document.querySelector<HTMLButtonElement>('[data-gallery-reference]')!.disabled).toBe(true)
        document.querySelector<HTMLButtonElement>('[data-gallery-reference]')!.click()
        expect(mocks.getSession).not.toHaveBeenCalled()
    })
    it('pins a pending assignment to the clicked chat and hides its feedback after switching chats', async () => {
        mocks.load.mockResolvedValue(record())
        let finish!: (saved: boolean) => void
        mocks.setReference.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
        await mount([item(1)])
        document.querySelector<HTMLButtonElement>('[data-gallery-image]')!.click(); await settle()
        const button = document.querySelector<HTMLButtonElement>('[data-gallery-reference]')!
        button.click(); button.click()
        await vi.waitFor(() => expect(mocks.setReference).toHaveBeenCalledOnce())
        bot.chatPage = 1; await settle()
        finish(true); await settle()
        expect(mocks.getSession).toHaveBeenCalledExactlyOnceWith('bot', 'chat')
        expect(document.body.textContent).toContain('현재 챗: 빈 챗')
        expect(document.body.textContent).not.toContain('참고 삽화로 지정했습니다.')
    })
    it('shows a failed assignment inline without closing the image', async () => {
        mocks.load.mockResolvedValue(record())
        mocks.setReference.mockResolvedValueOnce(false)
        mocks.getSession.mockReturnValue({ setReference: mocks.setReference, state: { error: '저장 실패' } })
        await mount([item(1)])
        document.querySelector<HTMLButtonElement>('[data-gallery-image]')!.click(); await settle()
        document.querySelector<HTMLButtonElement>('[data-gallery-reference]')!.click()
        await vi.waitFor(() => expect(document.querySelector('[data-gallery-reference-error]')?.textContent).toContain('저장 실패'))
        expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    })
    it('does not show a previous image assignment failure after navigating to another image', async () => {
        mocks.load.mockResolvedValue(record())
        let finish!: (saved: boolean) => void
        mocks.setReference.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
        await mount([item(1), item(2)])
        document.querySelector<HTMLButtonElement>('[data-gallery-image="image-2"]')!.click(); await settle()
        document.querySelector<HTMLButtonElement>('[data-gallery-reference]')!.click()
        await vi.waitFor(() => expect(mocks.setReference).toHaveBeenCalledWith('image-2'))
        document.querySelector<HTMLButtonElement>('[aria-label="다음 그림"]')!.click(); await settle()
        finish(false); await settle()
        expect(document.querySelector('[data-gallery-reference-error]')).toBeNull()
        expect(document.querySelector<HTMLButtonElement>('[data-gallery-reference]')!.disabled).toBe(false)
        expect(document.querySelector<HTMLButtonElement>('[data-gallery-reference]')!.textContent).toContain('참고 삽화 지정')
    })
    it('bounds the grid to 24 lazy thumbnails and fetches only the opened original', async () => {
        await mount(Array.from({ length: 50 }, (_, n) => item(n)))
        expect(document.querySelectorAll('[data-gallery-image]')).toHaveLength(24)
        expect([...document.querySelectorAll('img')].every(img => img.loading === 'lazy')).toBe(true)
        expect(mocks.blob).not.toHaveBeenCalled()
        document.querySelector<HTMLButtonElement>('[aria-label="다음 그림 페이지"]')!.click(); await tick()
        expect(document.querySelector('[data-gallery-image]')?.getAttribute('data-gallery-image')).toBe('image-25')
        document.querySelector<HTMLButtonElement>('[data-gallery-image]')!.click(); await settle()
        expect(mocks.blob).toHaveBeenCalledExactlyOnceWith('image-25')
        expect(document.body.textContent).toContain('저장된 생성 정보가 없는 그림입니다.')
    })
    it('offers all first and groups deleted chats without losing their images', async () => {
        await mount([item(1), item(2, 'deleted-a'), item(3, 'deleted-b')])
        const select = document.querySelector<HTMLSelectElement>('[aria-label="갤러리 챗"]')!
        expect(select.options[0].textContent).toBe('모두 (3장)')
        select.selectedIndex = [...select.options].findIndex(option => option.value === '__deleted__')
        expect(select.value).toBe('__deleted__')
        select.dispatchEvent(new Event('change', { bubbles: true })); await settle()
        expect(select.value).toBe('__deleted__')
        expect(document.querySelectorAll('[data-gallery-image]')).toHaveLength(2)
        const removeButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('이 분류 모두 삭제'))!
        removeButton.click(); await settle()
        await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce())
        expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining('본문에 삽입한 그림도 더 이상 표시되지'))
        expect(mocks.remove.mock.calls.map(call => call[0])).toEqual(['image-3', 'image-2'])
        expect(mocks.remove).not.toHaveBeenCalledWith('image-1')
        expect(mocks.save).toHaveBeenCalledOnce()
    })
    it('keeps images while their chat is generating or saving a painter result', async () => {
        await mount([item(1)])
        const select = document.querySelector<HTMLSelectElement>('[aria-label="갤러리 챗"]')!
        select.value = 'chat'; select.dispatchEvent(new Event('change', { bubbles: true })); await settle()
        mocks.busy.mockReturnValue(true)
        const removeButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('이 분류 모두 삭제'))!
        removeButton.click(); await settle()
        await vi.waitFor(() => expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('작업이나 이미지 저장')))
        expect(mocks.remove).not.toHaveBeenCalled()
    })
    it('copies separate saved prompt blocks and keeps originals unloaded when a generation record exists', async () => {
        mocks.load.mockResolvedValue({ version: 1, chatName: '예시 챗', result: { draft: { rendering: '', scene: 'quiet garden', negative: 'blur', subjects: [] }, style: { artist: '', rendering: '', negative: '', steps: 28, scale: 5, sampler: 'k_euler_ancestral', name: '기본' }, settings: { model: 'nai-diffusion-5-full', width: 832, height: 1216 }, seed: 42 } })
        await mount([item(1)])
        document.querySelector<HTMLButtonElement>('[data-gallery-image]')!.click(); await settle()
        document.querySelector<HTMLButtonElement>('[aria-label="메인 프롬프트 복사"]')!.click(); await settle()
        expect(mocks.copy).toHaveBeenCalledWith('quiet garden')
        expect(mocks.blob).not.toHaveBeenCalled()
        expect(document.body.textContent).toContain('42')
    })
})

describe('BardPainter gallery selection', () => {
    const click = (id: string, init: MouseEventInit = {}) => document.querySelector<HTMLButtonElement>(`[data-gallery-image="${id}"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true, ...init }))
    it('selects with Ctrl and Shift, selects all and deletes the selection after one confirmation', async () => {
        await mount([item(1), item(2), item(3), item(4)])
        click('image-4', { ctrlKey: true }); await settle()
        expect(document.querySelector('[role="dialog"]')).toBeNull()
        click('image-2', { shiftKey: true }); await settle()
        expect(document.querySelector('[data-gallery-selection]')!.textContent).toContain('3장 선택')
        // With a selection, a plain click toggles instead of opening the viewer.
        click('image-3'); await settle()
        expect(document.querySelector('[data-gallery-selection]')!.textContent).toContain('2장 선택')
        const deleteButton = [...document.querySelectorAll<HTMLButtonElement>('[data-gallery-selection] button')].find(button => button.textContent?.includes('삭제'))!
        deleteButton.click()
        await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledTimes(2))
        expect(mocks.confirm).toHaveBeenCalledOnce()
        expect(mocks.remove.mock.calls.map(call => call[0]).sort()).toEqual(['image-2', 'image-4'])
        const selectAll = [...document.querySelectorAll<HTMLButtonElement>('[data-gallery-selection] button')].find(button => button.textContent?.includes('모두 선택'))!
        selectAll.click(); await settle()
        expect(document.querySelector('[data-gallery-selection]')!.textContent).toContain('2장 선택')
    })
    it('filters by whether a chat still shows the image, reading unloaded chats without loading them', async () => {
        bot.chats[0].message = [{ role: 'char', data: 'a {{inlay::image-1}}', swipes: ['b {{inlay::image-3}}'] }]
        await mount([item(1), item(2), item(3)])
        const select = document.querySelector<HTMLSelectElement>('[aria-label="본문 사용 여부"]')!
        select.value = 'unused'; select.dispatchEvent(new Event('change', { bubbles: true }))
        await vi.waitFor(() => expect([...document.querySelectorAll('[data-gallery-image]')].map(element => element.getAttribute('data-gallery-image'))).toEqual(['image-2']))
        select.value = 'used'; select.dispatchEvent(new Event('change', { bubbles: true })); await settle()
        expect([...document.querySelectorAll('[data-gallery-image]')].map(element => element.getAttribute('data-gallery-image')).sort()).toEqual(['image-1', 'image-3'])
    })
    it('changes the thumbnail grid size', async () => {
        await mount([item(1)])
        const select = document.querySelector<HTMLSelectElement>('[aria-label="썸네일 크기"]')!
        select.value = 'small'; select.dispatchEvent(new Event('change', { bubbles: true })); await settle()
        expect(document.querySelector('[data-gallery-image]')!.parentElement!.parentElement!.classList.contains('grid-cols-3')).toBe(true)
    })
})
