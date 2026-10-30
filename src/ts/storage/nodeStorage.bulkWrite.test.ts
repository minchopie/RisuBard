import { describe, expect, it, vi } from 'vitest'

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('src/ts/stores.svelte', () => ({
    selIdState: { selId: 0 },
    DBState: { db: { characters: [] } },
}))
vi.mock('./database.svelte', () => ({
    normalizeChat: (value: unknown) => value,
    getCurrentChat: () => null,
    getCurrentCharacter: () => null,
    getDatabase: () => ({
        modules: [], enabledModules: [], personas: [], selectedPersona: 0,
        personaEnabledModules: {}, characters: [],
    }),
}))
vi.mock('./risuSave', () => ({ decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: vi.fn() }))
vi.mock('./chatContentPage', () => ({ assembleChatContentPages: vi.fn() }))

import { NodeStorage } from './nodeStorage'

describe('NodeStorage import progress', () => {
    it('decodes split lines and reports a disconnected stream without failing storage', async () => {
        const storage = new NodeStorage()
        const onEvent = vi.fn(), onLost = vi.fn()
        const encoder = new TextEncoder()
        ;(storage as any).authFetch = vi.fn(async () => new Response(new ReadableStream({ start(c) {
            c.enqueue(encoder.encode('{"type":"heart'))
            c.enqueue(encoder.encode('beat"}\n{"type":"progress","stage":"stage-files","completed":1,"total":2}\n'))
            c.close()
        } })))
        const stop = await storage.observeImportProgress('test-import', onEvent, onLost)
        await vi.waitFor(() => expect(onLost).toHaveBeenCalledOnce())
        expect(onEvent.mock.calls.map(call => call[0].type)).toEqual(['heartbeat', 'progress'])
        expect(storage.importProgressId).toBe('test-import')
        stop()
        expect(storage.importProgressId).toBeUndefined()
    })

    it('allows installation to continue when observation is unavailable', async () => {
        const storage = new NodeStorage()
        ;(storage as any).authFetch = vi.fn(async () => new Response('', { status: 503 }))
        const lost = vi.fn()
        const stop = await storage.observeImportProgress('test-import', vi.fn(), lost)
        expect(lost).toHaveBeenCalledOnce()
        stop()
        expect(storage.importProgressId).toBeUndefined()
    })
})

describe('NodeStorage live file synchronization', () => {
    it('keeps the session active during a transfer fence but still deactivates a displaced writer', async () => {
        const storage = new NodeStorage(), deactivated = vi.fn()
        ;(storage as any).checkAuth = async () => {}
        storage.createAuth = async () => 'test-token'
        let code: string | undefined = 'TRANSFER_BUSY'
        vi.stubGlobal('fetch', async () => Response.json({ error: 'busy', code }, { status: 423 }))
        window.addEventListener('risu-session-deactivated', deactivated)
        try {
            expect((await (storage as any).authFetch('/api/write')).status).toBe(423)
            expect(deactivated).not.toHaveBeenCalled()
            code = undefined
            await (storage as any).authFetch('/api/write')
            expect(deactivated).toHaveBeenCalledOnce()
        } finally { window.removeEventListener('risu-session-deactivated', deactivated); vi.unstubAllGlobals() }
    })

    it('sends the revision through authenticated transport without advancing the save etag', async () => {
        const storage = new NodeStorage()
        storage.setDbEtag('acknowledged')
        const result = { revision: 'new', etag: 'remote', snapshot: { characters: [], loreBook: [] } }
        const authFetch = vi.fn(async (path: string) => new Response(JSON.stringify(
            path === '/api/live-files/monitoring' ? { enabled: true, defaultEnabled: true } : result,
        ), { status: 200 }))
        ;(storage as any).authFetch = authFetch
        expect(await storage.syncLiveFiles('old')).toEqual(result)
        expect(authFetch).toHaveBeenCalledWith('/api/live-files/sync', {
            method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"revision":"old"}',
        })
        expect(storage._lastDbEtag).toBe('acknowledged')
    })

    it('rejects a failed sync instead of accepting a partial response', async () => {
        const storage = new NodeStorage()
        vi.spyOn(storage, 'getLiveFileMonitoring').mockResolvedValue({ enabled: true, defaultEnabled: true })
        ;(storage as any).authFetch = vi.fn(async () => new Response('{"error":"writer busy"}', { status: 423 }))
        await expect(storage.syncLiveFiles()).rejects.toThrow('writer busy')
    })

    it('announces inactive sync while preserving the error for send preflight', async () => {
        const storage = new NodeStorage()
        vi.spyOn(storage, 'getLiveFileMonitoring').mockResolvedValue({ enabled: true, defaultEnabled: true })
        const deactivated = vi.fn()
        window.addEventListener('risu-session-deactivated', deactivated)
        ;(storage as any).authFetch = vi.fn(async () => new Response(
            '{"code":"LIVE_FILES_INACTIVE","error":"writer inactive"}', { status: 409 },
        ))
        try {
            await expect(storage.syncLiveFiles()).rejects.toMatchObject({ code: 'LIVE_FILES_INACTIVE' })
            expect(deactivated).toHaveBeenCalledOnce()
        } finally {
            window.removeEventListener('risu-session-deactivated', deactivated)
        }
    })
})

it('keeps user intent when a save follows a long response or slow authentication', async () => {
    vi.useFakeTimers()
    const storage = new NodeStorage()
    ;(storage as any).checkAuth = async () => {}
    storage.createAuth = async () => 'test-token'
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    try {
        await (storage as any).authFetch('/before-input')
        expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).has('x-user-active')).toBe(false)
        window.dispatchEvent(new Event('pointerdown'))
        vi.advanceTimersByTime(60_000)
        await (storage as any).authFetch('/after-long-response')
        expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get('x-user-active')).toBe('1')
    } finally {
        vi.unstubAllGlobals()
        vi.useRealTimers()
    }
})

describe('NodeStorage bulk asset writes', () => {
    it('sends up to 200 small assets per request', async () => {
        const storage = new NodeStorage()
        const authFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(
            JSON.stringify({ success: true }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        ))
        ;(storage as any).authFetch = authFetch
        const entries = Array.from({ length: 201 }, (_, index) => ({
            key: `assets/${index}`,
            value: Uint8Array.of(index % 256),
        }))

        await storage.setItems(entries)

        expect(authFetch).toHaveBeenCalledTimes(2)
        expect(JSON.parse(String(authFetch.mock.calls[0]?.[1]?.body))).toHaveLength(200)
        expect(JSON.parse(String(authFetch.mock.calls[1]?.[1]?.body))).toHaveLength(1)
    })
})
