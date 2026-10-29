import { afterEach, expect, test, vi } from 'vitest'
import { nativeAutoscrollSkips, reverseAutoscroll } from './reverseAutoscroll'

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = '' })

// jsdom has no layout or Firefox's scrollTopMax; set them as Firefox reports a column-reverse chat.
function firefoxRange(el: HTMLElement, scrollHeight: number, scrollTopMax: number) {
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 500 })
    Object.assign(el, { scrollTopMax })
}

function setup() {
    const frames = new Map<number, FrameRequestCallback>()
    let id = 0
    vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++id, fn); return id })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
    const container = document.createElement('div')
    container.innerHTML = '<div class="message"><p>text</p><a href="#x">link</a><pre class="code"></pre></div>'
    document.body.append(container)
    firefoxRange(container, 5500, 0)
    for (const el of container.querySelectorAll<HTMLElement>('*')) firefoxRange(el, 500, 0)
    let top = 0
    container.scrollBy = vi.fn((options?: ScrollToOptions | number) => { top += (options as ScrollToOptions).top ?? 0 }) as typeof container.scrollBy
    const action = reverseAutoscroll(container)
    let now = 0
    const frame = () => { now += 20; const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(now)) }
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const press = (target: Element, button = 1, y = 300) => {
        const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button, clientX: 200, clientY: y })
        target.dispatchEvent(event)
        return event
    }
    const move = (y: number) => window.dispatchEvent(new MouseEvent('mousemove', { clientX: 200, clientY: y }))
    return { container, action, frame, press, move, frames, top: () => top }
}

test('only takes over when Firefox would skip a reversed scroller', () => {
    const s = setup()
    const text = s.container.querySelector('p')!
    expect(nativeAutoscrollSkips(s.container, text)).toBe(true)
    expect(nativeAutoscrollSkips(s.container, s.container.querySelector('a')!)).toBe(false)
    // A nested scroller keeps Firefox's own autoscroll.
    const code = s.container.querySelector<HTMLElement>('.code')!
    code.style.overflowY = 'auto'
    firefoxRange(code, 700, 200)
    expect(nativeAutoscrollSkips(s.container, code)).toBe(false)
    // Wide content spilling out of an overflow: visible wrapper is not a scroller.
    const wide = s.container.querySelector<HTMLElement>('.message')!
    Object.defineProperty(wide, 'scrollWidth', { configurable: true, value: 900 })
    Object.defineProperty(wide, 'clientWidth', { configurable: true, value: 600 })
    expect(nativeAutoscrollSkips(s.container, text)).toBe(true)
    // A normal scroller has a positive range, and Chrome has no scrollTopMax at all.
    firefoxRange(s.container, 5500, 5000)
    expect(nativeAutoscrollSkips(s.container, text)).toBe(false)
    delete (s.container as { scrollTopMax?: number }).scrollTopMax
    expect(nativeAutoscrollSkips(s.container, text)).toBe(false)
})

test('middle click scrolls the chat toward the pointer and the next click stops it', () => {
    const s = setup()
    const event = s.press(s.container.querySelector('p')!)
    expect(event.defaultPrevented).toBe(true)
    expect(document.querySelector('[data-chat-autoscroll-marker]')).not.toBeNull()
    s.frame()
    expect(s.top()).toBe(0)
    s.move(100)
    s.frame(); s.frame()
    expect(s.top()).toBeLessThan(-20)
    const stopped = s.top()
    s.press(document.body, 0)
    s.frame()
    expect(s.top()).toBe(stopped)
    expect(s.frames.size).toBe(0)
    expect(document.querySelector('[data-chat-autoscroll-marker]')).toBeNull()
})

test('leaves links, other buttons and destroyed containers alone', () => {
    const s = setup()
    expect(s.press(s.container.querySelector('a')!).defaultPrevented).toBe(false)
    expect(s.press(s.container.querySelector('p')!, 0).defaultPrevented).toBe(false)
    s.action.destroy()
    expect(s.press(s.container.querySelector('p')!).defaultPrevented).toBe(false)
    expect(s.frames.size).toBe(0)
})
