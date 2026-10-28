import { describe, expect, it } from 'vitest'

import {
    PRIVATE_MOBILE_GEMINI_CONTINUATION,
    normalizePrivateMobileGeminiContents,
} from './privateMobileGeminiRequest'

describe('normalizePrivateMobileGeminiContents', () => {
    it('appends a user continuation after a text model turn without mutating history', () => {
        const contents = [
            { role: 'user', parts: [{ text: 'Start the scene.' }] },
            { role: 'model', parts: [{ text: 'A required assistant prefill.' }] },
        ]
        const before = structuredClone(contents)
        const normalized = normalizePrivateMobileGeminiContents(contents)

        expect(normalized).toEqual([
            ...before,
            {
                role: 'user',
                parts: [{ text: PRIVATE_MOBILE_GEMINI_CONTINUATION }],
            },
        ])
        expect(contents).toEqual(before)
    })

    it('does not alter valid user or function endings', () => {
        const userEnding = [
            { role: 'user', parts: [{ text: 'Generate a reply.' }] },
        ]
        const functionEnding = [
            { role: 'function', parts: [{ functionResponse: { name: 'tool' } }] },
        ]

        expect(normalizePrivateMobileGeminiContents(userEnding)).toBe(userEnding)
        expect(normalizePrivateMobileGeminiContents(functionEnding)).toBe(functionEnding)
    })

    it('does not mask an unfinished function call', () => {
        const contents = [
            {
                role: 'model',
                parts: [{
                    functionCall: {
                        name: 'lookup',
                        args: { query: 'value' },
                    },
                }],
            },
        ]

        expect(normalizePrivateMobileGeminiContents(contents)).toBe(contents)
    })

    it('ignores empty and malformed content arrays', () => {
        const empty: never[] = []
        const malformed = [{ role: 'model' }] as any

        expect(normalizePrivateMobileGeminiContents(empty)).toBe(empty)
        expect(normalizePrivateMobileGeminiContents(malformed)).toBe(malformed)
    })
})
