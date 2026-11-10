// Regression for the PC "기준 기기 값으로 맞추기" failure: the server answers 423 NAS_SYNC_BUSY to an ordinary write while an exclusive
// sync step (bootstrap/snapshot/plan) runs; the write must wait and be resent unchanged, not be counted as a failed save.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('src/ts/stores.svelte', () => ({ selIdState: { selId: 0 }, DBState: { db: { characters: [] } } }))
vi.mock('./database.svelte', () => ({
    normalizeChat: (value: unknown) => value, getCurrentChat: () => null, getCurrentCharacter: () => null,
    getDatabase: () => ({ modules: [], enabledModules: [], personas: [], selectedPersona: 0, personaEnabledModules: {}, characters: [] }),
}))
vi.mock('./risuSave', () => ({ decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: vi.fn() }))
vi.mock('./chatContentPage', () => ({ assembleChatContentPages: vi.fn() }))

import { NodeStorage } from './nodeStorage'

const busy = () => new Response(JSON.stringify({ error: 'NAS sync apply must finish before saving', code: 'NAS_SYNC_BUSY' }), { status: 423, headers: { 'content-type': 'application/json' } })
const ok = () => new Response(JSON.stringify({ etag: 'e2' }), { status: 200, headers: { 'content-type': 'application/json' } })

describe('ordinary writes behind the NAS sync write gate', () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('a write refused with 423 NAS_SYNC_BUSY is resent unchanged after the gate clears and then succeeds', async () => {
        const storage = new NodeStorage()
        const answers = [busy(), busy(), ok()]
        const fetch = vi.fn(async () => answers.shift()!)
        ;(storage as any).authFetch = fetch
        const bytes = new Uint8Array([1, 2, 3])
        const pending = storage.setItem('database/database.bin', bytes)
        await vi.advanceTimersByTimeAsync(NodeStorage.SYNC_BUSY_RETRY_MS * 2 + 10)
        await pending
        expect(fetch).toHaveBeenCalledTimes(3)
        expect(fetch.mock.calls.every(([path, init]: any) => path === '/api/write' && init.body === bytes && init.method === 'POST')).toBe(true)
    })

    it('an import asset batch (setItems → bulk-write) waits behind the gate too; an armed plan (transaction) is not waited for', async () => {
        const storage = new NodeStorage()
        const answers = [busy(), ok()]
        const fetch = vi.fn(async () => answers.shift()!)
        ;(storage as any).authFetch = fetch
        const pending = storage.setItems([{ key: 'assets/a.png', value: new Uint8Array([1, 2]) }])
        await vi.advanceTimersByTimeAsync(NodeStorage.SYNC_BUSY_RETRY_MS + 10)
        await pending
        expect(fetch).toHaveBeenCalledTimes(2)
        expect(fetch.mock.calls.every(([path, init]: any) => path === '/api/assets/bulk-write' && init.body === (fetch.mock.calls[0] as any)[1].body)).toBe(true)
        const armed = vi.fn(async () => new Response(JSON.stringify({ error: 'NAS sync apply must finish before saving', code: 'NAS_SYNC_BUSY', transaction: 'tx' }), { status: 423 }))
        ;(storage as any).authFetch = armed
        await expect(storage.setItems([{ key: 'assets/b.png', value: new Uint8Array([3]) }])).rejects.toBe('setItems Error')
        expect(armed).toHaveBeenCalledTimes(1)
    })

    it('an import cancel stops resending an asset batch waiting behind the gate; the request in flight is not aborted', async () => {
        const storage = new NodeStorage()
        const fetch = vi.fn(async (_path: string, init: any) => { expect(init.signal).toBeUndefined(); return busy() })
        ;(storage as any).authFetch = fetch
        const cancel = new AbortController()
        const pending = storage.setItems([{ key: 'assets/c.png', value: new Uint8Array([4]) }], cancel.signal)
        const outcome = expect(pending).rejects.toBeTruthy()
        await vi.advanceTimersByTimeAsync(NodeStorage.SYNC_BUSY_RETRY_MS * 2 + 10)
        const sent = fetch.mock.calls.length
        cancel.abort(new Error('Import cancelled'))
        await vi.advanceTimersByTimeAsync(NodeStorage.SYNC_BUSY_RETRY_MS * 4)
        await outcome
        expect(fetch.mock.calls.length).toBe(sent)
        expect((storage as any).pendingSaveRequests).toBe(0)
    })

    it('0.9.92-ver7: a chunked chat upload refused at its commit (423 on the last chunk) is uploaded again from the first chunk under a new upload id, never by resending the last chunk alone; an earlier chunk refused the same way is resent alone under the same id (Codex A7)', async () => {
        const { encodeRisuSaveLegacy } = await import('./risuSave') as any
        encodeRisuSaveLegacy.mockReturnValue(new Uint8Array(2 * 1024 * 1024 + 1))
        const db = await import('./database.svelte') as any, original = db.getDatabase
        const storage = new NodeStorage()
        const posts: { id: string; index: string }[] = []; let refused = false, early = false
        ;(storage as any).authFetch = vi.fn(async (_url: string, init: any) => {
            if (init.method === 'DELETE') return ok()
            const index = init.headers['x-upload-index'], id = init.headers['x-upload-id']
            posts.push({ id, index })
            if (index === '1' && !early) { early = true; return busy() }
            if (index !== '2') return new Response(JSON.stringify({ uploadId: id, nextIndex: Number(index) + 1 }), { status: 202 })
            if (!refused) { refused = true; return busy() }
            return ok()
        })
        vi.spyOn(db, 'getDatabase').mockReturnValue({ ...original(), chatUploadChunkMiB: 1, chatUploadChunkEnabled: true })
        try {
            const pending = storage.saveChatContent('cha', 0, 'chat', {})
            await vi.advanceTimersByTimeAsync(NodeStorage.SYNC_BUSY_RETRY_MS * 2 + 20)
            await pending
            expect(posts.map(p => p.index)).toEqual(['0', '1', '1', '2', '0', '1', '2'])
            expect(new Set(posts.slice(0, 4).map(p => p.id)).size).toBe(1); expect(new Set(posts.slice(4).map(p => p.id)).size).toBe(1); expect(posts[4].id).not.toBe(posts[0].id)
            expect((storage as any).pendingSaveRequests).toBe(0)
        } finally { vi.restoreAllMocks() }
    })

    it('0.9.92-ver7: a refused chunked commit whose cleanup (DELETE) is not confirmed does not start another upload — also when an earlier cleanup succeeded and this one only times out (Codex A8/A9: upload slots)', async () => {
        const { encodeRisuSaveLegacy } = await import('./risuSave') as any
        encodeRisuSaveLegacy.mockReturnValue(new Uint8Array(1024 * 1024 + 1))
        const db = await import('./database.svelte') as any, original = db.getDatabase
        const storage = new NodeStorage()
        const ids = new Set<string>(); let deletes = 0
        ;(storage as any).authFetch = vi.fn(async (_url: string, init: any) => {
            if (init.method === 'DELETE') return deletes++ ? new Promise<Response>(() => {}) : ok() // the second cleanup never answers (5 s bound)
            ids.add(init.headers['x-upload-id'])
            return init.headers['x-upload-index'] === '0' ? new Response(JSON.stringify({ uploadId: init.headers['x-upload-id'], nextIndex: 1 }), { status: 202 }) : busy()
        })
        vi.spyOn(db, 'getDatabase').mockReturnValue({ ...original(), chatUploadChunkMiB: 1, chatUploadChunkEnabled: true })
        try {
            const pending = expect(storage.saveChatContent('cha', 0, 'chat', {})).rejects.toThrow('saveChatContent error: 503')
            await vi.advanceTimersByTimeAsync(NodeStorage.SYNC_BUSY_RETRY_MS * 3 + 5_000)
            await pending
            expect(ids.size).toBe(2)
            expect((storage as any).pendingSaveRequests).toBe(0)
        } finally { vi.restoreAllMocks() }
    })

    it('other 423s (session takeover) and non-busy failures keep the old behaviour: no retry', async () => {
        const storage = new NodeStorage()
        const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'session', code: 'SESSION_INACTIVE' }), { status: 423 }))
        ;(storage as any).authFetch = fetch
        await expect(storage.setItem('database/database.bin', new Uint8Array([1]))).rejects.toBe('setItem Error')
        expect(fetch).toHaveBeenCalledTimes(1)
    })

    it('the wait is bounded and honours the caller abort; a stream body is never replayed', async () => {
        const storage = new NodeStorage()
        ;(storage as any).authFetch = vi.fn(async () => busy())
        const started = Date.now(); vi.setSystemTime(started)
        const timedOut = expect(storage.setItem('database/database.bin', new Uint8Array([1]))).rejects.toBe('setItem Error') // surfaces as before once the bound is exceeded
        vi.setSystemTime(started + NodeStorage.SYNC_BUSY_WAIT_MS + 1); await vi.advanceTimersByTimeAsync(NodeStorage.SYNC_BUSY_RETRY_MS + 10)
        await timedOut
        const controller = new AbortController()
        const aborted = expect((storage as any).saveRequest('/api/write', { method: 'POST', body: 'x', signal: controller.signal })).rejects.toThrow()
        controller.abort(); await vi.advanceTimersByTimeAsync(NodeStorage.SYNC_BUSY_RETRY_MS + 10)
        await aborted
        const stream = new ReadableStream({ start(c) { c.close() } })
        expect((await (storage as any).saveRequest('/api/write', { method: 'POST', body: stream })).status).toBe(423)
    })
})

describe('armed plan and header changes', () => {
    it('a 423 that names an armed transaction is returned at once (recovery settles it), never waited on', async () => {
        const storage = new NodeStorage()
        const fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'NAS sync apply must finish before saving', code: 'NAS_SYNC_BUSY', transaction: 'tx-armed' }), { status: 423 }))
        ;(storage as any).authFetch = fetch
        await expect(storage.setItem('database/database.bin', new Uint8Array([1]))).rejects.toBe('setItem Error')
        expect(fetch).toHaveBeenCalledTimes(1)
    })
    it('a buffered ordinary write is not resent once a sync transaction header exists (it would pass the gate as the apply\'s own save)', async () => {
        vi.useFakeTimers()
        try {
            const storage = new NodeStorage()
            const fetch = vi.fn(async () => { storage.syncTransaction = 'tx-new'; return busy() })
            ;(storage as any).authFetch = fetch
            const pending = expect((storage as any).saveRequest('/api/write', { method: 'POST', body: 'x' })).resolves.toMatchObject({ status: 423 })
            await vi.advanceTimersByTimeAsync(NodeStorage.SYNC_BUSY_RETRY_MS * 3)
            await pending
            expect(fetch).toHaveBeenCalledTimes(1)
            storage.syncTransaction = 'tx-own' // the apply's own write is never retried either
            ;(storage as any).authFetch = vi.fn(async () => busy())
            expect((await (storage as any).saveRequest('/api/write', { method: 'POST', body: 'x' })).status).toBe(423)
        } finally { vi.useRealTimers() }
    })
})

describe('transaction identity flips during the wait', () => {
    it('a sync transaction that appears while the retry timer runs stops the retransmission: authFetch is called once and the earlier 423 stands', async () => {
        vi.useFakeTimers()
        try {
            const storage = new NodeStorage()
            const fetch = vi.fn(async () => busy())
            ;(storage as any).authFetch = fetch
            const pending = expect((storage as any).saveRequest('/api/write', { method: 'POST', body: 'x' })).resolves.toMatchObject({ status: 423 })
            setTimeout(() => { storage.syncTransaction = 'tx-armed-meanwhile' }, NodeStorage.SYNC_BUSY_RETRY_MS / 2)
            await vi.advanceTimersByTimeAsync(NodeStorage.SYNC_BUSY_RETRY_MS * 3)
            await pending
            expect(fetch).toHaveBeenCalledTimes(1)
        } finally { vi.useRealTimers() }
    })
    it('a manual transfer transaction that starts during the wait stops the retransmission too', async () => {
        vi.useFakeTimers()
        try {
            const storage = new NodeStorage()
            const fetch = vi.fn(async () => busy())
            ;(storage as any).authFetch = fetch
            const pending = expect((storage as any).saveRequest('/api/write', { method: 'POST', body: 'x' })).resolves.toMatchObject({ status: 423 })
            setTimeout(() => { storage.transferTransaction = 'import-meanwhile' }, NodeStorage.SYNC_BUSY_RETRY_MS / 2)
            await vi.advanceTimersByTimeAsync(NodeStorage.SYNC_BUSY_RETRY_MS * 3)
            await pending
            expect(fetch).toHaveBeenCalledTimes(1)
        } finally { vi.useRealTimers() }
    })
})
