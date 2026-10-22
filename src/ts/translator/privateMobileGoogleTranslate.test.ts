import { describe, expect, it, vi } from 'vitest'

import {
    PrivateMobileGoogleTranslateGate,
    shouldBatchPrivateMobileGoogleTranslation,
} from './privateMobileGoogleTranslate'

const response = (status = 200) => new Response('{}', { status })

describe('PrivateMobileGoogleTranslateGate', () => {
    it('calls the default browser fetch with its global receiver', async () => {
        vi.stubGlobal('fetch', function (this: unknown) {
            if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation')
            return Promise.resolve(response())
        })
        try {
            const gate = new PrivateMobileGoogleTranslateGate()
            expect((await gate.request('https://translate.googleapis.com/one'))?.status).toBe(200)
        } finally { vi.unstubAllGlobals() }
    })

    it('serializes concurrent requests and spaces their start times', async () => {
        let now = 1_000
        const starts: number[] = []
        const fetchImpl = vi.fn(async () => {
            starts.push(now)
            return response()
        }) as typeof fetch
        const gate = new PrivateMobileGoogleTranslateGate({
            fetchImpl,
            now: () => now,
            wait: async (milliseconds) => { now += milliseconds },
            minIntervalMs: 250,
        })

        const [first, second, third] = await Promise.all([
            gate.request('https://translate.googleapis.com/one'),
            gate.request('https://translate.googleapis.com/two'),
            gate.request('https://translate.googleapis.com/three'),
        ])

        expect(first?.status).toBe(200)
        expect(second?.status).toBe(200)
        expect(third?.status).toBe(200)
        expect(starts).toEqual([1_000, 1_250, 1_500])
        expect(fetchImpl).toHaveBeenCalledTimes(3)
    })

    it('opens a circuit after a rate-limit response and recovers after cooldown', async () => {
        let now = 5_000
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(response(429))
            .mockResolvedValueOnce(response(200)) as typeof fetch
        const gate = new PrivateMobileGoogleTranslateGate({
            fetchImpl,
            now: () => now,
            wait: async (milliseconds) => { now += milliseconds },
            minIntervalMs: 0,
            rateLimitBackoffMs: 1_000,
        })

        expect((await gate.request('https://translate.googleapis.com/one'))?.status).toBe(429)
        expect(await gate.request('https://translate.googleapis.com/two')).toBeNull()
        expect(fetchImpl).toHaveBeenCalledTimes(1)

        now += 1_000
        expect((await gate.request('https://translate.googleapis.com/three'))?.status).toBe(200)
        expect(fetchImpl).toHaveBeenCalledTimes(2)
    })

    it('does not poison the queue after a network failure', async () => {
        let now = 10_000
        const fetchImpl = vi.fn()
            .mockRejectedValueOnce(new TypeError('Failed to fetch'))
            .mockResolvedValueOnce(response(200)) as typeof fetch
        const gate = new PrivateMobileGoogleTranslateGate({
            fetchImpl,
            now: () => now,
            wait: async (milliseconds) => { now += milliseconds },
            minIntervalMs: 0,
            networkBackoffMs: 500,
        })

        expect(await gate.request('https://translate.googleapis.com/one')).toBeNull()
        expect(await gate.request('https://translate.googleapis.com/two')).toBeNull()
        expect(fetchImpl).toHaveBeenCalledTimes(1)

        now += 500
        expect((await gate.request('https://translate.googleapis.com/three'))?.status).toBe(200)
        expect(fetchImpl).toHaveBeenCalledTimes(2)
    })
})

describe('shouldBatchPrivateMobileGoogleTranslation', () => {
    it('batches only the Google translator in the private Android local bundle', () => {
        expect(shouldBatchPrivateMobileGoogleTranslation(true, 'google')).toBe(true)
        expect(shouldBatchPrivateMobileGoogleTranslation(true, 'llm')).toBe(false)
        expect(shouldBatchPrivateMobileGoogleTranslation(false, 'google')).toBe(false)
    })
})
