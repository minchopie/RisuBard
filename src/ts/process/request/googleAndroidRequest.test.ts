import { afterEach, expect, test, vi } from 'vitest'
import type { RequestDataArgumentExtended } from './request'

const { additional, fetchNative } = vi.hoisted(() => ({
    additional: vi.fn((body: unknown) => body), fetchNative: vi.fn(),
}))
vi.mock('src/ts/globalApi.svelte', () => ({ fetchNative, textifyReadableStream: vi.fn() }))
vi.mock('src/ts/model/modellist', () => ({ LLMFlags: {}, LLMFormat: { GoogleCloud: 'google', VertexAIGemini: 'vertex' } }))
vi.mock('src/ts/storage/database.svelte', () => ({ getDatabase: () => ({ google: { projectId: 'synthetic', accessToken: '' } }), setDatabase: vi.fn() }))
vi.mock('src/ts/util', () => ({ base64url: vi.fn(), simplifySchema: (value: unknown) => value }))
vi.mock('../files/inlays', () => ({ saveInlayedSignature: vi.fn(), setInlayAsset: vi.fn(), writeInlayImage: vi.fn() }))
vi.mock('../templates/jsonSchema', () => ({ extractJSON: vi.fn(), getGeneralJSONSchema: vi.fn() }))
vi.mock('../mcp/mcp', () => ({ callTool: vi.fn(), decodeToolCall: vi.fn(), encodeToolCall: vi.fn() }))
vi.mock('src/ts/alert', () => ({ notifyError: vi.fn() }))
vi.mock('./shared', () => ({ applyParameters: (value: unknown) => value, applyAdditionalParameters: additional, getAdditionalParameters: () => [] }))
vi.mock('src/ts/stores.svelte', () => ({ bodyIntercepterStore: { set: vi.fn() } }))

import { requestGoogleCloudVertex } from './google'
import { PRIVATE_MOBILE_GEMINI_CONTINUATION } from './privateMobileGeminiRequest'

afterEach(() => { vi.restoreAllMocks(); additional.mockReset().mockImplementation(body => body) })

async function preview(ua: string, override?: unknown) {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua)
    vi.spyOn(console, 'log').mockImplementation(() => {})
    if (override) additional.mockImplementation(body => ({ ...(body as object), contents: override }))
    const formated = [{ role: 'user', content: 'Start' }, { role: 'assistant', content: 'Prefill' }]
    const before = structuredClone(formated)
    const result = await requestGoogleCloudVertex({ formated, maxTokens: 64, aiModel: 'reverse_proxy', previewBody: true,
        modelInfo: { id: 'synthetic', internalID: 'synthetic', format: 'google', flags: [], parameters: [] },
    } as unknown as RequestDataArgumentExtended)
    expect(result.type).toBe('success')
    expect(formated).toEqual(before)
    expect(fetchNative).not.toHaveBeenCalled()
    return JSON.parse((result as { result: string }).result).body.contents
}

test('Android request preview contains the continuation without changing saved history', async () => {
    const contents = await preview('RisuBardAndroid/0.9.72')
    expect(contents.at(-2)).toEqual({ role: 'model', parts: [{ text: 'Prefill' }] })
    expect(contents.at(-1)).toEqual({ role: 'user', parts: [{ text: PRIVATE_MOBILE_GEMINI_CONTINUATION }] })
})

test('the ordinary desktop request keeps its existing ending', async () => {
    expect((await preview('Desktop browser')).at(-1).role).toBe('model')
})

test('custom request parameters with an unanswered tool call keep that call last', async () => {
    const contents = [{ role: 'model', parts: [{ functionCall: { name: 'lookup', args: {} } }] }]
    expect(await preview('RisuBardAndroid/0.9.72', contents)).toEqual(contents)
})
