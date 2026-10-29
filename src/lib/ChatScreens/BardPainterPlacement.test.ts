import { afterEach, expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { get } from 'svelte/store'
import { painterInsertionRequest } from 'src/ts/bardPainter/selectionState'
vi.mock('src/ts/stores.svelte', () => ({ DBState: { db: { characters: [{ chaId: 'bot', name: 'Bot', chats: [{ id: 'chat', message: [{ chatId: 'm', data: 'First.\n\nLast.' }, { chatId: 'n', data: 'Other.\n\nEnd.' }] }] }] } } }))
vi.mock('src/ts/personaScopes', () => ({ resolvePersonaById: () => null }))
import BardPainterPlacement from './BardPainterPlacement.svelte'
let component: ReturnType<typeof mount> | undefined
afterEach(async () => { if (component) await unmount(component); component = undefined; painterInsertionRequest.set(null); document.body.replaceChildren() })
async function setup() {
    const root = document.createElement('div')
    root.dataset.painterMessage = '0'; root.innerHTML = '<p>First.</p><p>Last.</p>'
    document.body.append(root)
    root.getBoundingClientRect = () => new DOMRect(0, 0, 300, 100)
    root.querySelectorAll('p').forEach((p, i) => { p.getBoundingClientRect = () => new DOMRect(0, i * 60, 300, 30) })
    const insert = vi.fn(async () => true)
    painterInsertionRequest.set({ characterId: 'bot', chatId: 'chat', resultId: 'image', insert })
    component = mount(BardPainterPlacement, { target: document.body, props: { characterId: 'bot', chatId: 'chat' } })
    await tick(); await tick()
    return { root, insert }
}
test.each(['Escape', 'contextmenu'])('cancels placement with %s without inserting', async (action) => {
    const { root, insert } = await setup()
    const event = action === 'Escape' ? new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }) : new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true })
    root.dispatchEvent(event); await tick()
    expect(get(painterInsertionRequest)).toBeNull()
    expect(event.defaultPrevented).toBe(true)
    expect(insert).not.toHaveBeenCalled()
    expect(document.body.classList.contains('painter-placing')).toBe(false)
})
test('left click places the image at the selected paragraph boundary', async () => {
    const { root, insert } = await setup()
    root.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 20, clientY: 45, bubbles: true }))
    root.dispatchEvent(new MouseEvent('click', { button: 0, detail: 1, clientX: 20, clientY: 45, bubbles: true }))
    await tick(); await tick()
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ characterId: 'bot', chatId: 'chat', messageId: 'm', start: 8, end: 8 }))
    expect(get(painterInsertionRequest)).toBeNull()
})
test.each(['scroll', 'load', 'resize'])('keeps the chosen insertion line aligned after %s', async eventType => {
    const { root, insert } = await setup()
    root.dispatchEvent(new PointerEvent('pointermove', { clientY: 45, bubbles: true }))
    await tick()
    expect(document.querySelector<HTMLElement>('.placement-marker')?.style.top).toBe('45px')
    root.querySelectorAll('p').forEach((p, i) => { p.getBoundingClientRect = () => new DOMRect(0, 120 + i * 60, 300, 30) })
    ;(eventType === 'resize' ? window : root).dispatchEvent(new Event(eventType))
    await tick()
    expect(document.querySelector<HTMLElement>('.placement-marker')?.style.top).toBe('165px')
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await tick(); await tick()
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ start: 8, end: 8 }))
})
test('does not move an unmapped boundary to the start after displayed paragraphs change', async () => {
    const { root, insert } = await setup()
    root.dispatchEvent(new PointerEvent('pointermove', { clientY: 45, bubbles: true }))
    await tick()
    root.innerHTML = '<p>First. Last.</p>'
    root.querySelector('p')!.getBoundingClientRect = () => new DOMRect(0, 0, 300, 30)
    root.dispatchEvent(new Event('load'))
    await tick()
    expect(document.querySelector('.placement-marker')).toBeNull()
    root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await tick(); await tick()
    expect(insert).not.toHaveBeenCalled()
})
test('starts at the message on screen instead of scrolling back to the scene message', async () => {
    const scene = document.createElement('div'), current = document.createElement('div')
    scene.dataset.painterMessage = '0'; scene.innerHTML = '<p>First.</p><p>Last.</p>'
    current.dataset.painterMessage = '1'; current.innerHTML = '<p>Other.</p><p>End.</p>'
    document.body.append(scene, current)
    scene.getBoundingClientRect = () => new DOMRect(0, -2000, 300, 100)
    current.getBoundingClientRect = () => new DOMRect(0, 100, 300, 300)
    scene.querySelectorAll('p').forEach((p, i) => { p.getBoundingClientRect = () => new DOMRect(0, -2000 + i * 60, 300, 30) })
    current.querySelectorAll('p').forEach((p, i) => { p.getBoundingClientRect = () => new DOMRect(0, 100 + i * 200, 300, 30) })
    const scroll = vi.fn()
    scene.scrollIntoView = scroll; current.scrollIntoView = scroll
    painterInsertionRequest.set({ characterId: 'bot', chatId: 'chat', resultId: 'image', messageId: 'm', insert: vi.fn(async () => true) })
    component = mount(BardPainterPlacement, { target: document.body, props: { characterId: 'bot', chatId: 'chat' } })
    await tick(); await tick()
    expect(scroll).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(current)
    expect(document.querySelector('.placement-marker')).not.toBeNull()
})
test('clicking an image in the message swaps it for the new illustration', async () => {
    const root = document.createElement('div')
    root.dataset.painterMessage = '0'; root.innerHTML = '<p>First.</p><span class="inlay-image-control"><img data-inlay-image-id="old" data-inlay-occurrence="0"><button type="button">x</button></span><p>Last.</p>'
    document.body.append(root)
    root.getBoundingClientRect = () => new DOMRect(0, 0, 300, 200)
    const { DBState } = await import('src/ts/stores.svelte')
    const message = DBState.db.characters[0].chats[0].message[0]
    const original = message.data
    message.data = 'First.\n\n{{inlay::old}}\n\nLast.'
    try {
        const insert = vi.fn(async () => true), replace = vi.fn(async () => true)
        painterInsertionRequest.set({ characterId: 'bot', chatId: 'chat', resultId: 'image', insert, replace })
        component = mount(BardPainterPlacement, { target: document.body, props: { characterId: 'bot', chatId: 'chat' } })
        await tick(); await tick()
        const image = root.querySelector('img')!
        image.getBoundingClientRect = () => new DOMRect(0, 40, 200, 100)
        image.dispatchEvent(new PointerEvent('pointermove', { clientY: 60, bubbles: true })); await tick()
        expect(document.querySelector('.placement-swap')).not.toBeNull()
        image.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: 20, clientY: 60, bubbles: true }))
        image.dispatchEvent(new MouseEvent('click', { button: 0, detail: 1, clientX: 20, clientY: 60, bubbles: true }))
        await tick(); await tick()
        expect(replace).toHaveBeenCalledWith({ messageId: 'm', inlayId: 'old', occurrence: 0 })
        expect(insert).not.toHaveBeenCalled()
    } finally { message.data = original }
})
