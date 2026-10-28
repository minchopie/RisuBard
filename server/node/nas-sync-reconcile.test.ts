import { test, expect } from 'vitest'
const { createGraph, makeRevision } = require('./nas-sync-core.cjs')
const { personaContent, personaSelection, mergePersonaHeads } = require('./transfer-sync/nas-sync-reconcile.cjs')
const person = (id: string, prompt = id) => ({ id, name: id, personaPrompt: prompt, note: '' })
function family(base: any, left: any, right: any, type = 'group') {
    const info = { domain: type === 'chat' ? 'play' : 'settings', type, root: type === 'chat' ? 'chat' : 'personas' }
    const b = makeRevision({ ...info, ...base })
    const a = makeRevision({ ...info, parents: [b.id], ...left }), c = makeRevision({ ...info, parents: [b.id], ...right })
    return { graph: createGraph([b, a, c]), heads: [a, c] }
}
test('persona additions merge by stable ID; equal existing items, selection and input mirrors are not conflicts', () => {
    const a = person('a'), b = person('b'), c = person('c')
    const f = family({ content: { personas: [a] } }, { content: { personas: [a, b], selectedPersona: 1, userNote: 'b' } }, { content: { personas: [c, a], selectedPersona: 0, username: 'c' } })
    expect(mergePersonaHeads(f.graph, f.heads).content.personas).toEqual([a, b, c])
    expect(mergePersonaHeads(f.graph, [...f.heads].reverse())).toEqual(mergePersonaHeads(f.graph, f.heads))
    expect(personaSelection({ personas: [a], selectedPersona: 0 }, [b, a, c])).toMatchObject({ selectedPersona: 1, userNote: '' })
    expect(personaContent({ personas: [b, a], userNote: 'legacy', selectedPersona: 1 })).toEqual({ personas: [a, b] })
})
test('unknown genesis can union additions but cannot guess differing same-ID prompts; equal prompts with different IDs survive', () => {
    const a = person('a', 'same'), b = person('b', 'same')
    const r = (content: any) => makeRevision({ domain: 'settings', type: 'group', root: 'personas', content })
    const x = r({ personas: [a] }), y = r({ personas: [b, a] })
    expect(mergePersonaHeads(createGraph([x, y]), [x, y]).content.personas).toEqual([a, b])
    const z = r({ personas: [person('a', 'changed')] })
    expect(mergePersonaHeads(createGraph([x, z]), [x, z])).toBeNull()
})
test('causal deletion survives an unchanged peer; delete versus edit and two different edits remain conflicts', () => {
    const a = person('a'), b = person('b'), c = person('c')
    const f = family({ content: { personas: [a, b] } }, { content: { personas: [a, b, c] } }, { content: { personas: [b] } })
    expect(mergePersonaHeads(f.graph, f.heads).content.personas).toEqual([b, c])
    for (const right of [[], [person('a', 'right')]]) {
        const conflict = family({ content: { personas: [a] } }, { content: { personas: [person('a', 'left')] } }, { content: { personas: right } })
        expect(mergePersonaHeads(conflict.graph, conflict.heads)).toBeNull()
    }
})
test('invalid IDs and sealed persona references fail closed', () => {
    for (const content of [{ personas: [{ name: 'missing ID' }] }, { personas: [person('a'), person('a')] }, { personas: [person('a')], $syncSecrets: [] }]) {
        const f = family({ content: { personas: [] } }, { content }, { content: { personas: [person('b')] } })
        expect(mergePersonaHeads(f.graph, f.heads)).toBeNull()
    }
})
test('explicit persona conflict choice preserves nonconflicting additions; ID and mirror selection never depend on head order', () => {
    const a = person('a'), c = person('c'), d = person('d')
    const f = family({ content: { personas: [a] } }, { content: { personas: [person('a', 'left'), c] } }, { content: { personas: [person('a', 'right'), d] } })
    const result = mergePersonaHeads(f.graph, f.heads, f.heads[0].id)
    expect(result.content.personas).toEqual([person('a', 'left'), c, d])
    expect(mergePersonaHeads(f.graph, [...f.heads].reverse(), f.heads[0].id)).toEqual(result)
})

test('wire keeps legacy selection keys, required assets follow merged records, and local note mismatches are detectable', () => {
    const { personaWireContent, personaMirrorsMatch } = require('./transfer-sync/nas-sync-reconcile.cjs')
    const { collectReferences } = require('./nas-sync-projection.cjs')
    const a = { ...person('a'), icon: 'assets/shared.png' }, b = { ...person('b'), icon: 'assets/shared.png' };
    const hash = 'a'.repeat(64)
    const f = family({ content: { personas: [a] }, dependencies: { 'asset:assets/shared.png': hash } }, { content: { personas: [] }, dependencies: {} }, { content: { personas: [a, b] }, dependencies: { 'asset:assets/shared.png': hash } })
    const merged = mergePersonaHeads(f.graph, f.heads, undefined, collectReferences)
    expect(merged.content.personas).toEqual([b]); expect(merged.dependencies).toEqual({ 'asset:assets/shared.png': hash })
    const wire = personaWireContent({ personas: [person('b'), person('a')] })
    for (const key of ['selectedPersona', 'username', 'userIcon', 'personaPrompt', 'userNote']) expect(wire).toHaveProperty(key)
    expect(wire.selectedPersona).toBe(0); expect(wire.username).toBe('a')
    expect(personaMirrorsMatch({ personas: [person('a')], selectedPersona: 0, userNote: 'unsaved' })).toBe(false)
    expect(personaMirrorsMatch({ personas: [person('a')], selectedPersona: 0, userNote: '' })).toBe(true)
})

test('a persona mirror mismatch has an actionable named explanation', () => {
    const { personaMirrorIssue } = require('./transfer-sync/nas-sync-reconcile.cjs')
    expect(personaMirrorIssue({ personas: [person('a')], selectedPersona: 0, userIcon: 'other.png' })).toEqual({ name: 'a', reason: 'local-persona-edit' })
    expect(personaMirrorIssue({ personas: [person('a')], selectedPersona: 0, userIcon: '' })).toBeNull()
})

test('optional empty persona mirrors are equivalent without masking real edits', () => {
    const { personaMirrorsMatch } = require('./transfer-sync/nas-sync-reconcile.cjs')
    for (const value of [undefined, null, '']) {
        const db = { personas: [{ id: 'a', name: 'a' }], selectedPersona: 0, username: 'a', userNote: value, userIcon: value, personaPrompt: value }
        expect(personaMirrorsMatch(db)).toBe(true)
        for (const key of ['userNote', 'userIcon', 'personaPrompt']) expect(personaMirrorsMatch({ ...db, [key]: 'actual edit' })).toBe(false)
    }
    expect(personaMirrorsMatch({ personas: [{ id: 'a', name: 'a', note: 'saved note' }], userNote: null })).toBe(false)
})
