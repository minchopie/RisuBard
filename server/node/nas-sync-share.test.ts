// Milestone 4 server behaviours on real fixtures: key sharing over the native inbox (provenance, recipient binding, rejection,
// crash/restart sweep, key conflict), no-backup placement with clone detection, conflict resolution, trash restore and the kept
// open-chat deletion — every path driven through the play-set service's native import and the sync service's plan pipeline.
import { test, expect } from 'vitest'
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile, copyFile, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fixtureDav } from './nas-sync-dav-fixture'
const { createNasSyncService } = require('./nas-sync-service.cjs')
const { createPlaySetService } = require('./play-set-service.cjs')
const { createUserDataRepository } = require('./user-data-repository.cjs')
const { createRuntimeMemoryService } = require('./risubard-memory-runtime.cjs')
const { createFileKv } = require('./file-kv.cjs')
const { androidProtector } = require('./transfer-secrets.cjs')
const { vaultMasterStore, createVault } = require('./nas-sync-vault.cjs')
const { readShareArchive, writeGrantArchive, deviceKeyStore } = require('./nas-sync-share.cjs')

const S = (n: string) => `SENTINEL-${n}-never-leaves-vault`
const MASTER = Buffer.from('ab'.repeat(32), 'hex'), OTHER = Buffer.from('cd'.repeat(32), 'hex')
let clock = 9_000_000; const now = () => clock
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
async function walk(dir: string): Promise<string[]> { if (!existsSync(dir)) return []; const out: string[] = []; for (const e of await readdir(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) out.push(...await walk(p)); else out.push(p) } return out }
/** No file under the device's data root, its native dirs or its secrets dir may hold the master in any encoding, nor a sentinel. */
async function assertNoKeyMaterial(roots: string[], master = MASTER) {
    const needles = [master.toString('hex'), master.toString('base64'), 'SENTINEL']
    for (const root of roots) for (const f of await walk(root)) {
        if (f.endsWith('sync-vault-master.dat') || /sync-vault-master\.recovery-/.test(f)) continue // the protected vault store itself (ciphertext)
        const text = (await readFile(f)).toString('latin1')
        for (const n of needles) expect(text, f).not.toContain(n)
    }
}
function applyPlanToDb(db: any, plan: any) {
    for (const [k, v] of Object.entries(plan.settings)) { if (v === null) delete db[k]; else db[k] = v }
    for (const item of plan.modules) { db.modules ??= []; const i = db.modules.findIndex((m: any) => m.id === item.id); if (i >= 0) db.modules[i] = item; else db.modules.push(item) }
    for (const item of plan.plugins) { db.plugins ??= []; const i = db.plugins.findIndex((p: any) => p.name === item.name); if (i >= 0) db.plugins[i] = item; else db.plugins.push(item) }
    if (plan.pluginEnabled) for (const p of db.plugins ?? []) if (p.name in plan.pluginEnabled) p.enabled = plan.pluginEnabled[p.name]
    for (const added of plan.newCharacters) if (!db.characters.some((c: any) => c.chaId === added.chaId)) { const { chatIds: _i, ...rest } = added; db.characters.push({ ...rest, chats: [], chatPage: 0 }) }
    for (const u of plan.characters) { const t = db.characters.find((c: any) => c.chaId === u.chaId); const keep = { chats: t.chats, chatPage: t.chatPage }; for (const k of Object.keys(t)) if (!(k in u.fields)) delete t[k]; Object.assign(t, u.fields, keep, { chaId: u.chaId }) }
    for (const row of plan.chats) { const t = db.characters.find((c: any) => c.chaId === row.characterId); const i = t.chats.findIndex((ch: any) => ch.id === row.chat.id); if (i >= 0) t.chats[i] = structuredClone(row.chat); else t.chats.push(structuredClone(row.chat)) }
    for (const d of plan.deletions) {
        if (d.kind === 'chat') { const t = db.characters.find((c: any) => c.chaId === d.characterId); t.chats = t.chats.filter((ch: any) => ch.id !== d.id) }
        else if (d.kind === 'character') db.characters = db.characters.filter((c: any) => c.chaId !== d.id)
        else db[d.kind + 's'] = (db[d.kind + 's'] ?? []).filter((i: any) => (d.kind === 'plugin' ? i.name : i.id) !== d.id)
    }
    return db
}
const echoOf = (plan: any, db: any, kept: any[] = []) => ({ transaction: plan.transaction, chats: plan.chats.map((r: any) => ({ characterId: r.characterId, chat: r.chat })), settings: Object.fromEntries(Object.keys(plan.settings).map(k => [k, db[k] ?? null])),
    characters: [...plan.characters.map((c: any) => ({ chaId: c.chaId, fields: c.fields })), ...plan.newCharacters.map((c: any) => { const { chatIds: _i, chats: _c, chatPage: _p, ...fields } = c; return { chaId: c.chaId, fields: { ...fields, chaId: c.chaId } } })],
    modules: plan.modules, plugins: plan.plugins, pluginEnabled: plan.pluginEnabled, keptDeletions: kept })

/** A device = canonical repository + play-set service with a fixture native inbox + sync service with a separate protected secrets dir. */
async function device(t: any, dav: ReturnType<typeof fixtureDav>, name: string, database: any, { master = MASTER as Buffer | null, secretsInside = false } = {}) {
    const root = await mkdtemp(join(tmpdir(), `bard-sync-m4-${name}-`)); t.onTestFinished(() => rm(root, { recursive: true, force: true }))
    const dataRoot = join(root, 'data'), secrets = secretsInside ? dataRoot : join(root, 'no-backup', 'nas-sync'), native = { state: join(root, 'native', 'inbox.json'), archives: join(root, 'native', 'archives') }
    await mkdir(dataRoot); await mkdir(secrets, { recursive: true }); await mkdir(native.archives, { recursive: true }); await writeFile(native.state, '[]')
    const repository = createUserDataRepository({ dataRoot }); repository.importLegacyDatabase(database, { mode: 'sync' })
    const memory = createRuntimeMemoryService(dataRoot), storage = createFileKv({ dataRoot }), protect = androidProtector('11'.repeat(32))
    if (master) await vaultMasterStore(secrets, protect).importMaster(master)
    const inlays = new Map<string, any>()
    const io = { readInlay: async (id: string) => inlays.get(id) ?? null, installInlay: async (entry: any, staging: string) => { inlays.set(entry.id, { metadata: entry.metadata, data: await readFile(join(staging, entry.file)) }) }, removeInlay: async (id: string) => { inlays.delete(id) } }
    let sync: any
    const transfers = createPlaySetService({ dataRoot, readDatabase: async () => repository.exportLegacyDatabase(), memory, storage, ...io, nativeInbox: native,
        foreignArchive: { detect: (f: string) => sync.detectShare(f), receive: (f: string, meta: any) => sync.receiveForeign(f, meta), consumed: (id: string) => sync.consumed(id) } })
    const make = (hooks: any = {}) => sync = createNasSyncService({ dataRoot, identityDir: secretsInside ? null : secrets, secretsDir: secretsInside ? null : secrets, transfers, readDatabase: async () => repository.exportLegacyDatabase(), memory, storage, secrets: dav.secrets, fetch: dav.fetch, protect, now, ...io, inlayMeta: async () => null, hooks })
    make()
    /** The native transport: the sender's staged export lands in the receiver's inbox with the provenance the transport writes. */
    const deliverTo = async (target: any, sendId: string, trustedDevice: string | null) => {
        const file = join(dataRoot, 'play-transfer', sendId, 'export.risuplay'), bytes = await readFile(file), handle = randomUUID(), id = randomUUID()
        await copyFile(file, join(target.native.archives, handle + '.risuplay'))
        const inbox = JSON.parse(await readFile(target.native.state, 'utf8')); inbox.push({ id, fileHandle: handle, hash: sha(bytes), trustedDevice, receivedAt: now(), state: 'received', accepted: false }); await writeFile(target.native.state, JSON.stringify(inbox))
        return { id, handle, file: join(target.native.archives, handle + '.risuplay') }
    }
    // Generated sync/native/export/protected artifacts only: the canonical repository's own secrets store (data/secrets) legitimately holds the source credentials.
    return { root, dataRoot, secrets, native, repository, transfers, protect, get service() { return sync }, make, deliverTo, save: (db: any) => repository.importLegacyDatabase(db, { mode: 'sync' }), db: () => repository.exportLegacyDatabase(), roots: () => [join(dataRoot, 'nas-sync'), join(dataRoot, 'play-transfer'), join(dataRoot, 'risubard'), join(root, 'native'), secrets] }
}
const EMPTY = () => ({ language: 'ko', botPresets: [], modules: [], personas: [], loreBook: [], plugins: [], characters: [] })
const TABLET = () => ({ ...EMPTY(), language: 'en', aiModel: 'gpt', openAIKey: S('openai'), characters: [{ chaId: 'card', type: 'character', name: '표본', chatPage: 0, chats: [{ id: 'chat', name: '현재', note: '', localLore: [], message: [{ role: 'char', data: '본문' }] }] }] })
const applyAll = async (dev: any, kept: any[] = []) => { await dev.service.pull(); const plan = await dev.service.plan(); if (plan.empty) return plan; const db = dev.db(); await dev.service.arm(plan.transaction, echoOf(plan, applyPlanToDb(structuredClone(db), plan), kept)); dev.save(applyPlanToDb(db, plan)); expect((await dev.service.finish(plan.transaction, true)).state).toBe('applied'); return plan }

test('key sharing: request over the trusted inbox → sealed grant → install; nothing secret in any queue or export; grants bind workspace, recipient key and epoch; untrusted or generic routes never deliver a key', async t => {
    const dav = fixtureDav()
    const tablet = await device(t, dav, 'tablet', TABLET()); tablet.service.enable({ workspaceId: 'ws', role: 'authority' })
    expect((await tablet.service.snapshot()).committed).toMatchObject({ sequence: 1 }); expect((await tablet.service.publish()).failed).toEqual([])
    const phone = await device(t, dav, 'phone', EMPTY(), { master: null }) // joining device: no vault key yet
    phone.service.enable({ workspaceId: 'ws', role: 'joining' })
    expect(phone.service.status()).toMatchObject({ enabled: true, role: 'joining', vault: { origin: null } })
    // 1. The joining device stages a request (its public key); the request file holds no secret.
    const request = await phone.service.shareRequest(); expect(request.kind).toBe('request')
    const requestFile = join(phone.dataRoot, 'play-transfer', request.id, 'export.risuplay')
    const parsed = await readShareArchive(requestFile); expect(parsed.kind).toBe('request'); expect(parsed.manifest.workspaceId).toBe('ws')
    // The request as a play set is refused by the generic incoming route (it is not one) and by the native path without provenance.
    const { createReadStream } = await import('node:fs')
    await expect(tablet.transfers.ingest(createReadStream(requestFile), { name: 'x.risuplay' })).rejects.toThrow()
    const untrusted = await phone.deliverTo(tablet, request.id, null)
    expect(await tablet.transfers.importNative(untrusted.id)).toMatchObject({ share: true, state: 'failed', error: expect.stringContaining('신뢰된 기기') }); expect(existsSync(untrusted.file)).toBe(false)
    expect(tablet.service.status().shares).toEqual([]) // no grant staged for an unproven source
    // 2. Delivered by a registered device: the authority stages a grant sealed to that key, and only that key.
    const trusted = await phone.deliverTo(tablet, request.id, 'registered-phone-id')
    const handled = await tablet.transfers.importNative(trusted.id)
    expect(handled).toMatchObject({ share: true, state: 'applied', kind: 'request', from: phone.service.store().identity().deviceId, replyTo: 'registered-phone-id' })
    expect(await tablet.transfers.importNative(trusted.id)).toEqual(handled) // idempotent, file gone
    const grant = tablet.service.status().shares.find((s: any) => s.kind === 'grant'); expect(grant.to).toBe(phone.service.store().identity().deviceId)
    await assertNoKeyMaterial([...tablet.roots(), ...phone.roots()])
    // A third device cannot open the grant (wrong recipient), a device bound to another workspace refuses it.
    const stranger = await device(t, dav, 'stranger', EMPTY(), { master: null }); stranger.service.enable({ workspaceId: 'ws', role: 'joining' })
    const misdelivered = await tablet.deliverTo(stranger, grant.id, 'registered-tablet-id')
    expect(await stranger.transfers.importNative(misdelivered.id)).toMatchObject({ state: 'failed', error: expect.stringContaining('이 기기용') })
    expect(await vaultMasterStore(stranger.secrets, stranger.protect).peek()).toBeNull()
    // 3. The intended device installs the key from the grant: vault epoch matches the authority's and the shared secrets open.
    const delivered = await tablet.deliverTo(phone, grant.id, 'registered-tablet-id')
    expect(await phone.transfers.importNative(delivered.id)).toMatchObject({ state: 'applied', kind: 'grant' })
    expect(existsSync(delivered.file)).toBe(false); expect(phone.service.status().vault).toMatchObject({ origin: 'shared', sharedFrom: tablet.service.store().identity().deviceId }) // the trusted grant sender = bootstrap authority
    expect((await phone.service.vault()).epoch).toBe((await tablet.service.vault()).epoch)
    const plan = await (async () => { await phone.service.pull(); return phone.service.plan() })()
    expect(plan.settings.openAIKey).toBe(S('openai')); expect(plan.pending.filter((p: any) => p.reason === 'vault')).toEqual([])
    await assertNoKeyMaterial([...tablet.roots(), ...phone.roots(), ...stranger.roots()])
    // Terminal share outcomes are visible in the transfer-queue shape for the native status path (sender polls see delivered/applied), never as play-set apply entries.
    expect(tablet.service.consumedAll()).toEqual(expect.arrayContaining([expect.objectContaining({ nativeId: trusted.id, share: true, kind: 'request', state: 'applied', direction: 'receive' }), expect.objectContaining({ nativeId: untrusted.id, state: 'failed' })]))
    expect(phone.service.consumedAll()).toEqual([expect.objectContaining({ nativeId: delivered.id, share: true, kind: 'grant', state: 'applied' })])
    // 4. Housekeeping: the authority drops its staged grant; the key never existed as a file anywhere.
    await tablet.service.discardShare({ id: grant.id }); expect(tablet.service.status().shares.filter((s: any) => s.kind === 'grant')).toEqual([])
    expect(existsSync(join(tablet.dataRoot, 'play-transfer', grant.id))).toBe(false)
})

test('key sharing: a grant that landed before a crash is installed by the startup sweep; a used different key is never replaced without confirmation and keeps a recovery copy; a damaged or foreign-epoch grant is refused', async t => {
    const dav = fixtureDav()
    const tablet = await device(t, dav, 'tablet', TABLET()); tablet.service.enable({ workspaceId: 'ws', role: 'authority' }); await tablet.service.snapshot(); await tablet.service.publish()
    // Phone A: fresh install, grant arrives in the native inbox, app stops before the inbox poll imported it; the next start installs it.
    const a = await device(t, dav, 'phone-a', EMPTY(), { master: null }); a.service.enable({ workspaceId: 'ws', role: 'joining' })
    const req = await a.service.shareRequest(); const reqIn = await a.deliverTo(tablet, req.id, 'registered-a'); await tablet.transfers.importNative(reqIn.id)
    const grant = tablet.service.status().shares.find((s: any) => s.kind === 'grant' && s.to === a.service.store().identity().deviceId)
    const landed = await tablet.deliverTo(a, grant.id, 'registered-tablet')
    const reopened = a.make(); expect(await reopened.recovery()).toEqual([]) // startup: sweep runs first
    expect(reopened.consumed(landed.id)).toMatchObject({ state: 'applied', kind: 'grant' }); expect(existsSync(landed.file)).toBe(false)
    expect((await reopened.vault()).epoch).toBe((await tablet.service.vault()).epoch)
    // Phone B: has its own key and already published with it — a grant for a different key waits for an explicit decision.
    const b = await device(t, dav, 'phone-b', { ...EMPTY(), openAIKey: 'b-own-key' }, { master: OTHER }); b.service.enable({ workspaceId: 'ws', role: 'joining' })
    expect((await b.service.snapshot()).committed).toMatchObject({ sequence: 1 }); expect((await b.service.publish()).failed).toEqual([])
    const reqB = await b.service.shareRequest(); const reqBIn = await b.deliverTo(tablet, reqB.id, 'registered-b'); await tablet.transfers.importNative(reqBIn.id)
    const grantB = tablet.service.status().shares.find((s: any) => s.kind === 'grant' && s.to === b.service.store().identity().deviceId)
    const landedB = await tablet.deliverTo(b, grantB.id, 'registered-tablet')
    expect(await b.transfers.importNative(landedB.id)).toMatchObject({ state: 'waiting', code: 'KEY_CONFLICT' })
    expect(existsSync(landedB.file)).toBe(true); expect(b.service.status().vault.pendingGrant).toMatchObject({ reason: 'key-conflict' })
    expect(await vaultMasterStore(b.secrets, b.protect).peek()).toEqual(OTHER) // untouched
    await expect(b.service.acceptPendingGrant({})).rejects.toThrow(/confirmation/)
    expect(await b.service.acceptPendingGrant({ replace: true })).toMatchObject({ state: 'applied', kind: 'grant' })
    expect(await vaultMasterStore(b.secrets, b.protect).peek()).toEqual(MASTER)
    expect((await readdir(b.secrets)).some(f => f.startsWith('sync-vault-master.recovery-'))).toBe(true) // the previous key is kept
    expect(b.service.status().vault).toMatchObject({ origin: 'shared', pendingGrant: null }); expect(existsSync(landedB.file)).toBe(false)
    // Damaged grant and a grant sealed under another vault (epoch mismatch) are refused; the inbox copy is removed.
    const c = await device(t, dav, 'phone-c', EMPTY(), { master: null }); c.service.enable({ workspaceId: 'ws', role: 'joining' })
    const kc = await deviceKeyStore(c.secrets, c.protect).load(), forged = join(c.root, 'forged.risuplay')
    await writeGrantArchive(forged, { workspaceId: 'ws', epoch: 'f'.repeat(32), device: 'rogue', recipient: c.service.store().identity().deviceId, recipientKeyId: kc.keyId, recipientPublicRaw: kc.publicRaw, master: OTHER })
    const fake = { ...await c.deliverTo(c, 'none', 'registered-x').catch(() => null) }
    const handle = randomUUID(), fid = randomUUID(); await copyFile(forged, join(c.native.archives, handle + '.risuplay'))
    await writeFile(c.native.state, JSON.stringify([{ id: fid, fileHandle: handle, hash: sha(await readFile(forged)), trustedDevice: 'registered-x', state: 'received', accepted: false }]))
    expect(await c.transfers.importNative(fid)).toMatchObject({ state: 'failed', error: expect.stringContaining('세대') }); expect(existsSync(join(c.native.archives, handle + '.risuplay'))).toBe(false)
    expect(await vaultMasterStore(c.secrets, c.protect).peek()).toBeNull()
    void fake
    await assertNoKeyMaterial([...tablet.roots(), ...a.roots(), ...b.roots(), ...c.roots()])
})

test('no-backup placement: identity, vault master and device key live outside the data root; a copied data root is a new incarnation and finds no key', async t => {
    const dav = fixtureDav(), tablet = await device(t, dav, 'tablet', TABLET())
    tablet.service.enable({ workspaceId: 'ws', role: 'authority' }); expect((await tablet.service.snapshot()).committed).toMatchObject({ sequence: 1 })
    const files = (await walk(tablet.dataRoot)).map(f => f.slice(tablet.dataRoot.length))
    expect(files.some(f => f.endsWith('identity.json') || f.endsWith('sync-vault-master.dat') || f.endsWith('sync-device-key.dat'))).toBe(false)
    expect((await readdir(tablet.secrets)).sort()).toEqual(expect.arrayContaining(['identity.json', 'sync-vault-master.dat']))
    // A copy of the data root alone (what a file-level backup or clone carries) starts as a restored copy: new incarnation, no vault key.
    const copyRoot = await mkdtemp(join(tmpdir(), 'bard-sync-m4-copy-')); t.onTestFinished(() => rm(copyRoot, { recursive: true, force: true }))
    await cp(tablet.dataRoot, join(copyRoot, 'data'), { recursive: true }); await mkdir(join(copyRoot, 'secrets'))
    const copyRepo = createUserDataRepository({ dataRoot: join(copyRoot, 'data') })
    const copy = createNasSyncService({ dataRoot: join(copyRoot, 'data'), identityDir: join(copyRoot, 'secrets'), secretsDir: join(copyRoot, 'secrets'), readDatabase: async () => copyRepo.exportLegacyDatabase(), memory: createRuntimeMemoryService(join(copyRoot, 'data')), storage: createFileKv({ dataRoot: join(copyRoot, 'data') }), secrets: dav.secrets, fetch: dav.fetch, protect: tablet.protect, now })
    expect(copy.store().identity().incarnationId).not.toBe(tablet.service.store().identity().incarnationId)
    expect(/sidecar/.test(copy.store().state().rotations.at(-1)?.reason ?? '')).toBe(true)
    expect(await vaultMasterStore(join(copyRoot, 'secrets'), tablet.protect).peek()).toBeNull()
})

test('conflicts are listed with every observed head and resolved by an explicit choice that the plan then materializes; trash restores its cohort through the same pipeline', async t => {
    const dav = fixtureDav(), tablet = await device(t, dav, 'tablet', TABLET()); tablet.service.enable({ workspaceId: 'ws', role: 'authority' }); await tablet.service.snapshot(); await tablet.service.publish()
    const phone = await device(t, dav, 'phone', { ...EMPTY(), aiModel: 'phone-model', language: 'ja' }); phone.service.enable({ workspaceId: 'ws', role: 'joining' })
    expect((await phone.service.snapshot()).committed).toMatchObject({ sequence: 1 }); await phone.service.pull()
    const diverged = await phone.service.plan(); expect(diverged.pending.map((p: any) => p.reason)).toContain('diverged'); expect((await phone.service.finish(diverged.transaction, false)).state).toBe('rolled-back')
    const conflicts = await phone.service.conflicts(); expect(conflicts.length).toBeGreaterThan(0)
    const provider = conflicts.find((c: any) => c.variants.some((v: any) => v.content.aiModel === 'gpt'))
    expect(provider.state).toBe('diverged'); expect(provider.variants).toHaveLength(2); expect(JSON.stringify(provider)).not.toContain('SENTINEL') // public form only
    const keep = provider.variants.find((v: any) => v.content.aiModel === 'gpt').heads[0]
    expect(await phone.service.resolveConflict({ root: provider.root, keep })).toMatchObject({ root: provider.root })
    expect(phone.service.status().localApply).toBeGreaterThan(0)
    const plan = await phone.service.plan(); expect(plan.settings.aiModel).toBe('gpt'); expect(plan.pending.filter((p: any) => p.root === provider.root)).toEqual([])
    const db = phone.db(); await phone.service.arm(plan.transaction, echoOf(plan, applyPlanToDb(structuredClone(db), plan))); phone.save(applyPlanToDb(db, plan))
    expect((await phone.service.finish(plan.transaction, true)).state).toBe('applied'); expect(phone.db().aiModel).toBe('gpt')
    expect(phone.service.status().localApply).toBe(0); expect((await phone.service.conflicts()).filter((c: any) => c.root === provider.root)).toEqual([])
    // Trash: the tablet deletes its chat; restoring the cohort brings the chat back through plan → save → finish.
    const tdb = tablet.db(); tdb.characters[0].chats = []; tablet.save(tdb)
    expect((await tablet.service.snapshot()).committed).toMatchObject({ tombstones: 1 })
    const trash = await tablet.service.trashList(); expect(trash).toEqual([expect.objectContaining({ root: 'chat', type: 'chat', expired: false })])
    expect(await tablet.service.restoreTrash({ id: trash[0].id })).toMatchObject({ restored: [{ root: 'chat', type: 'chat', revision: expect.any(String) }] })
    const back = await tablet.service.plan(); expect(back.chats).toEqual([expect.objectContaining({ update: false })]); expect(back.chats[0].chat.id).toBe('chat'); expect(back.chats[0].chat.message[0].data).toBe('본문')
    const db2 = tablet.db(); await tablet.service.arm(back.transaction, echoOf(back, applyPlanToDb(structuredClone(db2), back))); tablet.save(applyPlanToDb(db2, back))
    expect((await tablet.service.finish(back.transaction, true)).state).toBe('applied'); expect(tablet.db().characters[0].chats.map((c: any) => c.id)).toEqual(['chat'])
    expect(await tablet.service.trashList()).toEqual([]); expect(tablet.service.store().graph.classify('play\nchat\nchat').state).toBe('live')
})

test('the chat kept open through a remote deletion can be restored (its lineage continues, the tombstone is parented) or the deletion accepted (lineage dropped)', async t => {
    const dav = fixtureDav(), tablet = await device(t, dav, 'tablet', TABLET()); tablet.service.enable({ workspaceId: 'ws', role: 'authority' }); await tablet.service.snapshot(); await tablet.service.publish()
    const phone = await device(t, dav, 'phone', EMPTY()); phone.service.enable({ workspaceId: 'ws', role: 'joining' }); await applyAll(phone)
    const tdb = tablet.db(); tdb.characters[0].chats = []; tablet.save(tdb); await tablet.service.snapshot(); await tablet.service.publish()
    await phone.service.pull(); const plan = await phone.service.plan()
    expect(plan.deletions).toEqual([{ kind: 'chat', characterId: 'card', id: 'chat' }])
    const kept = [{ kind: 'chat', characterId: 'card', id: 'chat' }], db = phone.db()
    await phone.service.arm(plan.transaction, echoOf(plan, applyPlanToDb(structuredClone(db), { ...plan, deletions: [] }), kept)); phone.save(db) // the open chat stays
    expect(await phone.service.finish(plan.transaction, true)).toMatchObject({ state: 'applied', keptDeletions: kept })
    expect(phone.db().characters[0].chats).toHaveLength(1); expect(phone.service.store().graph.classify('play\nchat\nchat').state).toBe('deleted')
    // Restore: the kept chat (with a local edit) is published and un-deleted; the root is live again and the lineage points at the restored head.
    const edited = phone.db(); edited.characters[0].chats[0].message.push({ role: 'user', data: '삭제 후 이어서' }); phone.save(edited)
    const restored = await phone.service.restoreOpenDeletion({ chatId: 'chat' }); expect(restored.state).toBe('live')
    expect(phone.service.store().graph.classify('play\nchat\nchat').state).toBe('live')
    expect(phone.service.store().graph.get(phone.service.state().lineage['play\nchat\nchat#chat']).content.message).toHaveLength(2)
    expect((await phone.service.snapshot()).committed).toBeNull() // already published by the restore
    expect((await phone.service.publish()).failed).toEqual([])
    await tablet.service.pull(); const tp = await tablet.service.plan(); expect(tp.chats).toEqual([expect.objectContaining({ update: false })]); expect(tp.chats[0].chat.message).toHaveLength(2)
    // Accept instead (another kept deletion): the lineage key is dropped so the local removal is not a second deletion.
    const other = await device(t, dav, 'other', EMPTY()); other.service.enable({ workspaceId: 'ws', role: 'joining' })
    expect(other.service.acceptOpenDeletion({ chatId: 'chat' })).toEqual({ accepted: 'chat' })
    expect(Object.keys(other.service.state().lineage).some(k => k.endsWith('#chat'))).toBe(false)
})

test('local materialization intent survives an ambiguous commit (durable revisions + error); a clean failure withdraws only its own root and keeps a pre-existing one; the next plan materializes what is durable', async t => {
    const dav = fixtureDav(), tablet = await device(t, dav, 'tablet', TABLET()); tablet.service.enable({ workspaceId: 'ws', role: 'authority' })
    let tdb = tablet.db(); tdb.characters[0].chats.push({ id: 'chat2', name: '둘째', note: '', localLore: [], message: [{ role: 'char', data: '둘째' }] }); tablet.save(tdb); await tablet.service.snapshot()
    tdb = tablet.db(); tdb.characters[0].chats = tdb.characters[0].chats.filter((c: any) => c.id !== 'chat'); tablet.save(tdb); await tablet.service.snapshot() // operation 1
    tdb = tablet.db(); tdb.characters[0].chats = []; tablet.save(tdb); await tablet.service.snapshot() // operation 2
    const trash = await tablet.service.trashList(); expect(trash.map((t: any) => t.root).sort()).toEqual(['chat', 'chat2'])
    const first = trash.find((t: any) => t.root === 'chat'), second = trash.find((t: any) => t.root === 'chat2'), store = tablet.service.store(), original = store.commit
    // Ambiguous write: the commit lands durably, then the call reports an error → the intent stays.
    store.commit = (...args: any[]) => { original.apply(store, args); throw new Error('rename failed after the manifest write') }
    await expect(tablet.service.restoreTrash({ id: first.id })).rejects.toThrow('rename failed')
    expect(tablet.service.state().localApply).toEqual(['play\nchat\nchat']); expect(store.graph.classify('play\nchat\nchat').state).toBe('live')
    // Clean failure before any write → only this call's root is withdrawn; the pre-existing intent is untouched.
    store.commit = () => { throw new Error('disk full before any write') }
    await expect(tablet.service.restoreTrash({ id: second.id })).rejects.toThrow('disk full')
    expect(tablet.service.state().localApply).toEqual(['play\nchat\nchat']); expect(store.graph.classify('play\nchat\nchat2').state).toBe('deleted')
    store.commit = original
    const plan = await tablet.service.plan(); expect(plan.chats.map((r: any) => r.chat.id)).toEqual(['chat']) // the durable restore is materialized by the next plan
    const db = tablet.db(); await tablet.service.arm(plan.transaction, echoOf(plan, applyPlanToDb(structuredClone(db), plan))); tablet.save(applyPlanToDb(db, plan))
    expect((await tablet.service.finish(plan.transaction, true)).state).toBe('applied'); expect(tablet.service.state().localApply).toEqual([])
    expect(tablet.db().characters[0].chats.map((c: any) => c.id)).toEqual(['chat']); expect((await tablet.service.trashList()).map((t: any) => t.root)).toEqual(['chat2'])
})

test('an open sibling-branch chat hit by a remote deletion is restored as THIS chat with its own edited content: the unrelated live branch and an independent deletion of another branch both survive, locally and on a third device', async t => {
    const dav = fixtureDav(), tablet = await device(t, dav, 'tablet', TABLET()); tablet.service.enable({ workspaceId: 'ws', role: 'authority' }); await tablet.service.snapshot(); await tablet.service.publish()
    const phone = await device(t, dav, 'phone', EMPTY()); phone.service.enable({ workspaceId: 'ws', role: 'joining' }); await applyAll(phone)
    // Concurrent edits: phone edits locally (unpublished), tablet edits and publishes → the phone keeps its chat and gets the tablet's as a sibling.
    let pdb = phone.db(); pdb.characters[0].chats[0].message.push({ role: 'user', data: '폰 편집' }); phone.save(pdb); await phone.service.snapshot()
    let tdb = tablet.db(); tdb.characters[0].chats[0].message.push({ role: 'user', data: '태블릿 편집' }); tablet.save(tdb); await tablet.service.snapshot(); await tablet.service.publish()
    const branched = await applyAll(phone); expect(branched.chats[0].chat.id).toMatch(/^chat~/)
    const sibling = branched.chats[0].chat.id; expect(phone.service.state().branches[sibling]).toMatchObject({ root: 'chat' })
    // Add a third branch on the phone (another local edit of the sibling would merge; instead a second local chat edit creates no new branch,
    // so use the phone's own root branch as the "other" branch and delete it independently later).
    // Tablet deletes its branch (the sibling's base) and publishes; the phone has the SIBLING open and edits it after the deletion.
    tdb = tablet.db(); tdb.characters[0].chats = []; tablet.save(tdb); await tablet.service.snapshot(); await tablet.service.publish()
    await phone.service.pull(); const plan = await phone.service.plan()
    if (!plan.empty) { expect(plan.deletions.map((d: any) => d.id)).not.toContain('chat'); expect((await phone.service.finish(plan.transaction, false)).state).toBe('rolled-back') } // the phone's own branch is an unseen edit for that deletion
    pdb = phone.db(); pdb.characters[0].chats.find((c: any) => c.id === sibling).message.push({ role: 'user', data: '가지에서 이어서' }); phone.save(pdb)
    // Independent deletion of ANOTHER branch (the phone's own root chat) before the restore: its tombstone must not be consumed by the restore.
    const phoneHead = phone.service.state().lineage['play\nchat\nchat#chat']
    pdb = phone.db(); pdb.characters[0].chats = pdb.characters[0].chats.filter((c: any) => c.id !== 'chat'); phone.save(pdb)
    expect((await phone.service.snapshot()).committed).toMatchObject({ tombstones: 1 })
    const g0 = phone.service.store().graph
    const ownDeletion = (await phone.service.trashList()).find((x: any) => g0.get(x.id).tombstone.base === phoneHead); expect(ownDeletion).toBeTruthy() // the trash also lists the tablet's pulled deletion of the other branch
    expect(await phone.service.trashList()).toHaveLength(2)
    const restored = await phone.service.restoreOpenDeletion({ chatId: sibling })
    expect(restored.restored).toHaveLength(1); expect(restored.state).toBe('delete-pending') // actual state: restored live head + the unrelated deletion still a head
    const g = phone.service.store().graph, after = g.classify('play\nchat\nchat')
    const head = g.get(phone.service.state().lineage[`play\nchat\nchat#${sibling}`])
    expect(head.content.message.map((m: any) => m.data)).toEqual(['본문', '태블릿 편집', '가지에서 이어서']) // this chat's content, root identity space
    expect(after.liveHeads).toEqual([head.id]); expect(after.tombstoneHeads).toEqual([ownDeletion.id]) // the independent deletion survives
    expect(head.parents).not.toContain(ownDeletion.id)
    expect((await phone.service.trashList()).map((x: any) => x.id)).toEqual([ownDeletion.id]) // still recoverable
    // Recover the other branch from the trash: both branches are live heads again, both chats exist locally.
    await phone.service.restoreTrash({ id: ownDeletion.id })
    const back = await phone.service.plan(); expect(back.chats.map((r: any) => r.chat.id)).toEqual(['chat'])
    pdb = phone.db(); await phone.service.arm(back.transaction, echoOf(back, applyPlanToDb(structuredClone(pdb), back))); phone.save(applyPlanToDb(pdb, back)); expect((await phone.service.finish(back.transaction, true)).state).toBe('applied')
    expect(g.classify('play\nchat\nchat').liveHeads).toHaveLength(2); expect(g.classify('play\nchat\nchat').tombstoneHeads).toEqual([])
    expect(phone.db().characters[0].chats.map((c: any) => c.id).sort()).toEqual(['chat', sibling].sort())
    // Remotely as well: a third device receives BOTH branches with their own contents.
    expect((await phone.service.publish()).failed).toEqual([])
    const third = await device(t, dav, 'third', EMPTY()); third.service.enable({ workspaceId: 'ws', role: 'joining' })
    const got = await applyAll(third)
    expect(got.chats.map((r: any) => r.chat.message.map((m: any) => m.data)).sort()).toEqual([['본문', '태블릿 편집', '가지에서 이어서'], ['본문', '폰 편집']].sort())
    expect(new Set(got.chats.map((r: any) => r.chat.id)).size).toBe(2); expect(got.chats.map((r: any) => r.chat.id)).toContain('chat') // distinct local ids on a fresh recipient; the root id used once
    expect(third.db().characters[0].chats).toHaveLength(2); expect(new Set(third.db().characters[0].chats.map((c: any) => c.id)).size).toBe(2)
    // The authority's membership head says "no chats" while two live branches exist: the third device re-derives the membership once
    // (a character revision only; the chats themselves are never re-emitted) and is stable afterwards.
    const echo = await third.service.snapshot()
    if (echo.committed) { const tg = third.service.store().graph; expect(third.service.store().state().commits.at(-1).revisions.map((id: string) => tg.get(id).type)).toEqual(['character']) }
    expect((await third.service.snapshot()).committed).toBeNull()
    expect(third.service.store().graph.classify('play\nchat\nchat').liveHeads).toHaveLength(2)
})

test('a delayed grant after the user disabled sync installs the key safely but leaves sync disabled; outcomes are recorded before the archive is removed so a replay never sees ENOENT', async t => {
    const dav = fixtureDav(), tablet = await device(t, dav, 'tablet', TABLET()); tablet.service.enable({ workspaceId: 'ws', role: 'authority' }); await tablet.service.snapshot(); await tablet.service.publish()
    const phone = await device(t, dav, 'phone', EMPTY(), { master: null }); phone.service.enable({ workspaceId: 'ws', role: 'joining' })
    const req = await phone.service.shareRequest(); const reqIn = await phone.deliverTo(tablet, req.id, 'registered-phone'); const handled = await tablet.transfers.importNative(reqIn.id)
    phone.service.disable(); expect(phone.service.status()).toMatchObject({ enabled: false, role: 'joining' })
    const grant = tablet.service.status().shares.find((s: any) => s.kind === 'grant'); const landed = await tablet.deliverTo(phone, grant.id, 'registered-tablet')
    expect(await phone.transfers.importNative(landed.id)).toMatchObject({ state: 'applied', kind: 'grant', enabled: false })
    expect(phone.service.status()).toMatchObject({ enabled: false, role: 'joining', vault: { origin: 'shared' } }) // key kept safe, nothing restarted
    expect((await phone.service.vault()).epoch).toBe((await tablet.service.vault()).epoch)
    // Replay of both consumed native ids after the archives are gone answers from the durable records.
    expect(existsSync(landed.file)).toBe(false); expect(existsSync(reqIn.file)).toBe(false)
    expect(await phone.transfers.importNative(landed.id)).toMatchObject({ state: 'applied', kind: 'grant' })
    expect(await tablet.transfers.importNative(reqIn.id)).toEqual(handled)
    // Re-enabling is the user's explicit act; the coordinator never did it.
    phone.service.enable({ workspaceId: 'ws' }); expect(phone.service.status()).toMatchObject({ enabled: true, role: 'joining' })
})

test('a lost protected master is never replaced silently: a shared-origin manifest without its key, or any device with history, fails closed until a trusted re-share; a fresh device still gets its first key', async t => {
    const dav = fixtureDav(), tablet = await device(t, dav, 'tablet', TABLET()); tablet.service.enable({ workspaceId: 'ws', role: 'authority' }); await tablet.service.snapshot(); await tablet.service.publish()
    expect(tablet.service.status().vault).toMatchObject({ missing: false }) // the fixture installed the key directly (origin null); a self-generated one reports 'generated'
    const phone = await device(t, dav, 'phone', EMPTY(), { master: null }); phone.service.enable({ workspaceId: 'ws', role: 'joining' })
    const req = await phone.service.shareRequest(); const reqIn = await phone.deliverTo(tablet, req.id, 'registered-phone'); await tablet.transfers.importNative(reqIn.id)
    const grant = tablet.service.status().shares.find((s: any) => s.kind === 'grant'); const landed = await tablet.deliverTo(phone, grant.id, 'registered-tablet')
    expect(await phone.transfers.importNative(landed.id)).toMatchObject({ state: 'applied' }); await applyAll(phone)
    // The protected no-backup store is wiped (or this data root was cloned without it) while the manifest still says the key was shared.
    for (const f of await readdir(phone.secrets)) if (f !== 'identity.json') await rm(join(phone.secrets, f), { force: true })
    const reopened = phone.make()
    expect(reopened.status().vault).toMatchObject({ origin: 'shared', missing: true })
    const db = phone.db(); db.language = 'fr'; phone.save(db)
    await expect(reopened.snapshot()).rejects.toMatchObject({ code: 'VAULT_MISSING' }) // nothing sealed under a new random key
    expect(reopened.store().state().commits.filter((c: any) => !c.published)).toEqual([])
    await expect(reopened.plan()).rejects.toMatchObject({ code: 'VAULT_MISSING' })
    expect(await vaultMasterStore(phone.secrets, phone.protect).peek()).toBeNull() // still no key: not generated behind the user's back
    // A trusted re-share restores the exact same key; everything resumes.
    const req2 = await reopened.shareRequest(); const reqIn2 = await phone.deliverTo(tablet, req2.id, 'registered-phone'); await tablet.transfers.importNative(reqIn2.id)
    const grant2 = tablet.service.status().shares.filter((s: any) => s.kind === 'grant').at(-1); const landed2 = await tablet.deliverTo(phone, grant2.id, 'registered-tablet')
    expect(await phone.transfers.importNative(landed2.id)).toMatchObject({ state: 'applied', kind: 'grant' })
    expect(reopened.status().vault).toMatchObject({ origin: 'shared', missing: false }); expect((await reopened.vault()).epoch).toBe((await tablet.service.vault()).epoch)
    expect((await reopened.snapshot()).committed).toMatchObject({ revisions: expect.any(Number) })
    // An authority that loses its key after publishing history fails closed as well (no silent new key that would orphan every envelope).
    for (const f of await readdir(tablet.secrets)) if (f !== 'identity.json') await rm(join(tablet.secrets, f), { force: true })
    const tabletAgain = tablet.make(); expect(tabletAgain.status().vault.missing).toBe(true)
    await expect(tabletAgain.snapshot()).rejects.toMatchObject({ code: 'VAULT_MISSING' })
    // ...and a trusted request reaching that lost-key authority produces no fresh key and no grant: it waits, unconsumed, until the key is back.
    const req3 = await reopened.shareRequest(); const reqIn3 = await phone.deliverTo(tablet, req3.id, 'registered-phone')
    expect(await tablet.transfers.importNative(reqIn3.id)).toMatchObject({ state: 'waiting', code: 'VAULT_MISSING' })
    expect(await vaultMasterStore(tablet.secrets, tablet.protect).peek()).toBeNull(); expect(tabletAgain.status().shares.filter((s: any) => s.kind === 'grant' && s.at > grant2.at)).toEqual([])
    expect(existsSync(reqIn3.file)).toBe(true); expect(tabletAgain.consumed(reqIn3.id)).toBeNull()
})

test('a device that received the shared key can answer a request (lost-key recovery from any holder); a device without the key never grants one; conflict variants carry their source', async t => {
    const dav = fixtureDav(), tablet = await device(t, dav, 'tablet', TABLET()); tablet.service.enable({ workspaceId: 'ws', role: 'authority' }); await tablet.service.snapshot(); await tablet.service.publish()
    const phone = await device(t, dav, 'phone', EMPTY(), { master: null }); phone.service.enable({ workspaceId: 'ws', role: 'joining' })
    const req = await phone.service.shareRequest(); const reqIn = await phone.deliverTo(tablet, req.id, 'registered-phone'); await tablet.transfers.importNative(reqIn.id)
    const grant = tablet.service.status().shares.find((s: any) => s.kind === 'grant'); const landed = await tablet.deliverTo(phone, grant.id, 'registered-tablet'); await phone.transfers.importNative(landed.id)
    // A third device asks the PHONE (a holder, not the authority): it answers with a grant sealed for the third device.
    const laptop = await device(t, dav, 'laptop', EMPTY(), { master: null }); laptop.service.enable({ workspaceId: 'ws', role: 'joining' })
    const req2 = await laptop.service.shareRequest(); const reqIn2 = await laptop.deliverTo(phone, req2.id, 'registered-laptop')
    expect(await phone.transfers.importNative(reqIn2.id)).toMatchObject({ state: 'applied', kind: 'request' })
    const grant2 = phone.service.status().shares.find((s: any) => s.kind === 'grant'); const landed2 = await phone.deliverTo(laptop, grant2.id, 'registered-phone')
    expect(await laptop.transfers.importNative(landed2.id)).toMatchObject({ state: 'applied', kind: 'grant' })
    expect((await laptop.service.vault()).epoch).toBe((await tablet.service.vault()).epoch); expect(laptop.service.status().vault.sharedFrom).toBe(phone.service.store().identity().deviceId)
    // A joining device WITHOUT the key refuses to grant (it has nothing to share), and the request is not consumed as a grant.
    const empty = await device(t, dav, 'empty', EMPTY(), { master: null }); empty.service.enable({ workspaceId: 'ws', role: 'joining' })
    const req3 = await laptop.service.shareRequest(); const reqIn3 = await laptop.deliverTo(empty, req3.id, 'registered-laptop')
    expect(await empty.transfers.importNative(reqIn3.id)).toMatchObject({ state: 'failed', error: expect.stringContaining('공유할 동기화 키가 없어요') }); expect(empty.service.status().shares).toEqual([])
    // Conflict variants name their source (this device vs the peer that published the head).
    const pc = await device(t, dav, 'pc', { ...EMPTY(), aiModel: 'pc-model' }); pc.service.enable({ workspaceId: 'ws', role: 'joining' }); await pc.service.snapshot(); await pc.service.pull()
    const diverged = await pc.service.plan(); expect(diverged.pending.map((p: any) => p.reason)).toContain('diverged'); await pc.service.finish(diverged.transaction, false)
    const conflict = (await pc.service.conflicts()).find((c: any) => c.variants.some((v: any) => v.content.aiModel === 'gpt'))
    expect(conflict.variants.find((v: any) => v.content.aiModel === 'gpt').source).toEqual({ device: tablet.service.store().identity().deviceId, self: false })
    expect(conflict.variants.find((v: any) => v.content.aiModel === 'pc-model').source).toEqual({ device: pc.service.store().identity().deviceId, self: true })
    expect(JSON.stringify(conflict)).not.toContain('SENTINEL')
})

test('disabled status still reports the saved workspace and role so a reopened panel resumes them; re-enabling with them keeps the identity (Codex 31)', async t => {
    const dav = fixtureDav(), phone = await device(t, dav, 'phone', EMPTY()); phone.service.enable({ workspaceId: 'family-nas', role: 'joining' })
    phone.service.disable()
    expect(phone.service.status()).toMatchObject({ enabled: false, role: 'joining', workspaceId: 'family-nas' })
    const reopened = phone.make(); expect(reopened.status()).toMatchObject({ enabled: false, role: 'joining', workspaceId: 'family-nas' }) // across a restart, without opening the store
    expect(() => reopened.enable({ workspaceId: 'risubard', role: 'authority' })).toThrow(/Workspace already bound/) // the defaults would not resume this device
    expect(reopened.enable({ workspaceId: 'family-nas', role: 'joining' })).toMatchObject({ enabled: true, role: 'joining', workspaceId: 'family-nas' })
})
