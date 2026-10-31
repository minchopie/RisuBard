import { describe, expect, it } from 'vitest'
import {
    dropNeverMatchingRegexEdges,
    getLorebookKeyRegex,
    matchesLorebookKey,
    resolveLorebookMatchingMode,
} from './lorebookMatching'

describe('matchesLorebookKey', () => {
    it('preserves partial matching behavior', () => {
        expect(matchesLorebookKey('firefighter', 'fight', 'partial')).toBe(true)
        expect(matchesLorebookKey('fire fighter', 'fight', 'partial')).toBe(true)
    })

    it('preserves space-delimited exact matching behavior', () => {
        expect(matchesLorebookKey('fight now', 'fight', 'whitespace')).toBe(true)
        expect(matchesLorebookKey('fight, now', 'fight', 'whitespace')).toBe(false)
        expect(matchesLorebookKey('fighting now', 'fight', 'whitespace')).toBe(false)
    })

    it('matches a multi-word key as consecutive whitespace-delimited terms', () => {
        expect(matchesLorebookKey('game over', 'game over', 'whitespace')).toBe(true)
        expect(matchesLorebookKey('the game over screen', 'game over', 'whitespace')).toBe(true)
        expect(matchesLorebookKey('game overrun', 'game over', 'whitespace')).toBe(false)
    })

    it('matches Unicode word boundaries around punctuation', () => {
        expect(matchesLorebookKey('fight, now', 'fight', 'word-boundary', 'en')).toBe(true)
        expect(matchesLorebookKey('(fight)', 'fight', 'word-boundary', 'en')).toBe(true)
        expect(matchesLorebookKey('fighting', 'fight', 'word-boundary', 'en')).toBe(false)
        expect(matchesLorebookKey('전투, 시작', '전투', 'word-boundary', 'ko')).toBe(true)
    })

    it('matches multi-word keys on word boundaries', () => {
        expect(matchesLorebookKey('Visit New York, today', 'new york', 'word-boundary', 'en')).toBe(true)
        expect(matchesLorebookKey('Visit New Yorkshire', 'new york', 'word-boundary', 'en')).toBe(false)
    })

    it('accepts Korean particles without matching longer names', () => {
        expect(matchesLorebookKey('앨리스가 누구야?', '앨리스', 'word-boundary', 'ko')).toBe(true)
        expect(matchesLorebookKey('앨리스라는 사람', '앨리스', 'word-boundary', 'ko')).toBe(true)
        expect(matchesLorebookKey('앨리스터가 누구야?', '앨리스', 'word-boundary', 'ko')).toBe(false)
    })
})

describe('resolveLorebookMatchingMode', () => {
    it('migrates legacy full-word settings without changing behavior', () => {
        expect(resolveLorebookMatchingMode(undefined, true)).toBe('whitespace')
        expect(resolveLorebookMatchingMode(undefined, false)).toBe('partial')
        expect(resolveLorebookMatchingMode('word-boundary', true)).toBe('word-boundary')
        expect(resolveLorebookMatchingMode('invalid' as any, true)).toBe('whitespace')
    })
})

describe('getLorebookKeyRegex', () => {
    const fresh = (source: string, flags: string) => {
        try { return new RegExp(source, flags) } catch { return null }
    }
    const texts = ['', 'Wilmarina가 왔다', 'wilmarina', '윌마리나를', 'xWilmarina', 'Wil\nmarina', 'a|b', '(?!)', 'MGE '.repeat(50) + '윌마리나']

    it('drops only never-matching edge alternatives', () => {
        expect(dropNeverMatchingRegexEdges('(?!)|abc|(?!)')).toBe('abc')
        expect(dropNeverMatchingRegexEdges('(?!)|')).toBe('')
        expect(dropNeverMatchingRegexEdges('a\\|(?!)')).toBe('a\\|(?!)')
        expect(dropNeverMatchingRegexEdges('a\\\\|(?!)')).toBe('a\\\\')
        expect(dropNeverMatchingRegexEdges('(a|(?!))')).toBe('(a|(?!))')
        expect(dropNeverMatchingRegexEdges('abc')).toBe('abc')
    })

    it('matches exactly like a freshly compiled pattern, including invalid and stateful flags', () => {
        const keys: [string, string][] = [
            ['(?!)|(?<![A-Za-z가-힣])(?:Wilmarina|윌마리나)(?=(?:를|가)?(?:$|[^A-Za-z가-힣]))|(?!)', 'iu'],
            ['(?!)|wil|(?!)', 'g'],
            ['(?!)|wil|(?!)', 'gy'],
            ['(?!)|', 'i'],
            ['a\\|(?!)', 'u'],
            ['(?!)|(', 'u'],
            ['marina', 'gi'],
        ]
        for (const [source, flags] of keys) {
            for (const text of texts) {
                for (let repeat = 0; repeat < 3; repeat++) {
                    const expected = fresh(source, flags)
                    const actual = getLorebookKeyRegex(source, flags)
                    expect(actual === null).toBe(expected === null)
                    if (expected && actual) {
                        expect(actual.test(text)).toBe(expected.test(text))
                    }
                }
            }
        }
    })
})
