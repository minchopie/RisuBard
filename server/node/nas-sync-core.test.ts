import { test, expect } from 'vitest'
const { makeRevision, encodeRevision, decodeRevision, createGraph, missingDependencies, hashJson, rootKey } = require('./nas-sync-core.cjs')

const chat = (root: string, content: any, parents: string[] = [], dependencies: Record<string, string> = {}) =>
    makeRevision({ domain: 'play', type: 'chat', root, parents, content, dependencies })
const key = (root: string, type = 'chat', domain = 'play') => `${domain}\n${type}\n${root}`
const dep = (value: unknown) => hashJson(value)

test('revision IDs are deterministic over domain/type/root/sorted parents/content/dependencies only', () => {
    const a = chat('c1', { message: ['hi'] })
    expect(chat('c1', { message: ['hi'] }).id).toBe(a.id)
    expect(a.parents).toEqual([])
    const b = chat('c1', { message: ['hi', 'there'] }, [a.id])
    const c = chat('c1', { message: ['hi', 'other'] }, [a.id])
    const merge1 = chat('c1', { message: ['merged'] }, [b.id, c.id]), merge2 = chat('c1', { message: ['merged'] }, [c.id, b.id, b.id])
    expect(merge1.id).toBe(merge2.id)
    expect(merge1.parents).toEqual([b.id, c.id].sort())
    expect(chat('c2', { message: ['hi'] }).id).not.toBe(a.id)
    expect(makeRevision({ domain: 'library', type: 'chat', root: 'c1', content: { message: ['hi'] } }).id).not.toBe(a.id)
    // Dependency change alone (Wiki/slot/memory/Lua pin) creates a distinct revision with identical content.
    const pinned = chat('c1', { message: ['hi'] }, [], { wiki: dep({ page: 1 }) })
    expect(pinned.contentHash).toBe(a.contentHash)
    expect(pinned.id).not.toBe(a.id)
    expect(() => makeRevision({ domain: 'play', type: 'chat', root: 'c1', content: JSON.parse('{"__proto__":{"x":1}}') })).toThrow(/Unsafe JSON/)
    expect(() => makeRevision({ domain: 'play', type: 'chat', root: 'c1', parents: ['short'] })).toThrow(/parents/)
    expect(() => makeRevision({ domain: 'play', type: 'chat', root: 'c1', dependencies: { wiki: 'nothex' } })).toThrow(/dependencies/)
    expect(() => makeRevision({ domain: 'play', type: '', root: 'c1' })).toThrow(/type/)
})

test('identical skip, unique add, linear successor, concurrent branches, equivalent heads', () => {
    const g = createGraph()
    const a = chat('c1', { n: 1 })
    expect(g.add(a)).toBe('added')
    expect(g.add(chat('c1', { n: 1 }))).toBe('identical')
    const b = g.edit({ domain: 'play', type: 'chat', root: 'c1', content: { n: 2 }, dependencies: {} })
    g.add(b)
    expect(g.classify(key('c1'))).toMatchObject({ state: 'live', heads: [b.id], variants: [[b.id]] })
    expect(g.isAncestor(a.id, b.id)).toBe(true)
    expect(g.isAncestor(b.id, a.id)).toBe(false)
    // Device 2 edited a concurrently: two live heads stay separate, never concatenated or overwritten.
    const c = chat('c1', { n: 3 }, [a.id])
    g.add(c)
    const diverged = g.classify(key('c1'))
    expect(diverged.state).toBe('diverged')
    expect(diverged.variants).toHaveLength(2)
    expect(g.get(b.id).content).toEqual({ n: 2 }); expect(g.get(c.id).content).toEqual({ n: 3 })
    // Equal-content concurrent heads are one variant; the next edit parents all of them.
    const d1 = chat('c1', { n: 9 }, [b.id]), d2 = chat('c1', { n: 9 }, [c.id])
    g.add(d1); g.add(d2)
    expect(g.classify(key('c1'))).toMatchObject({ state: 'live', variants: [[d1.id, d2.id].sort()] })
    const e = g.edit({ domain: 'play', type: 'chat', root: 'c1', content: { n: 10 }, dependencies: {} })
    expect(e.parents).toEqual([d1.id, d2.id].sort())
    g.add(e)
    expect(g.heads(key('c1'))).toEqual([e.id])
    expect(() => g.add(chat('c1', { n: 11 }, ['f'.repeat(64)]))).toThrow(expect.objectContaining({ code: 'MISSING_PARENT' }))
    expect(() => g.add(chat('c2', { n: 1 }, [e.id]))).toThrow(/another root/)
    expect(() => g.add({ ...e, content: { n: 99 } })).toThrow(/collision|mismatch/)
})

test('virtual genesis: unrelated original histories of one root both survive as branches', () => {
    const g = createGraph()
    const tablet = chat('c1', { device: 'tablet' }), phone = chat('c1', { device: 'phone' })
    g.add(tablet); g.add(phone)
    expect(g.classify(key('c1')).state).toBe('diverged')
    const segments = g.branchSegments(key('c1'))
    const [first, second] = [tablet.id, phone.id].sort()
    expect(segments.get(first)).toBe('c1')
    expect(segments.get(second)).toMatch(/^[a-f0-9]{64}$/)
})

test('branch identity is stable: minimum child inherits, others derive, descendants and tombstone edges included', () => {
    const a = chat('c1', { n: 1 })
    const b = chat('c1', { n: 2 }, [a.id]), c = chat('c1', { n: 3 }, [a.id])
    const b2 = chat('c1', { n: 4 }, [b.id]), c2 = chat('c1', { n: 5 }, [c.id])
    const merge = chat('c1', { n: 6 }, [b2.id, c2.id])
    const forward = createGraph([a, b, c, b2, c2, merge]), reversed = createGraph([merge, c2, b2, c, b, a])
    const s1 = forward.branchSegments(key('c1')), s2 = reversed.branchSegments(key('c1'))
    expect([...s1]).toEqual([...s2])
    const [min, other] = [b, c].sort((x, y) => x.id < y.id ? -1 : 1)
    const minChild = min === b ? b2 : c2, otherChild = min === b ? c2 : b2
    expect(s1.get(a.id)).toBe('c1'); expect(s1.get(min.id)).toBe('c1'); expect(s1.get(minChild.id)).toBe('c1')
    expect(s1.get(other.id)).toMatch(/^[a-f0-9]{64}$/); expect(s1.get(otherChild.id)).toBe(s1.get(other.id))
    expect(s1.get(merge.id)).toBe(s1.get(merge.parents[0]))
    // A tombstone is an edge too: it competes for the inherited segment at its fork.
    const g = createGraph([a])
    const [tomb] = g.tombstones('op1', [{ domain: 'play', type: 'chat', root: 'c1' }])
    g.add(tomb)
    const late = chat('c1', { n: 7 }, [a.id]); g.add(late)
    const s3 = g.branchSegments(key('c1'))
    const inherited = [tomb.id, late.id].sort()[0]
    expect(s3.get(inherited)).toBe('c1')
})

test('causal tombstones: container + children delete, delete-pending on concurrent child edit, precise restore', () => {
    const g = createGraph()
    const char = makeRevision({ domain: 'play', type: 'character', root: 'ch', content: { name: '표본' } })
    const chatA = chat('a', { message: ['a'] }), chatB = chat('b', { message: ['b'] }), chatOld = chat('old', { message: ['old'] })
    for (const r of [char, chatA, chatB, chatOld]) g.add(r)
    // An earlier independent deletion must not be revived by the later container restore.
    const [oldTomb] = g.tombstones('earlier', [{ domain: 'play', type: 'chat', root: 'old' }])
    g.add(oldTomb)
    const batch = g.tombstones('delete-ch', [{ domain: 'play', type: 'character', root: 'ch' }, { domain: 'play', type: 'chat', root: 'a' }, { domain: 'play', type: 'chat', root: 'b' }])
    expect(batch.map(t => t.tombstone)).toEqual([{ operation: 'delete-ch', base: char.id }, { operation: 'delete-ch', base: chatA.id }, { operation: 'delete-ch', base: chatB.id }])
    g.addAll(batch)
    expect(g.classify(key('ch', 'character')).state).toBe('deleted')
    expect(g.classify(key('a')).state).toBe('deleted')
    expect(g.containerState(key('ch', 'character'), 'delete-ch')).toBe('deleted')
    expect(() => g.edit({ domain: 'play', type: 'chat', root: 'a', content: {}, dependencies: {} })).toThrow(/deleted/)
    // Another device edited chat b from its pre-delete head: b is delete-pending, so the container is too.
    const concurrent = chat('b', { message: ['b', 'more'] }, [chatB.id])
    g.add(concurrent)
    expect(g.classify(key('b'))).toMatchObject({ state: 'delete-pending', liveHeads: [concurrent.id] })
    expect(g.containerState(key('ch', 'character'), 'delete-ch')).toBe('delete-pending')
    // Restore brings back the container and exactly the children removed by that operation, atomically.
    const restored = g.restore(batch[0].id)
    expect(restored.map(r => r.root).sort()).toEqual(['a', 'b', 'ch'])
    expect(restored.find(r => r.root === 'a')!.content).toEqual({ message: ['a'] })
    expect(restored.find(r => r.root === 'ch')!.parents).toEqual([batch[0].id])
    g.addAll(restored)
    expect(g.classify(key('ch', 'character')).state).toBe('live')
    expect(g.classify(key('a')).state).toBe('live')
    // b now has the restored base and the concurrent edit as separate branches; nothing was overwritten.
    expect(g.classify(key('b')).state).toBe('diverged')
    expect(g.classify(key('old')).state).toBe('deleted')
    expect(() => g.restore(batch[0].id)).toThrow(/no longer a head/)
    expect(() => g.restore(chatA.id)).toThrow(/Not a tombstone/)
    // Deleting a diverged chat records which variant restore should bring back.
    expect(() => g.tombstones('x', [{ domain: 'play', type: 'chat', root: 'b' }])).toThrow(/variant/)
    const [chosen] = g.tombstones('x', [{ domain: 'play', type: 'chat', root: 'b', base: concurrent.id }])
    expect(chosen.parents).toHaveLength(2)
    expect(() => g.tombstones('x', [{ domain: 'play', type: 'chat', root: 'b', base: chatB.id }])).toThrow(/not a live head/)
})

test('bootstrap resolution parents tablet head + joining genesis only; backup restore never claims the frontier', () => {
    const g = createGraph()
    const a = makeRevision({ domain: 'library', type: 'persona', root: 'p', content: { v: 1 } })
    const tabletHead = makeRevision({ domain: 'library', type: 'persona', root: 'p', content: { v: 2 }, parents: [a.id] })
    const priorConflict = makeRevision({ domain: 'library', type: 'persona', root: 'p', content: { v: 3 }, parents: [a.id] })
    const joining = makeRevision({ domain: 'library', type: 'persona', root: 'p', content: { v: 'phone' } })
    for (const r of [a, tabletHead, priorConflict, joining]) g.add(r)
    const resolution = g.bootstrapResolution(tabletHead.id, joining.id)
    expect(resolution.parents).toEqual([tabletHead.id, joining.id].sort())
    expect(resolution.content).toEqual({ v: 2 })
    g.add(resolution)
    expect(g.get(joining.id).content).toEqual({ v: 'phone' }) // joining original preserved as ancestry
    expect(g.classify(key('p', 'persona', 'library')).liveHeads.sort()).toEqual([resolution.id, priorConflict.id].sort())
    expect(() => g.bootstrapResolution(tabletHead.id, priorConflict.id)).toThrow(/genesis/)
    expect(g.bootstrapResolution(a.id, a.id)).toBe(g.get(a.id))
    const fromKnownBase = g.fromBackup({ domain: 'library', type: 'persona', root: 'p', content: { v: 'backup' }, dependencies: {}, base: a.id })
    expect(fromKnownBase.parents).toEqual([a.id])
    const fromUnknownBase = g.fromBackup({ domain: 'library', type: 'persona', root: 'p', content: { v: 'backup' }, dependencies: {}, base: 'e'.repeat(64) })
    expect(fromUnknownBase.parents).toEqual([])
})

test('encode/decode round trip rejects tampering, drift and unknown fields; addAll is all-or-nothing', () => {
    const a = chat('c1', { message: ['안녕'], unknownOptional: { keep: true } }, [], { wiki: dep('w') })
    const text = encodeRevision(a)
    expect(decodeRevision(text)).toEqual(a)
    expect(text).toBe(encodeRevision(decodeRevision(text)))
    const tampered = JSON.parse(text); tampered.content.message = ['변조']
    expect(() => decodeRevision(JSON.stringify(tampered))).toThrow(/mismatch/)
    const drifted = JSON.parse(text); drifted.id = 'a'.repeat(64)
    expect(() => decodeRevision(JSON.stringify(drifted))).toThrow(/mismatch/)
    const extra = JSON.parse(text); extra.device = 'tablet'
    expect(() => decodeRevision(JSON.stringify(extra))).toThrow(/Unknown revision field/)
    expect(() => decodeRevision('[]')).toThrow(/Invalid revision record/)
    const b = chat('c1', { message: ['안녕', '둘'] }, [a.id]), c = chat('c1', { message: ['안녕', '셋'] }, [b.id])
    const g = createGraph()
    expect(g.addAll([c, b, a]).map(([rev, result]: [any, string]) => [rev.id, result])).toEqual([[a.id, 'added'], [b.id, 'added'], [c.id, 'added']])
    expect(g.addAll([c]).map(([, result]: [any, string]) => result)).toEqual(['identical'])
    const orphan = chat('c1', { n: 1 }, ['d'.repeat(64)])
    expect(() => g.addAll([chat('c9', { n: 1 }), orphan])).toThrow(expect.objectContaining({ code: 'MISSING_PARENT' }))
    expect(g.rootKeys()).toEqual([key('c1')])
    expect(rootKey(a)).toBe(key('c1'))
})

test('missing pinned dependencies block a chat even when its ancestry is known', () => {
    const wiki = dep({ page: 'a' }), slot = dep({ slot: 1 })
    const rev = chat('c1', { message: [] }, [], { wiki, 'slot:1': slot })
    expect(missingDependencies(rev, new Set([wiki, slot]))).toEqual([])
    expect(missingDependencies(rev, new Set([wiki]))).toEqual(['slot:1'])
})

test('an ordinary edit never absorbs an unrelated divergent head; resolution is a separate deliberate operation', () => {
    const base = chat('c1', { n: 0 })
    const left = chat('c1', { n: 'left' }, [base.id]), right = chat('c1', { n: 'right' }, [base.id])
    const g = createGraph([base, left, right])
    expect(() => g.edit({ domain: 'play', type: 'chat', root: 'c1', content: { n: 'x' }, dependencies: {} })).toThrow(/base head/)
    const leftEdit = g.edit({ domain: 'play', type: 'chat', root: 'c1', base: left.id, content: { n: 'left edited' }, dependencies: {} })
    expect(leftEdit.parents).toEqual([left.id])
    g.add(leftEdit)
    expect(g.classify(key('c1'))).toMatchObject({ state: 'diverged', liveHeads: [leftEdit.id, right.id].sort() })
    // Edits on both branches converge to the same heads under every arrival permutation.
    const rightEdit = chat('c1', { n: 'right edited' }, [right.id])
    const orders = [[base, left, right, leftEdit, rightEdit], [rightEdit, leftEdit, right, left, base], [base, right, rightEdit, left, leftEdit]]
    const expectedSegments = (() => { const h = createGraph(); h.addAll(orders[0]); return [...h.branchSegments(key('c1'))].sort() })()
    for (const order of orders) { const h = createGraph(); h.addAll(order); expect(h.heads(key('c1'))).toEqual([leftEdit.id, rightEdit.id].sort()); expect([...h.branchSegments(key('c1'))].sort()).toEqual(expectedSegments) }
    expect(expectedSegments.find(([id]) => id === rightEdit.id)![1]).toBe(g.branchSegments(key('c1')).get(right.id))
    // Offline device still on base: its edit forks instead of pretending to be a successor of the newer heads.
    const stale = g.edit({ domain: 'play', type: 'chat', root: 'c1', base: base.id, content: { n: 'offline' }, dependencies: {} })
    expect(stale.parents).toEqual([base.id])
    expect(() => g.edit({ domain: 'play', type: 'chat', root: 'c1', base: 'a'.repeat(64), content: {}, dependencies: {} })).toThrow(/Unknown edit base/)
    expect(() => g.resolve({ domain: 'play', type: 'chat', root: 'c9', content: {}, dependencies: {} })).toThrow(/Nothing to resolve/)
    g.add(rightEdit)
    const resolved = g.resolve({ domain: 'play', type: 'chat', root: 'c1', content: { n: 'chosen' }, dependencies: {} })
    expect(resolved.parents).toEqual([leftEdit.id, rightEdit.id].sort())
    g.add(resolved)
    expect(g.classify(key('c1'))).toMatchObject({ state: 'live', heads: [resolved.id] })
    // Delete-pending ends only by explicit resolution (keep) or by restore; an edit on the live head keeps it pending.
    const [tomb] = g.tombstones('op', [{ domain: 'play', type: 'chat', root: 'c1' }])
    g.add(tomb)
    const concurrent = chat('c1', { n: 'typed while deleted elsewhere' }, [resolved.id])
    g.add(concurrent)
    expect(g.classify(key('c1')).state).toBe('delete-pending')
    const more = g.edit({ domain: 'play', type: 'chat', root: 'c1', base: concurrent.id, content: { n: 'more' }, dependencies: {} })
    expect(more.parents).toEqual([concurrent.id]); g.add(more)
    expect(g.classify(key('c1')).state).toBe('delete-pending')
    expect(() => g.edit({ domain: 'play', type: 'chat', root: 'c1', base: tomb.id, content: {}, dependencies: {} })).toThrow(/tombstone/)
    const kept = g.resolve({ domain: 'play', type: 'chat', root: 'c1', content: { n: 'more' }, dependencies: {} })
    expect(kept.parents).toEqual([tomb.id, more.id].sort()); g.add(kept)
    expect(g.classify(key('c1'))).toMatchObject({ state: 'live', heads: [kept.id] })
})

test('a tombstone can only point restore at a live parent head of its own root; bad batches are rejected atomically (Codex review 03)', () => {
    const a = chat('a', { msg: 'a' }), b = chat('b', { msg: 'b' })
    const forged = { domain: 'play', type: 'chat', root: 'a', parents: [a.id], content: null, dependencies: {}, tombstone: { operation: 'del', base: b.id } }
    expect(() => makeRevision(forged)).toThrow(/base must be a deleted parent head/)
    expect(() => makeRevision({ ...forged, tombstone: { operation: 'del', base: null } })).toThrow(/base must be a deleted parent head/)
    expect(() => makeRevision({ ...forged, tombstone: { operation: '', base: a.id } })).toThrow(/operation/)
    // Hand-built record with a valid hash but a foreign base never enters the graph, and decode rejects it too.
    const raw = { ...forged }; raw.contentHash = hashJson(null); raw.dependencyHash = hashJson({}); raw.id = require('./nas-sync-core.cjs').revisionId(raw)
    expect(() => createGraph([a, b, raw])).toThrow(/base must be a deleted parent head/)
    expect(() => decodeRevision(JSON.stringify(raw))).toThrow(/base must be a deleted parent head/)
    const g = createGraph([a, b])
    expect(() => g.addAll([chat('c', { msg: 'c' }), raw])).toThrow(/base must be a deleted parent head/)
    expect(g.rootKeys()).toEqual([key('a'), key('b')]) // atomic: 'c' was not added either
    // A tombstone over a tombstone is not a deletion of anything live.
    const [t] = g.tombstones('del', [{ domain: 'play', type: 'chat', root: 'a' }]); g.add(t)
    const twice = { domain: 'play', type: 'chat', root: 'a', parents: [t.id], content: null, dependencies: {}, tombstone: { operation: 'del2', base: t.id } }
    twice.contentHash = hashJson(null); twice.dependencyHash = hashJson({}); twice.id = require('./nas-sync-core.cjs').revisionId(twice)
    expect(() => g.add(twice)).toThrow(/live revisions/)
    expect(g.restore(t.id)[0].content).toEqual({ msg: 'a' })
})
