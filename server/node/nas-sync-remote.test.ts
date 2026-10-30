import { test, expect } from 'vitest'
import { mkdtemp, rm, cp, writeFile, readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fixtureDav } from './nas-sync-dav-fixture'
const { createSyncRemote, createSyncTransport, parseListing, NAMESPACE, BUCKET } = require('./nas-sync-remote.cjs')
const { createSyncStore, commitIdOf } = require('./nas-sync-store.cjs')
const { makeRevision, hashJson } = require('./nas-sync-core.cjs')
const { canonical } = require('../../shared/play-set/protocol.ts')

const chat = (root: string, content: any, parents: string[] = [], dependencies: Record<string, string> = {}) => makeRevision({ domain: 'play', type: 'chat', root, parents, content, dependencies })
const key = (root: string) => `play\nchat\n${root}`
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
let clock = 5_000_000
const now = () => clock
async function temp(t: any, name = 'bard-sync-remote-') { const root = await mkdtemp(join(tmpdir(), name)); t.onTestFinished(() => rm(root, { recursive: true, force: true })); return root }
function device(t: any, dav: ReturnType<typeof fixtureDav>, root: string, extra: any = {}) {
    const store = createSyncStore({ dataRoot: root, now, ...extra }); if (!store.identity().workspaceId) store.setWorkspace('ws-fixture')
    const remote = createSyncRemote({ secrets: dav.secrets, fetch: dav.fetch })
    return { store, remote, transport: createSyncTransport({ store, remote, now }) }
}
const NS = NAMESPACE.join('/') + '/ws-fixture'

test('NAS dates come from WebDAV, backfill admitted old records, survive restart and never change commit bytes or revision IDs', async t => {
    const listing = (value: string) => `<d:response><d:href>/files/a.json</d:href><d:propstat><d:prop><d:getlastmodified>${value}</d:getlastmodified></d:prop></d:propstat></d:response>`
    expect(parseListing(listing('bad date'), 'https://nas.invalid/files')[0]).not.toHaveProperty('modifiedAt')
    expect(parseListing(listing('Thu, 22 Oct 2026 16:05:00 GMT'), 'https://nas.invalid/files')[0].modifiedAt).toBe(Date.parse('2026-10-22T16:05:00Z'))
    const dav = fixtureDav(), a = device(t, dav, await temp(t)), rootB = await temp(t), b = device(t, dav, rootB)
    const rev = chat('date-chat', { name: '날짜 표본', message: [] }), entry = a.store.commit([rev])
    const bytes = canonical(a.store.commitObject(entry))
    const addr = { device: a.store.identity().deviceId, incarnation: a.store.identity().incarnationId, sequence: entry.sequence, commitId: entry.commitId }
    const path = `${NS}/devices/${addr.device}/${addr.incarnation}/commits/0/${entry.sequence}_${entry.commitId}.json`
    dav.modifiedAt.set(path, Date.parse('2026-10-22T16:05:00Z'))
    expect((await a.transport.publish()).failed).toEqual([])
    expect(a.store.state().nasTimes[rev.id]).toBe(dav.modifiedAt.get(path))
    expect(canonical(a.store.commitObject(entry))).toBe(bytes)
    dav.modifiedAt.delete(path)
    await b.transport.pull(); expect(b.store.state().nasTimes?.[rev.id]).toBeUndefined()
    dav.modifiedAt.set(path, Date.parse('2026-10-22T16:06:00Z'))
    const ids = b.store.graph.heads(key('date-chat'))
    expect((await b.transport.pull()).identical).toBe(1)
    expect(b.store.graph.heads(key('date-chat'))).toEqual(ids)
    expect(device(t, dav, rootB).store.state().nasTimes[rev.id]).toBe(dav.modifiedAt.get(path))
    b.store.noteNasTimes([{ ...addr, at: NaN }, { ...addr, commitId: 'f'.repeat(64), at: Date.now() }])
    expect(b.store.state().nasTimes[rev.id]).toBe(dav.modifiedAt.get(path))
    const misplaced = path.replace('/commits/0/', '/commits/1/')
    dav.dirs.add(misplaced.slice(0, misplaced.lastIndexOf('/'))); dav.files.set(misplaced, dav.files.get(path)!); dav.modifiedAt.set(misplaced, 1000)
    await b.transport.pull(); expect(b.store.state().nasTimes[rev.id]).toBe(dav.modifiedAt.get(path))
    b.store.noteNasTimes = () => { throw new Error('date metadata disk full') }
    expect((await b.transport.pull()).identical).toBe(1)
})

test('immutable put on an empty tree creates every namespace parent, verifies, moves, and never leaves temp files', async t => {
    const dav = fixtureDav(), remote = createSyncRemote({ secrets: dav.secrets, fetch: dav.fetch })
    const bytes = Buffer.from('{"v":1}')
    const result = await remote.putImmutable(['ws-fixture', 'devices', 'dev 1', 'inc#1', 'commits', '0', '1_' + 'a'.repeat(64) + '.json'], bytes)
    expect(result).toEqual({ state: 'stored', hash: sha(bytes) })
    expect(dav.log.filter(l => l.startsWith('MKCOL')).slice(0, 3)).toEqual(['MKCOL .risubard-sync', 'MKCOL .risubard-sync/v1', 'MKCOL .risubard-sync/v1/ws-fixture'])
    expect(dav.dirs.has('.risubard-sync/v1/ws-fixture/devices/dev%201/inc%231/commits/0')).toBe(true) // per-segment encoding
    expect(dav.paths()).toEqual([`${NS}/devices/dev 1/inc#1/commits/0/1_${'a'.repeat(64)}.json`])
    expect(dav.log.some(l => l.includes('.part-'))).toBe(true); expect(dav.log.filter(l => l.startsWith('DELETE') && l.includes('.part-'))).toHaveLength(1)
    expect(await remote.putImmutable(['ws-fixture', 'devices', 'dev 1', 'inc#1', 'commits', '0', '1_' + 'a'.repeat(64) + '.json'], bytes)).toEqual({ state: 'exists-same', hash: sha(bytes) })
    expect((await remote.putImmutable(['ws-fixture', 'devices', 'dev 1', 'inc#1', 'commits', '0', '1_' + 'a'.repeat(64) + '.json'], Buffer.from('{"v":2}'))).state).toBe('conflict')
    expect(dav.paths()).toHaveLength(1)
    // Second put reuses existing collections (405) and still succeeds.
    expect((await remote.putImmutable(['ws-fixture', 'acks', 'd.json'], bytes)).state).toBe('stored')
    expect((await remote.putImmutable(['ws-fixture', 'acks', 'd.json'], Buffer.from('{"v":3}'), { overwrite: true })).state).toBe('stored')
    expect(dav.files.get('.risubard-sync/v1/ws-fixture/acks/d.json')!.toString()).toBe('{"v":3}')
    // Failure before MOVE: corrupted echo or network error on MOVE → error, final absent, temp removed.
    dav.hooks.push(req => req.method === 'GET' && req.path.includes('.part-') ? Object.assign(Readable.from([Buffer.from('xx')]), { statusCode: 200, headers: {} }) : undefined)
    await expect(remote.putImmutable(['ws-fixture', 'blobs', 'ab', 'ab'.repeat(32)], bytes)).rejects.toThrow(/hash mismatch/)
    dav.hooks.length = 0
    dav.hooks.push(req => { if (req.method === 'MOVE') throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) })
    await expect(remote.putImmutable(['ws-fixture', 'blobs', 'ab', 'ab'.repeat(32)], bytes)).rejects.toThrow(/socket hang up/)
    dav.hooks.length = 0
    expect(dav.paths().filter(p => p.includes('blobs'))).toEqual([]); expect([...dav.files.keys()].some(p => p.includes('.part-'))).toBe(false)
    // Streamed file upload and verification; damaged remote objects are detected and replaceable.
    const root = await temp(t), big = Buffer.alloc(3 * 1024 * 1024 + 7, 7); await writeFile(join(root, 'big'), big)
    expect(await remote.verify(['ws-fixture', 'blobs', sha(big).slice(0, 2), sha(big)], sha(big))).toBe('missing')
    expect((await remote.putFile(['ws-fixture', 'blobs', sha(big).slice(0, 2), sha(big)], join(root, 'big'), sha(big))).state).toBe('stored')
    expect(await remote.verify(['ws-fixture', 'blobs', sha(big).slice(0, 2), sha(big)], sha(big))).toBe('ok')
    dav.files.set(`.risubard-sync/v1/ws-fixture/blobs/${sha(big).slice(0, 2)}/${sha(big)}`, Buffer.from('damaged'))
    expect(await remote.verify(['ws-fixture', 'blobs', sha(big).slice(0, 2), sha(big)], sha(big))).toBe('damaged')
    await expect(remote.getToFile(['ws-fixture', 'blobs', sha(big).slice(0, 2), sha(big)], join(root, 'down'), sha(big))).rejects.toThrow(/hash mismatch/)
    expect(existsSync(join(root, 'down'))).toBe(false); expect((await import('node:fs/promises')).readdir(root).then(f => f.filter(n => n.includes('.part')))).resolves.toEqual([])
    expect((await remote.putFile(['ws-fixture', 'blobs', sha(big).slice(0, 2), sha(big)], join(root, 'big'), sha(big), { overwrite: true })).state).toBe('stored')
    expect(await remote.getToFile(['ws-fixture', 'blobs', sha(big).slice(0, 2), sha(big)], join(root, 'down'), sha(big))).toBe(join(root, 'down'))
    expect(await readFile(join(root, 'down'))).toEqual(big)
    expect(await remote.getToFile(['ws-fixture', 'blobs', 'zz', 'z'.repeat(64)], join(root, 'none'), 'z'.repeat(64))).toBeNull()
    // Production validation stays: plain http or credential-less config is refused before any request.
    const insecure = createSyncRemote({ secrets: { get: async () => ({ url: 'http://nas.invalid/x/', username: 'u', password: 'p' }) }, fetch: dav.fetch })
    await expect(insecure.list(['ws-fixture'])).rejects.toThrow(/HTTPS/)
    await expect(createSyncRemote({ secrets: { get: async () => ({ url: dav.base, username: '', password: '' }) }, fetch: dav.fetch }).list([])).rejects.toThrow(/계정/)
    await expect(remote.get(['ws-fixture', 'a/b'])).rejects.toThrow(/Invalid sync path segment/)
})

test('listing parses D:/d: multistatus with absolute hrefs and encoded names, bounded to one directory level', () => {
    const xml = `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:"><D:response><D:href>https://nas.invalid/home/RisuAI/.risubard-sync/v1/ws/devices/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
<D:response><D:href>/home/RisuAI/.risubard-sync/v1/ws/devices/dev%201/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype></D:prop></D:propstat></D:response>
<d:response><d:href>/home/RisuAI/.risubard-sync/v1/ws/devices/note%26file.json</d:href><d:propstat><d:prop><d:resourcetype/></d:prop></d:propstat></d:response>
<D:response><D:href>/home/RisuAI/.risubard-sync/v1/ws/devices/dev%201/deeper.json</D:href><D:propstat><D:prop><D:resourcetype/></D:prop></D:propstat></D:response></D:multistatus>`
    expect(parseListing(xml, 'https://nas.invalid/home/RisuAI/.risubard-sync/v1/ws/devices')).toEqual([{ name: 'dev 1', collection: true }, { name: 'note&file.json', collection: false }])
})

test('tablet publishes commits with streamed blobs; phone pulls, admits, applies, ACKs; receipts separate NAS-committed from applied', async t => {
    const dav = fixtureDav(), tablet = device(t, dav, await temp(t)), phone = device(t, dav, await temp(t, 'bard-sync-phone-'))
    const wiki = Buffer.from('# 위키\n'.repeat(5000)), wikiFile = join(tablet.store.root, '..', 'wiki.md'); await writeFile(wikiFile, wiki)
    const r1 = chat('c1', { message: ['안녕'] }, [], { wiki: sha(wiki) })
    const entry = tablet.store.commit([r1], { blobs: { [sha(wiki)]: wikiFile } })
    expect(tablet.transport.status().outbox).toMatchObject({ pending: [expect.objectContaining({ sequence: 1 })], published: 0 })
    const report = await tablet.transport.publish()
    expect(report).toMatchObject({ stored: [{ sequence: 1, commitId: entry.commitId, state: 'stored' }], blobs: 2, failed: [], rotated: null })
    const T = tablet.store.identity()
    expect(dav.paths()).toEqual([`${NS}/blobs/${r1.contentHash.slice(0, 2)}/${r1.contentHash}`, `${NS}/blobs/${sha(wiki).slice(0, 2)}/${sha(wiki)}`, `${NS}/devices/${T.deviceId}/${T.incarnationId}/commits/0/1_${entry.commitId}.json`].sort())
    expect(JSON.parse(dav.files.get(`.risubard-sync/v1/ws-fixture/devices/${T.deviceId}/${T.incarnationId}/commits/0/1_${entry.commitId}.json`)!.toString())).toMatchObject({ v: 1, sequence: 1, commitId: entry.commitId, blobs: entry.blobs })
    expect(tablet.transport.status().outbox).toEqual({ pending: [], published: 1 }) // NAS committed
    expect((await tablet.transport.publish()).stored).toEqual([]) // nothing due; blobs are not re-verified without a due commit
    const pulled = await phone.transport.pull()
    expect(pulled).toMatchObject({ admitted: [expect.objectContaining({ device: T.deviceId, sequence: 1, commitId: entry.commitId })], waiting: [], held: [], quarantined: [], identical: 0 })
    expect(pulled.scanned).toEqual([`${T.deviceId}/${T.incarnationId}/0`])
    expect(phone.store.graph.get(r1.id).content).toEqual({ message: ['안녕'] }); expect(await readFile(phone.store.blobFile(sha(wiki)))).toEqual(wiki)
    expect(phone.transport.status()).toMatchObject({ pendingApply: 1, incoming: { [`${T.deviceId}/${T.incarnationId}`]: expect.objectContaining({ admitted: 1, applied: 0, pendingApply: 1 }) } })
    expect((await phone.transport.pull()).identical).toBe(1) // idempotent
    // The client applies (milestone 3 wiring) and only then the ACK is recorded and published.
    const pending = phone.store.pendingApply()[0]; phone.store.markApplied(pending.device, pending.incarnation, pending.sequence, pending.commitId)
    const acked = await phone.transport.publish()
    expect(acked.ack).toBe('published')
    expect(JSON.parse(dav.files.get(`.risubard-sync/v1/ws-fixture/acks/${phone.store.identity().deviceId}.json`)!.toString())).toMatchObject({ v: 1, applied: { [`${T.deviceId}/${T.incarnationId}`]: { [`1_${entry.commitId}`]: expect.any(Number) } } })
    expect(phone.transport.status().incoming[`${T.deviceId}/${T.incarnationId}`]).toMatchObject({ applied: 1, pendingApply: 0 })
    // Restarted phone keeps everything; restarted tablet does not republish.
    const phone2 = device(t, dav, join(phone.store.root, '..')); expect(phone2.store.graph.heads(key('c1'))).toEqual([r1.id]); expect(phone2.transport.status().pendingApply).toBe(0)
    expect((await device(t, dav, join(tablet.store.root, '..')).transport.publish()).stored).toEqual([])
})

test('offline publish retries on schedule, stops at the first failure, and a durable retryable outbox survives restart', async t => {
    const dav = fixtureDav(), root = await temp(t), tablet = device(t, dav, root)
    tablet.store.commit([chat('c1', { n: 1 })]); tablet.store.commit([chat('c2', { n: 2 })])
    dav.hooks.push(() => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) })
    const failed = await tablet.transport.publish({ at: now() })
    expect(failed).toMatchObject({ stored: [], failed: [{ sequence: 1, error: expect.stringContaining('ECONNREFUSED') }] })
    expect(tablet.transport.status().outbox.pending).toEqual([expect.objectContaining({ sequence: 1, attempts: 1, nextAt: now() + 5000 }), expect.objectContaining({ sequence: 2, attempts: 0 })])
    expect(dav.paths()).toEqual([])
    dav.hooks.length = 0
    expect((await tablet.transport.publish({ at: now() + 1000 })).stored.map((s: any) => s.sequence)).toEqual([2]) // seq 1 still backing off; seq 2 is due
    const reopened = device(t, dav, root)
    expect((await reopened.transport.publish({ at: now() + 5000 })).stored.map((s: any) => s.sequence)).toEqual([1])
    expect(reopened.transport.status().outbox).toEqual({ pending: [], published: 2 })
})

test('clone/restore detection: a second install publishing the same (incarnation, sequence) rotates instead of colliding; receivers hold ambiguous records', async t => {
    const dav = fixtureDav(), rootA = await temp(t), a = device(t, dav, rootA)
    a.store.commit([chat('seed', { n: 0 })]); await a.transport.publish()
    const rootA2 = await temp(t, 'bard-sync-clone-'); await cp(join(rootA, 'nas-sync'), join(rootA2, 'nas-sync'), { recursive: true }) // full clone incl. sidecar
    const a2 = device(t, dav, rootA2); expect(a2.store.identity()).toEqual(a.store.identity())
    const left = a.store.commit([chat('left', { n: 1 })]), right = a2.store.commit([chat('right', { n: 1 })])
    expect(left.sequence).toBe(2); expect(right.sequence).toBe(2)
    await a.transport.publish()
    const original = a2.store.identity().incarnationId
    const report = await a2.transport.publish()
    expect(report.rotated).toBeTruthy(); expect(report.stored).toEqual([])
    expect(a2.store.identity().incarnationId).not.toBe(original); expect(a2.store.dueCommits()).toEqual([expect.objectContaining({ sequence: 1, commitId: right.commitId })])
    expect((await a2.transport.publish()).stored).toEqual([{ sequence: 1, commitId: right.commitId, state: 'stored' }])
    const A = a.store.identity()
    expect(dav.paths().filter(p => p.includes('/commits/'))).toEqual([`${NS}/devices/${A.deviceId}/${A.incarnationId}/commits/0/1_${a.store.state().commits[0].commitId}.json`, `${NS}/devices/${A.deviceId}/${A.incarnationId}/commits/0/2_${left.commitId}.json`, `${NS}/devices/${A.deviceId}/${a2.store.identity().incarnationId}/commits/0/1_${right.commitId}.json`].sort())
    // A third device sees two incarnations of the same device: both lineages admitted, no ambiguity.
    const b = device(t, dav, await temp(t, 'bard-sync-b-'))
    const pulled = await b.transport.pull()
    expect(pulled.admitted.map((x: any) => [x.incarnation === A.incarnationId, x.sequence]).sort()).toEqual([[false, 1], [true, 1], [true, 2]])
    expect(b.store.graph.classify(key('left')).state).toBe('live'); expect(b.store.graph.classify(key('right')).state).toBe('live')
    // Race the publisher check cannot cover: an object with the same incarnation+sequence but another commit id appears later.
    const forgedCommit = JSON.parse(dav.files.get(`.risubard-sync/v1/ws-fixture/devices/${A.deviceId}/${A.incarnationId}/commits/0/2_${left.commitId}.json`)!.toString())
    const other = chat('other', { n: 'x' }); const otherHeader = { ...other }; delete (otherHeader as any).content
    const forged = { ...forgedCommit, commitId: commitIdOf([other.id]), revisions: [otherHeader], blobs: [other.contentHash] }
    dav.files.set(`.risubard-sync/v1/ws-fixture/blobs/${other.contentHash.slice(0, 2)}/${other.contentHash}`, Buffer.from(canonical(other.content)))
    dav.dirs.add(`.risubard-sync/v1/ws-fixture/blobs/${other.contentHash.slice(0, 2)}`)
    dav.files.set(`.risubard-sync/v1/ws-fixture/devices/${A.deviceId}/${A.incarnationId}/commits/0/2_${forged.commitId}.json`, Buffer.from(canonical(forged)))
    const third = a.store.commit([chat('left', { n: 3 }, a.store.graph.heads(key('left')))]); await a.transport.publish()
    const second = await b.transport.pull()
    expect(second.held.map((h: any) => [h.sequence, h.commitId])).toEqual([[2, forged.commitId], [3, third.commitId]])
    expect(b.store.graph.classify(key('other')).state).toBe('absent'); expect(b.store.graph.get(third.revisions[0])).toBeUndefined()
    expect(b.transport.status().incoming[`${A.deviceId}/${A.incarnationId}`]).toMatchObject({ held: 2, ambiguous: expect.objectContaining({ sequence: 2 }) })
    expect((await b.transport.pull()).identical).toBeGreaterThan(0) // held records are known; nothing is re-fetched or admitted
    const released = b.store.resolveAmbiguity(A.deviceId, A.incarnationId, { acceptHeld: true })
    expect(released).toEqual([expect.objectContaining({ sequence: 2, commitId: forged.commitId, state: 'admitted' }), expect.objectContaining({ sequence: 3, commitId: third.commitId, state: 'admitted' })])
    expect(b.store.graph.classify(key('other')).state).toBe('live'); expect(b.store.graph.heads(key('left'))).toEqual([third.revisions[0]])
})

test('out-of-order arrival waits for parents, tampered objects are quarantined, damaged blobs keep the commit waiting', async t => {
    const dav = fixtureDav(), a = device(t, dav, await temp(t)); let b = device(t, dav, await temp(t, 'bard-sync-b-'))
    const r1 = chat('c1', { n: 1 }), r2 = chat('c1', { n: 2 }, [r1.id]), r3 = chat('c3', { n: 3 })
    const e1 = a.store.commit([r1]), e2 = a.store.commit([r2]), e3 = a.store.commit([r3]); await a.transport.publish()
    const A = a.store.identity(), dir = `.risubard-sync/v1/ws-fixture/devices/${A.deviceId}/${A.incarnationId}/commits/0/`
    const first = dav.files.get(`${dir}1_${e1.commitId}.json`)!; dav.files.delete(`${dir}1_${e1.commitId}.json`)
    const third = dav.files.get(`${dir}3_${e3.commitId}.json`)!; dav.files.set(`${dir}3_${e3.commitId}.json`, Buffer.from(third.toString().replace(r3.contentHash, r1.contentHash)))
    const blob = `.risubard-sync/v1/ws-fixture/blobs/${r2.contentHash.slice(0, 2)}/${r2.contentHash}`; const goodBlob = dav.files.get(blob)!; dav.files.set(blob, Buffer.from('{"n":"evil"}'))
    const pulled = await b.transport.pull()
    expect(pulled.waiting.map((w: any) => [w.sequence, w.reason.slice(0, 13)])).toEqual([[2, 'missing blobs'], [2, 'blob fetch: D']]) // parked, then the end-of-pull blob retry fails on the still-damaged object
    expect(pulled.quarantined).toEqual([expect.objectContaining({ sequence: 3, reason: expect.stringMatching(/header does not match|mismatch|Commit/) })])
    expect(b.store.graph.classify(key('c1')).state).toBe('absent'); expect(b.store.hasBlob(r2.contentHash)).toBe(false)
    expect((await b.transport.pull()).waiting.map((w: any) => w.reason.slice(0, 13))).toEqual(['blob fetch: D']) // still damaged: the durable waiting entry retries the download every pull
    dav.files.set(blob, goodBlob)
    const reopenedB = device(t, dav, join(b.store.root, '..')) // restart between pulls
    const again = await reopenedB.transport.pull()
    expect(reopenedB.store.hasBlob(r2.contentHash)).toBe(true)
    b = reopenedB
    expect(again.admitted).toEqual([]); expect(again.quarantined).toEqual([])
    expect(Object.values(b.store.peer(A.deviceId, A.incarnationId).waiting).map((w: any) => w.reason.slice(0, 14))).toEqual(['Missing parent']) // blob fetched; now only the parent is missing
    dav.files.set(`${dir}1_${e1.commitId}.json`, first)
    const done = await b.transport.pull()
    expect(done.admitted.map((x: any) => x.sequence).sort()).toEqual([1, 2])
    expect(b.store.graph.heads(key('c1'))).toEqual([r2.id]); expect(b.store.pendingApply().map((p: any) => p.sequence)).toEqual([1, 2])
    expect(b.transport.status().incoming[`${A.deviceId}/${A.incarnationId}`]).toMatchObject({ admitted: 2, quarantined: 1, waiting: 0 })
})

test('bucketed scanning: current and future buckets always, a rotating window of older ones, misplaced objects ignored, full scan on demand', async t => {
    const dav = fixtureDav(), b = device(t, dav, await temp(t), { }), peerDevice = 'peer-device', inc = 'inc-1'
    const dir = (bucket: number) => `.risubard-sync/v1/ws-fixture/devices/${peerDevice}/${inc}/commits/${bucket}`
    for (const p of ['.risubard-sync', '.risubard-sync/v1', '.risubard-sync/v1/ws-fixture', '.risubard-sync/v1/ws-fixture/devices', `.risubard-sync/v1/ws-fixture/devices/${peerDevice}`, `.risubard-sync/v1/ws-fixture/devices/${peerDevice}/${inc}`, `.risubard-sync/v1/ws-fixture/devices/${peerDevice}/${inc}/commits`]) dav.dirs.add(p)
    for (const bucket of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) dav.dirs.add(dir(bucket))
    dav.files.set(`${dir(0)}/${BUCKET + 5}_${'a'.repeat(64)}.json`, Buffer.from('{}')) // misplaced: sequence 261 does not belong to bucket 0
    dav.files.set(`${dir(11)}/${11 * BUCKET + 1}_${'b'.repeat(64)}.json`, Buffer.from('not json'))
    dav.files.set(`${dir(11)}/ignored.txt`, Buffer.from('x'))
    const first = await b.transport.pull()
    expect(first.scanned).toEqual(Array.from({ length: 12 }, (_, i) => `${peerDevice}/${inc}/${i}`)) // nothing seen yet: every bucket is current or future
    expect(first.quarantined).toEqual([expect.objectContaining({ sequence: 11 * BUCKET + 1, reason: expect.stringMatching(/Malformed/) })])
    expect(first.admitted).toEqual([]); expect(b.store.peer(peerDevice, inc).lastSeen).toBe(-1)
    // Pretend sequence 2600 (bucket 10) was seen: buckets ≥10 are current, older ones rotate 8 per scan and wrap.
    const admittedPeer = JSON.parse(JSON.stringify(b.store.state())); void admittedPeer
    b.store.admitRemote({ corrupt: true }, { device: peerDevice, incarnation: inc, sequence: 10 * BUCKET + 40, commitId: 'c'.repeat(64) }) // quarantined, but advances nothing
    const seen = b.store.peer(peerDevice, inc); expect(seen.lastSeen).toBe(-1)
    const waitObject = { v: 1, workspaceId: 'ws-fixture', deviceId: peerDevice, incarnationId: inc, sequence: 10 * BUCKET + 40, commitId: commitIdOf(['e'.repeat(64)]), revisions: [{ id: 'e'.repeat(64), domain: 'play', type: 'chat', root: 'x', parents: ['f'.repeat(64)], contentHash: '1'.repeat(64), dependencyHash: hashJson({}), dependencies: {} }], blobs: ['1'.repeat(64)] }
    expect(b.store.admitRemote(waitObject, { device: peerDevice, incarnation: inc, sequence: 10 * BUCKET + 40, commitId: waitObject.commitId }).state).toBe('waiting')
    expect(b.store.peer(peerDevice, inc).lastSeen).toBe(10 * BUCKET + 40)
    const second = await b.transport.pull()
    expect(second.scanned).toEqual([10, 11, 0, 1, 2, 3, 4, 5, 6, 7].map(i => `${peerDevice}/${inc}/${i}`))
    const third = await b.transport.pull()
    expect(third.scanned).toEqual([10, 11, 8, 9, 0, 1, 2, 3, 4, 5].map(i => `${peerDevice}/${inc}/${i}`))
    const full = await b.transport.pull({ full: true })
    expect(full.scanned).toHaveLength(12)
    const limited = createSyncTransport({ store: b.store, remote: b.remote, now, oldBucketsPerScan: 2 })
    expect((await limited.pull()).scanned.length).toBe(4)
})

test('ACK publication marks the exact uploaded snapshot; an apply landing during the upload is acknowledged next time (Codex 06)', async t => {
    const dav = fixtureDav(), a = device(t, dav, await temp(t)), b = device(t, dav, await temp(t, 'bard-sync-b-'))
    const e1 = a.store.commit([chat('c1', { n: 1 })]), e2 = a.store.commit([chat('c2', { n: 2 })]); await a.transport.publish()
    await b.transport.pull(); const A = a.store.identity()
    b.store.markApplied(A.deviceId, A.incarnationId, 1, e1.commitId)
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve })
    dav.hooks.push(async req => { if (req.method === 'PUT' && req.path.includes('/acks/')) { await gate } })
    const publishing = b.transport.publish()
    await new Promise(r => setTimeout(r, 20))
    b.store.markApplied(A.deviceId, A.incarnationId, 2, e2.commitId) // client apply during the network await
    release(); const report = await publishing
    expect(report.ack).toBe('published')
    const uploaded = JSON.parse(dav.files.get(`.risubard-sync/v1/ws-fixture/acks/${b.store.identity().deviceId}.json`)!.toString())
    expect(uploaded.applied[`${A.deviceId}/${A.incarnationId}`]).toEqual({ [`1_${e1.commitId}`]: expect.any(Number) })
    expect(b.store.ackChanged()).toBe(true) // the newer apply was not in the uploaded snapshot
    dav.hooks.length = 0
    expect((await b.transport.publish()).ack).toBe('published')
    expect(JSON.parse(dav.files.get(`.risubard-sync/v1/ws-fixture/acks/${b.store.identity().deviceId}.json`)!.toString()).applied[`${A.deviceId}/${A.incarnationId}`]).toEqual({ [`1_${e1.commitId}`]: expect.any(Number), [`2_${e2.commitId}`]: expect.any(Number) })
    expect(b.store.ackChanged()).toBe(false)
})

test('a restored or damaged NAS never receives a commit whose pinned blobs are absent: closure is re-verified and re-uploaded; checkpoints follow publications', async t => {
    const dav = fixtureDav(), root = await temp(t), a = device(t, dav, root, { checkpointEvery: 2 })
    const asset = Buffer.from('PNG-synthetic-bytes'), assetFile = join(root, 'asset.bin'); await writeFile(assetFile, asset)
    const r1 = chat('c1', { n: 1 }, [], { asset: sha(asset) }); a.store.commit([r1], { blobs: { [sha(asset)]: assetFile } }); await a.transport.publish()
    const blobPath = `.risubard-sync/v1/ws-fixture/blobs/${sha(asset).slice(0, 2)}/${sha(asset)}`
    expect(dav.files.has(blobPath)).toBe(true)
    // NAS restored from an older snapshot: the asset blob vanished and the content blob is damaged, local records still say "published".
    dav.files.delete(blobPath); dav.files.set(`.risubard-sync/v1/ws-fixture/blobs/${r1.contentHash.slice(0, 2)}/${r1.contentHash}`, Buffer.from('garbage'))
    const r2 = chat('c1', { n: 2 }, [r1.id], { asset: sha(asset) }); const e2 = a.store.commit([r2])
    const report = await a.transport.publish()
    expect(report.stored).toEqual([{ sequence: 2, commitId: e2.commitId, state: 'stored' }]); expect(report.blobs).toBe(2) // asset re-uploaded although recorded as published, new content stored
    expect(dav.files.get(blobPath)).toEqual(asset)
    // Material pinned only by earlier commits is repaired by the explicit maintenance pass (scheduler: join/recovery/full scan).
    expect(await a.transport.repair()).toEqual({ checked: 3, repaired: [{ hash: r1.contentHash, was: 'damaged' }] })
    expect(dav.files.get(`.risubard-sync/v1/ws-fixture/blobs/${r1.contentHash.slice(0, 2)}/${r1.contentHash}`)!.toString()).toBe(canonical(r1.content))
    expect(await a.transport.repair()).toEqual({ checked: 3, repaired: [] })
    expect(report.checkpoint).toMatch(/^[a-f0-9]{64}$/)
    const A = a.store.identity(), checkpointPath = dav.paths().find(p => p.includes('/checkpoints/'))!
    expect(checkpointPath).toBe(`${NS}/devices/${A.deviceId}/${A.incarnationId}/checkpoints/2_${report.checkpoint}.json`)
    expect(JSON.parse(dav.files.get(encodeURI(checkpointPath).replace(/^\.risubard/, '.risubard'))?.toString() ?? dav.files.get(checkpointPath)!.toString())).toMatchObject({ v: 1, publications: 2, heads: { [key('c1')]: [r2.id] } })
    // An upload failure in the middle leaves the commit unpublished and retryable; nothing claims NAS-committed.
    const r3 = chat('c3', { n: 3 }); a.store.commit([r3])
    dav.hooks.push(req => { if (req.method === 'MOVE' && req.path.includes('/commits/')) throw new Error('EPIPE') })
    const failed = await a.transport.publish()
    expect(failed.failed).toEqual([{ sequence: 3, error: 'EPIPE' }]); expect(a.transport.status().outbox.pending).toEqual([expect.objectContaining({ sequence: 3, attempts: 1 })])
    expect(dav.paths().some(p => p.includes('3_'))).toBe(false)
    dav.hooks.length = 0
    expect((await a.transport.publish({ at: now() + 6000 })).stored).toEqual([expect.objectContaining({ sequence: 3 })])
})

test('a blob pinned by an ADMITTED revision that vanished locally is repaired on the next pull by a hash-verified refetch (consumed-asset regression); absent or tampered NAS copies are reported per hash, never installed, never fail the pull', async t => {
    const dav = fixtureDav(), tablet = device(t, dav, await temp(t)), phone = device(t, dav, await temp(t, 'bard-sync-phone-'))
    const asset = Buffer.from('module-asset-bytes'), assetFile = join(tablet.store.root, '..', 'asset.bin'); await writeFile(assetFile, asset)
    const r1 = chat('m1', { n: 1 }, [], { 'asset:assets/x.png': sha(asset) })
    tablet.store.commit([r1], { blobs: { [sha(asset)]: assetFile } }); await tablet.transport.publish()
    const first = await phone.transport.pull(); expect(first.admitted).toHaveLength(1); expect(first.repaired).toEqual([]); expect(first.repairFailed).toEqual([])
    expect(phone.store.hasBlob(sha(asset))).toBe(true)
    await rm(phone.store.blobFile(sha(asset))) // what the consuming KV import used to do to the admitted blob
    expect(phone.store.missingBlobs([phone.store.graph.get(r1.id)])).toEqual([sha(asset)])
    const repaired = await phone.transport.pull()
    expect(repaired).toMatchObject({ identical: 1, admitted: [], repaired: [sha(asset)], repairFailed: [] })
    expect(await readFile(phone.store.blobFile(sha(asset)))).toEqual(asset)
    expect((await phone.transport.pull()).repaired).toEqual([]) // nothing missing: no download
    // Absent on the NAS: reported for that hash only; the pull still completes.
    const remotePath = `${NS}/blobs/${sha(asset).slice(0, 2)}/${sha(asset)}`
    await rm(phone.store.blobFile(sha(asset))); dav.files.delete(remotePath)
    expect(await phone.transport.pull()).toMatchObject({ identical: 1, repaired: [], repairFailed: [{ hash: sha(asset), reason: 'absent on NAS' }] })
    expect(phone.store.hasBlob(sha(asset))).toBe(false)
    // Tampered on the NAS: hash mismatch → not installed, reported.
    dav.files.set(remotePath, Buffer.from('tampered-bytes'))
    const bad = await phone.transport.pull(); expect(bad.repairFailed).toEqual([{ hash: sha(asset), reason: expect.stringContaining('hash mismatch') }]); expect(phone.store.hasBlob(sha(asset))).toBe(false)
    expect((await readdir(join(phone.store.blobFile(sha(asset)), '..'))).filter(f => f.endsWith('.part'))).toEqual([]) // no temp left behind
})

test('a held conflicting variant whose dependency was missing is re-downloaded on later pulls and admitted on explicit acceptance (Codex 08)', async t => {
    const dav = fixtureDav(), a = device(t, dav, await temp(t)), b = device(t, dav, await temp(t, 'bard-sync-b-'))
    const seed = a.store.commit([chat('seed', { n: 0 })]), left = a.store.commit([chat('left', { n: 1 })]); await a.transport.publish()
    const A = a.store.identity(), dir = `.risubard-sync/v1/ws-fixture/devices/${A.deviceId}/${A.incarnationId}/commits/0/`
    // Forge the clone's variant at sequence 2 with a dependency blob that is not on the NAS yet.
    const asset = Buffer.from('late-asset'), right = chat('right', { n: 1 }, [], { asset: sha(asset) }), rightHeader: any = { ...right }; delete rightHeader.content
    const forged = { ...JSON.parse(dav.files.get(`${dir}2_${left.commitId}.json`)!.toString()), commitId: commitIdOf([right.id]), revisions: [rightHeader], blobs: [right.contentHash, sha(asset)].sort() }
    dav.dirs.add(`.risubard-sync/v1/ws-fixture/blobs/${right.contentHash.slice(0, 2)}`); dav.files.set(`.risubard-sync/v1/ws-fixture/blobs/${right.contentHash.slice(0, 2)}/${right.contentHash}`, Buffer.from(canonical(right.content)))
    dav.files.set(`${dir}2_${forged.commitId}.json`, Buffer.from(canonical(forged)))
    const first = await b.transport.pull()
    expect(first.held).toEqual([expect.objectContaining({ sequence: 2, commitId: forged.commitId })]); expect(b.store.hasBlob(sha(asset))).toBe(false)
    expect(b.store.waitingEntries()).toEqual([expect.objectContaining({ kind: 'held', sequence: 2, blobs: [sha(asset)] })])
    expect(() => b.store.resolveAmbiguity(A.deviceId, A.incarnationId, { acceptHeld: true })).not.toThrow() // parks the variant as waiting(accepted) instead of failing forever
    expect(b.store.status().incoming[`${A.deviceId}/${A.incarnationId}`]).toMatchObject({ waiting: 1, held: 0, ambiguous: null })
    // NAS repaired: the next pull fetches the pinned blob for the parked variant and admits it as its exact pair.
    dav.dirs.add(`.risubard-sync/v1/ws-fixture/blobs/${sha(asset).slice(0, 2)}`); dav.files.set(`.risubard-sync/v1/ws-fixture/blobs/${sha(asset).slice(0, 2)}/${sha(asset)}`, asset)
    const second = await b.transport.pull()
    expect(second.admitted).toEqual([expect.objectContaining({ sequence: 2, commitId: forged.commitId, state: 'admitted' })])
    expect(b.store.graph.classify(key('right')).state).toBe('live'); expect(b.store.graph.classify(key('left')).state).toBe('live')
    expect(b.store.pendingApply().map((p: any) => [p.sequence, p.commitId]).sort()).toEqual([[1, seed.commitId], [2, forged.commitId], [2, left.commitId]].sort())
    expect((await b.transport.pull()).identical).toBe(3)
})

test('a 65 MiB media blob streams through snapshot-less commit → publish → pull without any JSON/base64 cap; a space check refuses the download and retries later', async t => {
    const dav = fixtureDav(), a = device(t, dav, await temp(t)), bRoot = await temp(t, 'bard-sync-b-')
    const big = Buffer.alloc(65 * 1024 * 1024 + 3, 42), file = join(a.store.root, '..', 'big.bin'); await writeFile(file, big)
    const rev = chat('media', { message: [{ data: 'see assets/big.bin' }] }, [], { 'asset:assets/big.bin': sha(big) })
    const entry = a.store.commit([rev], { blobs: { [sha(big)]: file } })
    expect(entry.sizes[sha(big)]).toBe(big.length)
    const published = await a.transport.publish(); expect(published.stored).toHaveLength(1); expect(published.blobs).toBe(2)
    const commitBytes = dav.files.get([...dav.files.keys()].find(k => k.includes('/commits/'))!)!; expect(commitBytes.length).toBeLessThan(16 * 1024) // metadata only
    expect(dav.files.get(`.risubard-sync/v1/ws-fixture/blobs/${sha(big).slice(0, 2)}/${sha(big)}`)!.length).toBe(big.length)
    // Receiver with almost no free space: the blob is not downloaded, the commit waits with the reason recorded, nothing is half-written.
    const store = createSyncStore({ dataRoot: bRoot, now }); store.setWorkspace('ws-fixture')
    const remote = createSyncRemote({ secrets: dav.secrets, fetch: dav.fetch })
    let free = 1024n
    const transport = createSyncTransport({ store, remote, now, statfs: async () => ({ bavail: free, bsize: 1n }) })
    const first = await transport.pull()
    expect(first.waiting.map((w: any) => w.reason.slice(0, 11))).toEqual(['missing blo', 'blob fetch:']); expect(first.waiting[1].reason).toContain('Not enough storage space')
    expect(store.hasBlob(sha(big))).toBe(false); expect((await readdir(join(store.root, 'blobs'), { recursive: true } as any)).filter((n: string) => n.includes('.part'))).toEqual([])
    free = BigInt(big.length) * 3n
    const second = await transport.pull()
    expect(second.admitted).toHaveLength(1); expect((await stat(store.blobFile(sha(big)))).size).toBe(big.length)
}, 120_000)

test('every ignored WebDAV success response is read to its end, never destroyed unread: put/exists-same/conflict/404 paths keep the keep-alive socket (Codex: first-sync connect timeouts)', async t => {
    const dav = fixtureDav(); let responses = 0, closedUnread = 0
    const fetch = async (url: string, init?: any) => { const res: any = await dav.fetch(url, init); responses++; res.on('close', () => { if (!res.readableEnded) closedUnread++ }); return res }
    const remote = createSyncRemote({ secrets: dav.secrets, fetch })
    const segments = ['ws-fixture', 'blobs', 'ab', 'ab' + 'c'.repeat(62)], bytes = Buffer.from('blob-bytes')
    expect((await remote.putImmutable(segments, bytes)).state).toBe('stored')      // MKCOL×n, PUT, GET(read), MOVE, DELETE
    expect((await remote.putImmutable(segments, bytes)).state).toBe('exists-same') // MOVE 412 + GET(read) + DELETE
    expect((await remote.putImmutable(segments, Buffer.from('other'))).state).toBe('conflict')
    expect(await remote.list(['ws-fixture', 'nowhere'])).toEqual([])              // PROPFIND 404
    expect(await remote.get(['ws-fixture', 'nowhere', 'x.json'])).toBeNull()       // GET 404
    expect(responses).toBeGreaterThan(12)
    expect(closedUnread).toBe(0)
    // Error statuses still fail fast (destroyed, not drained) and nothing is left behind.
    dav.hooks.push(async ({ method }) => method === 'PUT' ? Object.assign(Readable.from([Buffer.alloc(0)]), { statusCode: 507, headers: {} }) : null)
    await expect(remote.putImmutable(['ws-fixture', 'blobs', 'cd', 'cd' + 'e'.repeat(62)], bytes)).rejects.toThrow('HTTP 507')
    expect(dav.paths().filter(p => p.includes('.part-'))).toEqual([])
})

test('route-aware remote: one operation stays on one endpoint even when the network flips mid-run; the next run moves; credentials and namespace are identical on both routes', async t => {
    const home = fixtureDav('https://nas-home.invalid:5006/home/RisuAI/'), external = fixtureDav('https://nas.invalid/home/RisuAI/')
    const auth = new Set<string>(); const hosts: string[] = []
    const fetch = async (url: string, init?: any) => { hosts.push(new URL(url).host); auth.add(init?.headers?.Authorization ?? ''); return url.startsWith(home.base) ? home.fetch(url, init) : external.fetch(url, init) }
    const secrets = { get: async () => ({ url: external.base, homeUrl: home.base, username: 'fixture', password: 'fixture-password', homeSsids: ['Fixture Home'] }) }
    const { createNasRoute } = require('./nas-route.cjs')
    const route = createNasRoute({ secrets, probe: async () => false })
    route.report({ transport: 'wifi', ssid: 'Fixture Home' })
    const remote = createSyncRemote({ secrets, fetch, route })
    const segments = ['ws-fixture', 'blobs', 'ab', 'ab' + 'c'.repeat(62)]
    // Flip to an unknown Wi-Fi while the put is in flight (after its first request): every request of this run still goes home.
    home.hooks.push(async ({ method }) => { if (method === 'PUT') route.report({ transport: 'wifi', ssid: null }); return null })
    expect((await route.run(() => remote.putImmutable(segments, Buffer.from('bytes')))).state).toBe('stored')
    expect(new Set(hosts)).toEqual(new Set(['nas-home.invalid:5006'])); expect(home.paths()).toHaveLength(1); expect(external.paths()).toHaveLength(0)
    hosts.length = 0
    expect((await route.run(() => remote.putImmutable(['ws-fixture', 'blobs', 'cd', 'cd' + 'e'.repeat(62)], Buffer.from('other')))).state).toBe('stored') // next run: unknown SSID → external
    expect(new Set(hosts)).toEqual(new Set(['nas.invalid'])); expect(external.paths()).toHaveLength(1)
    expect(auth.size).toBe(1); expect([...auth][0]).toMatch(/^Basic /) // one credential for both routes
    expect(home.paths()[0]).toBe(external.paths()[0].replace(/cd.*$/, '') + home.paths()[0].slice(external.paths()[0].replace(/cd.*$/, '').length)) // same namespace prefix
})

test('direct-IP NAS: every sync request carries the TLS server name of the pinned side; a certificate-name/home-URL change saved while a routed run is in flight does not reach that run; a DNS config carries none', async t => {
    const dav = fixtureDav(), seen: string[] = []
    const spy = async (url: string, init: any) => { seen.push((init?.servername ?? '') + '@' + new URL(url).host); return dav.fetch(url, init) }
    const ip = createSyncRemote({ secrets: { get: async () => ({ url: dav.base, username: 'fixture', password: 'fixture-password', certHost: 'nas.example' }) }, fetch: spy })
    await ip.list([])
    expect(new Set(seen)).toEqual(new Set(['nas.example@' + new URL(dav.base).host]))
    seen.length = 0
    const { createNasRoute } = require('./nas-route.cjs')
    let config: any = { url: dav.base, homeUrl: dav.base, homeSsids: ['Fixture Home'], username: 'fixture', password: 'fixture-password', certHost: 'ext.example', homeCertHost: 'home.example' }
    const secrets = { get: async () => config }, route = createNasRoute({ secrets, probe: async () => false })
    route.report({ transport: 'wifi', ssid: 'Fixture Home' })
    const routed = createSyncRemote({ secrets, fetch: spy, route })
    await route.run(async () => {
        await routed.list([])
        config = { ...config, homeCertHost: 'changed.example', certHost: 'changed-ext.example' } // saved mid-run
        await routed.list([])
    })
    expect(new Set(seen)).toEqual(new Set(['home.example@' + new URL(dav.base).host])) // both requests used the pinned name
    seen.length = 0; await routed.list([]); expect(new Set(seen)).toEqual(new Set(['changed.example@' + new URL(dav.base).host])) // a new run sees the new name
    seen.length = 0
    const dns = createSyncRemote({ secrets: dav.secrets, fetch: spy }); await dns.list([])
    expect(new Set(seen)).toEqual(new Set(['@' + new URL(dav.base).host]))
})
