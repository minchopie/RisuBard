import { describe, expect, test } from 'vitest'
import { wikiPageTokenCap } from './wikiRetrievalLimits'

describe('wiki page token cap', () => {
    test('shares the page lane among about four pages within the per-source cap', () => {
        expect(wikiPageTokenCap({ target: 4_000, perSource: 2_000 })).toBe(1_000)
        expect(wikiPageTokenCap({ target: 6_000, perSource: 2_500 })).toBe(1_500)
        expect(wikiPageTokenCap({ target: 1_000, perSource: 2_000 })).toBe(512)
        expect(wikiPageTokenCap({ target: 20_000, perSource: 2_000 })).toBe(2_000)
        expect(wikiPageTokenCap({ target: 4_000, perSource: 300 })).toBe(300)
    })
})
