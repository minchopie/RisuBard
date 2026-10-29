import { afterEach, describe, expect, test, vi } from 'vitest'
import { tick } from 'svelte'
import { createClassComponent } from 'svelte/legacy'
import RisuBardOocNotepad from './RisuBardOocNotepad.svelte'
import type { Message } from 'src/ts/storage/database.svelte'
import { DBState } from 'src/ts/stores.svelte'

vi.mock('src/ts/stores.svelte', () => ({
    DBState: { db: { zoomsize: 100, lineHeight: 1.25 } },
    selIdState: { selId: -1 },
}))

let component: ReturnType<typeof createClassComponent> | undefined
afterEach(() => {
    component?.$destroy()
    component = undefined
    document.body.replaceChildren()
    delete DBState.db.risuBardOocMarkdown
    delete DBState.db.risuBardOocFontSize
})

const transcript = (): Message[] => [
    { role: 'user', data: 'Story request', chatId: 'u1' },
    { role: 'char', data: 'Story response', chatId: 'a1' },
    { role: 'user', data: 'Plan the ending', chatId: 'u2' },
    { role: 'char', data: '<!-- OOC_turn --> **A secret door**', chatId: 'a2' },
]

describe('OOC live notepad', () => {
    test('navigates groups, reveals the exact source, and switches Markdown off', async () => {
        const calls: unknown[] = []
        component = createClassComponent({
            component: RisuBardOocNotepad, target: document.body,
            props: {
                messages: [...transcript(), { role: 'char', data: 'Normal response' },
                    { role: 'user', data: 'Another idea' },
                    { role: 'char', data: '<!-- OOC_turn --> **Other group**' }],
                hideOoc: true,
                onHideChange: (value: boolean) => calls.push(value),
                onNavigate: (index: number) => calls.push(index),
            },
        })
        const groupSelect = document.querySelector<HTMLSelectElement>('[data-ooc-group]')!
        expect([...groupSelect.options].map(option => option.textContent)).toEqual(['턴 2', '턴 4'])
        document.querySelector<HTMLButtonElement>('[data-ooc-group-next]')!.click()
        await tick()
        expect(document.querySelector('[data-ooc-message-index="3"]')).toBeNull()
        document.querySelector<HTMLButtonElement>('[data-ooc-message-index="6"] [data-ooc-source]')!.click()
        expect(calls).toEqual([false, 6])
        const size = document.querySelector<HTMLInputElement>('[aria-label="메모장 글자 크기"]')!
        size.value = '20'
        size.dispatchEvent(new Event('change', { bubbles: true }))
        await tick()
        expect(DBState.db.risuBardOocFontSize).toBe(20)
        expect(document.querySelector<HTMLElement>('.content')?.style.fontSize).toBe('20px')
        document.querySelector<HTMLInputElement>('[data-ooc-md]')!.click()
        await tick()
        expect(document.querySelector('[data-ooc-message-index="6"] .content')?.textContent).toContain('**Other group**')
        expect(document.querySelector('[data-ooc-message-index="6"] strong')).toBeNull()
        expect(DBState.db.risuBardOocMarkdown).toBe(false)
        document.querySelector<HTMLButtonElement>('[data-ooc-group-previous]')!.click()
        await tick()
        expect(document.querySelector('[data-ooc-message-index="3"]')).not.toBeNull()
        const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
        search.value = 'Other group'
        search.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        expect(groupSelect.options).toHaveLength(1)
        expect(document.querySelector('[data-ooc-message-index="6"]')).not.toBeNull()
        document.querySelector<HTMLButtonElement>('[data-ooc-help]')!.click()
        await tick()
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('<!-- OOC_turn -->')
        expect(document.querySelector('[role="dialog"]')?.textContent).toContain('답변에 그대로 넣을 최근 응답 수')
        expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('최근 메시지 수')
    })
    test('uses chat typography and quote markup for formatted OOC replies', async () => {
        component = createClassComponent({
            component: RisuBardOocNotepad, target: document.body,
            props: { messages: [{ role: 'char', data: '<!-- OOC_turn --> *Action*\n\n## Heading\n\n**Idea** and "dialogue"\n\n- First\n- Second' }], onHideChange: vi.fn() },
        })
        await vi.waitFor(() => expect(document.querySelector('.chattext.prose mark[risu-mark="quote2"]')).not.toBeNull())
        const body = document.querySelector('.chattext.prose')!
        expect(body.querySelector('em')?.textContent).toBe('Action')
        expect(body.querySelector('h2')?.textContent).toBe('Heading')
        expect(body.querySelector('strong')?.textContent).toBe('Idea')
        expect(body.querySelectorAll('li')).toHaveLength(2)
    })
    test('reflects edits, swipes, deletions and a different chat without a saved copy', async () => {
        const original = transcript()
        const snapshot = structuredClone(original)
        component = createClassComponent({
            component: RisuBardOocNotepad, target: document.body,
            props: { messages: original, onHideChange: vi.fn() },
        })
        expect(document.querySelectorAll('[data-ooc-message-index]')).toHaveLength(2)
        expect(original).toEqual(snapshot)

        const edited = transcript()
        edited[3].data = '<!-- OOC_turn --> Revised ending'
        component.$set({ messages: edited })
        await tick()
        expect(document.body.textContent).toContain('Revised ending')
        expect(document.body.textContent).not.toContain('A secret door')

        component.$set({ messages: [...edited.slice(0, 3), { ...edited[3], data: 'A story swipe' }] })
        await tick()
        expect(document.querySelectorAll('[data-ooc-message-index]')).toHaveLength(0)

        component.$set({ messages: edited.slice(0, 3) })
        await tick()
        expect(document.querySelectorAll('[data-ooc-message-index]')).toHaveLength(0)

        component.$set({ messages: [{ role: 'char', data: '<!-- OOC_turn --> Other chat' }] })
        await tick()
        expect(document.body.textContent).toContain('Other chat')
        expect(document.body.textContent).not.toContain('Plan the ending')
    })

    test('searches OOC content, handles disabled notes and sanitizes unsafe HTML', async () => {
        component = createClassComponent({
            component: RisuBardOocNotepad, target: document.body,
            props: { messages: [
                ...transcript(),
                { role: 'char', disabled: true, data: '<!-- OOC_turn --> <script>alert(1)</script>' },
            ], onHideChange: vi.fn() },
        })
        await vi.waitFor(() => expect(document.querySelector('.content strong')?.textContent).toBe('A secret door'))
        expect(document.querySelectorAll('[data-ooc-message-index]')).toHaveLength(3)
        expect(document.querySelector('.content script')).toBeNull()
        expect(document.body.textContent).not.toContain('<script>alert(1)</script>')
        const search = document.querySelector<HTMLInputElement>('input[type="search"]')!
        search.value = 'secret'
        search.dispatchEvent(new Event('input', { bubbles: true }))
        await tick()
        expect(document.querySelectorAll('[data-ooc-message-index]')).toHaveLength(1)
        expect(document.body.textContent).toContain('A secret door')
    })
})
