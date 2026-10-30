import { describe, expect, test } from 'vitest'
import { resolveRisuBardChatSettings } from './risuBardSettings'
import {
    WIKI_SCALE_PRESET_IDS,
    detectWikiScalePreset,
    formatWikiScaleTokens,
    normalizeRisuBardWikiSettingsView,
    wikiScalePresetValues,
} from './wikiScalePreset'

describe('wiki scale presets', () => {
    test('the stored defaults are the standard scale', () => {
        expect(detectWikiScalePreset(resolveRisuBardChatSettings({}))).toBe('standard')
    })

    test('every scale round-trips and grows with its input limit', () => {
        const values = WIKI_SCALE_PRESET_IDS.map((id) => wikiScalePresetValues(id))
        for (const id of WIKI_SCALE_PRESET_IDS) {
            expect(detectWikiScalePreset(resolveRisuBardChatSettings(wikiScalePresetValues(id)))).toBe(id)
        }
        expect(values.map((value) => formatWikiScaleTokens(value.risuBardAnalysisTokenLimit))).toEqual(['24K', '32K', '48K', '64K'])
        for (let index = 1; index < values.length; index += 1) {
            expect(values[index].risuBardAnalysisLoreTokenLimit).toBeGreaterThan(values[index - 1].risuBardAnalysisLoreTokenLimit)
        }
    })

    test('a value edited in the advanced view is custom', () => {
        expect(detectWikiScalePreset(resolveRisuBardChatSettings({
            ...wikiScalePresetValues('roomy'), risuBardAnalysisTokenLimit: 40_000,
        }))).toBe('custom')
    })

    test('the view defaults to simple', () => {
        expect(normalizeRisuBardWikiSettingsView(undefined)).toBe('simple')
        expect(normalizeRisuBardWikiSettingsView('advanced')).toBe('advanced')
        expect(normalizeRisuBardWikiSettingsView('other')).toBe('simple')
    })
})
