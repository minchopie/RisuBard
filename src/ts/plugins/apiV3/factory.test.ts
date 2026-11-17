import { afterEach, describe, expect, test, vi } from 'vitest'
import { SandboxHost } from './factory'

describe('API v3 plugin sandbox document', () => {
    test('creates distinct CSP nonces over HTTP without crypto.randomUUID', () => {
        const getRandomValues = vi.fn(crypto.getRandomValues.bind(crypto))
        vi.stubGlobal('crypto', { getRandomValues })
        const nonces: string[] = []

        for (let i = 0; i < 2; i++) {
            const iframe = document.createElement('iframe')
            const host = new SandboxHost({})
            const stop = host.run(iframe, '')
            try {
                const nonce = iframe.getAttribute('csp')?.match(/'nonce-([^']+)'/)?.[1]
                expect(nonce).toMatch(/^[0-9a-f]{32}$/)
                expect(iframe.srcdoc).toContain(`<script nonce="${nonce}">`)
                expect(iframe.sandbox.contains('allow-same-origin')).toBe(false)
                nonces.push(nonce!)
            } finally {
                stop()
            }
        }

        expect(getRandomValues).toHaveBeenCalledTimes(2)
        expect(getRandomValues.mock.calls[0][0]).toHaveLength(16)
        expect(nonces[0]).not.toBe(nonces[1])
    })

    afterEach(() => {
        document.body.replaceChildren()
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
    })

    test('loads the sandbox without blob navigation and keeps its security policy', () => {
        const createObjectURL = vi.spyOn(URL, 'createObjectURL')
        const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL')
        const iframe = document.createElement('iframe')
        const host = new SandboxHost({})

        const stop = host.run(iframe, 'globalThis.pluginLoaded = true')

        expect(createObjectURL).not.toHaveBeenCalled()
        expect(iframe.getAttribute('src')).toBeNull()
        expect(iframe.srcdoc).toContain('globalThis.pluginLoaded = true')
        expect(iframe.sandbox.contains('allow-scripts')).toBe(true)
        expect(iframe.sandbox.contains('allow-modals')).toBe(true)
        expect(iframe.sandbox.contains('allow-downloads')).toBe(true)
        expect(iframe.sandbox.contains('allow-same-origin')).toBe(false)
        expect(iframe.getAttribute('allow') ?? '').toContain('screen-wake-lock')
        expect(iframe.getAttribute('csp')).toContain("default-src 'none'")
        expect(iframe.srcdoc).toContain(`content="${iframe.getAttribute('csp')}"`)
        expect(revokeObjectURL).not.toHaveBeenCalled()

        iframe.dispatchEvent(new Event('load'))

        stop()

        expect(revokeObjectURL).not.toHaveBeenCalled()
    })

    test('removes the frame and message handler when terminated before load', () => {
        const removeEventListener = vi.spyOn(window, 'removeEventListener')
        const iframe = document.createElement('iframe')
        const host = new SandboxHost({})
        document.body.appendChild(iframe)

        host.run(iframe, '')
        host.terminate()
        iframe.dispatchEvent(new Event('load'))

        expect(iframe.isConnected).toBe(false)
        expect(removeEventListener).toHaveBeenCalledWith('message', expect.any(Function))
    })

    test('bridges callbacks nested in API argument objects', async () => {
        vi.stubGlobal('ImageBitmap', class ImageBitmap {})
        const addProvider = vi.fn()
        const iframe = document.createElement('iframe')
        const host = new SandboxHost({ addProvider })
        const stop = host.run(iframe, '')

        window.dispatchEvent(new MessageEvent('message', {
            source: iframe.contentWindow,
            data: {
                type: 'CALL_ROOT',
                reqId: 'add-provider',
                method: 'addProvider',
                args: [
                    'callback-repro',
                    { __type: 'CALLBACK_REF', id: 'provider-callback' },
                    {
                        overrideRequestStatus: {
                            __type: 'CALLBACK_REF',
                            id: 'status-callback',
                        },
                    },
                ],
            },
        }))

        await vi.waitFor(() => expect(addProvider).toHaveBeenCalledOnce())
        const [, provider, options] = addProvider.mock.calls[0]

        expect(provider).toBeTypeOf('function')
        expect(options.overrideRequestStatus).toBeTypeOf('function')

        stop()
    })

    test('serializes callbacks nested in guest API argument objects', async () => {
        const iframe = document.createElement('iframe')
        const host = new SandboxHost({})

        const stop = host.run(iframe, '')
        const documentText = iframe.srcdoc
        expect(documentText).toContain('const serialized = serializeArg(val);')
        expect(documentText).toContain('out[key] = serialized;')

        stop()
    })

    test('ignores API calls from a different frame', () => {
        const registerSetting = vi.fn()
        const iframe = document.createElement('iframe')
        const otherFrame = document.createElement('iframe')
        document.body.append(iframe, otherFrame)
        const host = new SandboxHost({ registerSetting })
        const stop = host.run(iframe, '')

        window.dispatchEvent(new MessageEvent('message', {
            source: otherFrame.contentWindow,
            data: { type: 'CALL_ROOT', reqId: 'spoof', method: 'registerSetting', args: [] },
        }))

        expect(registerSetting).not.toHaveBeenCalled()
        stop()
    })
})


describe('plugin transfer collection fast path', () => {
    test('keeps nested buffers and platform transfers in their original order', () => {
        vi.stubGlobal('ImageBitmap', class ImageBitmap {})
        try {
            const host = new SandboxHost({}) as any
            const a = new ArrayBuffer(2)
            const b = new Uint8Array(3)
            Object.defineProperty(b, 'constructor', { value: Object })
            const channel = new MessageChannel()
            vi.stubGlobal('MessagePort', channel.port1.constructor)
            const bitmap = new ImageBitmap()
            const writable = new WritableStream()
            Object.defineProperty(writable, 'constructor', { value: Object })
            const transform = new TransformStream()
            const value = { chats: [{ message: [{ data: 'same', binary: b }] }], a, channel: channel.port1, bitmap, writable, transform }
            expect(host.collectTransferables(value)).toEqual([b.buffer, a, channel.port1, bitmap, writable, transform])
            channel.port1.close(); channel.port2.close()
        } finally { vi.unstubAllGlobals() }
    })

    test('does not inspect platform instance prototypes for ordinary message records', () => {
        const host = new SandboxHost({}) as any
        const inspected = vi.fn(() => { throw new Error('slow platform check') })
        const original = globalThis.ImageBitmap
        const Fake = function () {}
        Object.defineProperty(Fake, Symbol.hasInstance, { value: inspected })
        vi.stubGlobal('ImageBitmap', Fake)
        try {
            expect(host.collectTransferables({ chats: [{ message: [{ role: 'user', data: 'hello' }] }] })).toEqual([])
            expect(inspected).not.toHaveBeenCalled()
        } finally { vi.stubGlobal('ImageBitmap', original); vi.unstubAllGlobals() }
    })
})
