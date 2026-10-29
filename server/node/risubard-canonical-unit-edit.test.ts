import { describe, expect, test } from 'vitest'
import { applyCanonicalSectionPatches } from './risubard-markdown-section-patch'
import { annotateCanonicalUnits, resolveCanonicalUnitPatches, stripUnitMarkers } from './risubard-canonical-unit-edit'
import type { CanonicalSectionPatch } from './risubard-memory-writer'

const doc = [
    '## Alice',
    '',
    '### Current State',
    '',
    '- At home.',
    '',
    '### Knowledge',
    '',
    '- Knows the gate code.',
    '- Knows the cellar key is under the stone.',
    '- Distrusts [[Bob]] after the market.',
].join('\n')

const edit = (edits: Partial<NonNullable<CanonicalSectionPatch['edits']>>, heading = 'Knowledge'): CanonicalSectionPatch => ({
    heading, operation: 'edit', content: '', edits: { add: [], replace: [], remove: [], ...edits },
})

function apply(patches: CanonicalSectionPatch[], allowSupersede = false, rewrite = false) {
    const resolution = resolveCanonicalUnitPatches({ markdown: doc, title: 'Alice', patches, allowSupersede, rewrite })
    return { ...resolution, markdown: applyCanonicalSectionPatches({ markdown: doc, title: 'Alice', patches: resolution.patches }) }
}

describe('canonical unit edits', () => {
    test('numbers units for the model and strips numbers the model copies back', () => {
        const annotated = annotateCanonicalUnits(doc)
        expect(annotated).toContain('- [0] Knows the gate code.')
        expect(annotated).toContain('- [2] Distrusts [[Bob]] after the market.')
        expect(annotated).toContain('- [0] At home.')
        expect(stripUnitMarkers(annotated)).toBe(doc)
    })

    test('changes only the units an edit names', () => {
        const result = apply([edit({
            add: ['- [9] Knows the bell rings at noon.'],
            replace: [{ index: 0, text: '[0] Knows the new gate code.' }],
        })])
        expect(result.markdown).toContain('- Knows the new gate code.\n- Knows the cellar key is under the stone.\n- Distrusts [[Bob]] after the market.\n- Knows the bell rings at noon.')
        expect(result).toMatchObject({ restored: 0, rejected: 0, removed: 0 })
    })

    test('removes a unit only with a valid reason', () => {
        const merged = apply([edit({
            replace: [{ index: 0, text: 'Knows the gate code and that the cellar key is under the stone.' }],
            remove: [{ index: 1, reason: 'merged', mergedInto: 0 }],
        })])
        expect(merged.markdown).not.toContain('- Knows the cellar key is under the stone.')
        expect(merged.removed).toBe(1)

        const unsupported = apply([edit({ remove: [{ index: 1, reason: 'superseded', mergedInto: null }] })])
        expect(unsupported.markdown).toBe(doc)
        expect(unsupported.rejected).toBe(1)

        const superseded = apply([edit({ remove: [{ index: 1, reason: 'superseded', mergedInto: null }] })], true)
        expect(superseded.markdown).not.toContain('cellar key')

        const outOfRange = apply([edit({ remove: [{ index: 9, reason: 'corrected', mergedInto: null }] })])
        expect(outOfRange).toMatchObject({ rejected: 1, removed: 0 })
        expect(outOfRange.markdown).toBe(doc)
    })

    test('keeps a removed unit whose link would disappear', () => {
        const result = apply([edit({ remove: [{ index: 2, reason: 'corrected', mergedInto: null }] })])
        expect(result.markdown).toContain('Distrusts [[Bob]]')
        expect(result).toMatchObject({ restored: 1, removed: 0 })
    })

    test('restores units a whole-section rewrite silently dropped', () => {
        const result = apply([{ heading: 'Knowledge', operation: 'upsert', content: '- Knows the gate code.\n- Knows the bell.' }])
        expect(result.markdown).toContain('- Knows the gate code.\n- Knows the bell.\n- Knows the cellar key is under the stone.\n- Distrusts [[Bob]] after the market.')
        expect(result.restored).toBe(2)
    })

    test('does not take a similar line for a dropped one', () => {
        const clues = '## Alice\n\n### Knowledge\n\n- 북문에서 단서 6를 확인했다. (#6)\n- 북문에서 단서 12를 확인했다. (#12)'
        const resolution = resolveCanonicalUnitPatches({ markdown: clues, title: 'Alice', allowSupersede: false,
            patches: [{ heading: 'Knowledge', operation: 'upsert', content: '- 북문에서 단서 12를 확인했다.\n- 북문에서 단서 18를 확인했다.' }] })
        expect(resolution.restored).toBe(1)
        expect(applyCanonicalSectionPatches({ markdown: clues, title: 'Alice', patches: resolution.patches }))
            .toContain('단서 6를 확인했다')
    })

    test('keeps a deleted section unless its facts moved elsewhere', () => {
        const blocked = apply([{ heading: 'Knowledge', operation: 'delete', content: '' }])
        expect(blocked.markdown).toBe(doc)
        expect(blocked.restored).toBe(3)

        const moved = apply([
            { heading: 'Knowledge', operation: 'delete', content: '' },
            { heading: 'Knowledge and Secrets', operation: 'upsert', content: '- Knows the gate code.\n- Knows the cellar key is under the stone.\n- Distrusts [[Bob]] after the market.' },
        ])
        expect(moved.markdown).not.toContain('### Knowledge\n')
        expect(moved.restored).toBe(0)
    })

    test('replaces the current-state snapshot and rewrite targets as written', () => {
        const state = apply([{ heading: 'Current State', operation: 'upsert', content: '- At the gate.' }])
        expect(state.markdown).toContain('### Current State\n\n- At the gate.')
        expect(state.markdown).not.toContain('At home')

        const rewrite = apply([{ heading: 'Knowledge', operation: 'upsert', content: '- Knows the gate code.' }], false, true)
        expect(rewrite.markdown).not.toContain('cellar key')
        expect(rewrite.restored).toBe(0)
    })

    test('turns an edit of a missing section into a new section', () => {
        const result = apply([edit({ add: ['Owns a lantern.'] }, 'Equipment')])
        expect(result.markdown).toContain('### Equipment\n\n- Owns a lantern.')
    })
})
