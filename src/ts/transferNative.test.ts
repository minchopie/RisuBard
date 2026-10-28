import { afterEach, expect, test, vi } from 'vitest'
import { get } from 'svelte/store'
import { nativeSend, sendNative } from './transferNative'
import { transferStatus } from './transferState'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
test('a lost status reply clears a stale sending bar without claiming delivery failed', async () => {
    vi.useFakeTimers()
    let listener: (event: { data: string }) => void
    vi.stubGlobal('RisuPlay', {
        addEventListener: (_: string, callback: typeof listener) => { listener = callback },
        postMessage: (input: string) => {
            const { id, op } = JSON.parse(input)
            queueMicrotask(() => listener({ data: JSON.stringify(op.endsWith('.progress') ? { id, error: 'connection closed' } : { id, value: op === 'bard.export' ? 'file-handle' : true }) }))
        },
    })
    await sendNative('export-id', 'usb')
    await vi.runAllTimersAsync()
    expect(get(nativeSend)).toEqual({ state: 'unknown', error: 'Error: connection closed' })
    expect(get(transferStatus)).toContain('상대 기기 상태를 확인하지 못했어요')
})

test('a temporarily closed receiver keeps delivery proof and resumes the import receipt poll', async () => {
    vi.useFakeTimers()
    let listener: (event: { data: string }) => void, statusCalls = 0
    vi.stubGlobal('RisuPlay', {
        addEventListener: (_: string, callback: typeof listener) => { listener = callback },
        postMessage: (input: string) => {
            const { id, op } = JSON.parse(input)
            const reply = op.endsWith('.status') ? (++statusCalls === 1 ? { id, error: 'receiver closed' } : { id, value: 'applied' })
                : { id, value: op.endsWith('.progress') ? { state: 'delivered' } : 'handle' }
            queueMicrotask(() => listener({ data: JSON.stringify(reply) }))
        },
    })
    await sendNative('export-id', 'wifi', 'device')
    await vi.advanceTimersByTimeAsync(0)
    expect(get(nativeSend)?.state).toBe('delivered')
    expect(get(transferStatus)).toContain('전달 완료')
    await vi.advanceTimersByTimeAsync(2000)
    expect(statusCalls).toBe(2); expect(get(nativeSend)?.state).toBe('applied')
})
