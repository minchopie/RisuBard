type FirefoxScrollArea = Element & { scrollTopMax?: number }

// Firefox only autoscrolls real scroll containers; overflowing content under
// overflow: visible has no scroll frame and never counts.
const scrolls = (overflow: string) => overflow === 'auto' || overflow === 'scroll'

// Firefox accepts an element for middle-click autoscroll only when scrollTopMax > 0.
// A column-reverse chat scrolls from a negative scrollTop up to 0, so its scrollTopMax
// stays 0 and Firefox skips it: the icon appears but nothing scrolls. Only Firefox has
// scrollTopMax, so other browsers never reach this path.
export function nativeAutoscrollSkips(container: HTMLElement, target: Element | null) {
    const area = container as FirefoxScrollArea
    if (area.scrollTopMax !== 0 || container.scrollHeight <= container.clientHeight) return false
    if (!target || !container.contains(target)) return false
    if (target.closest('a[href], input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return false
    // A nested scroller still gets Firefox's own autoscroll.
    for (let node: Element | null = target; node && node !== container; node = node.parentElement) {
        const el = node as FirefoxScrollArea
        const style = getComputedStyle(el)
        if (scrolls(style.overflowY) && (el.scrollTopMax ?? 0) > 0) return false
        if (scrolls(style.overflowX) && el.scrollWidth > el.clientWidth) return false
    }
    return true
}

// Same curve as Firefox's AutoScrollChild, in CSS pixels per 20ms.
function accelerate(distance: number) {
    const value = distance / 12
    if (value > 1) return value * Math.sqrt(value) - 1
    if (value < -1) return value * Math.sqrt(-value) + 1
    return 0
}

export function reverseAutoscroll(container: HTMLElement) {
    let startX = 0
    let startY = 0
    let currentY = 0
    let moved = false
    let frame: number | null = null
    let lastFrame = 0
    let error = 0
    let marker: HTMLElement | null = null
    let previousCursor = ''

    function loop(timestamp: number) {
        const step = accelerate(currentY - startY) * Math.min(100, timestamp - lastFrame) / 20 + error
        lastFrame = timestamp
        const pixels = step > 0 ? Math.floor(step) : Math.ceil(step)
        error = step - pixels
        if (pixels) container.scrollBy({ top: pixels, behavior: 'instant' })
        frame = requestAnimationFrame(loop)
    }

    function onMove(event: MouseEvent) {
        currentY = event.clientY
        if (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10) moved = true
    }

    function onDown(event: MouseEvent) {
        // Any click while scrolling only ends the scroll, as in the native autoscroll.
        event.preventDefault()
        stop()
    }

    function onUp(event: MouseEvent) {
        // Press, drag and release ends the scroll; a plain middle click keeps it running.
        if (event.button === 1 && moved) stop()
    }

    function onKey(event: KeyboardEvent) {
        if (event.key === 'Escape') stop()
    }

    function stop() {
        if (frame === null) return
        cancelAnimationFrame(frame)
        frame = null
        marker?.remove()
        marker = null
        container.style.cursor = previousCursor
        window.removeEventListener('mousemove', onMove, true)
        window.removeEventListener('mousedown', onDown, true)
        window.removeEventListener('mouseup', onUp, true)
        window.removeEventListener('keydown', onKey, true)
        window.removeEventListener('wheel', stop, true)
        window.removeEventListener('blur', stop)
    }

    function start(event: MouseEvent) {
        if (frame !== null || event.button !== 1 || event.defaultPrevented) return
        if (!nativeAutoscrollSkips(container, event.target as Element | null)) return
        // Also keeps Firefox from starting its own autoscroll on the page.
        event.preventDefault()
        startX = event.clientX
        startY = currentY = event.clientY
        moved = false
        error = 0
        lastFrame = performance.now()
        marker = document.createElement('div')
        marker.dataset.chatAutoscrollMarker = ''
        marker.setAttribute('aria-hidden', 'true')
        marker.textContent = '↕'
        Object.assign(marker.style, {
            position: 'fixed', left: `${startX - 14}px`, top: `${startY - 14}px`, width: '28px', height: '28px',
            borderRadius: '9999px', display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'var(--color-darkbg)', color: 'var(--color-textcolor)', border: '1px solid var(--color-borderc)',
            font: '16px/1 sans-serif', pointerEvents: 'none', zIndex: '2147483647',
        })
        document.body.append(marker)
        previousCursor = container.style.cursor
        container.style.cursor = 'ns-resize'
        window.addEventListener('mousemove', onMove, true)
        window.addEventListener('mousedown', onDown, true)
        window.addEventListener('mouseup', onUp, true)
        window.addEventListener('keydown', onKey, true)
        window.addEventListener('wheel', stop, true)
        window.addEventListener('blur', stop)
        frame = requestAnimationFrame(loop)
    }

    container.addEventListener('mousedown', start)
    return {
        destroy() {
            stop()
            container.removeEventListener('mousedown', start)
        },
    }
}
