// @vitest-environment node
/**
 * Upstream plugin storage layouts folded back into plain plugin keys:
 * cad8595a's `_coldplugin` key -> cold id map, and 68b5d032c's
 * (v2026.10.210+) `_coldpluginIndex` pointer to one index item.
 * Ported from an upstream fork (2026-10) (unit part).
 */
import { describe, test, expect } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const upstream = require('./upstream-plugin-storage.cjs')
const { resolveUpstreamPluginStorage, INDEX_KEY, LEGACY_MAP_KEY, INDEX_TYPE } = upstream

const IDX = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d'
const BIG = '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b'
const OLD_IDX = '2b3c4d5e-6f70-4182-9a3b-4c5d6e7f8091'
const LEGACY = '3c4d5e6f-7081-4293-8b4c-5d6e7f809102'

const index = (entries: unknown[], trash: unknown[] = []) => ({ type: INDEX_TYPE, version: 1, entries, trash })

// ─── Unit ──────────────────────────────────────────────────────────────────

function resolve(storage: Record<string, unknown>, cold: Record<string, unknown>, opts: Record<string, unknown> = {}) {
    const reads: string[] = []
    const result = resolveUpstreamPluginStorage(storage, {
        readCold: (id: string) => {
            reads.push(id)
            if (id === 'unreadable') throw new Error('corrupt item')
            return Object.prototype.hasOwnProperty.call(cold, id) ? cold[id] : undefined
        },
        isPresent: (key: string) => key !== INDEX_KEY && key !== LEGACY_MAP_KEY
            && Object.prototype.hasOwnProperty.call(storage, key),
        source: 'test',
        ...opts,
    })
    return { ...result, values: new Map<string, unknown>(result.assign), reads }
}

describe('resolveUpstreamPluginStorage (unit)', () => {
    test('restores inline JSON and large items from the index exactly', () => {
        const values: Record<string, unknown> = {
            zero: 0, no: false, empty: '', nothing: null,
            nested: { a: [1, { b: 'c' }] }, list: [1, 2, 3], text: '한글 값',
        }
        const entries = Object.entries(values).map(([k, v]) => ({ k, s: JSON.stringify(v) }))
        entries.push({ k: 'big', l: BIG } as any)
        const r = resolve({ [INDEX_KEY]: IDX }, { [IDX]: index(entries, [{ id: OLD_IDX, at: 1, index: true }]), [BIG]: { huge: 'x'.repeat(1000) } })

        expect(r.failed).toBe(0)
        expect(Object.fromEntries(r.values)).toEqual({ ...values, big: { huge: 'x'.repeat(1000) } })
        expect(r.record).toMatchObject({ source: 'test', pointer: IDX, trashCount: 1 })
        expect(r.reads).not.toContain(OLD_IDX)
    })

    test('a missing or unreadable large item is recorded and the rest restores', () => {
        const r = resolve({ [INDEX_KEY]: IDX }, {
            [IDX]: index([{ k: 'ok', s: '"fine"' }, { k: 'lost', l: BIG }, { k: 'broken', l: 'unreadable' }]),
        })
        expect(Object.fromEntries(r.values)).toEqual({ ok: 'fine' })
        expect(r.failed).toBe(2)
        expect(r.record.failedEntries).toEqual([{ k: 'lost', l: BIG }, { k: 'broken', l: 'unreadable' }])
    })

    test('an unusable index is reported without throwing, legacy keys still restore', () => {
        const cases: Array<[unknown, string]> = [
            [undefined, 'index item not found'],
            [{ type: 'something-else', version: 1, entries: [], trash: [] }, 'not a plugin storage index'],
            [{ type: INDEX_TYPE, version: 2, entries: [], trash: [] }, 'unsupported index version 2'],
            [{ type: INDEX_TYPE, version: 1, entries: {}, trash: [] }, 'malformed index'],
        ]
        for (const [item, error] of cases) {
            const cold: Record<string, unknown> = { [LEGACY]: 'legacy value' }
            if (item !== undefined) cold[IDX] = item
            const r = resolve({ [INDEX_KEY]: IDX, [LEGACY_MAP_KEY]: { old: LEGACY } }, cold)
            expect(r.record.pointerError).toBe(error)
            expect(Object.fromEntries(r.values)).toEqual({ old: 'legacy value' })
            expect(r.failed).toBe(1)
        }
        const thrown = resolve({ [INDEX_KEY]: 'unreadable' }, {})
        expect(thrown.record.pointerError).toBe('corrupt item')
        const invalid = resolve({ [INDEX_KEY]: 42 }, {})
        expect(invalid.record).toMatchObject({ pointer: 42, pointerError: 'invalid pointer' })
    })

    test('unparsable s, repeated keys, l over s and non-string keys follow upstream', () => {
        const r = resolve({ [INDEX_KEY]: IDX }, {
            [IDX]: index([
                { k: 'bad', s: '{not json' },
                { k: 'dup', s: '"first"' },
                { k: 'dup', s: '"second"' },
                { k: 'both', s: '"inline"', l: BIG },
                { k: 42, s: '"ignored"' },
                { s: '"no key"' },
            ]),
            [BIG]: 'large wins',
        })
        expect(Object.fromEntries(r.values)).toEqual({ dup: 'second', both: 'large wins' })
        expect(r.record.failedEntries).toEqual([{ k: 'bad' }])
    })

    test('with an index: present keys win over the index, and both win over the legacy map', () => {
        const r = resolve({
            [INDEX_KEY]: IDX,
            [LEGACY_MAP_KEY]: { fromIndex: LEGACY, present: LEGACY, legacyOnly: LEGACY },
            present: 'written after upstream loaded',
        }, {
            [IDX]: index([{ k: 'fromIndex', s: '"index"' }, { k: 'present', s: '"older index copy"' }]),
            [LEGACY]: 'legacy',
        })
        expect(Object.fromEntries(r.values)).toEqual({ fromIndex: 'index', legacyOnly: 'legacy' })
        expect(r.record.shadowedIndexKeys).toEqual(['present'])
        expect(r.record.shadowedLegacyKeys).toEqual(['fromIndex', 'present'])
        expect(r.reads.filter(id => id === LEGACY)).toHaveLength(1)
    })

    // upstream v210 migrateLegacy: a leftover legacy entry is older than an
    // inline value written by an older build, so it is dropped unread.
    test('cad8595a data (no index): an inline value wins over the legacy map', () => {
        const r = resolve({ [LEGACY_MAP_KEY]: { memory: LEGACY }, memory: 'written after the move' }, { [LEGACY]: 'cold value' })
        expect(r.values.size).toBe(0)
        expect(r.reads).toEqual([])
        expect(r.record.shadowedLegacyKeys).toEqual(['memory'])
    })

    test('reserved names inside the layouts and a non-object legacy map never become plugin keys', () => {
        const r = resolve({ [INDEX_KEY]: IDX, [LEGACY_MAP_KEY]: 'not a map' }, {
            [IDX]: index([{ k: INDEX_KEY, s: '"x"' }, { k: LEGACY_MAP_KEY, s: '{}' }, { k: 'real', s: '1' }]),
        })
        expect(Object.fromEntries(r.values)).toEqual({ real: 1 })
        expect(r.record.invalidLegacyMap).toBe('not a map')
    })

    test('a "__proto__" key is returned as a plain entry', () => {
        const r = resolve({ [INDEX_KEY]: IDX }, { [IDX]: index([{ k: '__proto__', s: '"polluted?"' }]) })
        expect(r.assign).toEqual([['__proto__', 'polluted?']])
    })
})
