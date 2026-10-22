import { afterEach, expect, it, vi } from 'vitest'
import { installDynamicViewportHeight } from './viewportHeight'

afterEach(() => vi.unstubAllGlobals())

it.each([
    ['Android browser, typing', 'Mozilla/5.0 Android', 'TEXTAREA', 0],
    ['Android browser, browsing', 'Mozilla/5.0 Android', 'BODY', 1],
    ['embedded Android', 'Mozilla/5.0 Android RisuBardAndroid/0.9.72', 'TEXTAREA', 1],
])('keeps the composer in the visible viewport for %s', (_name, userAgent, tagName, expected) => {
    const setProperty = vi.fn()
    const viewport = { height: 555, scale: 1, addEventListener: vi.fn() }
    vi.stubGlobal('window', { visualViewport: viewport })
    vi.stubGlobal('navigator', { userAgent })
    vi.stubGlobal('document', { activeElement: { tagName }, documentElement: { style: { setProperty } } })
    installDynamicViewportHeight()
    expect(setProperty).toHaveBeenCalledTimes(expected)
    if (expected) expect(setProperty).toHaveBeenCalledWith('--risu-height-size', '555px')
    let frame: FrameRequestCallback | undefined
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frame = callback; return 1 })
    viewport.height = 855
    viewport.addEventListener.mock.calls[0][1]()
    frame!(0)
    expect(setProperty).toHaveBeenCalledTimes(expected * 2)
    if (expected) expect(setProperty).toHaveBeenLastCalledWith('--risu-height-size', '855px')
    viewport.scale = 2
    installDynamicViewportHeight()
    expect(setProperty).toHaveBeenCalledTimes(expected * 2)
})
