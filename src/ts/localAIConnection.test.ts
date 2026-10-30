import { afterEach, expect, test, vi } from 'vitest'

const { state, request } = vi.hoisted(() => ({ state: { available: true, enabled: true }, request: vi.fn() }))
vi.mock('./globalApi.svelte', () => ({ forageStorage: { Init: async () => {}, realStorage: { localAIRequest: request } } }))
vi.mock('./localAI.svelte', () => ({ isOfflineBuild: true, localAI: state }))
import { refreshLocalAI } from './localAI'

afterEach(() => { vi.restoreAllMocks(); request.mockReset(); state.available = true; state.enabled = true })

test('unavailable engine status cannot silently enable online routing in an Offline build', async () => {
    request.mockResolvedValue(Response.json({ available: false, enabled: false }))
    await expect(refreshLocalAI()).rejects.toThrow('엔진을 확인하지 못했어요')
    expect(state).toEqual({ available: true, enabled: true })
})

test('failed status lookup preserves the last explicit mode', async () => {
    state.enabled = false
    request.mockResolvedValue(new Response('busy', { status: 503 }))
    await expect(refreshLocalAI()).rejects.toThrow('설정을 읽지 못했어요')
    expect(state).toEqual({ available: true, enabled: false })
})

test('status lookup has a bounded abort signal without changing the mode', async () => {
    const controller = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    request.mockImplementation(async (_path, { signal }) => {
        controller.abort(new DOMException('Status timed out', 'TimeoutError'))
        signal.throwIfAborted()
    })
    await expect(refreshLocalAI()).rejects.toThrow('Status timed out')
    expect(timeout).toHaveBeenCalledWith(5000)
    expect(state).toEqual({ available: true, enabled: true })
})
