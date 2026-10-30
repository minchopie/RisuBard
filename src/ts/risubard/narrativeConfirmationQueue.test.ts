import { describe, expect, test } from 'vitest'
import { enqueueNarrativeConfirmation, narrativeConfirmationsSettled, pendingNarrativeConfirmationKeys } from './narrativeConfirmationQueue'

const defer = () => {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
}

describe('per-chat narrative confirmation queue', () => {
    test('settles once the running and queued analyses have ended, failed ones included', async () => {
        let release!: () => void
        const running = enqueueNarrativeConfirmation('chat-settle', () => new Promise<void>((resolve) => { release = resolve }))
        const failing = enqueueNarrativeConfirmation('chat-settle', async () => { throw new Error('down') })
        let settled = false
        void narrativeConfirmationsSettled('chat-settle').then(() => { settled = true })
        await Promise.resolve()
        expect(settled).toBe(false)
        release()
        await running
        await expect(failing).rejects.toThrow('down')
        await narrativeConfirmationsSettled('chat-settle')
        expect(settled).toBe(true)
        await expect(narrativeConfirmationsSettled('chat-idle')).resolves.toBeUndefined()
    })

    test('runs tasks for the same chat one after another in enqueue order', async () => {
        const first = defer()
        const order: string[] = []
        const a = enqueueNarrativeConfirmation('chat', async () => { order.push('a:start'); await first.promise; order.push('a:end'); return 'a' })
        const b = enqueueNarrativeConfirmation('chat', async () => { order.push('b:start'); return 'b' })
        await Promise.resolve()
        expect(order).toEqual(['a:start'])
        first.resolve()
        expect(await a).toBe('a')
        expect(await b).toBe('b')
        expect(order).toEqual(['a:start', 'a:end', 'b:start'])
    })

    test('a failed task neither blocks nor fails the next one', async () => {
        const failing = enqueueNarrativeConfirmation('chat', async () => { throw new Error('boom') })
        const next = enqueueNarrativeConfirmation('chat', async () => 'ok')
        await expect(failing).rejects.toThrow('boom')
        expect(await next).toBe('ok')
    })

    test('different chats run concurrently', async () => {
        const gate = defer()
        const order: string[] = []
        const slow = enqueueNarrativeConfirmation('chat-1', async () => { await gate.promise; order.push('slow') })
        const fast = enqueueNarrativeConfirmation('chat-2', async () => { order.push('fast') })
        await fast
        expect(order).toEqual(['fast'])
        gate.resolve()
        await slow
    })

    test('forgets a chat once its queue drains', async () => {
        await enqueueNarrativeConfirmation('chat-3', async () => undefined)
        await Promise.resolve()
        expect(pendingNarrativeConfirmationKeys()).not.toContain('chat-3')
    })

    test('holds a browser-wide lock per chat so other tabs wait too', async () => {
        const names: string[] = []
        const original = Object.getOwnPropertyDescriptor(globalThis.navigator, 'locks')
        Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: {
            request: async (name: string, callback: () => Promise<unknown>) => { names.push(name); return callback() },
        } })
        try {
            expect(await enqueueNarrativeConfirmation('chat-lock', async () => 'done')).toBe('done')
            expect(names).toEqual(['risubard-wiki-analysis:chat-lock'])
        }
        finally {
            if (original) Object.defineProperty(globalThis.navigator, 'locks', original)
            else delete (globalThis.navigator as { locks?: unknown }).locks
        }
    })
})
