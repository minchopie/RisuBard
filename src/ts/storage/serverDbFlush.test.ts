import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('src/lang', () => ({ language: { storageConnectionTimeout: 'connection timeout', storageWriteTimeout: 'write timeout' } }))
vi.mock('../alert', () => ({ alertInput: vi.fn(), waitAlert: vi.fn(), notifyError: vi.fn() }))
vi.mock('./database.svelte', () => ({ normalizeChat: (value: unknown) => value, getDatabase: () => ({}) }))
vi.mock('./risuSave', () => ({ decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: vi.fn() }))
import { NodeStorage } from './nodeStorage'
import { AutoStorage } from './autoStorage'

// Exercise the actual save controller entry point without booting the app.
const source = readFileSync('src/ts/globalApi.svelte.ts', 'utf8')
const start = source.indexOf('    async function flushServerDbNow(')
const end = source.indexOf('    async function flushServerDbKeepalive(', start)
const createFlush = new Function('forageStorage', `${ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 })}; return flushServerDbNow`)

function fixture() {
    const storage = new NodeStorage()
    storage.authChecked = true
    ;(storage as any).cachedJwt = { token: 'valid-token', expiresAt: Date.now() + 300_000 }
    const autoStorage = new AutoStorage()
    autoStorage.realStorage = storage
    return { storage, flush: createFlush(autoStorage) as (keepalive?: boolean, canonicalOnly?: boolean, signal?: AbortSignal) => Promise<void> }
}

beforeEach(() => {
    ;(NodeStorage as any).sessionInitialized = true
})
afterEach(() => {
    ;(NodeStorage as any).sessionInitialized = false
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

it.each([false, true])('authenticates a cookie-less flush (keepalive=%s) and preserves the canonical mode and import id', async keepalive => {
    const { storage, flush } = fixture()
    storage.importProgressId = 'test-import'
    let request: { url: string, init: RequestInit } | undefined
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        request = { url, init }
        return new Headers(init.headers).get('risu-auth') === 'valid-token'
            ? Response.json({ success: true }) : new Response(null, { status: 401 })
    })
    await flush(keepalive, true)
    expect(request!.url).toBe('/api/db/flush?mode=canonical')
    expect(request!.init).toMatchObject({ method: 'POST', keepalive, credentials: 'same-origin' })
    expect(new Headers(request!.init.headers).get('x-import-id')).toBe('test-import')
})

it('refreshes an expired token once before acknowledging the flush', async () => {
    const { flush } = fixture()
    const requests: string[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        requests.push(url)
        if (url === '/api/test_auth') return Response.json({ status: 'correct', token: 'renewed-token' })
        return new Headers(init.headers).get('risu-auth') === 'renewed-token'
            ? Response.json({ success: true }) : Response.json({ error: 'Token Expired' }, { status: 401 })
    })
    await flush(false, true)
    expect(requests).toEqual(['/api/db/flush?mode=canonical', '/api/test_auth', '/api/db/flush?mode=canonical'])
})

it('waits for an unresponsive flush without a time limit or retry', async () => {
    vi.useFakeTimers()
    const { storage, flush } = fixture()
    const request = vi.fn(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', request)
    let settled = false
    void flush(false, true).finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(600_000)
    expect(settled).toBe(false)
    expect(request).toHaveBeenCalledOnce()
    expect(storage.pendingSaveRequests).toBe(1)
})

it('waits past the write timeout for a cancellable flush and stops when it is aborted', async () => {
    vi.useFakeTimers()
    const { storage, flush } = fixture()
    let requestSignal: AbortSignal | undefined
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_, reject) => {
        requestSignal = init.signal!
        init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
    })))
    const controller = new AbortController()
    let settled = false
    const result = flush(false, true, controller.signal).catch(error => error).finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(settled).toBe(false)
    expect(storage.pendingSaveRequests).toBe(1)
    controller.abort(new Error('cancelled by user'))
    expect(requestSignal!.aborted).toBe(true)
    expect((await result).message).toBe('cancelled by user')
    expect(storage.pendingSaveRequests).toBe(0)
})

it('propagates a failed canonical flush instead of reporting a successful save', async () => {
    const { flush } = fixture()
    vi.stubGlobal('fetch', async () => Response.json({ error: 'disk full' }, { status: 500 }))
    await expect(flush(false, true)).rejects.toThrow('Server database flush failed (500)')
})

it.each([false, true])('a paused HTTP 200 is a conflict, never a durable-save acknowledgement (external changes=%s)', async pending => {
    const { flush } = fixture()
    vi.stubGlobal('fetch', async () => Response.json({ success: true, paused: true, externalChangesPending: pending, etag: 'revision' }))
    await expect(flush(false, true)).rejects.toMatchObject({ name: 'ConflictError', currentEtag: 'revision', externalEditMode: !pending, externalChangesPending: pending })
})
