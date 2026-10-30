import type { ResolvedRisuBardChatSettings, RisuBardChatSettings } from './risuBardSettings'

/**
 * One choice in the simple settings view sets how much the wiki analysis reads at once, and with it how much
 * lorebook the analysis may cite. 32K equals the stored defaults.
 */
export type WikiScalePresetId = 'light' | 'standard' | 'roomy' | 'large'

export const WIKI_SCALE_FIELD_KEYS = [
    'risuBardAnalysisTokenLimit',
    'risuBardAnalysisLoreTokenLimit',
] as const satisfies readonly (keyof RisuBardChatSettings)[]

export type WikiScaleFieldKey = typeof WIKI_SCALE_FIELD_KEYS[number]
export type WikiScaleValues = Pick<ResolvedRisuBardChatSettings, WikiScaleFieldKey>

export interface WikiScalePreset {
    id: WikiScalePresetId
    label: string
    analysis: number
    lore: number
}

export const WIKI_SCALE_PRESET_IDS = ['light', 'standard', 'roomy', 'large'] as const satisfies readonly WikiScalePresetId[]

export const WIKI_SCALE_PRESETS: Readonly<Record<WikiScalePresetId, WikiScalePreset>> = {
    light: { id: 'light', label: '가볍게', analysis: 24_576, lore: 750 },
    standard: { id: 'standard', label: '보통', analysis: 32_768, lore: 1_000 },
    roomy: { id: 'roomy', label: '넉넉', analysis: 49_152, lore: 1_500 },
    large: { id: 'large', label: '크게', analysis: 65_536, lore: 2_000 },
}

export function wikiScalePresetValues(id: WikiScalePresetId): WikiScaleValues {
    const preset = WIKI_SCALE_PRESETS[id]
    return {
        risuBardAnalysisTokenLimit: preset.analysis,
        risuBardAnalysisLoreTokenLimit: preset.lore,
    }
}

/** Exact match on both resolved values; anything else was adjusted in the advanced view. */
export function detectWikiScalePreset(settings: WikiScaleValues): WikiScalePresetId | 'custom' {
    for (const id of WIKI_SCALE_PRESET_IDS) {
        const values = wikiScalePresetValues(id)
        if (WIKI_SCALE_FIELD_KEYS.every((key) => settings[key] === values[key])) return id
    }
    return 'custom'
}

export function formatWikiScaleTokens(tokens: number): string {
    return `${Math.round(tokens / 1024)}K`
}

/** The BardWiki settings view; the simple view is the default for everyone. */
export type RisuBardWikiSettingsView = 'simple' | 'advanced'

export function normalizeRisuBardWikiSettingsView(value: unknown): RisuBardWikiSettingsView {
    return value === 'advanced' ? 'advanced' : 'simple'
}
