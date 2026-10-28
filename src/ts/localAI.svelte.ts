import type { ModelPreset } from './preset/types'

export interface LocalAIStatus {
    available: boolean
    enabled: boolean
    context: number
    output: number
    model: { name: string; bytes: number; sha256: string } | null
    running: boolean
    busy: boolean
    error: string
}

export const isOfflineBuild = typeof navigator !== 'undefined' && navigator.userAgent.includes('RisuBardOffline/')
export const localAI = $state<LocalAIStatus>({
    available: isOfflineBuild, enabled: isOfflineBuild, context: 4096, output: 512,
    model: null, running: false, busy: false, error: '',
})
export const LOCAL_AI_PRESET = 'risubard:device-local'

export function localAIPreset(state: LocalAIStatus = localAI): ModelPreset {
    return {
        id: LOCAL_AI_PRESET, name: state.model?.name ?? '기기 내 AI', createdAt: 0, updatedAt: 0,
        userValues: {}, useStreaming: true, maxContext: state.context,
        profileSnapshot: {
            profileId: LOCAL_AI_PRESET, profileVersion: 1, providerBaseId: 'device-local', providerBaseVersion: 1,
            adapterKind: 'openai-compatible', auth: { kind: 'none', fields: [] },
            endpoint: { kind: 'static', url: `${globalThis.location?.origin ?? 'http://localhost'}/api/local-ai/chat/completions` },
            modelId: 'risubard-local', schema: [], uiSchema: { groups: [], fields: [] },
            defaults: { model: 'risubard-local', temperature: 0.8, max_tokens: state.output },
            capabilities: ['streaming'], limits: { contextWindowTokens: state.context },
            headerTemplate: { 'Content-Type': 'application/json' },
        },
    }
}
