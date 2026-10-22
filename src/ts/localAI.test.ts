import { afterEach, expect, test, vi } from 'vitest'
import { localAI, localAIPreset, LOCAL_AI_PRESET } from './localAI.svelte'
import { previewChatRequest } from './preset/adapter'
vi.mock('./storage/database.svelte', () => ({ getDatabase: () => ({ aiModel: 'existing-online-model', maxResponse: 900, nodeOnlyModelModeLock: 'preset' }) }))
import { resolveChatModelBinding, resolveChatMaxResponseTokens } from './process/request/modelPresetBinding'
afterEach(() => { localAI.available = false; localAI.enabled = false })

test('device mode uses the same local model for legacy, bound and module calls without changing bindings', () => {
    localAI.available = true; localAI.enabled = true; localAI.context = 4096; localAI.output = 512
    const chat = { useModelPreset: true, modelBinding: { main: 'online-private-preset' } } as any
    const original = JSON.stringify(chat)
    for (const mode of ['model', 'submodel', 'memory', 'translate'] as const) {
        expect(resolveChatModelBinding(chat, mode, 'existing-module')).toMatchObject({ kind: 'modelPreset', preset: { id: LOCAL_AI_PRESET } })
    }
    expect(resolveChatMaxResponseTokens(chat)).toBe(512)
    expect(JSON.stringify(chat)).toBe(original)
    localAI.enabled = false
    expect(resolveChatModelBinding(chat, 'model')).toMatchObject({ kind: 'block' })
})
test('local OpenAI adapter request has only local endpoint, no credentials, matching output cap and original messages', async () => {
    const messages = [{ role: 'system' as const, content: 'Synthetic character' }, { role: 'user' as const, content: 'Hello' }]
    const result = await previewChatRequest(localAIPreset(), { messages })
    expect(result.url).toBe(location.origin + '/api/local-ai/chat/completions')
    expect(result.body).toMatchObject({ model: 'risubard-local', max_tokens: 512, messages })
    expect(JSON.stringify(result.headers)).not.toMatch(/Authorization|api.key/i)
})
