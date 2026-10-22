import { test, expect } from 'vitest'
import { mkdtemp, rm, cp, writeFile, readFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { createSyncStore, commitIdOf, RETRY_SECONDS, PHYSICAL_PURGE, TRASH_DAYS } = require('./nas-sync-store.cjs')
const { makeRevision, hashJson } = require('./nas-sync-core.cjs')
const { atomicWriteJson } = require('./file-store.cjs')
const { canonical } = require('../../shared/play-set/protocol.ts')

const chat = (root: string, content: any, parents: string[] = [], dependencies: Record<string, string> = {}) => makeRevision({ domain: 'play', type: 'chat', root, parents, content, dependencies })
const key = (root: string) => `play\nchat\n${root}`
async function temp(t: any, name = 'bard-sync-store-') { const root = await mkdtemp(join(tmpdir(), name)); t.onTestFinished(() => rm(root, { recursive: true, force: true })); return root }
let clock = 1_000_000
const now = () => clock
const open = (root: string, extra: any = {}) => createSyncStore({ dataRoot: root, now, ...extra })
/** Copy a peer's commit object plus the blobs it lists into another store, the way the transport does. */
function deliver(from: any, to: any, entry: any) {
    const object = from.commitObject(entry)
    for (const hash of object.blobs) if (!to.hasBlob(hash)) to.storeBlobFromFile(hash, from.blobFile(hash))
    return object
}

test('identity, workspace, commit outbox and graph survive restart; identical commits are not re-queued', async t => {
    const root = await temp(t), a = open(root)
    const id = a.identity(); expect(id.deviceId).toMatch(/^[0-9a-f-]{36}$/); expect(id.workspaceId).toBeNull()
    expect(JSON.parse(await readFile(join(root, 'nas-sync', 'identity.json'), 'utf8'))).toMatchObject({ deviceId: id.deviceId, incarnationId: id.incarnationId })
    a.setWorkspace('ws-1'); expect(() => a.setWorkspace('ws-2')).toThrow(/already bound/)
    const r1 = chat('c1', { message: ['안녕'] }), r2 = chat('c1', { message: ['안녕', '둘'] }, [r1.id])
    const entry = a.commit([r1, r2])
    expect(entry).toMatchObject({ sequence: 1, commitId: commitIdOf([r1.id, r2.id]), published: null, revisions: [r1.id, r2.id].sort(), blobs: [r1.contentHash, r2.contentHash].sort() })
    expect(a.commit([r1, r2])).toBeNull()
    expect(existsSync(join(root, 'nas-sync', 'revisions', `${r1.id}.json`))).toBe(true)
    expect(existsSync(join(root, 'nas-sync', 'blobs', r1.contentHash.slice(0, 2), r1.contentHash))).toBe(true)
    expect(a.graph.heads(key('c1'))).toEqual([r2.id])
    const b = open(root)
    expect(b.identity()).toEqual({ ...id, workspaceId: 'ws-1' })
    expect(b.graph.heads(key('c1'))).toEqual([r2.id]); expect(b.graph.get(r2.id).content).toEqual({ message: ['안녕', '둘'] })
    expect(b.status().outbox).toEqual({ pending: [{ sequence: 1, commitId: entry.commitId, attempts: 0, nextAt: 0, error: null }], published: 0 })
    expect(b.commitObject(b.dueCommits()[0])).toMatchObject({ v: 1, workspaceId: 'ws-1', deviceId: id.deviceId, sequence: 1, blobs: entry.blobs })
    expect(b.commitObject(b.dueCommits()[0]).revisions.every((h: any) => !('content' in h) && h.contentHash)).toBe(true)
    // Orphan revision/blob files from an interrupted write are not part of the graph.
    const orphan = chat('orphan', { n: 1 })
    atomicWriteJson(join(root, 'nas-sync'), `revisions/${orphan.id}.json`, { ...orphan, content: undefined })
    expect(open(root).graph.classify(key('orphan')).state).toBe('absent')
})

test('a failed manifest write leaves memory and disk untouched, so the same instance and a reopened one both retry (Codex 05 P1)', async t => {
    const root = await temp(t)
    let failures: string[] = []
    const writeJson = (dir: string, name: string, value: any, options?: any) => { if (name === 'state.json' && failures.length) throw new Error(failures.shift()!); return atomicWriteJson(dir, name, value, options) }
    const a = open(root, { writeJson }); a.setWorkspace('ws')
    const r1 = chat('c1', { n: 1 })
    failures = ['disk full']
    expect(() => a.commit([r1])).toThrow(/disk full/)
    expect(a.graph.classify(key('c1')).state).toBe('absent'); expect(a.status().outbox.pending).toEqual([]); expect(a.status().sequence).toBe(0)
    expect(open(root).status().outbox.pending).toEqual([])
    const entry = a.commit([r1]) // same instance retry
    expect(entry).toMatchObject({ sequence: 1 }); expect(a.graph.heads(key('c1'))).toEqual([r1.id])
    expect(open(root).status().outbox.pending).toHaveLength(1)
    // publication bookkeeping and ACKs follow the same rule
    failures = ['sidecar io']
    expect(() => a.markPublished(1, entry.commitId)).toThrow(/sidecar io/)
    expect(a.status().outbox.published).toBe(0); expect(open(root).status().outbox.published).toBe(0)
    a.markPublished(1, entry.commitId); expect(open(root).status().outbox.published).toBe(1)
    // admitRemote: failure after blobs/headers are staged still admits nothing until the manifest is durable
    const peerRoot = await temp(t), peer = open(peerRoot); peer.setWorkspace('ws')
    const p1 = chat('p1', { n: 'peer' }); const pe = peer.commit([p1]); const object = deliver(peer, a, pe)
    failures = ['manifest busy']
    expect(() => a.admitRemote(object, { device: peer.identity().deviceId, incarnation: peer.identity().incarnationId, sequence: 1, commitId: pe.commitId })).toThrow(/manifest busy/)
    expect(a.graph.classify(key('p1')).state).toBe('absent'); expect(a.pendingApply()).toEqual([])
    expect(a.admitRemote(object, { device: peer.identity().deviceId, incarnation: peer.identity().incarnationId, sequence: 1, commitId: pe.commitId }).state).toBe('admitted')
    expect(open(root).graph.heads(key('p1'))).toEqual([p1.id]); expect(open(root).pendingApply()).toHaveLength(1)
})

test('restored copies without their identity sidecar start a new incarnation and re-sequence only unpublished commits', async t => {
    const root = await temp(t), a = open(root); a.setWorkspace('ws')
    const e1 = a.commit([chat('c1', { n: 1 })]), e2 = a.commit([chat('c2', { n: 2 })])
    a.markPublished(1, e1.commitId)
    const original = a.identity().incarnationId
    // Backup restore: manifest and data copied, protected sidecar not included.
    const restored = await temp(t, 'bard-sync-restored-')
    await cp(join(root, 'nas-sync'), join(restored, 'nas-sync'), { recursive: true })
    await rm(join(restored, 'nas-sync', 'identity.json'))
    const b = open(restored)
    expect(b.identity().deviceId).toBe(a.identity().deviceId); expect(b.identity().incarnationId).not.toBe(original)
    expect(b.state().rotations).toEqual([expect.objectContaining({ from: original, reason: 'missing identity sidecar' })])
    expect(b.state().commits.map((c: any) => [c.sequence, c.incarnationId === original, !!c.published])).toEqual([[1, true, true], [1, false, false]])
    expect(b.dueCommits()).toEqual([expect.objectContaining({ sequence: 1, commitId: e2.commitId, incarnationId: b.identity().incarnationId })])
    expect(JSON.parse(await readFile(join(restored, 'nas-sync', 'identity.json'), 'utf8')).incarnationId).toBe(b.identity().incarnationId)
    expect(open(restored).identity().incarnationId).toBe(b.identity().incarnationId) // stable afterwards
    // Sidecar from another install → mismatch → rotation as well; a fresh store without sidecar is simply initialised.
    await writeFile(join(root, 'nas-sync', 'identity.json'), JSON.stringify({ version: 1, deviceId: a.identity().deviceId, incarnationId: 'other' }))
    expect(open(root).state().rotations.at(-1).reason).toBe('identity sidecar mismatch')
    const fresh = await temp(t, 'bard-sync-fresh-'); expect(open(fresh).state().rotations).toEqual([])
    // Separate sidecar directory (platform no-backup location) is honoured.
    const side = await temp(t, 'bard-sync-side-'), c = createSyncStore({ dataRoot: fresh, identityDir: side, now })
    expect(existsSync(join(side, 'identity.json'))).toBe(true)
    expect(createSyncStore({ dataRoot: fresh, identityDir: side, now }).identity()).toEqual(c.identity())
})

test('retry schedule, due selection, publication counters, checkpoint boundary and blob publication bookkeeping', async t => {
    const root = await temp(t), a = open(root, { checkpointEvery: 2 }); a.setWorkspace('ws')
    const entries = [1, 2, 3].map(n => a.commit([chat(`c${n}`, { n })]))
    expect(a.dueCommits(now()).map((e: any) => e.sequence)).toEqual([1, 2, 3])
    a.markPublishFailed(1, new Error('ECONNREFUSED'), now())
    expect(a.status().outbox.pending[0]).toMatchObject({ attempts: 1, nextAt: now() + 5000, error: 'ECONNREFUSED' })
    expect(a.dueCommits(now() + 4999).map((e: any) => e.sequence)).toEqual([2, 3]); expect(a.dueCommits(now() + 5000).map((e: any) => e.sequence)).toEqual([1, 2, 3])
    for (let i = 1; i < 6; i++) a.markPublishFailed(1, 'again', now())
    expect(a.status().outbox.pending[0].nextAt - now()).toBe(RETRY_SECONDS.at(-1) * 1000)
    expect(() => a.markPublished(9, 'x'.repeat(64))).toThrow(/Unknown outbox commit/)
    expect(a.needsCheckpoint()).toBe(false)
    a.markPublished(1, entries[0].commitId); a.markPublished(2, entries[1].commitId); a.markPublished(3, entries[2].commitId)
    expect(a.status().publications).toBe(3); expect(a.needsCheckpoint()).toBe(true) // 3 >= 0 + 2: a batch past the boundary still checkpoints
    const object = a.checkpointObject()
    expect(object).toMatchObject({ v: 1, sequence: 3, publications: 3 }); expect(Object.keys(object.heads)).toHaveLength(3); expect(object.revisions[0]).not.toHaveProperty('content')
    a.recordCheckpoint(hashJson(object)); expect(a.needsCheckpoint()).toBe(false)
    a.commit([chat('c4', { n: 4 })]); a.markPublished(4, a.dueCommits()[0].commitId); expect(a.needsCheckpoint()).toBe(false)
    a.commit([chat('c5', { n: 5 })]); a.markPublished(5, a.dueCommits()[0].commitId); expect(a.needsCheckpoint()).toBe(true)
    expect(a.unpublishedBlobs(entries[0])).toEqual(entries[0].blobs); a.markBlobPublished(entries[0].blobs[0]); expect(a.unpublishedBlobs(entries[0])).toEqual([])
    expect(open(root).unpublishedBlobs(entries[0])).toEqual([])
})

test('dependency blobs stream into the store by hash; commits pinning absent material are refused', async t => {
    const root = await temp(t), a = open(root); a.setWorkspace('ws')
    const wiki = Buffer.from('# 위키\n'.repeat(1000)), wikiHash = hashBytes(wiki), file = join(root, 'wiki.md'); await writeFile(file, wiki)
    const rev = chat('c1', { message: [] }, [], { wiki: wikiHash })
    expect(() => a.commit([rev])).toThrow(expect.objectContaining({ code: 'MISSING_BLOBS', missing: [wikiHash] }))
    expect(a.graph.classify(key('c1')).state).toBe('absent')
    await writeFile(join(root, 'bad.md'), 'tampered')
    expect(() => a.commit([rev], { blobs: { [wikiHash]: join(root, 'bad.md') } })).toThrow(/does not match its hash/)
    expect(a.hasBlob(wikiHash)).toBe(false)
    const entry = a.commit([rev], { blobs: { [wikiHash]: file } })
    expect(entry.blobs).toEqual([rev.contentHash, wikiHash].sort()); expect(await readFile(a.blobFile(wikiHash))).toEqual(wiki)
    expect(a.storeBlobFromFile(wikiHash, file)).toBe(false) // already present: never rewritten
})

test('remote admission: validated whole, out-of-order waits, duplicates identical, tamper and wrong workspace quarantined, blobs required', async t => {
    const rootA = await temp(t), rootB = await temp(t, 'bard-sync-b-'), a = open(rootA), b = open(rootB)
    a.setWorkspace('ws'); b.setWorkspace('ws')
    const A = a.identity(), at = (sequence: number, commitId: string) => ({ device: A.deviceId, incarnation: A.incarnationId, sequence, commitId })
    const r1 = chat('c1', { n: 1 }), r2 = chat('c1', { n: 2 }, [r1.id])
    const e1 = a.commit([r1]), e2 = a.commit([r2])
    const o1 = deliver(a, b, e1), o2 = deliver(a, b, e2)
    expect(b.admitRemote(o2, at(2, e2.commitId))).toEqual({ state: 'waiting', reason: expect.stringContaining('Missing parent') })
    expect(b.graph.classify(key('c1')).state).toBe('absent'); expect(b.peer(A.deviceId, A.incarnationId).lastSeen).toBe(2)
    expect(jsonFiles(await readdir(join(rootB, 'nas-sync', 'incoming')))).toHaveLength(1)
    expect(b.admitRemote(o1, at(1, e1.commitId))).toEqual({ state: 'admitted', revisions: [r1.id] })
    expect(b.retryWaiting()).toEqual([expect.objectContaining({ sequence: 2, state: 'admitted' })])
    expect(b.graph.heads(key('c1'))).toEqual([r2.id]); expect(jsonFiles(await readdir(join(rootB, 'nas-sync', 'incoming')))).toEqual([])
    expect(b.admitRemote(o1, at(1, e1.commitId))).toEqual({ state: 'identical' })
    expect(b.pendingApply().map((p: any) => p.sequence)).toEqual([1, 2])
    expect(() => b.admitRemote(o1, { ...at(1, e1.commitId), device: b.identity().deviceId, incarnation: b.identity().incarnationId })).toThrow(/Own commits/)
    // Tamper: header hash altered; blob altered; wrong workspace; malformed → quarantined with evidence, never in the graph.
    const r3 = chat('c3', { n: 3 }); const e3 = a.commit([r3]); const o3 = deliver(a, b, e3)
    const forged = JSON.parse(JSON.stringify(o3)); forged.revisions[0].dependencyHash = 'f'.repeat(64)
    expect(b.admitRemote(forged, at(3, e3.commitId))).toMatchObject({ state: 'quarantined', reason: expect.stringMatching(/header does not match|mismatch/) })
    expect(b.graph.classify(key('c3')).state).toBe('absent')
    expect(b.admitRemote(o3, at(3, e3.commitId))).toEqual({ state: 'quarantined', reason: 'previously quarantined' })
    expect(jsonFiles(await readdir(join(rootB, 'nas-sync', 'quarantine')))).toHaveLength(1)
    const r4 = chat('c4', { n: 4 }); const e4 = a.commit([r4]); const o4 = deliver(a, b, e4)
    expect(b.admitRemote({ ...o4, workspaceId: 'other' }, at(4, e4.commitId)).reason).toMatch(/workspaceId does not match/)
    expect(b.admitRemote({ corrupt: 'x' }, at(9, 'a'.repeat(64))).reason).toMatch(/Malformed/)
    // Renamed well-formed object: address and object agree on a fake id, but the revision ids do not derive it.
    const r5 = chat('c5', { n: 5 }); const e5 = a.commit([r5]); const o5 = deliver(a, b, e5)
    expect(b.admitRemote({ ...o5, commitId: 'b'.repeat(64) }, at(5, 'b'.repeat(64))).reason).toMatch(/Commit id does not match its revisions/)
    expect(b.admitRemote(o5, at(5, e5.commitId)).state).toBe('admitted')
    // Malformed or foreign objects at an admitted sequence are quarantined evidence and never make the incarnation ambiguous.
    expect(b.admitRemote({ corrupt: true }, at(5, 'e'.repeat(64))).state).toBe('quarantined')
    expect(b.admitRemote({ ...o5, workspaceId: 'foreign', commitId: 'e'.repeat(64) }, at(5, 'e'.repeat(64))).state).toBe('quarantined')
    expect(b.peer(A.deviceId, A.incarnationId).ambiguous).toBeNull()
    // Missing blob: waits (not quarantined) until the blob arrives; the durable entry names the missing hashes.
    const img = Buffer.from('img'); await writeFile(join(rootA, 'img'), img)
    const r6 = chat('c6', { n: 6 }, [], { asset: hashBytes(img) }); const e6 = a.commit([r6], { blobs: { [hashBytes(img)]: join(rootA, 'img') } }); const o6 = a.commitObject(e6)
    expect(b.admitRemote(o6, at(6, e6.commitId))).toMatchObject({ state: 'waiting', reason: expect.stringContaining('missing blobs') })
    expect(b.waitingEntries()).toEqual([expect.objectContaining({ kind: 'waiting', sequence: 6, commitId: e6.commitId, blobs: expect.arrayContaining([hashBytes(img)]), object: expect.objectContaining({ commitId: e6.commitId }) })])
    for (const hash of o6.blobs) if (!b.hasBlob(hash)) b.storeBlobFromFile(hash, a.blobFile(hash))
    expect(b.retryWaiting()).toEqual([expect.objectContaining({ sequence: 6, state: 'admitted' })])
    // Unreadable waiting file is kept with its error, not dropped.
    const r8 = chat('c8', { n: 8 }, ['c'.repeat(64)]); const h8: any = { ...r8 }; delete h8.content
    await writeFile(join(rootB, 'r8'), canonical(r8.content)); b.storeBlobFromFile(r8.contentHash, join(rootB, 'r8'))
    const o8 = { ...o5, sequence: 8, commitId: commitIdOf([r8.id]), revisions: [h8], blobs: [r8.contentHash] }
    expect(b.admitRemote(o8, at(8, o8.commitId))).toMatchObject({ state: 'waiting', reason: expect.stringContaining('Missing parent') })
    const waitingFile = (await readdir(join(rootB, 'nas-sync', 'incoming'))).find(f => f.includes('__8_') && f.endsWith('.json'))!
    await writeFile(join(rootB, 'nas-sync', 'incoming', waitingFile), '{broken')
    expect(b.retryWaiting()).toEqual([expect.objectContaining({ sequence: 8, state: 'waiting', reason: expect.stringContaining('unreadable') })])
    expect(open(rootB).status().incoming[`${A.deviceId}/${A.incarnationId}`]).toMatchObject({ admitted: 4, waiting: 1, quarantined: 5, pendingApply: 4 })
    expect(b.waitingEntries()).toEqual([expect.objectContaining({ sequence: 8, commitId: o8.commitId, blobs: [], object: null })])
})

test('cloned incarnation: both commits preserved, later records held until explicit resolution, survives restart', async t => {
    const rootA = await temp(t), rootA2 = await temp(t, 'bard-sync-clone-'), rootB = await temp(t, 'bard-sync-b-')
    const a = open(rootA); a.setWorkspace('ws'); a.commit([chat('seed', { n: 0 })])
    await cp(join(rootA, 'nas-sync'), join(rootA2, 'nas-sync'), { recursive: true }) // full clone including the sidecar
    const a2 = open(rootA2); expect(a2.identity()).toEqual(a.identity())
    const b = open(rootB); b.setWorkspace('ws')
    const A = a.identity(), at = (sequence: number, commitId: string) => ({ device: A.deviceId, incarnation: A.incarnationId, sequence, commitId })
    const e1 = a.commit([chat('left', { n: 1 })]), e1c = a2.commit([chat('right', { n: 1 })]), e2 = a.commit([chat('left', { n: 2 }, [a.graph.heads(key('left'))[0]])])
    expect(e1.sequence).toBe(2); expect(e1c.sequence).toBe(2); expect(e1.commitId).not.toBe(e1c.commitId)
    const seed = deliver(a, b, a.state().commits[0])
    expect(b.admitRemote(seed, at(1, seed.commitId)).state).toBe('admitted')
    expect(b.admitRemote(deliver(a, b, e1), at(2, e1.commitId)).state).toBe('admitted')
    expect(b.admitRemote(deliver(a2, b, e1c), at(2, e1c.commitId))).toMatchObject({ state: 'held' })
    expect(b.admitRemote(deliver(a, b, e2), at(3, e2.commitId))).toMatchObject({ state: 'held', reason: expect.stringContaining('ambiguous since sequence 2') })
    expect(b.graph.heads(key('left'))).toHaveLength(1); expect(b.graph.classify(key('right')).state).toBe('absent')
    const reopened = open(rootB)
    expect(reopened.status().incoming[`${A.deviceId}/${A.incarnationId}`]).toMatchObject({ admitted: 2, held: 2, ambiguous: expect.objectContaining({ sequence: 2, commits: [e1.commitId, e1c.commitId] }) })
    expect(jsonFiles(await readdir(join(rootB, 'nas-sync', 'incoming')))).toHaveLength(2)
    expect(reopened.retryWaiting()).toEqual([]) // held records never flow through the waiting retry
    // Explicit resolution keeping only the admitted commit: the clone's commit is quarantined (preserved on disk), seq 3 released.
    const released = reopened.resolveAmbiguity(A.deviceId, A.incarnationId, { acceptHeld: false })
    expect(released).toEqual([expect.objectContaining({ sequence: 2, commitId: e1c.commitId, state: 'quarantined', reason: expect.stringContaining('rejected by explicit resolution') }), expect.objectContaining({ sequence: 3, state: 'admitted' })])
    expect(reopened.graph.classify(key('right')).state).toBe('absent'); expect(reopened.graph.get(e2.revisions[0]).content).toEqual({ n: 2 })
    expect(jsonFiles(await readdir(join(rootB, 'nas-sync', 'quarantine')))).toHaveLength(1)
    expect(reopened.status().incoming[`${A.deviceId}/${A.incarnationId}`]).toMatchObject({ held: 0, ambiguous: null, quarantined: 1, admitted: 3 })
    expect(() => reopened.resolveAmbiguity(A.deviceId, A.incarnationId)).toThrow(/not ambiguous/)
    // Alternative resolution: accept the clone's commit too; both lineages exist as separate roots/branches and both await apply.
    const rootC = await temp(t, 'bard-sync-c-'), c = open(rootC); c.setWorkspace('ws')
    c.admitRemote(deliver(a, c, a.state().commits[0]), at(1, seed.commitId)); c.admitRemote(deliver(a, c, e1), at(2, e1.commitId)); c.admitRemote(deliver(a2, c, e1c), at(2, e1c.commitId)); c.admitRemote(deliver(a, c, e2), at(3, e2.commitId))
    expect(c.resolveAmbiguity(A.deviceId, A.incarnationId, { acceptHeld: true })).toEqual([expect.objectContaining({ sequence: 2, commitId: e1c.commitId, state: 'admitted', revisions: e1c.revisions }), expect.objectContaining({ sequence: 3, state: 'admitted' })])
    expect(c.graph.classify(key('right')).state).toBe('live'); expect(c.graph.heads(key('left'))).toHaveLength(1)
    // Exact (sequence, commitId) receipts: each accepted variant delivers its own revisions, re-admission is idempotent, both ACK pairs survive restart.
    expect(c.pendingApply().map((p: any) => [p.sequence, p.commitId, p.revisions])).toEqual([[1, seed.commitId, seed.revisions.map((h: any) => h.id)], [2, e1.commitId, e1.revisions], [2, e1c.commitId, e1c.revisions], [3, e2.commitId, e2.revisions]])
    expect(c.admitRemote(deliver(a2, c, e1c), at(2, e1c.commitId))).toEqual({ state: 'identical' }); expect(c.admitRemote(deliver(a, c, e1), at(2, e1.commitId))).toEqual({ state: 'identical' })
    expect(c.peer(A.deviceId, A.incarnationId).ambiguous).toBeNull(); expect(c.knownRemote(A.deviceId, A.incarnationId, 2, e1c.commitId)).toBe(true)
    c.markApplied(A.deviceId, A.incarnationId, 2, e1.commitId); c.markApplied(A.deviceId, A.incarnationId, 2, e1c.commitId)
    expect(Object.keys(open(rootC).ackObject().applied[`${A.deviceId}/${A.incarnationId}`]).sort()).toEqual([`2_${e1.commitId}`, `2_${e1c.commitId}`].sort())
    expect(open(rootC).pendingApply().map((p: any) => p.sequence)).toEqual([1, 3])
})

test('ACK validates (sequence, commitId) of a completed apply; trash is logical with 30-day recoverability and purge off', async t => {
    const rootA = await temp(t), rootB = await temp(t, 'bard-sync-b-'), a = open(rootA), b = open(rootB); a.setWorkspace('ws'); b.setWorkspace('ws')
    const A = a.identity(), r = chat('c1', { n: 1 }), e = a.commit([r])
    expect(b.admitRemote(deliver(a, b, e), { device: A.deviceId, incarnation: A.incarnationId, sequence: 1, commitId: e.commitId }).state).toBe('admitted')
    expect(() => b.markApplied(A.deviceId, A.incarnationId, 1, 'd'.repeat(64))).toThrow(/does not match/)
    expect(() => b.markApplied(A.deviceId, A.incarnationId, 2, e.commitId)).toThrow(/does not match/)
    expect(b.ackChanged()).toBe(false) // nothing applied yet, nothing to announce
    b.markApplied(A.deviceId, A.incarnationId, 1, e.commitId); expect(b.ackChanged()).toBe(true)
    expect(b.pendingApply()).toEqual([]); expect(b.ackObject()).toMatchObject({ v: 1, deviceId: b.identity().deviceId, applied: { [`${A.deviceId}/${A.incarnationId}`]: { [`1_${e.commitId}`]: now() } }, hash: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(() => b.markAckPublished()).toThrow(/snapshot hash/)
    b.markAckPublished(b.ackObject().hash); expect(b.ackChanged()).toBe(false); expect(open(rootB).ackChanged()).toBe(false)
    expect(() => b.markApplied(A.deviceId, A.incarnationId, 1, e.commitId)).toThrow(/does not match/) // not pending any more
    const [tomb] = a.graph.classify(key('c1')).liveHeads.length ? [makeRevision({ domain: 'play', type: 'chat', root: 'c1', parents: [r.id], tombstone: { operation: 'del', base: r.id } })] : []
    a.commit([tomb])
    expect(a.trash()).toEqual([{ id: tomb.id, root: 'c1', deletedAt: now(), recoverableUntil: now() + TRASH_DAYS * 86400000, expired: false }])
    expect(a.trash(now() + TRASH_DAYS * 86400000 + 1)[0].expired).toBe(true)
    expect(PHYSICAL_PURGE).toBe(false); expect(a.status().physicalPurge).toBe(false)
    expect(existsSync(a.blobFile(r.contentHash))).toBe(true) // nothing physically removed
    a.recordBase(key('c1'), r.id); expect(open(rootA).state().bases).toEqual({ [key('c1')]: r.id })
    expect(() => a.recordBase(key('c1'), 'short')).toThrow(/Invalid base/)
    // Rotating window over older buckets advances across calls and wraps.
    expect(a.rotateBuckets('d', 'i', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(a.rotateBuckets('d', 'i', [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 8)).toEqual([8, 9, 0, 1, 2, 3, 4, 5])
    expect(a.rotateBuckets('d', 'i', [], 8)).toEqual([])
})

function hashBytes(bytes: Buffer) { return require('node:crypto').createHash('sha256').update(bytes).digest('hex') }
const jsonFiles = (names: string[]) => names.filter(n => n.endsWith('.json')) // atomicWriteJson also writes .sha256 sidecars

test('ambiguous write failures: after-write throw, stale checksum sidecar, damaged manifest and fail-closed (Codex 06 P1)', async t => {
    const root = await temp(t)
    let afterWrite: string[] = []
    const writeJson = (dir: string, name: string, value: any, options?: any) => { const result = atomicWriteJson(dir, name, value, options); if (name === 'state.json' && afterWrite.length) throw new Error(afterWrite.shift()!); return result }
    const a = open(root, { writeJson }); a.setWorkspace('ws')
    const rA = chat('a', { n: 'A' }), rB = chat('b', { n: 'B' })
    afterWrite = ['EIO after rename']
    expect(() => a.commit([rA])).toThrow(/EIO after rename/)
    // The manifest did land: the same instance now reflects it and does not overwrite it with the next commit.
    expect(a.status().outbox.pending).toHaveLength(1); expect(a.graph.heads(key('a'))).toEqual([rA.id])
    expect(a.commit([rA])).toBeNull()
    const entryB = a.commit([rB])
    expect(entryB.sequence).toBe(2)
    expect(open(root).status().outbox.pending.map((c: any) => c.sequence)).toEqual([1, 2])
    expect(open(root).graph.heads(key('a'))).toEqual([rA.id])
    // Crash between manifest rename and sidecar replacement: stale sidecar, but the manifest verifies by its own digest.
    await writeFile(join(root, 'nas-sync', 'state.json.sha256'), 'deadbeef\n')
    const b = open(root)
    expect(b.status().outbox.pending).toHaveLength(2); expect(b.status().recovery).toBeNull()
    // Damaged main manifest: the preserved .bak (last durable state) is used and the recovery is reported, never silent.
    const good = await readFile(join(root, 'nas-sync', 'state.json'), 'utf8')
    b.commit([chat('c', { n: 'C' })])
    await writeFile(join(root, 'nas-sync', 'state.json'), good.slice(0, 40))
    const c = open(root)
    expect(c.status().recovery).toEqual({ from: 'state.json.bak', reason: expect.stringMatching(/JSON|digest/) })
    expect(c.status().outbox.pending.map((x: any) => x.sequence)).toEqual([1, 2]) // state before the damaged write
    // Forged digest is rejected like any other damage.
    const forged = JSON.parse(good); forged.sequence = 99
    await writeFile(join(root, 'nas-sync', 'state.json'), JSON.stringify(forged)); await rm(join(root, 'nas-sync', 'state.json.bak'))
    expect(() => open(root)).toThrow(expect.objectContaining({ code: 'MANIFEST_UNREADABLE' }))
    // Fail closed: if the write throws and no manifest can be reloaded, every further mutation refuses until reopened.
    const root2 = await temp(t, 'bard-sync-closed-'), d = open(root2, { writeJson: (dir: string, name: string, value: any, o?: any) => {
        if (name === 'state.json' && value.sequence === 1) { atomicWriteJson(dir, name, { garbage: true }, o); require('node:fs').writeFileSync(join(dir, 'state.json.bak'), 'x'); throw new Error('torn write') } // main and backup both unusable
        return atomicWriteJson(dir, name, value, o) } })
    expect(() => d.commit([rA])).toThrow(/torn write/)
    expect(() => d.commit([rB])).toThrow(expect.objectContaining({ code: 'STORE_BROKEN' }))
    expect(d.status().broken).toMatch(/manual recovery/)
})

test('interrupted resolution resumes from its durable intent; held variants fetch blobs before explicit acceptance; rejections never resurrect (Codex 08)', async t => {
    const rootA = await temp(t), rootA2 = await temp(t, 'bard-sync-clone-')
    const a = open(rootA); a.setWorkspace('ws'); const seed = a.commit([chat('seed', { n: 0 })])
    await cp(join(rootA, 'nas-sync'), join(rootA2, 'nas-sync'), { recursive: true })
    const a2 = open(rootA2), A = a.identity(), at = (sequence: number, commitId: string) => ({ device: A.deviceId, incarnation: A.incarnationId, sequence, commitId })
    const asset = Buffer.from('asset-bytes'); await writeFile(join(rootA2, 'asset'), asset)
    const left = a.commit([chat('left', { n: 1 })]), right = a2.commit([chat('right', { n: 1 }, [], { asset: hashBytes(asset) })], { blobs: { [hashBytes(asset)]: join(rootA2, 'asset') } }), third = a.commit([chat('third', { n: 3 })])
    /** Deliver the right variant WITHOUT its dependency blob (transient NAS gap). */
    const deliverRightWithoutAsset = (to: any) => { const object = a2.commitObject(right); for (const hash of object.blobs) if (hash !== hashBytes(asset) && !to.hasBlob(hash)) to.storeBlobFromFile(hash, a2.blobFile(hash)); return object }
    const stage = async (root: string, writeJson?: any) => {
        const s = open(root, writeJson ? { writeJson } : {})
        s.setWorkspace('ws')
        expect(s.admitRemote(deliver(a, s, seed), at(1, seed.commitId)).state).toBe('admitted'); expect(s.admitRemote(deliver(a, s, left), at(2, left.commitId)).state).toBe('admitted')
        expect(s.admitRemote(deliverRightWithoutAsset(s), at(2, right.commitId)).state).toBe('held'); expect(s.admitRemote(deliver(a, s, third), at(3, third.commitId)).state).toBe('held')
        return s
    }
    // --- accept, crashing right after the durable intent was written ---
    let stateWrites = 0, failAt = 0
    const crashy = (dir: string, name: string, value: any, o?: any) => { if (name === 'state.json' && ++stateWrites === failAt) throw new Error('crash before manifest write'); return atomicWriteJson(dir, name, value, o) }
    const rootB = await temp(t, 'bard-sync-b-'), b = await stage(rootB, crashy)
    expect(b.waitingEntries()).toEqual([expect.objectContaining({ kind: 'held', sequence: 2, commitId: right.commitId, blobs: [hashBytes(asset)] }), expect.objectContaining({ kind: 'held', sequence: 3, commitId: third.commitId, blobs: [] })])
    stateWrites = 0; failAt = 2 // 1 = intent, 2 = first held record
    expect(() => b.resolveAmbiguity(A.deviceId, A.incarnationId, { acceptHeld: true })).toThrow(/crash/)
    expect(b.status().incoming[`${A.deviceId}/${A.incarnationId}`]).toMatchObject({ held: 2, resolution: expect.objectContaining({ decision: 'accept', other: right.commitId }) })
    expect(jsonFiles(await readdir(join(rootB, 'nas-sync', 'incoming')))).toHaveLength(2) // every held file still has a manifest reference
    const b2 = open(rootB) // restart: the recorded decision resumes by itself
    expect(b2.resumed).toEqual([expect.objectContaining({ sequence: 2, commitId: right.commitId, state: 'waiting', reason: expect.stringContaining('missing blobs') }), expect.objectContaining({ sequence: 3, commitId: third.commitId, state: 'admitted' })])
    expect(b2.status().incoming[`${A.deviceId}/${A.incarnationId}`]).toMatchObject({ held: 0, waiting: 1, ambiguous: null, resolution: null, admitted: 3 })
    expect(b2.graph.classify(key('third')).state).toBe('live'); expect(b2.graph.classify(key('right')).state).toBe('absent')
    // The blob arrives later (transport re-download): the accepted variant is admitted as its exact pair, not re-held.
    b2.storeBlobFromFile(hashBytes(asset), join(rootA2, 'asset'))
    expect(b2.retryWaiting()).toEqual([expect.objectContaining({ sequence: 2, commitId: right.commitId, state: 'admitted' })])
    expect(b2.graph.classify(key('right')).state).toBe('live'); expect(b2.graph.classify(key('left')).state).toBe('live')
    expect(b2.pendingApply().map((p: any) => [p.sequence, p.commitId, p.revisions])).toEqual([[1, seed.commitId, seed.revisions], [2, left.commitId, left.revisions], [3, third.commitId, third.revisions], [2, right.commitId, right.revisions]])
    expect(open(rootB).pendingApply()).toHaveLength(4); expect(jsonFiles(await readdir(join(rootB, 'nas-sync', 'incoming')))).toEqual([])
    // --- reject, crashing after the quarantine but before the later record was released ---
    const rootC = await temp(t, 'bard-sync-c-'), c = await stage(rootC, crashy)
    stateWrites = 0; failAt = 3 // 1 = intent, 2 = quarantine of the rejected variant, 3 = admission of seq 3
    expect(() => c.resolveAmbiguity(A.deviceId, A.incarnationId, { acceptHeld: false })).toThrow(/crash/)
    expect(c.status().incoming[`${A.deviceId}/${A.incarnationId}`]).toMatchObject({ held: 1, quarantined: 1, resolution: expect.objectContaining({ decision: 'reject' }) })
    const c2 = open(rootC)
    expect(c2.resumed).toEqual([expect.objectContaining({ sequence: 3, state: 'admitted' })])
    expect(c2.status().incoming[`${A.deviceId}/${A.incarnationId}`]).toMatchObject({ held: 0, quarantined: 1, ambiguous: null, resolution: null, admitted: 3 })
    expect(c2.graph.classify(key('right')).state).toBe('absent') // explicitly rejected: never resurrected
    expect(c2.admitRemote(deliverRightWithoutAsset(c2), at(2, right.commitId))).toEqual({ state: 'quarantined', reason: 'previously quarantined' })
    expect(c2.state().peers[`${A.deviceId}/${A.incarnationId}`].resolved).toEqual([expect.objectContaining({ sequence: 2, kept: left.commitId, other: right.commitId, decision: 'reject' })])
    // Calling resolve again while an intent is pending continues it instead of starting another.
    const rootD = await temp(t, 'bard-sync-d-'), d = await stage(rootD, crashy)
    stateWrites = 0; failAt = 4 // crash at finalisation: everything processed, ambiguity flag still set
    expect(() => d.resolveAmbiguity(A.deviceId, A.incarnationId, { acceptHeld: true })).toThrow(/crash/)
    expect(d.resolveAmbiguity(A.deviceId, A.incarnationId, { acceptHeld: false })).toEqual([]) // decision already recorded as accept; nothing left to process
    expect(d.status().incoming[`${A.deviceId}/${A.incarnationId}`]).toMatchObject({ ambiguous: null, resolution: null, waiting: 1, admitted: 3 })
})
