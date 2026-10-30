import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { canonical, hashLocalJson } from '../../../shared/play-set/protocol'

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('../alert', () => ({ alertInput: vi.fn(), waitAlert: vi.fn(), notifyError: vi.fn() }))
vi.mock('./database.svelte', () => ({ normalizeChat: vi.fn((value: unknown) => value), getDatabase: vi.fn() }))
vi.mock('../globalApi.svelte', () => ({ forageStorage: {} }))
vi.mock('./risuSave', async importOriginal => {
    const actual = await importOriginal<typeof import('./risuSave')>()
    return { ...actual, decodeRisuSave: vi.fn(actual.decodeRisuSave) }
})

import { decodeRisuSave, encodeRisuSaveLegacy } from './risuSave'
import { normalizeChat } from './database.svelte'
import { NodeStorage } from './nodeStorage'

const response = (value: unknown, status = 200) => new Response(encodeRisuSaveLegacy(value) as BodyInit, { status })
const fixture = (count: number) => ({
    id: 'chat-1', name: 'Existing chat', note: 'Keep note', scriptstate: { '$state': 'kept' },
    localLore: [{ key: 'synthetic', content: 'Keep lore' }], modules: ['module-1'],
    message: Array.from({ length: count }, (_, index) => ({ id: `message-${index}`, role: index % 2 ? 'char' : 'user', data: `Text ${index}` })),
})

function pagingResponse(chat: ReturnType<typeof fixture>, route: string) {
    const query = new URL(route, 'http://localhost').searchParams
    const offset = Number(query.get('offset')), limit = Number(query.get('limit'))
    const { message, ...metadata } = chat
    return response({ chat: metadata, messages: message.slice(offset, offset + limit), offset, limit, total: message.length })
}

function transport(handler: (route: string, init?: RequestInit) => Promise<Response>) {
    const storage = new NodeStorage(), request = vi.fn(handler)
    Object.defineProperty(storage, 'authFetch', { value: request })
    return { storage, request }
}

beforeEach(() => {
    vi.mocked(decodeRisuSave).mockClear()
    vi.mocked(normalizeChat).mockReset()
    vi.mocked(normalizeChat).mockImplementation(value => value as any)
})

describe('NodeStorage exact raw chat reads for startup recovery', () => {
    const legacy = () => ({
        id: 'legacy-chat', message: [{ role: 'user', data: 'synthetic legacy body' }],
        scriptstate: { synthetic: 9 }, savedToggleValues: { synthetic: 'keep' },
    })

    it('preserves absent legacy fields and the server canonical hash without calling normalizeChat', async () => {
        const body = legacy()
        const { storage, request } = transport(async () => response(body))
        const raw = await storage.fetchRawChatContent('character / 1', 2, body.id)
        expect(raw).toEqual(body)
        for (const field of ['note', 'name', 'localLore', 'supaMemory', 'risuBardWikiGuide', 'risuBardWikiReboot', 'lorebookOwnerId']) {
            expect(Object.hasOwn(raw, field)).toBe(false)
        }
        // Server localHash uses SHA256(canonical(value,true)); this is the same
        // representation used for partial recovery currentHash classification.
        const serverHash = createHash('sha256').update(canonical(body as any, true)).digest('hex')
        expect(await hashLocalJson(raw)).toBe(serverHash)
        expect(normalizeChat).not.toHaveBeenCalled()
        expect(decodeRisuSave).toHaveBeenCalledOnce()
        expect(request).toHaveBeenCalledExactlyOnceWith('/api/chat-content/character%20%2F%201/2', { headers: { 'x-chat-id': body.id } })
    })

    it('keeps the full fallback normalization contract for ordinary fetchChatContent', async () => {
        const body = legacy()
        const normalized = { ...body, note: '', name: '', localLore: [], supaMemory: false, risuBardWikiGuide: '' }
        vi.mocked(normalizeChat).mockReturnValueOnce(normalized as any)
        const { storage, request } = transport(async route => route.includes('/page?') ? response({}, 404) : response(body))
        expect(await storage.fetchChatContent('character-1', 0, body.id)).toEqual(normalized)
        expect(normalizeChat).toHaveBeenCalledExactlyOnceWith(body)
        expect(request.mock.calls.map(([route]) => route)).toEqual([
            '/api/chat-content/character-1/0/page?offset=0&limit=500', '/api/chat-content/character-1/0',
        ])
        for (const [, init] of request.mock.calls) expect(init?.headers).toEqual({ 'x-chat-id': body.id })
    })

    it('returns null for a missing raw body without decoding or normalizing it', async () => {
        const { storage, request } = transport(async () => response({}, 404))
        expect(await storage.fetchRawChatContent('card', 0, 'legacy-chat')).toBeNull()
        expect(decodeRisuSave).not.toHaveBeenCalled()
        expect(normalizeChat).not.toHaveBeenCalled()
        expect(request).toHaveBeenCalledOnce()
    })

    it('keeps the ordinary full fallback null case without normalizing null', async () => {
        const { storage, request } = transport(async () => response({}, 404))
        expect(await storage.fetchChatContent('card', 0, 'legacy-chat')).toBeNull()
        expect(decodeRisuSave).not.toHaveBeenCalled()
        expect(normalizeChat).not.toHaveBeenCalled()
        expect(request).toHaveBeenCalledTimes(2)
    })

    it.each([401, 423, 500])('propagates raw HTTP %s as a failure without decode, normalization or route fallback', async status => {
        const { storage, request } = transport(async () => response({}, status))
        await expect(storage.fetchRawChatContent('card', 0, 'legacy-chat')).rejects.toThrow(`fetchChatContent error: ${status}`)
        expect(request).toHaveBeenCalledOnce()
        expect(request.mock.calls[0][0]).toBe('/api/chat-content/card/0')
        expect(decodeRisuSave).not.toHaveBeenCalled()
        expect(normalizeChat).not.toHaveBeenCalled()
    })

    it('does not turn a corrupt raw body into a successful empty chat', async () => {
        // A map declares one entry but has no key/value bytes. MessagePack 0xc1
        // is a recognized extension marker, so it is not a corrupt fixture.
        const { storage, request } = transport(async () => new Response(new Uint8Array([0x81])))
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        try {
            await expect(storage.fetchRawChatContent('card', 0, 'legacy-chat')).rejects.toBeDefined()
            expect(request).toHaveBeenCalledOnce()
            expect(decodeRisuSave).toHaveBeenCalledOnce()
            expect(normalizeChat).not.toHaveBeenCalled()
        } finally {
            error.mockRestore()
            log.mockRestore()
        }
    })
})

describe('NodeStorage bounded chat paging', () => {
    it('hydrates 436 messages with one 500-message request and keeps chat metadata', async () => {
        const chat = fixture(436)
        const { storage, request } = transport(async route => pagingResponse(chat, route))
        expect(await storage.fetchChatContent('character / 1', 2, chat.id)).toEqual(chat)
        expect(request).toHaveBeenCalledOnce()
        expect(request).toHaveBeenCalledWith('/api/chat-content/character%20%2F%201/2/page?offset=0&limit=500', { headers: { 'x-chat-id': chat.id } })
    })

    it('assembles 1001 messages from three pages in order, including the final single message', async () => {
        const chat = fixture(1001), completed: number[] = []
        const { storage, request } = transport(async route => {
            const offset = Number(new URL(route, 'http://localhost').searchParams.get('offset'))
            if (offset === 500) await new Promise(resolve => setTimeout(resolve, 5))
            completed.push(offset)
            return pagingResponse(chat, route)
        })
        expect(await storage.fetchChatContent('character-1', 0, chat.id)).toEqual(chat)
        expect(request.mock.calls.map(([route]) => route)).toEqual([0, 500, 1000].map(offset => `/api/chat-content/character-1/0/page?offset=${offset}&limit=500`))
        expect(completed).toEqual([0, 1000, 500])
        for (const [, init] of request.mock.calls) expect(init?.headers).toEqual({ 'x-chat-id': chat.id })
    })

    it('keeps the existing maximum of four parallel requests after the first page', async () => {
        const chat = fixture(2501)
        let active = 0, peak = 0
        const { storage, request } = transport(async route => {
            active++; peak = Math.max(peak, active)
            await new Promise(resolve => setTimeout(resolve, 1))
            active--
            return pagingResponse(chat, route)
        })
        expect(await storage.fetchChatContent('character-1', 0, chat.id)).toEqual(chat)
        expect(request).toHaveBeenCalledTimes(6)
        expect(peak).toBe(4)
    })

    it('uses the full-chat compatibility endpoint exactly once after a first-page 404', async () => {
        const chat = fixture(436)
        const { storage, request } = transport(async route => route.includes('/page?') ? response({ error: 'Missing page endpoint' }, 404) : response(chat))
        expect(await storage.fetchChatContent('character-1', 0, chat.id)).toEqual(chat)
        expect(request.mock.calls.map(([route]) => route)).toEqual([
            '/api/chat-content/character-1/0/page?offset=0&limit=500', '/api/chat-content/character-1/0',
        ])
        for (const [, init] of request.mock.calls) expect(init?.headers).toEqual({ 'x-chat-id': chat.id })
    })

    it.each([409, 500])('rejects first-page HTTP %s without falling back or returning a partial chat', async status => {
        const { storage, request } = transport(async () => response({ error: 'Existing server failure' }, status))
        await expect(storage.fetchChatContent('character-1', 0, 'chat-1')).rejects.toThrow(`fetchChatContent page error: ${status}`)
        expect(request).toHaveBeenCalledOnce()
        expect(decodeRisuSave).not.toHaveBeenCalled()
    })

    it('rejects a nonempty chat whose first page makes no progress', async () => {
        const { storage, request } = transport(async () => response({ chat: { id: 'chat-1' }, messages: [], offset: 0, limit: 500, total: 1 }))
        await expect(storage.fetchChatContent('character-1', 0, 'chat-1')).rejects.toThrow('fetchChatContent page made no progress')
        expect(request).toHaveBeenCalledOnce()
    })

    it('propagates the last-page failure without fallback or partial success', async () => {
        const chat = fixture(1001)
        const { storage, request } = transport(async route => route.includes('offset=1000&') ? response({ error: 'Lost final page' }, 503) : pagingResponse(chat, route))
        await expect(storage.fetchChatContent('character-1', 0, chat.id)).rejects.toThrow('fetchChatContent page error: 503')
        expect(request).toHaveBeenCalledTimes(3)
        expect(request.mock.calls.every(([route]) => route.includes('/page?'))).toBe(true)
    })

    it('retains the empty-chat case without additional requests', async () => {
        const chat = fixture(0)
        const { storage, request } = transport(async route => pagingResponse(chat, route))
        expect(await storage.fetchChatContent('character-1', 0, chat.id)).toEqual(chat)
        expect(request).toHaveBeenCalledOnce()
    })
})
