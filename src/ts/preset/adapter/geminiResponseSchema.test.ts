import { describe, expect, it } from 'vitest'
import { directWikiCommandSchema } from '../../risubard/directWikiCommand'
import { directWikiBlockSchema } from '../../risubard/directWikiBlocks'
import { toGeminiResponseSchema } from './geminiResponseSchema'

const unsupportedKeys = ['const', 'oneOf', '$schema', 'additionalProperties']

function collectKeys(value: unknown, keys = new Set<string>()): Set<string> {
    if (Array.isArray(value)) value.forEach((item) => collectKeys(item, keys))
    else if (value && typeof value === 'object') {
        for (const [key, item] of Object.entries(value)) {
            keys.add(key)
            collectKeys(item, keys)
        }
    }
    return keys
}

describe('toGeminiResponseSchema', () => {
    it('replaces const with an equivalent Gemini constraint', () => {
        expect(toGeminiResponseSchema({
            type: 'object',
            properties: {
                version: { const: 1 },
                ratio: { const: 0.5 },
                kind: { type: 'string', const: 'note' },
                flag: { const: true },
            },
        })).toEqual({
            type: 'object',
            properties: {
                version: { type: 'integer', minimum: 1, maximum: 1 },
                ratio: { type: 'number', minimum: 0.5, maximum: 0.5 },
                kind: { type: 'string', enum: ['note'] },
                flag: { type: 'boolean' },
            },
        })
    })

    it('maps oneOf to anyOf and drops JSON Schema only keys', () => {
        expect(toGeminiResponseSchema({
            $schema: 'https://json-schema.org/draft/2020-12/schema',
            type: 'object',
            additionalProperties: false,
            properties: {
                title: { oneOf: [{ type: 'string' }, { type: 'null' }] },
            },
        })).toEqual({
            type: 'object',
            properties: {
                title: { anyOf: [{ type: 'string' }, { type: 'null' }] },
            },
        })
    })

    it('keeps additionalProperties when the caller asks for it', () => {
        expect(toGeminiResponseSchema(
            { type: 'object', additionalProperties: false },
            true,
        )).toEqual({ type: 'object', additionalProperties: false })
    })

    it('leaves no unsupported keyword in the BardChat wiki schemas', () => {
        for (const schema of [directWikiCommandSchema, directWikiBlockSchema]) {
            const keys = collectKeys(toGeminiResponseSchema(JSON.parse(schema)))
            for (const key of unsupportedKeys) expect(keys.has(key)).toBe(false)
        }
    })
})
