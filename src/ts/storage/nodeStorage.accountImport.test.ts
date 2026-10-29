import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('src/ts/stores.svelte', () => ({
    selIdState: { selId: 0 },
    DBState: { db: { characters: [] } },
}))
vi.mock('../alert', () => ({
    alertInput: vi.fn(),
    waitAlert: vi.fn(),
    notifyError: vi.fn(),
}))
vi.mock('./database.svelte', () => ({
    normalizeChat: (value: unknown) => value,
    getCurrentChat: () => null,
    getCurrentCharacter: () => null,
    getDatabase: () => ({ characters: [] }),
}))
vi.mock('./risuSave', () => ({ decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: vi.fn() }))
vi.mock('./chatContentPage', () => ({ assembleChatContentPages: vi.fn() }))

import { NodeStorage } from './nodeStorage'

function setUpStorage() {
    const storage = new NodeStorage()
    storage.authChecked = true
    vi.spyOn(storage, 'createAuth').mockResolvedValue('token')
    vi.spyOn(storage as any, 'checkAuth').mockResolvedValue(undefined)
    return storage
}

/** A response whose body the test writes. */
function streamResponse() {
    const encoder = new TextEncoder()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({ start(c) { controller = c } })
    return {
        response: new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
        push: (line: string) => controller.enqueue(encoder.encode(line)),
        end: () => controller.close(),
        fail: (error: Error) => controller.error(error),
    }
}

describe('NodeStorage RisuAI account import', () => {
    let fetchSpy: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
        vi.useFakeTimers()
        fetchSpy = vi.spyOn(globalThis, 'fetch')
    })
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

    test('a refused write tells the app why', async () => {
        fetchSpy
            .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'busy', code: 'ACCOUNT_IMPORT_ACTIVE' }), { status: 423 }))
            .mockResolvedValueOnce(new Response('locked', { status: 423 }))
        const storage = setUpStorage()
        const reasons: unknown[] = []
        const listener = (event: Event) => reasons.push((event as CustomEvent).detail?.code)
        window.addEventListener('risu-session-deactivated', listener)
        try {
            await expect(storage.applyRisuAccountImport()).rejects.toMatchObject({ status: 423, code: 'ACCOUNT_IMPORT_ACTIVE' })
            await expect(storage.applyRisuAccountImport()).rejects.toMatchObject({ status: 423 })
        } finally {
            window.removeEventListener('risu-session-deactivated', listener)
        }
        expect(reasons).toEqual(['ACCOUNT_IMPORT_ACTIVE', null])
    })

    // RisuBard never puts a time limit on a server wait.
    test('waits for a slow status answer instead of giving up', async () => {
        let answer: (response: Response) => void = () => {}
        fetchSpy.mockReturnValueOnce(new Promise<Response>((resolve) => { answer = resolve }))
        const storage = setUpStorage()

        let settled: unknown = 'pending'
        const pending = storage.getRisuAccountImportStatus().then((status) => { settled = status }, (error) => { settled = error })
        await vi.advanceTimersByTimeAsync(10 * 60_000)
        expect(settled).toBe('pending')
        expect((fetchSpy.mock.calls[0] as any[])[1].signal).toBeUndefined()

        answer(new Response(JSON.stringify({ state: 'idle', blocking: false }), { status: 200 }))
        await pending
        expect(settled).toMatchObject({ state: 'idle', blocking: false })
    })

    test('a status read whose body is cut off fails instead of reading as an empty status', async () => {
        const truncated = streamResponse()
        const broken = streamResponse()
        fetchSpy.mockResolvedValueOnce(truncated.response).mockResolvedValueOnce(broken.response)
        const storage = setUpStorage()

        truncated.push('{"state":')
        truncated.end()
        await expect(storage.getRisuAccountImportStatus()).rejects.toBeInstanceOf(SyntaxError)

        const pending = storage.getRisuAccountImportStatus()
        broken.push('{"state":')
        broken.fail(new TypeError('network error'))
        await expect(pending).rejects.toThrow()
    })

    test('an error answer carries its code even without a JSON body', async () => {
        fetchSpy
            .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'nope', code: 'ACCOUNT_MISMATCH' }), { status: 409 }))
            .mockResolvedValueOnce(new Response('<html>', { status: 404 }))
        const storage = setUpStorage()
        await expect(storage.prepareRisuAccountImport('token-value', 'id')).rejects.toMatchObject({ status: 409, code: 'ACCOUNT_MISMATCH' })
        await expect(storage.getRisuAccountImportStatus()).rejects.toMatchObject({ status: 404, code: null })
    })
})
