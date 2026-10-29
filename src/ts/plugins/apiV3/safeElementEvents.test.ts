import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { v4 } from 'uuid'
import ts from 'typescript'
import { afterEach, describe, expect, test, vi } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'src/ts/plugins/apiV3/v3.svelte.ts'), 'utf8')

// Execute the real DOM bridge and reload cleanup without loading the app's
// database, model providers, or iframe runtime. No event behavior is replicated.
const bridge = source.slice(source.indexOf('class SafeElement {'), source.indexOf('class SafeDocument extends'))
const reload = source.slice(source.indexOf('export async function loadV3Plugins('), source.indexOf('export async function executePluginV3('))
const compiled = ts.transpileModule(`${bridge}\n${reload.replace('export ', '')}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

interface ListenerEntry {
    target?: EventTarget
    type: string
    listener: EventListener
    options: AddEventListenerOptions
}

const listeners: ListenerEntry[] = []
const { SafeElement, loadV3Plugins } = new Function(
    'v4', 'documentEventListeners', 'v3PluginInstances', 'unloadV3Plugin', 'executePluginV3',
    `${compiled}\nreturn { SafeElement, loadV3Plugins };`,
)(v4, listeners, [], vi.fn(), vi.fn())

function button() {
    const element = document.createElement('button')
    document.body.appendChild(element)
    return { element, safe: new SafeElement(element) }
}

afterEach(() => {
    for (const entry of listeners) {
        (entry.target ?? document).removeEventListener(entry.type, entry.listener, entry.options)
    }
    listeners.length = 0
    document.body.replaceChildren()
    vi.useRealTimers()
})

describe('API v3 SafeElement events', () => {
    test('does not activate a covered textarea expander when the overlying dialog receives pointerup', async () => {
        const { safe } = button()
        const dialog = document.createElement('div')
        dialog.setAttribute('role', 'dialog')
        document.body.appendChild(dialog)
        const expand = vi.fn()
        await safe.addEventListener('pointerup', expand)

        // The browser targets the dialog even when the coordinates also fall
        // within the covered expander's rectangle.
        dialog.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientX: 120, clientY: 80 }))

        expect(expand).not.toHaveBeenCalled()
    })

    test('delivers descendant clicks to the owning element and preserves body delegation', async () => {
        const { element, safe } = button()
        const icon = document.createElement('span')
        element.appendChild(icon)
        const clicked = vi.fn()
        const delegated = vi.fn()
        await safe.addEventListener('click', clicked)
        await new SafeElement(document.body).addEventListener('click', delegated)

        icon.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 12, clientY: 34 }))

        expect(clicked).toHaveBeenCalledOnce()
        expect(clicked).toHaveBeenCalledWith(expect.objectContaining({ type: 'click', clientX: 12, clientY: 34 }))
        expect(clicked.mock.calls[0][0]).not.toHaveProperty('target')
        expect(delegated).toHaveBeenCalledOnce()
    })

    test('does not consume a once listener for clicks outside its element', async () => {
        const { element, safe } = button()
        const other = button().element
        const clicked = vi.fn()
        await safe.addEventListener('click', clicked, { once: true })

        other.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        expect(clicked).not.toHaveBeenCalled()
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        expect(clicked).toHaveBeenCalledOnce()
    })

    test('only schedules delayed keyboard callbacks for the owning element', async () => {
        vi.useFakeTimers()
        const { element, safe } = button()
        const other = button().element
        const keyed = vi.fn()
        await safe.addEventListener('keydown', keyed)

        other.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
        await vi.runAllTimersAsync()
        expect(keyed).not.toHaveBeenCalled()

        element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
        expect(keyed).not.toHaveBeenCalled()
        await vi.runAllTimersAsync()
        expect(keyed).toHaveBeenCalledOnce()
        expect(keyed).toHaveBeenCalledWith(expect.objectContaining({ type: 'keydown', key: 'Enter' }))
    })

    test('supports non-bubbling events on the registered element', async () => {
        const { element, safe } = button()
        const entered = vi.fn()
        await safe.addEventListener('pointerenter', entered)

        element.dispatchEvent(new MouseEvent('pointerenter'))

        expect(entered).toHaveBeenCalledOnce()
    })

    test('binds root document listeners to the Document so viewport scroll reaches them', async () => {
        const scrolled = vi.fn()
        const root = new SafeElement(document.documentElement, document)
        const id = await root.addEventListener('scroll', scrolled)

        document.dispatchEvent(new Event('scroll'))
        expect(scrolled).toHaveBeenCalledOnce()
        expect(listeners[0].target).toBe(document)

        await root.removeEventListener('scroll', id)
        document.dispatchEvent(new Event('scroll'))
        expect(scrolled).toHaveBeenCalledOnce()
        expect(listeners).toHaveLength(0)
    })

    test('removal replays the registration even when type and capture do not match', async () => {
        const { element, safe } = button()
        const clicked = vi.fn()
        const id = await safe.addEventListener('click', clicked, true)
        await safe.removeEventListener('pointerup', id)

        element.dispatchEvent(new MouseEvent('click', { bubbles: true }))

        expect(clicked).not.toHaveBeenCalled()
        expect(listeners).toHaveLength(0)
    })

    test.each([false, true])('removes listeners from their element with capture=%s', async (capture) => {
        const { element, safe } = button()
        const clicked = vi.fn()
        const id = await safe.addEventListener('click', clicked, capture)
        await safe.removeEventListener('click', id, capture)

        element.dispatchEvent(new MouseEvent('click', { bubbles: true }))

        expect(clicked).not.toHaveBeenCalled()
        expect(listeners).toHaveLength(0)
    })

    test('removes element listeners when plugins are reloaded', async () => {
        vi.useFakeTimers()
        const { element, safe } = button()
        const listener = vi.fn()
        await safe.addEventListener('click', listener, true)
        await safe.addEventListener('keydown', listener)
        await loadV3Plugins([])

        element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        element.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
        await vi.runAllTimersAsync()

        expect(listener).not.toHaveBeenCalled()
        expect(listeners).toHaveLength(0)
    })
})
