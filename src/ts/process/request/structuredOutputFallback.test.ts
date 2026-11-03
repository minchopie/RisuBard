import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import { ModelPresetAdapterError } from 'src/ts/preset/adapter'
import type { AdapterChatOptions } from 'src/ts/preset/adapter'

const baseOptions = (): AdapterChatOptions => ({
    messages: [{ role: 'user', content: 'Return JSON.' }],
    responseSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
    },
})

async function loadFallbackModule() {
    const modulePath = './structuredOutputFallback'
    return import(/* @vite-ignore */ modulePath).catch(() => null)
}

describe('structured output compatibility fallback', () => {
    test('builds the same schema prompt for providers without native support', async () => {
        const module = await loadFallbackModule()
        expect(module).not.toBeNull()
        if (!module) return

        expect(module.createStructuredOutputFallbackMessage(
            baseOptions().responseSchema
        )).toMatchObject({
            role: 'system',
            content: expect.stringContaining('"value"'),
        })
    })

    test('retries one schema rejection as a prompt-schema request', async () => {
        const module = await loadFallbackModule()
        expect(module).not.toBeNull()
        if (!module) return
        const send = vi.fn()
            .mockRejectedValueOnce(new ModelPresetAdapterError(
                'invalid-request',
                'Invalid generation_config.response_schema'
            ))
            .mockResolvedValueOnce('ok')

        await expect(module.sendWithStructuredOutputFallback(
            baseOptions(),
            send
        )).resolves.toBe('ok')

        expect(send).toHaveBeenCalledTimes(2)
        expect(send.mock.calls[1][0].responseSchema).toBeUndefined()
        expect(send.mock.calls[1][0].messages[0]).toMatchObject({
            role: 'system',
        })
        expect(send.mock.calls[1][0].messages[0].content)
            .toContain('"value"')
        expect(send.mock.calls[1][0].messages.slice(1))
            .toEqual(baseOptions().messages)
    })

    test('appends the schema after a BardWiki shared-evidence request so its prefix stays stable', async () => {
        const module = await loadFallbackModule()
        expect(module).not.toBeNull()
        if (!module) return
        const send = vi.fn()
            .mockRejectedValueOnce(new ModelPresetAdapterError(
                'invalid-request',
                'Invalid generation_config.response_schema'
            ))
            .mockResolvedValueOnce('ok')
        const user = '<confirmedMessages>\n[]\n</confirmedMessages>\n\n<request_instructions>\nRules.\n</request_instructions>'
        const options = {
            ...baseOptions(),
            messages: [
                { role: 'system' as const, content: 'Shared.' },
                { role: 'user' as const, content: user },
            ],
        }

        await expect(module.sendWithStructuredOutputFallback(options, send))
            .resolves.toBe('ok')

        const messages = send.mock.calls[1][0].messages
        expect(messages).toHaveLength(2)
        expect(messages[0]).toEqual(options.messages[0])
        expect(messages[1].role).toBe('user')
        expect(messages[1].content.startsWith(`${user}\n\nReturn exactly one JSON value`)).toBe(true)
        expect(messages[1].content).toContain('"value"')
    })

    test('keeps the schema first when the request does not end with a user message', async () => {
        const module = await loadFallbackModule()
        expect(module).not.toBeNull()
        if (!module) return
        const send = vi.fn()
            .mockRejectedValueOnce(new ModelPresetAdapterError(
                'invalid-request',
                'Invalid generation_config.response_schema'
            ))
            .mockResolvedValueOnce('ok')
        const options = {
            ...baseOptions(),
            messages: [
                { role: 'system' as const, content: 'Rules.' },
                { role: 'assistant' as const, content: 'Draft.' },
            ],
        }

        await expect(module.sendWithStructuredOutputFallback(options, send))
            .resolves.toBe('ok')

        const messages = send.mock.calls[1][0].messages
        expect(messages).toHaveLength(3)
        expect(messages[0].role).toBe('system')
        expect(messages[0].content).toContain('"value"')
        expect(messages.slice(1)).toEqual(options.messages)
    })

    test('retries an ambiguous 400 invalid argument when native schema was active', async () => {
        const module = await loadFallbackModule()
        expect(module).not.toBeNull()
        if (!module) return
        const send = vi.fn()
            .mockRejectedValueOnce(new ModelPresetAdapterError(
                'invalid-request',
                'Request contains an invalid argument.',
                { status: 400 }
            ))
            .mockResolvedValueOnce('ok')

        await expect(module.sendWithStructuredOutputFallback(
            baseOptions(),
            send
        )).resolves.toBe('ok')

        expect(send).toHaveBeenCalledTimes(2)
        expect(send.mock.calls[1][0].responseSchema).toBeUndefined()
    })

    test.each([
        new ModelPresetAdapterError('auth', 'missing key'),
        new ModelPresetAdapterError('rate-limit', 'slow down'),
        new ModelPresetAdapterError('invalid-request', 'blocked prompt'),
        new ModelPresetAdapterError(
            'invalid-request',
            'Invalid argument: contents[0].role is unsupported',
            { status: 400 }
        ),
    ])('does not downgrade unrelated errors: %s', async (error) => {
        const module = await loadFallbackModule()
        expect(module).not.toBeNull()
        if (!module) return
        const send = vi.fn().mockRejectedValue(error)

        await expect(module.sendWithStructuredOutputFallback(
            baseOptions(),
            send
        )).rejects.toBe(error)
        expect(send).toHaveBeenCalledTimes(1)
    })

    test('does not retry a failed fallback a third time', async () => {
        const module = await loadFallbackModule()
        expect(module).not.toBeNull()
        if (!module) return
        const fallbackError = new Error('bad JSON')
        const send = vi.fn()
            .mockRejectedValueOnce(new ModelPresetAdapterError(
                'invalid-request',
                'response_format json_schema unsupported'
            ))
            .mockRejectedValueOnce(fallbackError)

        await expect(module.sendWithStructuredOutputFallback(
            baseOptions(),
            send
        )).rejects.toBe(fallbackError)
        expect(send).toHaveBeenCalledTimes(2)
    })

    test('is wired only around the non-streaming ModelPreset send', () => {
        const source = readFileSync(
            resolve(process.cwd(), 'src/ts/process/request/request.ts'),
            'utf8'
        )
        expect(source).toContain("from './structuredOutputFallback'")
        expect(source).toContain('sendWithStructuredOutputFallback(')
        expect(source).toContain('createStructuredOutputFallbackMessage(')
    })

    test('keeps bound model preset reasoning settings for structured internal requests', () => {
        const source = readFileSync(
            resolve(process.cwd(), 'src/ts/process/request/request.ts'),
            'utf8'
        )

        expect(source).toContain('responseSchema: arg.schema')
        expect(source).not.toContain(
            "reasoningEffort: arg.schema ? 'minimal' : undefined"
        )
    })

    test('remembers a schema rejection per target and sends the same prompt-schema request directly', async () => {
        const module = await loadFallbackModule()
        expect(module).not.toBeNull()
        if (!module) return
        module.clearStructuredOutputSchemaRejections()
        const rejection = () => new ModelPresetAdapterError('invalid-request', 'Request contains an invalid argument.', { status: 400 })
        const first = vi.fn()
            .mockRejectedValueOnce(rejection())
            .mockResolvedValueOnce('first')
        await expect(module.sendWithStructuredOutputFallback(baseOptions(), first, undefined, 'target-a')).resolves.toBe('first')
        expect(first).toHaveBeenCalledTimes(2)

        const second = vi.fn().mockResolvedValueOnce('second')
        const onFallback = vi.fn()
        await expect(module.sendWithStructuredOutputFallback(baseOptions(), second, onFallback, 'target-a')).resolves.toBe('second')
        expect(second).toHaveBeenCalledTimes(1)
        expect(onFallback).not.toHaveBeenCalled()
        expect(JSON.stringify(second.mock.calls[0][0])).toBe(JSON.stringify(first.mock.calls[1][0]))

        const otherTarget = vi.fn().mockResolvedValueOnce('native')
        await expect(module.sendWithStructuredOutputFallback(baseOptions(), otherTarget, undefined, 'target-b')).resolves.toBe('native')
        expect(otherTarget.mock.calls[0][0].responseSchema).toEqual(baseOptions().responseSchema)

        const otherSchema = vi.fn().mockResolvedValueOnce('native')
        await expect(module.sendWithStructuredOutputFallback({
            ...baseOptions(),
            responseSchema: { type: 'object', properties: { other: { type: 'string' } } },
        }, otherSchema, undefined, 'target-a')).resolves.toBe('native')
        expect(otherSchema.mock.calls[0][0].responseSchema).toBeDefined()

        const otherOptions = vi.fn().mockResolvedValueOnce('native')
        await expect(module.sendWithStructuredOutputFallback({ ...baseOptions(), temperature: 0.2 }, otherOptions, undefined, 'target-a')).resolves.toBe('native')
        expect(otherOptions.mock.calls[0][0].responseSchema).toBeDefined()
    })

    test('keeps trying native output every time without a target', async () => {
        const module = await loadFallbackModule()
        expect(module).not.toBeNull()
        if (!module) return
        module.clearStructuredOutputSchemaRejections()
        for (let i = 0; i < 2; i++) {
            const send = vi.fn()
                .mockRejectedValueOnce(new ModelPresetAdapterError('invalid-request', 'Invalid generation_config.response_schema'))
                .mockResolvedValueOnce('ok')
            await expect(module.sendWithStructuredOutputFallback(baseOptions(), send)).resolves.toBe('ok')
            expect(send).toHaveBeenCalledTimes(2)
        }
    })

    test('does not remember other errors and forgets a rejection after an hour', async () => {
        const module = await loadFallbackModule()
        expect(module).not.toBeNull()
        if (!module) return
        module.clearStructuredOutputSchemaRejections()
        const overload = new ModelPresetAdapterError('server', 'overloaded')
        const failing = vi.fn().mockRejectedValueOnce(overload)
        await expect(module.sendWithStructuredOutputFallback(baseOptions(), failing, undefined, 'target-a')).rejects.toBe(overload)
        const native = vi.fn().mockResolvedValueOnce('native')
        await module.sendWithStructuredOutputFallback(baseOptions(), native, undefined, 'target-a')
        expect(native.mock.calls[0][0].responseSchema).toBeDefined()

        vi.useFakeTimers()
        try {
            vi.setSystemTime(new Date('2026-11-03T00:00:00Z'))
            const rejected = vi.fn()
                .mockRejectedValueOnce(new ModelPresetAdapterError('invalid-request', 'Invalid generation_config.response_schema'))
                .mockResolvedValueOnce('ok')
            await module.sendWithStructuredOutputFallback(baseOptions(), rejected, undefined, 'target-a')
            vi.setSystemTime(new Date('2026-11-03T00:59:00Z'))
            const direct = vi.fn().mockResolvedValueOnce('ok')
            await module.sendWithStructuredOutputFallback(baseOptions(), direct, undefined, 'target-a')
            expect(direct.mock.calls[0][0].responseSchema).toBeUndefined()
            vi.setSystemTime(new Date('2026-11-03T01:00:01Z'))
            const retried = vi.fn().mockResolvedValueOnce('native')
            await module.sendWithStructuredOutputFallback(baseOptions(), retried, undefined, 'target-a')
            expect(retried.mock.calls[0][0].responseSchema).toBeDefined()
        } finally {
            vi.useRealTimers()
        }
    })

    test('passes the request target so remembered rejections stay per preset', () => {
        const source = readFileSync(
            resolve(process.cwd(), 'src/ts/process/request/request.ts'),
            'utf8'
        )
        expect(source).toContain('structuredOutputTarget(kind, provenance.wireModelId, preset)')
    })
})
