import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('src/lang', () => ({ language: { storageConnectionTimeout: 'connection timeout', storageWriteTimeout: 'write timeout' } }))
vi.mock('../alert', () => ({ alertInput: vi.fn(), waitAlert: vi.fn(), notifyError: vi.fn() }))
vi.mock('./database.svelte', () => ({ normalizeChat: (v: unknown) => v, getDatabase: () => ({}) }))
vi.mock('./risuSave', () => ({ decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: () => new Uint8Array([1]) }))
import { NodeStorage } from './nodeStorage'

beforeEach(() => {
    vi.useFakeTimers()
    ;(NodeStorage as any).sessionInitialized = true
    ;(NodeStorage as any).sessionPending = null
})
afterEach(() => {
    ;(NodeStorage as any).sessionInitialized = false
    ;(NodeStorage as any).sessionPending = null
    vi.useRealTimers(); vi.unstubAllGlobals()
})

it.each(['cleanup', 'prepare'])('shows the server reason for failed import rollback %s', async action => {
    const storage = new NodeStorage()
    ;(storage as any).authFetch = vi.fn(async () => Response.json({ error: 'Plugin storage unavailable during asset cleanup' }, { status: 500 }))
    const request = action === 'cleanup' ? storage.cleanupImportAssets(['assets/new.png'], 'id') : storage.prepareImportRollback('id')
    await expect(request).rejects.toThrow('Plugin storage unavailable during asset cleanup')
})

it.each(['cleanup', 'prepare'])('waits for a stalled import rollback %s response without a time limit', async action => {
    const storage = new NodeStorage()
    ;(storage as any).authFetch = vi.fn(() => new Promise(() => {}))
    let settled = false
    void (action === 'cleanup' ? storage.cleanupImportAssets([], 'id') : storage.prepareImportRollback('id')).finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(600_000)
    expect(settled).toBe(false)
    expect(storage.pendingSaveRequests).toBe(1)
})

it('keeps the HTTP status when the rollback error body is not JSON', async () => {
    const storage = new NodeStorage()
    ;(storage as any).authFetch = vi.fn(async () => new Response('<html>proxy failure</html>', { status: 502 }))
    await expect(storage.cleanupImportAssets([], 'id')).rejects.toThrow('Import rollback failed (502)')
})

it.each(['CANONICAL_FILES_CHANGED', 'EXTERNAL_EDIT_MODE'])('preserves %s through the bounded save transport', async code => {
    const storage = new NodeStorage()
    ;(storage as any).authFetch = vi.fn(async () => Response.json({code, error: 'conflict', currentEtag: 'new'}, {status: 409}))
    await expect(storage.saveChatContent('c', 0, 'chat', {})).rejects.toMatchObject({
        currentEtag: 'new', canonicalFilesChanged: code === 'CANONICAL_FILES_CHANGED',
        externalEditMode: code === 'EXTERNAL_EDIT_MODE',
    })
    expect(storage.pendingSaveRequests).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
})

it('waits for a slow shared token refresh without a time limit', async () => {
    const storage = new NodeStorage()
    let release!: (v: Response) => void
    const fetch = vi.fn(() => new Promise<Response>(resolve => { release = resolve }))
    vi.stubGlobal('fetch', fetch)
    const first = storage.createAuth()
    const concurrent = storage.createAuth()
    await vi.advanceTimersByTimeAsync(600_000)
    release(Response.json({ token: 'late' }))
    expect(await first).toBe('late')
    expect(await concurrent).toBe('late')
    expect(fetch).toHaveBeenCalledOnce()
})

it('keeps using a still-valid token when its renewal stalls', async () => {
    const storage = new NodeStorage()
    // Every renewal after the first stalls behind other connections.
    const fetch = vi.fn().mockImplementation(() => new Promise(() => {}))
        .mockResolvedValueOnce(Response.json({ token: 'current' }))
    vi.stubGlobal('fetch', fetch)
    expect(await storage.createAuth()).toBe('current')
    // Inside the renewal window callers get the current token without waiting.
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000)
    expect(await storage.createAuth()).toBe('current')
    expect(fetch.mock.calls.length).toBeGreaterThan(1)
    // Stalled renewals time out without breaking the still-valid session.
    await vi.advanceTimersByTimeAsync(8_000)
    expect(await storage.createAuth()).toBe('current')
})

it('waits for a slow session initialization without a time limit', async () => {
    ;(NodeStorage as any).sessionInitialized = false
    const storage = new NodeStorage()
    vi.spyOn(storage, 'createAuth').mockResolvedValue('token')
    let release!: (v: Response) => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise(resolve => { release = resolve })))
    const init = (storage as any).initSession()
    await vi.advanceTimersByTimeAsync(600_000)
    expect((NodeStorage as any).sessionInitialized).toBe(false)
    release(Response.json({}))
    await init
    expect((NodeStorage as any).sessionInitialized).toBe(true)
})

it.each(['chat', 'patch', 'database'])('waits for a slow %s save response without a time limit or retry', async kind => {
    const storage = new NodeStorage()
    storage.setDbEtag('before')
    const request = vi.fn(() => new Promise<Response>(() => {}))
    ;(storage as any).authFetch = request
    let settled = false
    void (kind === 'chat' ? storage.saveChatContent('c', 0, 'chat', {})
        : kind === 'patch' ? storage.patchItem('database/database.bin', { patch: [], expectedHash: 'before' })
        : storage.setItem('database/database.bin', new Uint8Array([1]), 'before')).finally(() => { settled = true })
    await vi.advanceTimersByTimeAsync(600_000)
    expect(settled).toBe(false)
    expect(storage.pendingSaveRequests).toBe(1)
    expect(request).toHaveBeenCalledTimes(1)
})

function authenticatedTransport() {
    const storage = new NodeStorage()
    const check = vi.spyOn(storage as any, 'checkAuth').mockResolvedValue(undefined)
    vi.spyOn(storage, 'createAuth').mockResolvedValue('token')
    return { storage, check }
}

it.each(['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed'])('identifies the app-server transport failure %s and preserves its original cause', async message => {
    const { storage } = authenticatedTransport()
    const cause = new TypeError(message)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause))
    const failure = await storage.getLiveFileMonitoring().catch(error => error)
    expect(failure).toBeInstanceOf(TypeError)
    expect(failure).toMatchObject({
        message: '앱 서버에 연결하지 못했습니다', code: 'APP_SERVER_FETCH', cause,
    })
    expect(failure.cause).toBe(cause)
    // authFetch is shared by reads and session requests; it must not claim an unsaved edit exists.
    for (const route of ['/api/read', '/api/session']) {
        const failure = await (storage as any).authFetch(route).catch((error: unknown) => error)
        expect(failure).toBeInstanceOf(TypeError)
        expect(failure.message).toBe('앱 서버에 연결하지 못했습니다')
        expect(failure.cause).toBe(cause)
        expect(failure.message).not.toMatch(/저장|편집|로컬|내부/)
    }
})

it.each([
    new TypeError('Failed to parse URL from http://['),
    new TypeError('Request with GET/HEAD method cannot have body.'),
    new Error('Failed to fetch'),
    new SyntaxError('invalid response'),
    new DOMException('Aborted', 'AbortError'),
])('preserves non-network exceptions unchanged: %s', async failure => {
    const { storage } = authenticatedTransport()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure))
    await expect((storage as any).authFetch('/api/read')).rejects.toBe(failure)
})

it('does not relabel a cancelled request even if fetch rejects with a network-looking TypeError', async () => {
    const { storage } = authenticatedTransport()
    const controller = new AbortController(), failure = new TypeError('Failed to fetch')
    vi.stubGlobal('fetch', vi.fn(async () => { controller.abort(); throw failure }))
    await expect((storage as any).authFetch('/api/read', { signal: controller.signal })).rejects.toBe(failure)
})

it('leaves authentication and response-decoding failures outside the transport error boundary', async () => {
    const { storage, check } = authenticatedTransport()
    const authFailure = new TypeError('Failed to fetch')
    const fetch = vi.fn(async () => new Response('not-json'))
    vi.stubGlobal('fetch', fetch)
    check.mockRejectedValueOnce(authFailure)
    await expect((storage as any).authFetch('/api/read')).rejects.toBe(authFailure)
    expect(fetch).not.toHaveBeenCalled()
    const decodeFailure = await storage.getLiveFileMonitoring().catch(error => error)
    expect(decodeFailure).toBeInstanceOf(SyntaxError)
    expect(decodeFailure.code).toBeUndefined()
})

it('does not convert an unrecognized HTTP 401 into a connection error or replay it', async () => {
    const { storage } = authenticatedTransport()
    const response = Response.json({ error: 'Permission denied' }, { status: 401 })
    const fetch = vi.fn(async () => response)
    vi.stubGlobal('fetch', fetch)
    expect(await (storage as any).authFetch('/api/read')).toBe(response)
    expect(fetch).toHaveBeenCalledOnce()
})
