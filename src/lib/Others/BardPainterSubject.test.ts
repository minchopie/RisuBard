import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { tick } from 'svelte'
import { createClassComponent } from 'svelte/legacy'
import BardPainterSubject from './BardPainterSubject.svelte'
import { painterTestState } from './BardPainterTestState.svelte'

let component: ReturnType<typeof createClassComponent> | undefined
let session: any
let subject: any
const onMove = vi.fn(), onRemove = vi.fn()
async function mount(disabled = false) {
    component = createClassComponent({ component: BardPainterSubject, target: document.body,
        props: { subject, session, disabled, index: 0, total: 2, onMove, onRemove } })
    await tick()
}
const field = <T extends HTMLElement = HTMLTextAreaElement>(selector: string) => document.querySelector<T>(selector)!
const byLabel = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
async function type(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
    element.value = value
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new Event('blur'))
    await tick()
}
beforeEach(() => {
    onMove.mockReset(); onRemove.mockReset()
    const cape = { id: 'cape', subjectId: 'saved-person', name: 'Travel cape', clothing: 'green cape', state: 'dusty' }
    session = painterTestState({
        data: { draft: { subjects: [{ id: 'draft-person', name: 'Current', aliases: [], kind: 'character', appearance: 'short hair', clothing: 'old jacket', state: '', pose: 'looking left', negative: '' }] }, outfits: [] },
        bot: { identities: [{ id: 'saved-person', name: 'Saved', aliases: ['Alias'], appearance: 'long hair' }], outfits: [cape] }, get identities() { return this.bot.identities },
        unreflectedGlobalIdentities: [{ id: 'g-current', name: 'Current', aliases: [], appearance: 'global look' }],
        globalMatchFor(item: any) { return item.id === 'saved-person' ? undefined : this.unreflectedGlobalIdentities.find((global: any) => global.name === item.name) },
        outfitChoices(id: string) { return id === 'saved-person' ? [cape] : [] },
        state: { notice: '', error: '' },
        persist: vi.fn().mockResolvedValue(undefined), rememberIdentity: vi.fn(), saveOutfit: vi.fn().mockResolvedValue('new'),
        applyOutfit: vi.fn(), linkSubject: vi.fn(),
    })
    subject = session.data.draft.subjects[0]
})
afterEach(() => { component?.$destroy(); component = undefined; document.body.replaceChildren() })

describe('subject block', () => {
    test('separates appearance, clothing, state and pose fields', async () => {
        await mount()
        expect(field('#subject-draft-person-appearance').value).toBe('short hair')
        expect(field('#subject-draft-person-clothing').value).toBe('old jacket')
        expect(field('#subject-draft-person-pose').value).toBe('looking left')
        await type(field('#subject-draft-person-clothing'), 'red coat')
        await type(field<HTMLInputElement>('[aria-label="대상 1 상태"]'), 'wet')
        expect(subject).toMatchObject({ clothing: 'red coat', state: 'wet', appearance: 'short hair' })
        expect(session.persist).toHaveBeenCalled()
    })
    test('marks hand-edited appearance so revisions keep it', async () => {
        await mount()
        await type(field('#subject-draft-person-appearance'), 'braided hair')
        expect(subject.appearanceEdited).toBe(true)
        await type(field('#subject-draft-person-appearance'), '')
        expect(subject.appearanceEdited).toBeUndefined()
    })
    test('reverts an edited preset look and saves a new look as a preset', async () => {
        Object.assign(subject, { id: 'saved-person', name: 'Saved', appearance: 'edited hair', appearanceEdited: true, presetMatch: 'name' })
        await mount()
        expect(document.querySelector('[data-preset-match="name"]')?.textContent).toContain('프리셋')
        expect(document.body.textContent).toContain('직접 수정함')
        byLabel('프리셋 외형을 이 내용으로 덮어쓰기').click()
        expect(session.rememberIdentity).toHaveBeenCalledWith('saved-person')
        byLabel('프리셋 외형으로 되돌리기').click(); await tick()
        expect(subject.appearance).toBe('long hair')
        expect(subject.appearanceEdited).toBeUndefined()
        expect(document.body.textContent).not.toContain('직접 수정함')
    })
    test('loads a bot or global character through the session', async () => {
        await mount()
        const select = field<HTMLSelectElement>('[aria-label="대상 1 캐릭터 불러오기"]')
        expect([...select.querySelectorAll('optgroup')].map(group => group.label)).toEqual(['글로벌 (고르면 이 봇에 반영)'])
        select.value = 'bot:saved-person'; select.dispatchEvent(new Event('change', { bubbles: true })); await tick()
        expect(session.linkSubject).toHaveBeenCalledWith('draft-person', { identityId: 'saved-person' })
        expect(select.value).toBe('')
        select.value = 'global:g-current'; select.dispatchEvent(new Event('change', { bubbles: true })); await tick()
        expect(session.linkSubject).toHaveBeenLastCalledWith('draft-person', { globalId: 'g-current' })
    })
    test('explains and reflects a same-named global character', async () => {
        await mount()
        expect(document.querySelector('.global')?.textContent).toContain('「Current」이 이 봇에 없어서')
        ;[...document.querySelectorAll<HTMLButtonElement>('.global button')][0].click()
        expect(session.linkSubject).toHaveBeenCalledWith('draft-person', { globalId: 'g-current' })
    })
    test('applies outfits and flags hand edits of the selected outfit', async () => {
        Object.assign(subject, { id: 'saved-person', outfitId: 'cape', clothing: 'green cape' })
        await mount()
        const select = field<HTMLSelectElement>('[aria-label="대상 1 의상 불러오기"]')
        select.value = 'cape'; select.dispatchEvent(new Event('change', { bubbles: true })); await tick()
        expect(session.applyOutfit).toHaveBeenCalledWith('saved-person', 'cape')
        await type(field('#subject-saved-person-clothing'), 'green cape, torn')
        expect(subject.outfitEdited).toBe(true)
    })
    test('keeps rare controls behind more and confirms deletion', async () => {
        await mount()
        expect(document.querySelector('[data-subject-more]')).toBeNull()
        byLabel('Current 더 보기').click(); await tick()
        expect(document.querySelector('[aria-label="대상 1 별칭"]')).not.toBeNull()
        byLabel('Current 아래로').click()
        expect(onMove).toHaveBeenCalledWith(1)
        byLabel('Current 블록 삭제').click(); await tick()
        expect(onRemove).not.toHaveBeenCalled()
        ;[...document.querySelectorAll('button')].find(el => el.textContent === '삭제')!.click()
        expect(onRemove).toHaveBeenCalledOnce()
    })
    test('toggles lock and kind, and collapses the fields', async () => {
        await mount()
        byLabel('AI로 개선할 때 이 블록 유지').click(); await tick()
        expect(subject.locked).toBe(true)
        byLabel('인물 블록 (누르면 사물로 바꿈)').click(); await tick()
        expect(subject.kind).toBe('object')
        expect(document.querySelector('[aria-label="대상 1 캐릭터 불러오기"]')).toBeNull()
        byLabel('Current 접기').click(); await tick()
        expect(document.querySelector('fieldset')).toBeNull()
    })
    test('disables editing during generation', async () => {
        await mount(true)
        expect(document.querySelector('fieldset')?.disabled).toBe(true)
        expect(field<HTMLInputElement>('[aria-label="대상 1 이름"]').disabled).toBe(true)
    })
})
