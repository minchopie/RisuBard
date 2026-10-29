import { describe, expect, test } from 'vitest'
import { selectAnalysisLoreReference, type AnalysisLoreCandidate } from './analysisLoreReference'
import {
    RISUBARD_ANALYSIS_LORE_EXCLUDE_WORDS_DEFAULT,
    resolveRisuBardChatSettings,
} from './risuBardSettings'

const candidate = (patch: Partial<AnalysisLoreCandidate>): AnalysisLoreCandidate => ({
    title: 'Entry',
    source: 'text',
    rendered: 'text',
    tokens: 100,
    priority: 0,
    alwaysActive: false,
    ...patch,
})

const settings = { tokenLimit: 1_000, includeAlwaysActive: false, excludeWords: '' }

describe('analysis lorebook reference', () => {
    test('uses the rendered text, highest priority first', () => {
        expect(selectAnalysisLoreReference([
            candidate({ title: 'Low', source: '{{#if 1}}A{{/if}}', rendered: 'A', priority: 1 }),
            candidate({ title: 'High', rendered: 'B', priority: 5 }),
        ], settings)).toEqual([
            { title: 'High', content: 'B' },
            { title: 'Low', content: 'A' },
        ])
    })

    test('skips an entry that does not fit whole and keeps filling', () => {
        expect(selectAnalysisLoreReference([
            candidate({ title: 'Big', rendered: 'big', tokens: 900, priority: 3 }),
            candidate({ title: 'Too big', rendered: 'huge', tokens: 200, priority: 2 }),
            candidate({ title: 'Small', rendered: 'small', tokens: 100, priority: 1 }),
        ], settings).map((entry) => entry.title)).toEqual(['Big', 'Small'])
    })

    test('leaves out always-active entries unless asked', () => {
        const entries = [candidate({ title: 'Always', rendered: 'always', alwaysActive: true })]
        expect(selectAnalysisLoreReference(entries, settings)).toEqual([])
        expect(selectAnalysisLoreReference(entries, { ...settings, includeAlwaysActive: true })).toHaveLength(1)
    })

    test('excludes entries whose title or source contains a listed word, ignoring case', () => {
        const entries = [
            candidate({ title: 'Assets', source: 'Show <IMG="smile"> when happy', rendered: 'Show <IMG="smile">' }),
            candidate({ title: '에셋 목록', source: 'list', rendered: 'list' }),
            candidate({ title: 'Story', rendered: 'story' }),
        ]
        expect(selectAnalysisLoreReference(entries, { ...settings, excludeWords: '<img\n\n  에셋  ' })
            .map((entry) => entry.title)).toEqual(['Story'])
    })

    test('a zero limit turns the reference off', () => {
        expect(selectAnalysisLoreReference([candidate({})], { ...settings, tokenLimit: 0 })).toEqual([])
    })

    test('drops empty and repeated text', () => {
        expect(selectAnalysisLoreReference([
            candidate({ title: 'A', rendered: 'same' }),
            candidate({ title: 'B', rendered: ' same ' }),
            candidate({ title: 'C', rendered: '  ' }),
        ], settings).map((entry) => entry.title)).toEqual(['A'])
    })

    test('settings default to 1,000 tokens, no always-active entries and the asset words', () => {
        const resolved = resolveRisuBardChatSettings({})
        expect(resolved.risuBardAnalysisLoreTokenLimit).toBe(1_000)
        expect(resolved.risuBardAnalysisLoreIncludeAlwaysActive).toBe(false)
        expect(resolved.risuBardAnalysisLoreExcludeWords).toBe(RISUBARD_ANALYSIS_LORE_EXCLUDE_WORDS_DEFAULT)
        expect(resolveRisuBardChatSettings({}, { risuBardAnalysisLoreExcludeWords: '' })
            .risuBardAnalysisLoreExcludeWords).toBe('')
        expect(resolveRisuBardChatSettings({ risuBardAnalysisLoreTokenLimit: -5 })
            .risuBardAnalysisLoreTokenLimit).toBe(0)
    })
})
