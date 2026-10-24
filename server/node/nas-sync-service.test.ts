import { test, expect } from 'vitest'
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { fixtureDav } from './nas-sync-dav-fixture'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'
import { createMemorySaveSlot, memorySaveWorkspaceId } from './risubard-memory-save'
import { encodeMemorySaveChat, decodeMemorySaveChat } from '../../src/ts/risubard/memorySaveCodec'
const { createNasSyncService } = require('./nas-sync-service.cjs')
const { createUserDataRepository } = require('./user-data-repository.cjs')
const { createRuntimeMemoryService } = require('./risubard-memory-runtime.cjs')
const { createFileKv } = require('./file-kv.cjs')
const { androidProtector } = require('./transfer-secrets.cjs')
const { vaultMasterStore } = require('./nas-sync-vault.cjs')

const S = (n: string) => `SENTINEL-${n}-never-leaves-vault`
const settle = async (d: any) => {
    const plan = await d.service.plan(); if (plan.empty) return plan;
    const db = applyPlanToDb(d.db(), plan);
    await d.service.arm(plan.transaction, echoOf(plan, db)); d.save(db);
    await d.service.finish(plan.transaction, true); return plan;
}
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const MASTER = Buffer.from('ab'.repeat(32), 'hex'), OTHER_MASTER = Buffer.from('cd'.repeat(32), 'hex')
let clock = 7_000_000; const now = () => clock

async function walk(dir: string): Promise<string[]> { if (!existsSync(dir)) return []; const out: string[] = []; for (const e of await readdir(dir, { withFileTypes: true })) { const p = join(dir, e.name); if (e.isDirectory()) out.push(...await walk(p)); else out.push(p) } return out }
/** Every file produced by sync on this device (journals, recovery copies, blobs, manifests, sidecars, .bak) must be free of credential sentinels. */
async function assertNoSentinel(dataRoot: string) {
    const files = await walk(join(dataRoot, 'nas-sync'))
    expect(files.length).toBeGreaterThan(5)
    const offenders: string[] = []
    for (const f of files) if ((await readFile(f)).toString('latin1').includes('SENTINEL')) offenders.push(f.slice(dataRoot.length))
    expect(offenders).toEqual([])
}
/** Minimal stand-in for the client's canonical save: mutate the exported DB like nasSync.ts and write it back through the repository. */
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
        else if (d.kind === 'character') { db.characters = db.characters.filter((c: any) => c.chaId !== d.id) }
        else { db[d.kind + 's'] = (db[d.kind + 's'] ?? []).filter((i: any) => (d.kind === 'plugin' ? i.name : i.id) !== d.id) }
    }
    return db
}
const echoOf = (plan: any, db: any) => ({ transaction: plan.transaction, chats: plan.chats.map((r: any) => ({ characterId: r.characterId, chat: r.chat })), settings: Object.fromEntries(Object.keys(plan.settings).map(k => [k, db[k] ?? null])),
    characters: [...plan.characters.map((c: any) => ({ chaId: c.chaId, fields: c.fields })), ...plan.newCharacters.map((c: any) => { const { chatIds: _i, chats: _c, chatPage: _p, ...fields } = c; return { chaId: c.chaId, fields: { ...fields, chaId: c.chaId } } })],
    modules: plan.modules, plugins: plan.plugins, pluginEnabled: plan.pluginEnabled })

async function device(t: any, dav: ReturnType<typeof fixtureDav>, name: string, database: any, master = MASTER, extra: any = {}) {
    const root = await mkdtemp(join(tmpdir(), `bard-sync-svc-${name}-`)); t.onTestFinished(() => rm(root, { recursive: true, force: true }))
    const dataRoot = join(root, 'data'); await mkdir(dataRoot)
    const repository = createUserDataRepository({ dataRoot }); repository.importLegacyDatabase(database, { mode: 'sync' })
    const memory = createRuntimeMemoryService(dataRoot), storage = createFileKv({ dataRoot })
    const protect = androidProtector('11'.repeat(32)); await vaultMasterStore(dataRoot, protect).importMaster(master)
    const inlays = new Map<string, { metadata: any; data: Buffer | string }>()
    const make = (hooks: any = {}) => createNasSyncService({ dataRoot, readDatabase: async () => repository.exportLegacyDatabase(), memory, storage, secrets: dav.secrets, fetch: dav.fetch, protect, now,
        readInlay: async (id: string) => inlays.get(id) ?? null,
        installInlay: async (entry: any, staging: string) => { if (inlays.has(entry.id)) throw Object.assign(new Error('EEXIST inlay'), { code: 'EEXIST' }); inlays.set(entry.id, { metadata: entry.metadata, data: await readFile(join(staging, entry.file)) }); if (entry.ownership) storage.kvSet('inlay_meta/' + entry.id, Buffer.from(JSON.stringify(entry.ownership))) },
        inlayMeta: async (id: string) => { const raw = storage.kvGet('inlay_meta/' + id); return raw ? JSON.parse(Buffer.from(raw).toString('utf8')) : null },
        removeInlay: async (id: string) => { inlays.delete(id); storage.kvDel('inlay_meta/' + id) }, hooks, ...extra })
    const service = make()
    const save = (db: any) => repository.importLegacyDatabase(db, { mode: 'sync' })
    return { root, dataRoot, repository, memory, storage, inlays, service, make, save, db: () => repository.exportLegacyDatabase() }
}
const baseDb = (extra: any = {}) => ({ language: 'ko', botPresets: [{ id: 'p1', name: '프리셋', openAIKey: S('preset') }], botPresetsId: 0, modules: [{ id: 'mod', name: '모듈', lorebook: [] }], personas: [{ id: 'me', name: '나' }], loreBook: [],
    plugins: [{ name: 'plug', script: '', arguments: {}, realArg: { api_key: S('plugin') }, enabled: true, customLink: [], argMeta: {} }], enabledModules: ['mod'],
    openAIKey: S('openai'), forceReplaceUrl: 'https://proxy.example/v1', proxyKey: S('proxy'), aiModel: 'gpt', textAreaSize: 11, account: { token: S('account'), id: 'me', data: {} },
    characters: [{ chaId: 'card', type: 'character', name: '표본', image: 'assets/icon.png', chatPage: 0, oaiTTSConfig: { apiKey: S('tts'), baseURL: 'https://tts.example' },
        chats: [{ id: 'chat', name: '현재', note: '', localLore: [], scriptstate: { day: 7 }, message: [{ role: 'char', data: '본문 {{inlay::draw1}}', promptInfo: { promptText: 'private request' } }] }] }], ...extra })

async function seedTablet(t: any, dav: ReturnType<typeof fixtureDav>) {
    const tablet = await device(t, dav, 'tablet', baseDb())
    tablet.storage.kvSet('assets/icon.png', Buffer.from('icon-bytes'))
    tablet.inlays.set('draw1', { metadata: { type: 'image', ext: 'png', name: '그림' }, data: Buffer.from('inlay-draw1-bytes') })
    tablet.storage.kvSet('inlay_meta/draw1', Buffer.from(JSON.stringify({ createdAt: 100, updatedAt: 200, charId: 'card', chatId: 'chat' })))
    await tablet.memory.saveMarkdownWikiTurn({ characterId: 'card', chatId: 'chat', sourceMessageIds: ['m1'], markdown: '## 사건\n\n슬롯 밖 위키' })
    const slotChat = { id: 'chat', name: '슬롯', note: '', localLore: [], scriptstate: { day: 3 }, message: [{ role: 'char', data: '슬롯 전용 {{inlay::slot-only}}' }] }
    tablet.inlays.set('slot-only', { metadata: { type: 'image', ext: 'png' }, data: Buffer.from('slot-only-bytes') })
    await createMemorySaveSlot({ userDataDirectory: tablet.dataRoot, characterId: 'card', sourceChatId: 'chat', saveId: 'slot', sourceChatName: '슬롯', turnCount: 1, chatBytes: encodeMemorySaveChat(slotChat as any) })
    tablet.service.enable({ workspaceId: 'ws-fixture' })
    const snap = await tablet.service.snapshot(); expect(snap.committed).toMatchObject({ sequence: 1 })
    const pub = await tablet.service.publish(); expect(pub.failed).toEqual([])
    return tablet
}

test('overview lists local and remote-only materials with NAS dates, and keeps older NAS dates when local edits are unpublished', async t => {
    const dav = fixtureDav(), tablet = await seedTablet(t, dav)
    const own = await tablet.service.overview()
    expect(own.items.find((i: any) => i.type === 'chat')).toMatchObject({ title: '표본 · 현재', nasTimeKind: 'uploaded', nasAt: clock })
    const phone = await device(t, dav, 'date-phone', { characters: [], personas: [], modules: [], plugins: [], botPresets: [] })
    phone.service.enable({ workspaceId: 'ws-fixture' }); await phone.service.pull()
    const before = await phone.service.overview()
    expect(before.chats).toEqual([])
    expect(before.items.find((i: any) => i.type === 'chat')).toMatchObject({ title: '표본 · 현재', nasAt: null })
    expect(before.items.some((i: any) => i.type === 'module' && i.title === '모듈')).toBe(true)
    expect(before.items.some((i: any) => i.id === 'personas')).toBe(true)
    const at = Date.parse('2026-10-22T16:05:00Z')
    for (const path of dav.files.keys()) if (path.includes('/commits/')) dav.modifiedAt.set(path, at)
    await phone.service.pull()
    expect((await phone.service.overview()).items.find((i: any) => i.type === 'chat').nasAt).toBe(at)
    const db = tablet.db(); db.characters[0].chats[0].message.push({ role: 'char', data: '아직 보내지 않은 변경' }); tablet.save(db); await tablet.service.snapshot()
    expect((await tablet.service.overview()).items.find((i: any) => i.type === 'chat').nasAt).toBe(clock)
    expect(phone.db().characters).toEqual([]) // a list refresh never applies data
})

test('archived chat sync survives service restart, transfers Wiki, and does not rewrite the source', async t => {
    const dav = fixtureDav()
    const full = { message: [{ role: 'char', data: 'archived message', chatId: 'm1' }], scriptstate: { day: 7 }, localLore: [] }
    const database = { personas: [], characters: [{ chaId: 'card', type: 'character', name: 'card', chats: [{ id: 'chat', name: 'chat', lastDate: 123,
        message: [{ role: 'char', data: '\uEF01COLDSTORAGE\uEF01key' }] }] }] }
    const source = await device(t, dav, 'cold-source', database, MASTER, { readColdChat: async (key: string) => key === 'key' ? full : null })
    await source.memory.saveMarkdownWikiTurn({ characterId: 'card', chatId: 'chat', sourceMessageIds: ['m1'], markdown: '## 기억\n\n보관 채팅의 기억' })
    source.service.enable({ workspaceId: 'ws-fixture' })
    const before = source.db()
    await source.service.snapshot(); await source.service.publish()
    expect(source.db()).toEqual(before)
    const restarted = source.make()
    expect((await restarted.snapshot()).committed).toBeNull()
    const target = await device(t, dav, 'cold-target', { characters: [], personas: [] })
    target.service.enable({ workspaceId: 'ws-fixture' }); await target.service.pull()
    const plan = await settle(target)
    expect(plan.pending).toEqual([])
    expect(target.db().characters[0].chats[0]).toMatchObject({ id: 'chat', lastDate: 123, ...full })
    const wiki = await walk(join(resolveMemoryWorkspace(target.dataRoot, 'card', 'chat').directory, 'wiki'))
    expect((await Promise.all(wiki.filter(f => f.endsWith('.md')).map(f => readFile(f, 'utf8')))).join('\n')).toContain('보관 채팅의 기억')
    expect((await target.service.snapshot()).committed).toBeNull()
    expect(source.db()).toEqual(before)
    const edited = target.db(); edited.characters[0].chats[0].message.push({ role: 'user', data: 'return update' }); target.save(edited)
    await target.service.snapshot(); await target.service.publish(); await restarted.pull()
    const received = await settle({ ...source, service: restarted })
    expect(received.pending).toEqual([])
    expect(source.db().characters[0].chats[0].message.at(-1).data).toBe('return update')
})

test('unresolved stored stub never commits a partial snapshot or deletion', async t => {
    const dav = fixtureDav(), tablet = await seedTablet(t, dav)
    const db = tablet.db(); db.characters[0].chats[0] = { id: 'chat', name: '현재', _stub: true }
    tablet.save(db)
    const before = tablet.db()
    await expect(tablet.service.snapshot()).rejects.toMatchObject({ code: 'CHAT_NOT_HYDRATED', characterId: 'card', chatId: 'chat' })
    expect(tablet.db()).toEqual(before)
    // A restarted reader must report the same problem rather than publishing an empty replacement.
    await expect(tablet.make().snapshot()).rejects.toMatchObject({ code: 'CHAT_NOT_HYDRATED' })
})

test('a plan finishing after status was read defers a queued snapshot without dropping the plan or touching user data', async t => {
    const dav = fixtureDav(), tablet = await seedTablet(t, dav)
    const phone = await device(t, dav, 'snapshot-race', { characters: [], personas: [], modules: [], plugins: [], botPresets: [] })
    phone.service.enable({ workspaceId: 'ws-fixture' }); await phone.service.pull()
    const before = JSON.stringify(phone.db()), preparing = phone.service.plan()
    expect(phone.service.status().plan).toBeNull() // /status is not queued behind /plan
    const snapshot = phone.service.snapshot()
    const rejected = expect(snapshot).rejects.toMatchObject({ code: 'NAS_SYNC_PLAN_PENDING' })
    const plan = await preparing; await rejected
    expect(phone.service.status().plan).toMatchObject({ transaction: plan.transaction, phase: 'prepared' })
    await phone.service.arm(plan.transaction, echoOf(plan, applyPlanToDb(structuredClone(phone.db()), plan)))
    await expect(phone.service.snapshot()).rejects.toMatchObject({ code: 'NAS_SYNC_PLAN_PENDING' })
    expect(phone.service.status().plan.phase).toBe('saving'); expect(JSON.stringify(phone.db())).toBe(before)
    expect((await phone.service.finish(plan.transaction, false)).state).toBe('rolled-back')
    await expect(phone.service.snapshot()).resolves.toHaveProperty('committed')
})

test('real snapshot → publish → pull → plan → canonical save → arm → finish: data lands on disk, journals/recovery hold no plaintext secrets, ACK and no echo', async t => {
    const dav = fixtureDav(), tablet = await seedTablet(t, dav)
    await assertNoSentinel(tablet.dataRoot)
    expect(dav.paths().join('\n')).not.toContain('SENTINEL')
    for (const [, bytes] of dav.files) expect(bytes.toString('latin1')).not.toContain('SENTINEL')
    const phone = await device(t, dav, 'phone', { language: 'ko', botPresets: [], modules: [], personas: [], loreBook: [], plugins: [], characters: [], openAIKey: 'phone-local-key', textAreaSize: 33, account: { token: 'phone-account', id: 'p', data: {} } })
    phone.service.enable({ workspaceId: 'ws-fixture' })
    const pulled = await phone.service.pull(); expect(pulled.admitted).toHaveLength(1)
    const plan = await phone.service.plan()
    expect(plan.empty).toBeUndefined(); expect(plan.pending).toEqual([])
    expect(plan.settings.openAIKey).toBe(S('openai')); expect(plan.settings.proxyKey).toBe(S('proxy')); expect(plan.settings).not.toHaveProperty('textAreaSize'); expect(plan.settings).not.toHaveProperty('account')
    expect(plan.newCharacters[0].oaiTTSConfig.apiKey).toBe(S('tts')); expect(plan.plugins[0].realArg.api_key).toBe(S('plugin')); expect(plan.plugins[0].enabled).toBe(false); expect(plan.pluginEnabled).toEqual({ plug: true })
    expect(plan.chats[0].chat.message[0].data).toBe('본문 {{inlay::draw1}}'); expect(plan.chats[0].chat.message[0].promptInfo?.promptText).toBeUndefined()
    await assertNoSentinel(phone.dataRoot) // plan journal + recovery copy + blobs: sealed
    const journal = JSON.parse(await readFile(join(phone.dataRoot, 'nas-sync', 'apply', `${plan.transaction}.json`), 'utf8'))
    expect(journal.settings.openAIKey).toBe(''); expect(journal.secretRefs.map((r: any) => r.slot)).toEqual(expect.arrayContaining(['/openAIKey', '/proxyKey', '/characters/card/oaiTTSConfig/apiKey', '/plugins/plug/realArg/api_key', '/botPresets/p1/openAIKey']))
    expect(phone.inlays.get('draw1')!.data).toEqual(Buffer.from('inlay-draw1-bytes')); expect(phone.inlays.get('slot-only')!.data).toEqual(Buffer.from('slot-only-bytes')) // media staged before the client saves
    expect(JSON.parse(Buffer.from(phone.storage.kvGet('inlay_meta/draw1')).toString())).toEqual({ createdAt: 100, updatedAt: 200, charId: 'card', chatId: 'chat' }) // ownership KV travels with the image
    expect(phone.storage.kvGet('assets/icon.png')).toEqual(Buffer.from('icon-bytes'))
    // Client: arm first (write gate moves), then save canonically, then finish.
    const db = phone.db()
    await phone.service.arm(plan.transaction, echoOf(plan, applyPlanToDb(structuredClone(db), plan)))
    expect(() => phone.service.assertWrite({ path: '/api/db/flush', headers: {} })).toThrow(expect.objectContaining({ code: 'NAS_SYNC_BUSY', transaction: plan.transaction })) // armed: carries the transaction
    expect(() => phone.service.assertWrite({ path: '/api/db/flush', headers: { 'x-nas-sync-id': plan.transaction } })).not.toThrow()
    phone.save(applyPlanToDb(db, plan))
    const finished = await phone.service.finish(plan.transaction, true)
    expect(finished).toMatchObject({ state: 'applied', commits: 1, chats: 1 })
    // Actual saved data on the phone.
    const after = phone.db()
    expect(after.openAIKey).toBe(S('openai')); expect(after.textAreaSize).toBe(33); expect(after.account.token).toBe('phone-account')
    expect(after.characters[0].chats[0].message[0].data).toBe('본문 {{inlay::draw1}}'); expect(after.characters[0].chats[0].scriptstate).toEqual({ day: 7 }); expect(after.characters[0].oaiTTSConfig.apiKey).toBe(S('tts'))
    expect(after.plugins[0].enabled).toBe(true); expect(after.plugins[0].realArg.api_key).toBe(S('plugin')); expect(after.botPresets[0].openAIKey).toBe(S('preset'))
    const wiki = await walk(join(resolveMemoryWorkspace(phone.dataRoot, 'card', 'chat').directory, 'wiki'))
    expect(wiki.length).toBeGreaterThan(0); expect((await Promise.all(wiki.filter(f => f.endsWith('.md')).map(f => readFile(f, 'utf8')))).join('\n')).toContain('슬롯 밖 위키')
    const slotDir = resolveMemoryWorkspace(phone.dataRoot, 'card', memorySaveWorkspaceId('slot')).directory
    expect(decodeMemorySaveChat(await readFile(join(slotDir, 'chat.bin'))).name).toBe('슬롯'); expect(JSON.parse(await readFile(join(slotDir, 'risubard-save.json'), 'utf8')).sourceChatId).toBe('chat')
    expect(phone.service.store().pendingApply()).toEqual([]); expect(await phone.service.recovery()).toEqual([])
    expect(await phone.service.plan()).toEqual({ empty: true, pending: [] })
    await assertNoSentinel(phone.dataRoot)
    // No echo: the phone's own snapshot of the applied state produces nothing new; the tablet sees nothing to apply.
    expect((await phone.service.snapshot()).committed).toBeNull()
    expect((await phone.service.publish()).stored).toEqual([])
    await tablet.service.pull(); expect(await tablet.service.plan()).toEqual({ empty: true, pending: [] })
    // Phone edits the chat; the tablet receives a linear update of the same chat (no sibling, no newChat defaults).
    const edited = phone.db(); edited.characters[0].chats[0].message.push({ role: 'user', data: '폰에서 추가' }); phone.save(edited)
    expect((await phone.service.snapshot()).committed).toMatchObject({ sequence: 1 }); await phone.service.publish()
    await tablet.service.pull(); const tp = await tablet.service.plan()
    expect(tp.chats).toEqual([expect.objectContaining({ characterId: 'card', update: true })]); expect(tp.chats[0].chat.id).toBe('chat'); expect(tp.chats[0].chat.message).toHaveLength(2)
    const tdb = tablet.db(); await tablet.service.arm(tp.transaction, echoOf(tp, applyPlanToDb(structuredClone(tdb), tp))); tablet.save(applyPlanToDb(tdb, tp))
    expect((await tablet.service.finish(tp.transaction, true)).state).toBe('applied')
    expect(tablet.db().characters[0].chats).toHaveLength(1); expect(tablet.db().characters[0].chats[0].message[1].data).toBe('폰에서 추가')
    await assertNoSentinel(tablet.dataRoot)
})

/** pull → plan → arm → canonical save → finish, the way the client does it. */
async function applyAll(dev: any) {
    await dev.service.pull(); const plan = await dev.service.plan(); if (plan.empty) return plan
    const db = dev.db(); await dev.service.arm(plan.transaction, echoOf(plan, applyPlanToDb(structuredClone(db), plan))); dev.save(applyPlanToDb(db, plan))
    const result = await dev.service.finish(plan.transaction, true); expect(result.state).toBe('applied'); return plan
}
const EMPTY_DB = () => ({ language: 'ko', botPresets: [], modules: [], personas: [], loreBook: [], plugins: [], characters: [], openAIKey: 'phone-key' })

test('finish is resumable after a crash in the committed phase; the device\'s own unsnapshotted workspace is moved aside, never deleted; ACK is idempotent', async t => {
    const dav = fixtureDav(), tablet = await seedTablet(t, dav)
    const phone = await device(t, dav, 'phone', EMPTY_DB()); phone.service.enable({ workspaceId: 'ws-fixture' })
    await applyAll(phone) // round 1: the chat and its Wiki arrive and are acknowledged
    const edited = tablet.db(); edited.characters[0].chats[0].message.push({ role: 'user', data: '태블릿에서 추가' }); tablet.save(edited)
    expect((await tablet.service.snapshot()).committed).toMatchObject({ sequence: 2 }); await tablet.service.publish()
    await phone.service.pull(); const plan = await phone.service.plan()
    expect(plan.chats).toEqual([expect.objectContaining({ update: true })]); expect(plan.chats[0].chat.id).toBe('chat')
    // A Wiki turn written after the plan was prepared (inside the apply window, past the local-edit guard) is moved aside by finish, never deleted.
    await phone.memory.saveMarkdownWikiTurn({ characterId: 'card', chatId: 'chat', sourceMessageIds: ['x'], markdown: '## 폰 고유\n\n덮어쓰기 전 원본' })
    const db = phone.db(); await phone.service.arm(plan.transaction, echoOf(plan, applyPlanToDb(structuredClone(db), plan))); phone.save(applyPlanToDb(db, plan))
    // Crash right after the plan reached 'committed' and before any workspace landed.
    let crashes = 1
    const crashing = phone.make({ afterStep: async (current: any) => { if (current.phase === 'committed' && crashes-- > 0) throw new Error('power loss') } })
    await expect(crashing.finish(plan.transaction, true)).rejects.toThrow(/power loss/)
    expect(crashing.state().plan).toMatchObject({ transaction: plan.transaction }) // pointer may lag the journal; both phases block ordinary writes
    expect(() => crashing.assertWrite({ path: '/api/db/flush', headers: {} })).toThrow(expect.objectContaining({ code: 'NAS_SYNC_BUSY' }))
    // Restart: the committed plan resumes without re-verifying and completes every step exactly once.
    const reopened = phone.make()
    expect(reopened.state().plan.phase).toBe('committed')
    expect((await reopened.finish(plan.transaction)).state).toBe('applied')
    expect(reopened.store().pendingApply()).toEqual([]); expect(reopened.state().plan).toBeNull()
    const recoveryBard = await walk(join(phone.dataRoot, 'nas-sync', 'recovery', plan.transaction, 'bard'))
    expect((await Promise.all(recoveryBard.filter(f => f.endsWith('.md')).map(f => readFile(f, 'utf8')))).join()).toContain('덮어쓰기 전 원본') // moved aside, not deleted
    expect((await Promise.all((await walk(join(resolveMemoryWorkspace(phone.dataRoot, 'card', 'chat').directory, 'wiki'))).filter(f => f.endsWith('.md')).map(f => readFile(f, 'utf8')))).join()).toContain('슬롯 밖 위키')
    expect(phone.db().characters[0].chats[0].message[1].data).toBe('태블릿에서 추가')
    expect((await reopened.finish(plan.transaction)).state).toBe('applied') // repeat answers from the durable completion record (Codex 20)
    await assertNoSentinel(phone.dataRoot)
})

test('a failed slot backup keeps the original slot bytes and the plan; rollback happens only when every planned entity is provably untouched', async t => {
    const dav = fixtureDav(), tablet = await seedTablet(t, dav)
    const phone = await device(t, dav, 'phone', EMPTY_DB()); phone.service.enable({ workspaceId: 'ws-fixture' })
    await applyAll(phone)
    const slotDir = resolveMemoryWorkspace(phone.dataRoot, 'card', memorySaveWorkspaceId('slot')).directory
    const phoneSlot = { id: 'chat', name: '폰 슬롯', note: '', localLore: [], scriptstate: {}, message: [{ role: 'char', data: '폰에서 바꾼 슬롯' }] }
    const edited = tablet.db(); edited.characters[0].chats[0].message.push({ role: 'user', data: '둘째' }); tablet.save(edited)
    await tablet.service.snapshot(); await tablet.service.publish()
    await phone.service.pull(); const plan = await phone.service.plan(); const db = phone.db()
    expect(plan.chats).toEqual([expect.objectContaining({ update: true })])
    // The phone's own slot bytes change after prepare (inside the apply window): finish must back them up, never drop them.
    await writeFile(join(slotDir, 'chat.bin'), encodeMemorySaveChat(phoneSlot as any)); const originalBytes = await readFile(join(slotDir, 'chat.bin'))
    // Partial save: the client saved only the settings, not the updated chat → never rolled back, media kept, gate kept.
    await phone.service.arm(plan.transaction, echoOf(plan, applyPlanToDb(structuredClone(db), plan)))
    const partial = applyPlanToDb(structuredClone(db), plan); partial.characters[0].chats[0].message.push({ role: 'user', data: 'deviates from the planned record' }); phone.save(partial) // a planned entity changed, but not to the expected state
    await expect(phone.service.finish(plan.transaction)).rejects.toThrow(expect.objectContaining({ code: 'NAS_SYNC_PARTIAL' }))
    expect(phone.service.state().plan.phase).toBe('saving')
    // Complete the save, then make the slot backup fail: the original slot stays, the plan stays committed and resumes later.
    const journalBeforeFinish = JSON.parse(await readFile(join(phone.dataRoot, 'nas-sync', 'apply', `${plan.transaction}.json`), 'utf8'))
    expect(Object.keys(journalBeforeFinish.workspaces[0].slots)).toEqual(['slot'])
    phone.save(applyPlanToDb(phone.db(), plan))
    const failing = phone.make({ beforeMoveAside: async (source: string) => { if (source.includes(Buffer.from('save-slot:slot').toString('base64url'))) throw new Error('EACCES backup') } })
    await expect(failing.finish(plan.transaction, true)).rejects.toThrow(/EACCES backup/)
    expect(await readFile(join(slotDir, 'chat.bin'))).toEqual(originalBytes); expect(decodeMemorySaveChat(await readFile(join(slotDir, 'chat.bin'))).name).toBe('폰 슬롯')
    expect(failing.state().plan.phase).toBe('committed')
    expect((await phone.make().finish(plan.transaction)).state).toBe('applied')
    expect(decodeMemorySaveChat(await readFile(join(slotDir, 'chat.bin'))).name).toBe('슬롯')
    expect(decodeMemorySaveChat(await readFile(join(phone.dataRoot, 'nas-sync', 'recovery', plan.transaction, 'slot', Buffer.from('slot').toString('base64url'), 'chat.bin'))).name).toBe('폰 슬롯')
    await assertNoSentinel(phone.dataRoot)
})

test('pre-save failure rolls back only this plan\'s media and keeps commits pending; a wrong vault key leaves the provider group pending while chats apply', async t => {
    const dav = fixtureDav(), tablet = await seedTablet(t, dav)
    const phone = await device(t, dav, 'phone', { language: 'ko', botPresets: [], modules: [], personas: [], loreBook: [], plugins: [], characters: [], openAIKey: 'phone-working-key', forceReplaceUrl: 'https://phone.example' }, OTHER_MASTER)
    phone.service.enable({ workspaceId: 'ws-fixture' }); await phone.service.pull()
    const plan = await phone.service.plan()
    expect(plan.pending.map((p: any) => [p.root.split('\n')[2], p.reason])).toEqual(expect.arrayContaining([['provider-main', 'vault'], ['prompt-presets', 'vault'], ['card', 'vault'], ['plug', 'vault'], ['chat', 'owner unknown']]))
    expect(plan.settings).not.toHaveProperty('openAIKey'); expect(plan.chats).toHaveLength(0); expect(plan.commits).toEqual([]) // the commit mixes pending roots: not acknowledged
    expect(plan.modules).toHaveLength(1) // credential-free library items still apply
    // The activation group names the sealed plugin: it waits for the plugin's record (its enabled flag cannot be applied to an absent plugin).
    expect(plan.pending).toContainEqual({ root: 'settings\ngroup\nactivation', reason: 'plugin-pending', pending: ['plug'] }); expect(plan.settings).not.toHaveProperty('enabledModules'); expect(plan.pluginEnabled).toBeNull()
    expect(phone.inlays.has('draw1')).toBe(false) // media of a pending chat is not staged
    // Client fails before saving: unconfirmed finish rolls back staged media, pointer cleared, commit still pending.
    await phone.service.arm(plan.transaction, echoOf(plan, applyPlanToDb(structuredClone(phone.db()), plan)))
    expect((await phone.service.finish(plan.transaction)).state).toBe('rolled-back')
    expect(phone.service.state().plan).toBeNull(); expect(phone.service.store().pendingApply()).toHaveLength(1)
    expect(phone.db().openAIKey).toBe('phone-working-key')
    // Key arrives through the trusted channel: replan applies everything and acknowledges.
    await vaultMasterStore(phone.dataRoot, androidProtector('11'.repeat(32))).importMaster(MASTER, { replace: true })
    const keyed = phone.make(); const full = await keyed.plan()
    expect(full.pending).toEqual([]); expect(full.settings.openAIKey).toBe(S('openai')); expect(full.commits).toHaveLength(1); expect(full.chats).toHaveLength(1); expect(phone.inlays.has('draw1')).toBe(true)
    const db = phone.db(); await keyed.arm(full.transaction, echoOf(full, applyPlanToDb(structuredClone(db), full))); phone.save(applyPlanToDb(db, full))
    expect((await keyed.finish(full.transaction, true)).state).toBe('applied'); expect(keyed.store().pendingApply()).toEqual([])
    expect(phone.db().openAIKey).toBe(S('openai')); expect(phone.db().forceReplaceUrl).toBe('https://proxy.example/v1')
    await assertNoSentinel(phone.dataRoot)
})

test('journal phase is authoritative over the pointer on open; finished journals are never re-adopted; manifest write failure reloads', async t => {
    const dav = fixtureDav(), tablet = await seedTablet(t, dav)
    const phone = await device(t, dav, 'phone', baseDb({ openAIKey: 'phone-key' }))
    phone.service.enable({ workspaceId: 'ws-fixture' }); await phone.service.pull()
    const plan = await phone.service.plan()
    // Simulate a crash between the journal write (saving) and the pointer write (prepared).
    const journalPath = join(phone.dataRoot, 'nas-sync', 'apply', `${plan.transaction}.json`)
    const journal = JSON.parse(await readFile(journalPath, 'utf8')); journal.phase = 'saving'; journal.expected = { chats: [], settings: {}, characters: [], modules: [], plugins: [], pluginEnabled: null, deletions: [], keptDeletions: [] }
    require('./file-store.cjs').atomicWriteJson(join(phone.dataRoot, 'nas-sync'), `apply/${plan.transaction}.json`, journal)
    expect(phone.service.state().plan.phase).toBe('prepared')
    const reopened = phone.make()
    expect(reopened.state().plan.phase).toBe('saving')
    expect(() => reopened.assertWrite({ path: '/api/db/flush', headers: {} })).toThrow(expect.objectContaining({ code: 'NAS_SYNC_BUSY' }))
    // Hold the plan (user decision) → pointer cleared, journal retained for inspection; reopening never re-adopts it as active work.
    expect(await reopened.hold(plan.transaction)).toMatchObject({ state: 'recovery-held' })
    const again = phone.make(); expect(again.state().plan).toBeNull(); expect(again.state().retained).toHaveLength(1)
    expect(existsSync(journalPath)).toBe(true); expect(existsSync(join(phone.dataRoot, 'nas-sync', 'recovery', plan.transaction, 'before.json'))).toBe(true) // held artifacts are kept, not adopted, not deleted
    expect(() => again.assertWrite({ path: '/api/db/flush', headers: {} })).not.toThrow()
    // Orphan adoption only for genuinely active journals: a journal whose transaction already finished is cleaned up instead.
    const active = await again.plan(); expect(active.transaction).not.toBe(plan.transaction)
    const db = phone.db(); await again.arm(active.transaction, echoOf(active, applyPlanToDb(structuredClone(db), active))); phone.save(applyPlanToDb(db, active))
    expect((await again.finish(active.transaction, true)).state).toBe('applied')
    require('./file-store.cjs').atomicWriteJson(join(phone.dataRoot, 'nas-sync'), `apply/${active.transaction}.json`, { ...active, phase: 'committed' }) // stale copy left behind by a crash after completion
    const last = phone.make(); expect(last.state().plan).toBeNull(); expect(existsSync(join(phone.dataRoot, 'nas-sync', 'apply', `${active.transaction}.json`))).toBe(false)
    await assertNoSentinel(phone.dataRoot)
})

test('a container deletion based on an older observed child stays delete-pending where the child was edited concurrently; the edited chat survives', async t => {
    const dav = fixtureDav(), tablet = await seedTablet(t, dav)
    const phone = await device(t, dav, 'phone', EMPTY_DB()); phone.service.enable({ workspaceId: 'ws-fixture' })
    await applyAll(phone)
    // Phone edits the chat (unseen by the tablet user) and publishes; the tablet pulls it (admitted) but has not applied it.
    const edited = phone.db(); edited.characters[0].chats[0].message.push({ role: 'user', data: '폰에서 이어 쓴 대화' }); phone.save(edited)
    await phone.service.snapshot(); await phone.service.publish()
    await tablet.service.pull(); expect(tablet.service.store().pendingApply()).toHaveLength(1)
    // Tablet user deletes the character (and so its chat) based on what they observed, then snapshots.
    const deleted = tablet.db(); deleted.characters = []; tablet.save(deleted)
    const snap = await tablet.service.snapshot(); expect(snap.committed.tombstones).toBe(2)
    await tablet.service.publish()
    // Phone: the character root is deleted but its chat has a live head the tablet never saw → container delete-pending, chat kept.
    await phone.service.pull(); const plan = await phone.service.plan()
    expect(plan.chats ?? []).toEqual([]); expect(plan.deletions ?? []).toEqual([]) // nothing removed, nothing rewritten
    expect(plan.pending).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'delete-pending' })]))
    expect(phone.db().characters).toHaveLength(1); expect(phone.db().characters[0].chats[0].message).toHaveLength(2)
    expect(phone.service.store().graph.classify('play\nchat\nchat').state).toBe('delete-pending')
    // Tablet: the unseen edit arrives as a delete-pending chat; nothing is silently dropped, nothing is acknowledged, recovery is explicit.
    const tp = await tablet.service.plan()
    expect(tp.chats ?? []).toEqual([]); expect(tp.deletions ?? []).toEqual([]); expect(tp.pending).toEqual(expect.arrayContaining([expect.objectContaining({ reason: 'delete-pending' })]))
    expect(tablet.service.store().pendingApply()).toHaveLength(1)
    expect(tablet.service.store().graph.classify('play\nchat\nchat').state).toBe('delete-pending')
    expect(tablet.service.store().trash()).toHaveLength(2); expect(tablet.service.store().status().physicalPurge).toBe(false)
    await assertNoSentinel(phone.dataRoot); await assertNoSentinel(tablet.dataRoot)
})

test('three devices: two offline edits of one chat arrive at a third device as two distinct stable branch chats with their own Wiki/slots; restart, repeat and round trip keep both (Codex 18)', async t => {
    const dav = fixtureDav(), a = await seedTablet(t, dav)
    const b = await device(t, dav, 'phone', EMPTY_DB()), c = await device(t, dav, 'third', EMPTY_DB())
    b.service.enable({ workspaceId: 'ws-fixture' }); c.service.enable({ workspaceId: 'ws-fixture' })
    await applyAll(b); await applyAll(c) // base everywhere
    // A and B edit the same chat while apart; each writes its own Wiki turn too.
    const ea = a.db(); ea.characters[0].chats[0].message.push({ role: 'user', data: 'A의 편집' }); a.save(ea)
    await a.memory.saveMarkdownWikiTurn({ characterId: 'card', chatId: 'chat', sourceMessageIds: ['a1'], markdown: '## A 위키\n\nA 전용 사건' })
    const eb = b.db(); eb.characters[0].chats[0].message.push({ role: 'user', data: 'B의 편집' }); b.save(eb)
    await b.memory.saveMarkdownWikiTurn({ characterId: 'card', chatId: 'chat', sourceMessageIds: ['b1'], markdown: '## B 위키\n\nB 전용 사건' })
    await a.service.snapshot(); await a.service.publish(); await b.service.snapshot(); await b.service.publish()
    // C holds only the base: both children arrive; exactly one keeps the existing id, the other gets a stable sibling id.
    await c.service.pull(); const plan = await c.service.plan()
    expect(plan.chats).toHaveLength(2)
    const ids = plan.chats.map((r: any) => r.chat.id).sort()
    expect(ids.filter(id => id === 'chat')).toHaveLength(1); expect(ids.find(id => id !== 'chat')).toMatch(/^chat~[a-f0-9]{8}$/)
    expect(plan.chats.map((r: any) => r.chat.message.at(-1).data).sort()).toEqual(['A의 편집', 'B의 편집'])
    expect(plan.characters).toEqual([]) // the character root itself did not change; the sibling is appended locally after the remote membership order
    const db = c.db(); await c.service.arm(plan.transaction, echoOf(plan, applyPlanToDb(structuredClone(db), plan))); c.save(applyPlanToDb(db, plan))
    expect((await c.service.finish(plan.transaction, true)).state).toBe('applied')
    const sibling = ids.find(id => id !== 'chat')!
    const after = c.db().characters[0]
    expect(after.chats.map((ch: any) => ch.id).sort()).toEqual(['chat', sibling].sort())
    expect(after.chats.map((ch: any) => ch.message.at(-1).data).sort()).toEqual(['A의 편집', 'B의 편집'])
    const wikiOf = async (chatId: string) => (await Promise.all((await walk(join(resolveMemoryWorkspace(c.dataRoot, 'card', chatId).directory, 'wiki'))).filter(f => f.endsWith('.md')).map(f => readFile(f, 'utf8')))).join('\n')
    const mainText = after.chats.find((ch: any) => ch.id === 'chat').message.at(-1).data, mainWiki = await wikiOf('chat'), siblingWiki = await wikiOf(sibling)
    expect(mainWiki).toContain(mainText.startsWith('A') ? 'A 전용 사건' : 'B 전용 사건'); expect(siblingWiki).toContain(mainText.startsWith('A') ? 'B 전용 사건' : 'A 전용 사건')
    // The sibling's slot is relinked to the sibling chat id and decodable.
    const siblingSlotDir = resolveMemoryWorkspace(c.dataRoot, 'card', memorySaveWorkspaceId(`slot~${sibling.slice(5)}`)).directory
    expect(existsSync(join(siblingSlotDir, 'risubard-save.json'))).toBe(true)
    expect(JSON.parse(await readFile(join(siblingSlotDir, 'risubard-save.json'), 'utf8')).sourceChatId).toBe(sibling)
    expect(decodeMemorySaveChat(await readFile(join(siblingSlotDir, 'chat.bin'))).name).toBe('슬롯')
    expect(JSON.parse(await readFile(join(resolveMemoryWorkspace(c.dataRoot, 'card', memorySaveWorkspaceId('slot')).directory, 'risubard-save.json'), 'utf8')).sourceChatId).toBe('chat')
    // Load the received branch slot through the real memory runtime (prepare → finalize): shared pages and Wiki are restored, not just decodable.
    const ownerOf = (id: string) => JSON.parse(Buffer.from(c.storage.kvGet('inlay_meta/' + id)).toString())
    expect(ownerOf('draw1')).toMatchObject({ charId: 'card', chatId: 'chat' }) // the image reached C with the first (main) chat; ownership stays on that chat
    const siblingSaveId = `slot~${sibling.slice(5)}`
    expect((await c.memory.listMemorySaves({ characterId: 'card', sourceChatId: sibling })).map((x: any) => x.saveId)).toEqual([siblingSaveId])
    const loaded = await c.memory.prepareMemorySaveLoad({ characterId: 'card', saveId: siblingSaveId, destinationChatId: 'loaded-from-branch' })
    await c.memory.completeMemoryFork({ characterId: 'card', destinationChatId: 'loaded-from-branch', forkToken: loaded.fork.forkToken, action: 'finalize' })
    const loadedWiki = (await Promise.all((await walk(join(resolveMemoryWorkspace(c.dataRoot, 'card', 'loaded-from-branch').directory, 'wiki'))).filter(f => f.endsWith('.md')).map(f => readFile(f, 'utf8')))).join()
    expect(loadedWiki).toContain('슬롯 밖 위키')
    // Restart, repeat, no echo.
    const c2 = c.make(); expect(c2.state().plan).toBeNull()
    expect(c2.db ?? true).toBeTruthy()
    expect(c.db().characters[0].chats).toHaveLength(2)
    const branchOverview = await c.service.overview()
    expect(branchOverview.items.filter((i: any) => i.type === 'chat')).toHaveLength(2)
    await c2.pull(); expect(await c2.plan()).toMatchObject({ empty: true })
    const echo = await c2.snapshot()
    expect(echo.committed ? c2.store().state().commits.at(-1).revisions.map((id: string) => { const r = c2.store().graph.get(id); return `${r.type}:${r.root}`; }) : []).toEqual([]) // no echo after applying two branches
    // A ↔ B exchange converges: each keeps its own chat id for its own branch and gains the other's as a sibling.
    await applyAll(a); await applyAll(b)
    for (const dev of [a, b]) { const chats = dev.db().characters[0].chats; expect(chats).toHaveLength(2); expect(chats.map((ch: any) => ch.message.at(-1).data).sort()).toEqual(['A의 편집', 'B의 편집']); expect(chats.find((ch: any) => ch.id === 'chat')).toBeTruthy() }
    expect(a.db().characters[0].chats.find((ch: any) => ch.id === 'chat').message.at(-1).data).toBe('A의 편집')
    expect(b.db().characters[0].chats.find((ch: any) => ch.id === 'chat').message.at(-1).data).toBe('B의 편집')
    // Next edit on C's sibling chat round-trips to A as an in-place update of A's own chat on that branch (if it is A's branch) or of A's sibling.
    const next = c.db(); const target = next.characters[0].chats.find((ch: any) => ch.id === sibling); target.message.push({ role: 'user', data: 'C가 가지에서 이어감' }); c.save(next)
    expect((await c2.snapshot()).committed).toMatchObject({ revisions: expect.any(Number) }); await c2.publish()
    await applyAll(a); await applyAll(b)
    for (const dev of [a, b]) { const chats = dev.db().characters[0].chats; expect(chats).toHaveLength(2); expect(chats.some((ch: any) => ch.message.at(-1).data === 'C가 가지에서 이어감')).toBe(true) }
    for (const dev of [a, b, c]) await assertNoSentinel(dev.dataRoot)
})

test('restored backup: absence is not deletion and edits continue from the recorded base; joining-device bootstrap resolves matched settings to the authority and archives the originals sealed', async t => {
    const dav = fixtureDav(), tablet = await seedTablet(t, dav)
    // --- restored backup on the tablet: a copy without the protected identity sidecar, taken when the chat was already deleted locally ---
    const copy = await mkdtemp(join(tmpdir(), 'bard-sync-restored-')); t.onTestFinished(() => rm(copy, { recursive: true, force: true }))
    const { cp } = await import('node:fs/promises')
    await cp(tablet.dataRoot, join(copy, 'data'), { recursive: true }); await rm(join(copy, 'data', 'nas-sync', 'identity.json'), { force: true })
    const restoredRepo = createUserDataRepository({ dataRoot: join(copy, 'data') }), restoredDb = restoredRepo.exportLegacyDatabase()
    restoredDb.characters[0].chats = [] ; restoredRepo.importLegacyDatabase(restoredDb, { mode: 'sync' }) // the backup predates the chat
    const restored = createNasSyncService({ dataRoot: join(copy, 'data'), readDatabase: async () => restoredRepo.exportLegacyDatabase(), memory: createRuntimeMemoryService(join(copy, 'data')), storage: createFileKv({ dataRoot: join(copy, 'data') }), secrets: dav.secrets, fetch: dav.fetch, protect: androidProtector('11'.repeat(32)), now, readInlay: async () => null, installInlay: async () => {}, removeInlay: async () => {} })
    expect(restored.store().identity().incarnationId).not.toBe(tablet.service.store().identity().incarnationId) // rotated: restored copy
    const snap = await restored.snapshot()
    expect(snap.provenance).toBe('restored-backup'); expect(snap.committed?.tombstones ?? 0).toBe(0) // absence in a restore is not deletion
    expect(restored.store().graph.classify('play\nchat\nchat').state).toBe('live')
    expect(Object.keys(restored.state().lineage).some(k => k.includes('#chat'))).toBe(false)
    // An edit made in the restored copy continues from the recorded base and publishes under the new incarnation.
    const edited = restoredRepo.exportLegacyDatabase(); edited.language = 'ja'; restoredRepo.importLegacyDatabase(edited, { mode: 'sync' })
    const second = await restored.snapshot(); expect(second.provenance).toBe('edit'); expect(second.committed).toMatchObject({ sequence: 2 })
    expect((await restored.publish()).failed).toEqual([])
    // --- joining device with its own prior settings ---
    const phone = await device(t, dav, 'phone', { ...EMPTY_DB(), language: 'en', aiModel: 'phone-model', botPresets: [{ id: 'phone-preset', name: '폰 프리셋', openAIKey: S('phone-preset-key') }], botPresetsId: 0 })
    phone.service.enable({ workspaceId: 'ws-fixture' })
    expect((await phone.service.snapshot()).committed).toMatchObject({ sequence: 1 }) // own genesis revisions
    await phone.service.pull()
    const diverged = await phone.service.plan()
    expect(diverged.pending.map((p: any) => p.reason)).toContain('diverged'); expect(diverged.settings).not.toHaveProperty('aiModel') // conflicting settings stay pending, current values kept
    expect((await phone.service.finish(diverged.transaction)).state).toBe('rolled-back') // nothing saved from that plan: release it before bootstrapping
    const result = await phone.service.bootstrap({ authorityDevice: tablet.service.identity ? tablet.service.store().identity().deviceId : tablet.service.store().identity().deviceId })
    expect(result.resolved).toBeGreaterThan(0)
    const archive = JSON.parse(await readFile(join(phone.dataRoot, 'nas-sync', result.archive), 'utf8'))
    expect(archive.originals.find((o: any) => o.root.endsWith('provider-main')).content.aiModel).toBe('phone-model'); expect(JSON.stringify(archive)).not.toContain('SENTINEL')
    expect(archive.originals.some((o: any) => (o.content.$syncSecrets ?? []).some((r: any) => r.slot === '/botPresets/phone-preset/openAIKey'))).toBe(true) // the joining preset key is archived as a sealed reference
    const plan = await phone.service.plan()
    expect(plan.settings.aiModel).toBe('gpt'); expect(plan.settings.language).toBe('ja'); expect(plan.pending.filter((p: any) => p.reason === 'diverged')).toEqual([]) // 'ja': the restored copy's edit continued the authority lineage linearly
    const db = phone.db(); await phone.service.arm(plan.transaction, echoOf(plan, applyPlanToDb(structuredClone(db), plan))); phone.save(applyPlanToDb(db, plan))
    expect((await phone.service.finish(plan.transaction, true)).state).toBe('applied')
    expect(phone.db().aiModel).toBe('gpt'); expect(phone.db().openAIKey).toBe(S('openai'))
    await assertNoSentinel(phone.dataRoot); await assertNoSentinel(join(copy, 'data'))
})

test('a local edit no snapshot has published is never overwritten: the root stays pending (commit not acknowledged) until the snapshot makes it a branch; an unapplied pull does not fork unchanged items (Codex 21)', async t => {
    const dav = fixtureDav(), tablet = await seedTablet(t, dav)
    const phone = await device(t, dav, 'phone', EMPTY_DB()); phone.service.enable({ workspaceId: 'ws-fixture' })
    await applyAll(phone)
    // Tablet edits the chat and publishes. The phone pulls but does not apply: its own unchanged snapshot must not re-emit the chat
    // under the (now older) recorded head, which would fork it.
    let tdb = tablet.db(); tdb.characters[0].chats[0].message.push({ role: 'user', data: '태블릿 추가' }); tablet.save(tdb)
    expect((await tablet.service.snapshot()).committed).toMatchObject({ sequence: 2 }); expect((await tablet.service.publish()).failed).toEqual([])
    expect((await phone.service.pull()).admitted).toHaveLength(1)
    expect((await phone.service.snapshot()).committed).toBeNull()
    // The phone user edits the same chat and the app saves it, but no snapshot has run yet.
    const pdb = phone.db(); pdb.characters[0].chats[0].message.push({ role: 'user', data: '폰의 미발행 편집' }); phone.save(pdb)
    const blocked = await phone.service.plan()
    expect(blocked.empty).toBe(true); expect(blocked.pending).toEqual([expect.objectContaining({ root: 'play\nchat\nchat', reason: 'local-edit' })])
    expect(phone.db().characters[0].chats[0].message.map((m: any) => m.data)).toEqual(['본문 {{inlay::draw1}}', '폰의 미발행 편집']) // untouched
    expect(phone.service.store().pendingApply()).toHaveLength(1) // not acknowledged: the tablet's commit waits for a plan that can apply it
    expect(await phone.service.recovery()).toEqual([]) // nothing staged for an empty plan
    // The snapshot turns the edit into its own causal revision; the plan then keeps the local chat and materializes the tablet's as a sibling branch.
    expect((await phone.service.snapshot()).committed).toMatchObject({ sequence: 1 })
    const plan = await phone.service.plan()
    expect(plan.pending).toEqual([]); expect(plan.chats).toHaveLength(1); expect(plan.chats[0].update).toBe(false); expect(plan.chats[0].chat.id).toMatch(/^chat~[0-9a-f]{8}$/)
    expect(plan.chats[0].chat.message.map((m: any) => m.data)).toEqual(['본문 {{inlay::draw1}}', '태블릿 추가'])
    const db = phone.db(); await phone.service.arm(plan.transaction, echoOf(plan, applyPlanToDb(structuredClone(db), plan))); phone.save(applyPlanToDb(db, plan))
    expect((await phone.service.finish(plan.transaction, true)).state).toBe('applied')
    const chats = phone.db().characters[0].chats
    expect(chats.map((c: any) => c.message.at(-1).data)).toEqual(['폰의 미발행 편집', '태블릿 추가'])
    expect(phone.service.store().pendingApply()).toEqual([])
    await assertNoSentinel(phone.dataRoot)
})

test('arm refuses a plan whose prepared baseline a legitimate write changed (replan) and leaves the gate open; the newer local value is then a local edit, never disposable (Codex 21)', async t => {
    const dav = fixtureDav(), tablet = await seedTablet(t, dav)
    const phone = await device(t, dav, 'phone', EMPTY_DB()); phone.service.enable({ workspaceId: 'ws-fixture' })
    await applyAll(phone)
    const tdb = tablet.db(); tdb.language = 'en'; tablet.save(tdb); await tablet.service.snapshot(); await tablet.service.publish()
    await phone.service.pull()
    // A write to something the plan does not touch (device-local field) is fine.
    const first = await phone.service.plan(); expect(first.settings.language).toBe('en'); expect(first.settings).not.toHaveProperty('textAreaSize')
    let db = phone.db(); db.textAreaSize = 99; phone.save(db)
    await phone.service.arm(first.transaction, echoOf(first, applyPlanToDb(structuredClone(db), first)))
    expect((await phone.service.finish(first.transaction, false)).state).toBe('rolled-back') // abandoned by the client; nothing saved
    // A write that reaches a planned entity between prepare and arm: replan, gate never moved, plan releasable.
    const second = await phone.service.plan(); db = phone.db(); db.language = 'fr'; phone.save(db)
    await expect(phone.service.arm(second.transaction, echoOf(second, applyPlanToDb(structuredClone(db), second)))).rejects.toMatchObject({ code: 'NAS_SYNC_REPLAN' })
    expect(await phone.service.recovery()).toEqual([{ transaction: second.transaction, phase: 'prepared' }])
    expect(() => phone.service.assertWrite({ path: '/api/db/flush', headers: {} })).not.toThrow()
    expect((await phone.service.finish(second.transaction, false)).state).toBe('rolled-back')
    expect(existsSync(join(phone.dataRoot, 'nas-sync', 'apply', second.transaction))).toBe(false)
    // Planning again sees the newer local value as an unpublished edit: pending, current value kept.
    const third = await phone.service.plan(); expect(third.empty).toBe(true); expect(third.pending).toEqual([expect.objectContaining({ reason: 'local-edit' })])
    expect(phone.db().language).toBe('fr')
    await phone.service.snapshot()
    const fourth = await phone.service.plan(); expect(fourth.pending).toEqual([expect.objectContaining({ reason: 'diverged' })]); expect(phone.db().language).toBe('fr')
})

test('a finish retry after the completion record is durable returns the same applied outcome and never disturbs a newer plan; a lost response is not a held client forever (Codex 20)', async t => {
    const dav = fixtureDav(), tablet = await seedTablet(t, dav)
    let lose = true
    const phone = await device(t, dav, 'phone', EMPTY_DB(), MASTER, { hooks: { afterCompletion: async () => { if (lose) { lose = false; throw new Error('response lost after the final manifest write') } } } })
    phone.service.enable({ workspaceId: 'ws-fixture' }); await phone.service.pull()
    const plan = await phone.service.plan(); const db = phone.db()
    await phone.service.arm(plan.transaction, echoOf(plan, applyPlanToDb(structuredClone(db), plan))); phone.save(applyPlanToDb(db, plan))
    await expect(phone.service.finish(plan.transaction, true)).rejects.toThrow('response lost')
    expect(await phone.service.recovery()).toEqual([]) // durable completion already recorded
    const retry = await phone.service.finish(plan.transaction, true)
    expect(retry).toMatchObject({ state: 'applied', transaction: plan.transaction, commits: 1, chats: 1, keptDeletions: [] }); expect(retry.completedAt).toBeTypeOf('number')
    expect(await phone.service.finish(plan.transaction, false)).toMatchObject({ state: 'applied', transaction: plan.transaction })
    // A newer plan is pending: the old transaction's retry still answers for itself only.
    const tdb = tablet.db(); tdb.language = 'en'; tablet.save(tdb); await tablet.service.snapshot(); await tablet.service.publish(); await phone.service.pull()
    const newer = await phone.service.plan(); expect(newer.transaction).not.toBe(plan.transaction)
    expect((await phone.service.finish(plan.transaction, true)).state).toBe('applied')
    expect(await phone.service.recovery()).toEqual([{ transaction: newer.transaction, phase: 'prepared' }])
    expect(existsSync(join(phone.dataRoot, 'nas-sync', 'apply', `${newer.transaction}.json`))).toBe(true)
})

test('bootstrap keeps the applied lineage until the resolution is applied: restart and a snapshot before apply publish nothing; a crash after the store commit completes the record on reopen (Codex 22)', async t => {
    const dav = fixtureDav(), tablet = await seedTablet(t, dav)
    let crash = true
    const phone = await device(t, dav, 'phone', { ...EMPTY_DB(), language: 'en', aiModel: 'phone-model' }, MASTER, { hooks: { afterBootstrapCommit: async () => { if (crash) { crash = false; throw new Error('crash after commit') } } } })
    phone.service.enable({ workspaceId: 'ws-fixture' })
    expect((await phone.service.snapshot()).committed).toMatchObject({ sequence: 1 })
    await phone.service.pull()
    const diverged = await phone.service.plan(); expect(diverged.pending.map((p: any) => p.reason)).toContain('diverged'); expect((await phone.service.finish(diverged.transaction)).state).toBe('rolled-back')
    const authority = tablet.service.store().identity().deviceId
    await expect(phone.service.bootstrap({ authorityDevice: authority })).rejects.toThrow('crash after commit')
    expect(phone.service.state().pendingBootstrap).toMatchObject({ authorityDevice: authority }); expect(phone.service.state().bootstraps).toEqual([])
    const before = structuredClone(phone.service.state().lineage)
    // Reopen: the intent completes from the store; lineage still points at the joining revisions (nothing applied yet).
    const reopened = phone.make()
    expect(reopened.state().pendingBootstrap).toBeNull(); expect(reopened.state().bootstraps).toHaveLength(1); expect(reopened.state().bootstraps[0].commit).toBeTypeOf('string')
    expect(reopened.state().lineage).toEqual(before)
    expect((await reopened.snapshot()).committed).toBeNull() // joining values equal their recorded head: no republish of the originals as authority descendants
    expect((await reopened.publish()).failed).toEqual([])
    // Normal apply of the resolution, then no echo.
    const plan = await reopened.plan(); expect(plan.settings.aiModel).toBe('gpt'); expect(plan.pending.filter((p: any) => p.reason === 'diverged')).toEqual([])
    const db = phone.db(); await reopened.arm(plan.transaction, echoOf(plan, applyPlanToDb(structuredClone(db), plan))); phone.save(applyPlanToDb(db, plan))
    expect((await reopened.finish(plan.transaction, true)).state).toBe('applied')
    expect(phone.db().aiModel).toBe('gpt'); expect(phone.db().openAIKey).toBe(S('openai'))
    expect((await reopened.snapshot()).committed).toBeNull()
    expect(reopened.state().lineage).not.toEqual(before)
    // A bootstrap that never reached the store leaves no intent and no archive.
    const archiveDirs = async () => (await readdir(join(phone.dataRoot, 'nas-sync', 'recovery'))).filter(n => n.startsWith('bootstrap-'))
    expect(await archiveDirs()).toHaveLength(1)
    await assertNoSentinel(phone.dataRoot)
})

test('identity-intact restore: A backed up → B applied → A restored with its recorded bases; new revisions continue A (never B), B survives as a sibling, a deleted chat comes back, absence is not deletion, the mark is consumed (Codex 22/23)', async t => {
    const dav = fixtureDav(), tablet = await seedTablet(t, dav)
    // State A (seq 2): a second chat and language ja. Its lineage file is what an app backup carries.
    let db = tablet.db(); db.characters[0].chats.push({ id: 'chat2', name: '둘째', note: '', localLore: [], message: [{ role: 'char', data: '둘째 대화' }] }); db.language = 'ja'; tablet.save(db)
    expect((await tablet.service.snapshot()).committed).toMatchObject({ sequence: 2 })
    const backupA = structuredClone(tablet.db()), lineageFileA = JSON.parse(await readFile(join(tablet.dataRoot, 'risubard', 'nas-sync', 'lineage.json'), 'utf8'))
    expect(lineageFileA.lineage).toEqual(tablet.service.state().lineage); const atA = now(); clock += 60_000
    // State B (seq 3): the chat edited, chat2 deleted, language en, a module added.
    db = tablet.db(); db.characters[0].chats[0].message.push({ role: 'user', data: 'B에서 추가' }); db.characters[0].chats = db.characters[0].chats.filter((c: any) => c.id !== 'chat2'); db.language = 'en'; db.modules.push({ id: 'late', name: '나중 모듈', lorebook: [] }); tablet.save(db)
    expect((await tablet.service.snapshot()).committed).toMatchObject({ sequence: 3, tombstones: 1 })
    const s = tablet.service.store(), lineageB = tablet.service.state().lineage, chatKey = 'play\nchat\nchat#chat'
    const bChat = lineageB[chatKey]; expect(s.graph.classify('play\nchat\nchat2').state).toBe('deleted')
    const settingsKey = Object.keys(lineageB).find(k => k.startsWith('settings\n') && 'language' in (s.graph.get(lineageB[k])?.content ?? {}))!, bSettings = lineageB[settingsKey]
    // The app restores backup A into the same installation (identity + service lineage untouched). The mark resolves the bases
    // recorded with A — from the backup's lineage file (import) or from the lineage history at A's time (DB snapshot); both agree.
    expect(() => tablet.service.markRestore({ source: 'backup-import', restoreId: '../x' })).toThrow()
    tablet.service.markRestore({ source: 'backup-import', restoreId: 'backup-aborted' }); tablet.service.clearRestore('backup-aborted'); expect(tablet.service.status().pendingRestore).toBeNull()
    const byTime = tablet.service.markRestore({ source: 'db-snapshot', restoreId: 'snapshot-a', at: atA })
    expect(byTime.basesFrom).toBe('history'); expect(byTime.bases).toEqual(lineageFileA.lineage)
    expect(tablet.service.markRestore({ source: 'db-snapshot', restoreId: 'snapshot-0', at: 1 }).basesFrom).toBe('none') // nothing recorded that early: unknown origin
    const mark = tablet.service.markRestore({ source: 'backup-import', restoreId: 'backup-a', lineage: lineageFileA.lineage })
    expect(mark.basesFrom).toBe('recorded'); expect(tablet.service.status().pendingRestore).toMatchObject({ id: 'backup-a' })
    tablet.save(backupA)
    expect(existsSync(join(tablet.dataRoot, 'nas-sync', 'identity.json'))).toBe(true)
    const snap = await tablet.service.snapshot()
    expect(snap.provenance).toBe('restored-backup'); expect(snap.restore).toEqual(mark); expect(snap.committed).toMatchObject({ sequence: 4, tombstones: 0 })
    const lineageR = tablet.service.state().lineage
    expect(s.graph.revisions().filter((r: any) => r.parents.includes(bChat) || r.parents.includes(bSettings))).toEqual([]) // nothing descends from B
    // chat: A's content is re-published as a restored revision continuing A's recorded base; B stays a sibling head.
    const restoredChat = s.graph.get(lineageR[chatKey]); expect(restoredChat.parents).toEqual([lineageFileA.lineage[chatKey]]); expect(restoredChat.id).not.toBe(bChat)
    expect(s.graph.classify('play\nchat\nchat')).toMatchObject({ state: 'diverged' }); expect(s.graph.classify('play\nchat\nchat').liveHeads).toEqual(expect.arrayContaining([bChat, restoredChat.id]))
    // chat2: deleted in B, present in A → restored from the tombstone (un-delete), alive again.
    const chat2 = s.graph.classify('play\nchat\nchat2'); expect(chat2.state).toBe('live'); expect(s.graph.get(chat2.liveHeads[0]).parents.map((p: string) => !!s.graph.get(p).tombstone)).toEqual([true])
    expect(lineageR['play\nchat\nchat2#chat2']).toBe(chat2.liveHeads[0])
    // settings: ja continues A's recorded base; en (B) remains a head → diverged.
    expect(s.graph.get(lineageR[settingsKey]).parents).toEqual([lineageFileA.lineage[settingsKey]]); expect(s.graph.classify(settingsKey.split('#')[0]).state).toBe('diverged')
    // module added in B: absent from A → not a deletion; its lineage is dropped.
    expect(s.graph.classify('library\nmodule\nlate').state).toBe('live'); expect(Object.keys(lineageR).some(k => k.endsWith('#late'))).toBe(false)
    expect(tablet.service.status().pendingRestore).toBeNull()
    expect(JSON.parse(await readFile(join(tablet.dataRoot, 'risubard', 'nas-sync', 'lineage.json'), 'utf8')).lineage).toEqual(lineageR)
    // An edit after the restore continues the restored revision, not B.
    db = tablet.db(); db.characters[0].chats[0].message.push({ role: 'user', data: '복원 후 편집' }); tablet.save(db)
    expect((await tablet.service.snapshot()).provenance).toBe('edit')
    expect(s.graph.get(tablet.service.state().lineage[chatKey]).parents).toEqual([restoredChat.id])
    await assertNoSentinel(tablet.dataRoot)
})

test('a crash between the restore snapshot\'s store commit and its manifest write completes from the durable intent, consuming the restore without losing its provenance (Codex 23)', async t => {
    const dav = fixtureDav(), tablet = await seedTablet(t, dav)
    let db = tablet.db(); db.language = 'ja'; tablet.save(db); expect((await tablet.service.snapshot()).committed).toMatchObject({ sequence: 2 })
    const backupA = structuredClone(tablet.db()), lineageA = JSON.parse(await readFile(join(tablet.dataRoot, 'risubard', 'nas-sync', 'lineage.json'), 'utf8')).lineage
    db = tablet.db(); db.language = 'en'; tablet.save(db); expect((await tablet.service.snapshot()).committed).toMatchObject({ sequence: 3 })
    const crashing = tablet.make({ afterSnapshotCommit: async () => { throw new Error('power loss after commit') } })
    const mark = crashing.markRestore({ source: 'backup-import', restoreId: 'backup-a', lineage: lineageA }); tablet.save(backupA)
    await expect(crashing.snapshot()).rejects.toThrow('power loss')
    expect(crashing.state().pendingLineage).toMatchObject({ provenance: 'restored-backup', restore: mark }); expect(crashing.state().pendingRestore).toEqual(mark)
    const reopened = tablet.make()
    expect(reopened.state().pendingLineage).toBeNull(); expect(reopened.state().pendingRestore).toBeNull()
    const s = reopened.store(), settingsKey = Object.keys(lineageA).find(k => k.startsWith('settings\n') && 'language' in (s.graph.get(lineageA[k])?.content ?? {}))!
    const head = s.graph.get(reopened.state().lineage[settingsKey]); expect(head.content.language).toBe('ja'); expect(head.parents).toEqual([lineageA[settingsKey]])
    expect(JSON.parse(await readFile(join(tablet.dataRoot, 'risubard', 'nas-sync', 'lineage.json'), 'utf8')).lineage).toEqual(reopened.state().lineage)
    const again = await reopened.snapshot(); expect(again.provenance).toBe('edit'); expect(again.committed).toBeNull()
})

test('a crash before the restore snapshot\'s store commit leaves lineage and the restore mark untouched; the next snapshot does the restore (Codex 24)', async t => {
    const dav = fixtureDav(), tablet = await seedTablet(t, dav)
    let db = tablet.db(); db.language = 'ja'; tablet.save(db); expect((await tablet.service.snapshot()).committed).toMatchObject({ sequence: 2 })
    const backupA = structuredClone(tablet.db()), lineageA = JSON.parse(await readFile(join(tablet.dataRoot, 'risubard', 'nas-sync', 'lineage.json'), 'utf8')).lineage
    db = tablet.db(); db.language = 'en'; db.modules.push({ id: 'late', name: '나중 모듈', lorebook: [] }); tablet.save(db); expect((await tablet.service.snapshot()).committed).toMatchObject({ sequence: 3 })
    const lineageB = structuredClone(tablet.service.state().lineage)
    const crashing = tablet.make({ beforeSnapshotCommit: async () => { throw new Error('power loss before commit') } })
    const mark = crashing.markRestore({ source: 'backup-import', restoreId: 'backup-a', lineage: lineageA }); tablet.save(backupA)
    await expect(crashing.snapshot()).rejects.toThrow('power loss before commit')
    expect(crashing.state().pendingLineage).toMatchObject({ restore: mark }); expect(crashing.store().status().sequence).toBe(3) // nothing committed
    const reopened = tablet.make()
    expect(reopened.state().pendingLineage).toBeNull()
    expect(reopened.state().pendingRestore).toEqual(mark) // the restore is still pending
    expect(reopened.state().lineage).toEqual(lineageB) // nothing dropped (the module's lineage is still there)
    const snap = await reopened.snapshot()
    expect(snap.provenance).toBe('restored-backup'); expect(snap.restore).toEqual(mark); expect(snap.committed).toMatchObject({ sequence: 4 })
    expect(reopened.state().pendingRestore).toBeNull(); expect(Object.keys(reopened.state().lineage).some(k => k.endsWith('#late'))).toBe(false)
    const s = reopened.store(), settingsKey = Object.keys(lineageA).find(k => k.startsWith('settings\n') && 'language' in (s.graph.get(lineageA[k])?.content ?? {}))!
    expect(s.graph.get(reopened.state().lineage[settingsKey]).parents).toEqual([lineageA[settingsKey]])
})

test('publish and pull are single-flight on the server: a concurrent call joins the run in progress (no duplicate uploads), a failed or rejected run is not sticky, and a run in flight finishes after disable while the next call is refused until re-enable', async t => {
    const dav = fixtureDav()
    let hold: Promise<void> | null = null, release = () => {}, failPut = false, failList = false
    const tablet = await device(t, dav, 'tablet', baseDb(), MASTER, { fetch: async (url: string, init?: any) => {
        if (init?.method === 'PUT' && hold) await hold
        if (init?.method === 'PUT' && failPut) throw new Error('PUT refused') // transport catches per entry → report.failed (real helper behaviour)
        if (init?.method === 'PROPFIND' && failList) throw new Error('listing failed') // pull has no catch here → rejects
        return dav.fetch(url, init)
    } })
    tablet.storage.kvSet('assets/icon.png', Buffer.from('icon-bytes')); tablet.inlays.set('draw1', { metadata: { type: 'image', ext: 'png', name: '그림' }, data: Buffer.from('inlay-draw1-bytes') })
    tablet.storage.kvSet('inlay_meta/draw1', Buffer.from(JSON.stringify({ createdAt: 100, updatedAt: 200, charId: 'card', chatId: 'chat' })))
    tablet.service.enable({ workspaceId: 'ws-fixture' }); await tablet.service.snapshot()
    hold = new Promise<void>(r => { release = r })
    const first = tablet.service.publish(), second = tablet.service.publish()
    expect(second).toBe(first) // joined: one run, one result for both callers
    release(); hold = null
    const report = await first; expect(report.failed).toEqual([]); expect(report.stored).toHaveLength(1)
    const puts = dav.log.filter(l => l.startsWith('PUT ')); expect(new Set(puts).size).toBe(puts.length) // every object uploaded exactly once
    const again = tablet.service.publish(); expect(again).not.toBe(first); expect((await again).stored).toEqual([]) // a completed run is not sticky; awaited so nothing races the edits below
    const pullA = tablet.service.pull(), pullB = tablet.service.pull(); expect(pullB).toBe(pullA); expect((await pullA).admitted).toEqual([]) // pull joins the same way
    const renamed = (name: string) => { const db = baseDb(); db.characters[0].name = name; return db }
    tablet.save(renamed('표본2')); expect((await tablet.service.snapshot()).committed).not.toBeNull()
    failPut = true; const failed = await tablet.service.publish(); expect(failed.failed.length).toBeGreaterThan(0); expect(failed.stored).toEqual([])
    failPut = false; clock += 60 * 60 * 1000; const retried = await tablet.service.publish(); // past the store's retry schedule expect(retried.failed).toEqual([]); expect(retried.stored).toHaveLength(1) // fresh run after a failed report
    failList = true; await expect(tablet.service.pull()).rejects.toThrow('listing failed'); failList = false
    expect((await tablet.service.pull()).admitted).toEqual([]) // fresh run after a rejection
    tablet.save(renamed('표본3')); expect((await tablet.service.snapshot()).committed).not.toBeNull()
    hold = new Promise<void>(r => { release = r })
    const running = tablet.service.publish()
    tablet.service.disable()
    expect(() => tablet.service.publish()).toThrow('NAS 동기화가 꺼져 있어요') // refused while disabled; the run in flight is not killed
    release(); hold = null
    expect((await running).failed).toEqual([]); expect((await running).stored).toHaveLength(1) // the immutable upload finished safely
    tablet.service.enable({ workspaceId: 'ws-fixture' })
    expect((await tablet.service.publish()).stored).toEqual([]) // nothing left over, no duplicate
})

test('re-mirroring device-local layout into the active theme preset after an apply is not a local edit (no phantom revision), and a joining device receives theme presets without layout fields', async t => {
    const dav = fixtureDav()
    const themed = (zoom: number, icon: number) => baseDb({ themePresets: [{ name: '테마', font: 'f', lineHeight: 1.4, zoomsize: zoom, iconsize: icon }], themePresetsId: 0 })
    const tablet = await device(t, dav, 'tablet', themed(100, 50))
    tablet.storage.kvSet('assets/icon.png', Buffer.from('icon-bytes')); tablet.inlays.set('draw1', { metadata: { type: 'image', ext: 'png', name: '그림' }, data: Buffer.from('inlay-draw1-bytes') })
    tablet.storage.kvSet('inlay_meta/draw1', Buffer.from(JSON.stringify({ createdAt: 100, updatedAt: 200, charId: 'card', chatId: 'chat' })))
    tablet.service.enable({ workspaceId: 'ws-fixture' })
    expect((await tablet.service.snapshot()).committed).toMatchObject({ sequence: 1 }); expect((await tablet.service.publish()).failed).toEqual([])
    // The device's own mirror rewrites layout fields of the active entry (zoom 100 → 70, icon 50 → 60): nothing to sync.
    tablet.save(themed(70, 60)); clock += 1000
    expect((await tablet.service.snapshot()).committed).toBeNull()
    // A real change to a synced field of the entry still commits.
    const db = themed(70, 60); db.themePresets[0].lineHeight = 1.6; tablet.save(db); clock += 1000
    expect((await tablet.service.snapshot()).committed).toMatchObject({ sequence: 2 }); expect((await tablet.service.publish()).failed).toEqual([])
    const phone = await device(t, dav, 'phone', baseDb({ themePresets: undefined, themePresetsId: undefined }))
    phone.service.enable({ workspaceId: 'ws-fixture' }); await phone.service.pull(); clock += 1000
    const plan = await phone.service.plan()
    const theme = plan.settings?.themePresets
    expect(theme).toEqual([{ name: '테마', font: 'f', lineHeight: 1.6 }]) // layout fields never travel; the client keeps its own
})

test('the sync service pins the NAS route for a whole publish and a whole pull: a network flip mid-publish never moves a request to the other endpoint; the next run follows the new network; one credential, one namespace', async t => {
    const home = fixtureDav('https://nas-home.invalid:5006/home/RisuAI/'), external = fixtureDav('https://nas.invalid/home/RisuAI/')
    const hosts: string[] = [], auth = new Set<string>()
    const fetch = async (url: string, init?: any) => { hosts.push(new URL(url).host); auth.add(init?.headers?.Authorization ?? ''); return url.startsWith(home.base) ? home.fetch(url, init) : external.fetch(url, init) }
    const secrets = { get: async () => ({ url: external.base, homeUrl: home.base, username: 'fixture', password: 'fixture-password', homeSsids: ['Fixture Home'] }) }
    const { createNasRoute } = require('./nas-route.cjs')
    const nasRoute = createNasRoute({ secrets, probe: async () => false })
    nasRoute.report({ transport: 'wifi', ssid: 'Fixture Home' })
    const tablet = await device(t, home, 'tablet', baseDb(), MASTER, { secrets, fetch, nasRoute })
    tablet.storage.kvSet('assets/icon.png', Buffer.from('icon-bytes')); tablet.inlays.set('draw1', { metadata: { type: 'image', ext: 'png', name: '그림' }, data: Buffer.from('inlay-draw1-bytes') })
    tablet.storage.kvSet('inlay_meta/draw1', Buffer.from(JSON.stringify({ createdAt: 100, updatedAt: 200, charId: 'card', chatId: 'chat' })))
    tablet.service.enable({ workspaceId: 'ws-fixture' }); await tablet.service.snapshot()
    home.hooks.push(async ({ method }) => { if (method === 'PUT') nasRoute.report({ transport: 'wifi', ssid: 'Cafe' }); return null }) // flips during the first upload
    const report = await tablet.service.publish(); expect(report.failed).toEqual([]); expect(report.stored).toHaveLength(1)
    expect(new Set(hosts)).toEqual(new Set(['nas-home.invalid:5006'])); expect(external.log).toEqual([])
    hosts.length = 0
    expect((await tablet.service.pull()).admitted).toEqual([]) // the next run: unknown-to-home network → external, every request there
    expect(new Set(hosts)).toEqual(new Set(['nas.invalid']))
    expect(auth.size).toBe(1)
})

test('applying a plan with an asset keeps the admitted blob in the sync store (the KV import consumes a staged copy, never the blob): a later commit that pins the same asset plans without "missing material" and applies (live PC: 134 module assets)', async t => {
    const dav = fixtureDav(), tablet = await seedTablet(t, dav)
    const phone = await device(t, dav, 'phone', { language: 'ko', botPresets: [], modules: [], personas: [], loreBook: [], plugins: [], characters: [], openAIKey: 'phone-local-key', textAreaSize: 33, account: { token: 'phone-account', id: 'p', data: {} } })
    phone.service.enable({ workspaceId: 'ws-fixture' }); await phone.service.pull()
    const iconHash = createHash('sha256').update('icon-bytes').digest('hex')
    const plan = await phone.service.plan(); expect(plan.pending).toEqual([])
    expect(phone.service.store().hasBlob(iconHash)).toBe(true) // media staged into the KV before the client saves
    expect(phone.storage.kvGet('assets/icon.png')).toEqual(Buffer.from('icon-bytes'))
    expect(phone.service.store().hasBlob(iconHash)).toBe(true) // regression: the real file KV import moved the blob file away
    const db = phone.db(); await phone.service.arm(plan.transaction, echoOf(plan, applyPlanToDb(structuredClone(db), plan))); phone.save(applyPlanToDb(db, plan))
    expect((await phone.service.finish(plan.transaction, true)).state).toBe('applied')
    // The tablet edits the character (same icon): the next plan pins the same asset blob and must not report it missing.
    const tdb = tablet.db(); tdb.characters[0].desc = '설명 수정'; tablet.save(tdb)
    const snap = await tablet.service.snapshot(); expect(snap.committed).toBeTruthy(); expect((await tablet.service.publish()).failed).toEqual([])
    const pulled = await phone.service.pull(); expect(pulled.admitted).toHaveLength(1)
    const next = await phone.service.plan()
    expect(next.pending).toEqual([]); expect(next.characters[0].fields.desc).toBe('설명 수정')
    const db2 = phone.db(); await phone.service.arm(next.transaction, echoOf(next, applyPlanToDb(structuredClone(db2), next))); phone.save(applyPlanToDb(db2, next))
    expect((await phone.service.finish(next.transaction, true)).state).toBe('applied'); expect(phone.service.store().hasBlob(iconHash)).toBe(true)
    expect(phone.db().characters[0].desc).toBe('설명 수정'); expect(phone.storage.kvGet('assets/icon.png')).toEqual(Buffer.from('icon-bytes'))
})

test('startup recovery of a persisted plan is independent of the auto-sync switch: while disabled, recovery() lists it, finish rolls back a prepared plan, commits a verified saving plan, retains a partial one for hold; sync is never re-enabled and no journal is dropped (live .77 tablet)', async t => {
    const dav = fixtureDav(); await seedTablet(t, dav)
    // Prepared plan, then the user disabled sync, then restart: rollback instead of "NAS 동기화가 꺼져 있어요".
    const a = await device(t, dav, 'phone-a', baseDb({ openAIKey: 'a-key' }))
    a.service.enable({ workspaceId: 'ws-fixture' }); await a.service.pull(); const planA = await a.service.plan()
    a.service.disable(); expect(a.service.status().enabled).toBe(false)
    const reA = a.make(); expect(await reA.recovery()).toEqual([{ transaction: planA.transaction, phase: 'prepared' }])
    expect((await reA.finish(planA.transaction)).state).toBe('rolled-back'); expect(reA.state().plan).toBeNull(); expect(reA.state().enabled).toBe(false)
    expect(() => reA.assertWrite({ path: '/api/db/flush', headers: {} })).not.toThrow()
    // Saving plan whose canonical save completed: commits while disabled, ACKs locally, stays disabled.
    const b = await device(t, dav, 'phone-b', baseDb({ openAIKey: 'b-key' }))
    b.service.enable({ workspaceId: 'ws-fixture' }); await b.service.pull(); const planB = await b.service.plan(); const dbB = b.db()
    await b.service.arm(planB.transaction, echoOf(planB, applyPlanToDb(structuredClone(dbB), planB))); b.save(applyPlanToDb(dbB, planB))
    b.service.disable(); const reB = b.make(); expect(reB.state().plan.phase).toBe('saving')
    expect((await reB.finish(planB.transaction)).state).toBe('applied'); expect(reB.store().pendingApply()).toEqual([]); expect(reB.state().enabled).toBe(false)
    // Saving plan whose save deviated: PARTIAL (not the disabled error), journal and recovery copy kept, hold works while disabled.
    const c = await device(t, dav, 'phone-c', baseDb({ openAIKey: 'c-key' }))
    c.service.enable({ workspaceId: 'ws-fixture' }); await c.service.pull(); const planC = await c.service.plan(); const dbC = c.db()
    await c.service.arm(planC.transaction, echoOf(planC, applyPlanToDb(structuredClone(dbC), planC)))
    // Deviate a PLANNED entity (a settings key this plan carries), not an unplanned local chat: the saved state then neither verifies nor equals the baseline.
    const plannedKey = Object.keys(planC.settings).find(k => typeof planC.settings[k] === 'string'); expect(plannedKey).toBeTruthy()
    const partial = applyPlanToDb(structuredClone(dbC), planC); partial[plannedKey!] = planC.settings[plannedKey!] + '-half-saved'; c.save(partial)
    c.service.disable(); const reC = c.make()
    expect(await reC.recovery()).toEqual([{ transaction: planC.transaction, phase: 'saving' }])
    await expect(reC.finish(planC.transaction)).rejects.toThrow(expect.objectContaining({ code: 'NAS_SYNC_PARTIAL' }))
    const journalC = join(c.dataRoot, 'nas-sync', 'apply', `${planC.transaction}.json`)
    expect(existsSync(journalC)).toBe(true); expect(reC.state().plan.phase).toBe('saving')
    expect(await reC.hold(planC.transaction)).toMatchObject({ state: 'recovery-held' })
    expect(reC.state().plan).toBeNull(); expect(reC.state().retained).toHaveLength(1); expect(reC.state().enabled).toBe(false)
    expect(existsSync(journalC)).toBe(true); expect(existsSync(join(c.dataRoot, 'nas-sync', 'recovery', planC.transaction, 'before.json'))).toBe(true)
    // Enabled-only operations are still refused while disabled.
    await expect(reC.plan()).rejects.toThrow(/꺼져 있어요/); await expect(reC.snapshot()).rejects.toThrow(/꺼져 있어요/)
    for (const d of [a, b, c]) await assertNoSentinel(d.dataRoot)
})

test('live .78 root cause: a joining device whose prompt-presets stayed vault-pending until its key arrived forks its own presets as a genesis sibling (conflict for bootstrap), never as the tablet head\'s successor; the tablet keeps its presets and sees the conflict', async t => {
    const dav = fixtureDav(), tablet = await seedTablet(t, dav)
    const presetsRoot = 'settings\ngroup\nprompt-presets', tabletHead = tablet.service.store().graph.classify(presetsRoot).heads[0]
    // Phone: fresh install with one default preset and no shared key yet (its vault holds a locally generated master).
    const phone = await device(t, dav, 'phone', { language: 'ko', botPresets: [{ id: 'default', name: '기본', openAIKey: '' }], botPresetsId: 0, modules: [], personas: [], loreBook: [], plugins: [], characters: [], openAIKey: '', textAreaSize: 33, account: { token: '', id: 'p', data: {} } }, OTHER_MASTER)
    phone.service.enable({ workspaceId: 'ws-fixture' }); await phone.service.pull()
    const first = await phone.service.plan()
    expect(first.pending.map((p: any) => p.root)).toContain(presetsRoot); expect(first.pending.find((p: any) => p.root === presetsRoot).reason).toBe('vault') // keyless: public roots apply, secret groups wait
    // The plugin record is vault-pending (sealed realArg) while the public activation group names it: the group waits instead of planning an
    // enabled flag the client cannot apply (regression: finish verified {} against {plug: true} → PARTIAL; live phone had the plugin preinstalled).
    const activationRoot = 'settings\ngroup\nactivation'
    expect(first.pending.find((p: any) => p.root === 'library\nplugin\nplug')?.reason).toBe('vault')
    expect(first.pending.find((p: any) => p.root === activationRoot)).toMatchObject({ reason: 'plugin-pending', pending: ['plug'] })
    expect(first.pluginEnabled).toBeNull(); expect(first.settings).not.toHaveProperty('enabledModules'); expect(first.lineage).not.toHaveProperty(activationRoot + '#activation')
    const db = phone.db(); await phone.service.arm(first.transaction, echoOf(first, applyPlanToDb(structuredClone(db), first))); phone.save(applyPlanToDb(db, first))
    expect((await phone.service.finish(first.transaction, true)).state).toBe('applied'); expect(phone.db().botPresets.map((p: any) => p.id)).toEqual(['default'])
    // The key arrives (grant) → coordinator order: snapshot + publish BEFORE pull/apply.
    await vaultMasterStore(phone.dataRoot, androidProtector('11'.repeat(32))).importMaster(MASTER, { replace: true })
    const keyed = phone.make(); const snap = await keyed.snapshot(); expect(snap.committed).toBeTruthy()
    const mine = keyed.store().state().commits.flatMap((c: any) => c.revisions).map((id: string) => keyed.store().graph.get(id)).find((r: any) => r.root === 'prompt-presets')
    expect(mine).toBeTruthy(); expect(mine.parents).toEqual([]) // regression: was [tabletHead] — a linear successor every device then applied
    expect(keyed.store().graph.classify(presetsRoot)).toMatchObject({ state: 'diverged' })
    expect((await keyed.publish()).failed).toEqual([])
    // Tablet pulls: the root is a conflict, not a linear update; its presets stay and the conflict is reported for resolution.
    await tablet.service.pull(); const plan = await tablet.service.plan()
    expect(plan.settings?.botPresets).toBeUndefined(); expect(tablet.db().botPresets.map((p: any) => p.id)).toEqual(['p1']) // the plan is empty or carries no preset change
    const conflict = tablet.service.conflicts().find((c: any) => c.root === presetsRoot); expect(conflict?.state).toBe('diverged'); expect(conflict.variants).toHaveLength(2)
    const heads = tablet.service.store().graph.classify(presetsRoot).heads; expect(heads).toHaveLength(2); expect(heads).toEqual(expect.arrayContaining([tabletHead, mine.id]))
    // restore-revision on the diverged root: duplicated heads are not "every head" (exact set); a device whose key cannot open the sealed
    // values is refused before anything is queued; with the exact set the tablet's revision becomes the resolution of both heads.
    await expect(tablet.service.restoreRevision({ root: presetsRoot, revision: tabletHead, expectedHeads: [tabletHead, tabletHead], confirmed: true })).rejects.toThrow(expect.objectContaining({ code: 'HEADS_CHANGED' }))
    const stranger = await device(t, dav, 'stranger', baseDb({ openAIKey: 'x-key' }), OTHER_MASTER); stranger.service.enable({ workspaceId: 'ws-fixture' }); await stranger.service.pull()
    await expect(stranger.service.restoreRevision({ root: presetsRoot, revision: tabletHead, expectedHeads: heads, confirmed: true })).rejects.toThrow(expect.objectContaining({ code: 'VAULT_PENDING' }))
    expect(stranger.service.state().localApply).toEqual([]); expect(stranger.service.store().graph.classify(presetsRoot).heads).toEqual(expect.arrayContaining(heads))
    const r = await tablet.service.restoreRevision({ root: presetsRoot, revision: tabletHead, expectedHeads: [...heads].reverse(), confirmed: true })
    expect(tablet.service.store().graph.get(r.restored).parents).toEqual(expect.arrayContaining(heads)); expect(tablet.service.store().graph.classify(presetsRoot)).toMatchObject({ state: 'live', heads: [r.restored] })
    // The designed joining path on the phone: bootstrap to the tablet's values resolves its genesis forks (activation included); the next plan
    // then carries the plugin record AND its enabled flag together, and the saved state verifies.
    const boot = await keyed.bootstrap({ authorityDevice: tablet.service.store().identity().deviceId }); expect(boot.resolved).toBeGreaterThan(0)
    const second = await keyed.plan(); expect(second.pending.filter((p: any) => p.reason === 'plugin-pending')).toEqual([])
    expect(second.plugins.map((p: any) => p.name)).toEqual(['plug']); expect(second.pluginEnabled).toEqual({ plug: true })
    const db2 = phone.db(); await keyed.arm(second.transaction, echoOf(second, applyPlanToDb(structuredClone(db2), second))); phone.save(applyPlanToDb(db2, second))
    expect((await keyed.finish(second.transaction, true)).state).toBe('applied'); expect(phone.db().plugins.map((p: any) => [p.name, p.enabled])).toEqual([['plug', true]])
    for (const d of [tablet, phone, stranger]) await assertNoSentinel(d.dataRoot)
})

test('restore-revision: a past settings-group revision is re-published as the successor of every current head with its own content/dependency references; the device materializes it through the plan and a peer applies it linearly; refusals: unconfirmed, non-settings root, foreign revision, stale heads, pending plan, already current', async t => {
    const dav = fixtureDav(), tablet = await seedTablet(t, dav)
    const presetsRoot = 'settings\ngroup\nprompt-presets', graph = () => tablet.service.store().graph
    const original = graph().classify(presetsRoot).heads[0], originalRev = graph().get(original)
    // A later edit (the "wrong" linear successor, as the phone's publication was).
    const tdb = tablet.db(); tdb.botPresets = [{ id: 'default', name: '기본', openAIKey: '' }]; tdb.botPresetsId = 0; tablet.save(tdb)
    expect((await tablet.service.snapshot()).committed).toBeTruthy(); expect((await tablet.service.publish()).failed).toEqual([])
    const wrong = graph().classify(presetsRoot).heads; expect(wrong).toHaveLength(1); expect(wrong[0]).not.toBe(original)
    const pc = await device(t, dav, 'pc', baseDb({ openAIKey: 'pc-key' })); pc.service.enable({ workspaceId: 'ws-fixture' }); await pc.service.pull()
    const pcPlan = await pc.service.plan(); const pcDb = pc.db(); await pc.service.arm(pcPlan.transaction, echoOf(pcPlan, applyPlanToDb(structuredClone(pcDb), pcPlan))); pc.save(applyPlanToDb(pcDb, pcPlan))
    expect((await pc.service.finish(pcPlan.transaction, true)).state).toBe('applied'); expect(pc.db().botPresets.map((p: any) => p.id)).toEqual(['default'])
    // Refusals (nothing committed).
    const ok = { root: presetsRoot, revision: original, expectedHeads: wrong, confirmed: true }
    await expect(tablet.service.restoreRevision({ ...ok, confirmed: undefined })).rejects.toThrow(/confirmation/)
    await expect(tablet.service.restoreRevision({ ...ok, root: 'play\nchat\nchat' })).rejects.toThrow(/Only a settings group/)
    await expect(tablet.service.restoreRevision({ ...ok, root: 'library\ncharacter\ncard' })).rejects.toThrow(/Only a settings group/)
    const otherRoot = graph().rootKeys().find((k: string) => k.startsWith('settings\ngroup\n') && k !== presetsRoot)
    await expect(tablet.service.restoreRevision({ ...ok, root: otherRoot })).rejects.toThrow(/does not belong/)
    await expect(tablet.service.restoreRevision({ ...ok, revision: 'f'.repeat(64) })).rejects.toThrow(/does not belong/)
    await expect(tablet.service.restoreRevision({ ...ok, expectedHeads: [original] })).rejects.toThrow(expect.objectContaining({ code: 'HEADS_CHANGED', heads: wrong }))
    await expect(tablet.service.restoreRevision({ ...ok, expectedHeads: undefined })).rejects.toThrow(/heads changed/)
    await expect(tablet.service.restoreRevision({ ...ok, revision: wrong[0] })).rejects.toThrow(/already has this content/)
    expect(graph().classify(presetsRoot).heads).toEqual(wrong); expect(tablet.service.state().localApply).toEqual([])
    // The restore: new head, parents = all current heads, content/dependencies identical to the past revision (same hashes), queued for local apply.
    const r = await tablet.service.restoreRevision(ok)
    const restored = graph().get(r.restored)
    expect(restored.parents).toEqual(wrong); expect(restored.contentHash).toBe(originalRev.contentHash); expect(restored.dependencyHash).toBe(originalRev.dependencyHash); expect(restored.id).not.toBe(original)
    expect(graph().classify(presetsRoot)).toMatchObject({ state: 'live', heads: [r.restored] }); expect(tablet.service.state().localApply).toEqual([presetsRoot])
    // Production sequence: the browser was closed during the restores; the next UI cycle runs snapshot BEFORE plan. The unchanged local DB
    // (still the wrong content, equal to its recorded lineage head) publishes nothing and leaves the restored head and the queued apply intact.
    const idle = await tablet.service.snapshot(); expect(idle.committed).toBeNull()
    expect(graph().classify(presetsRoot)).toMatchObject({ state: 'live', heads: [r.restored] }); expect(tablet.service.state().localApply).toEqual([presetsRoot])
    const pcChatsBefore = pc.db().characters[0].chats.map((c: any) => c.id)
    // Pending plan blocks a second restore; the plan materializes the restored content locally.
    const plan = await tablet.service.plan(); expect(plan.settings.botPresets.map((p: any) => p.id)).toEqual(['p1'])
    await expect(tablet.service.restoreRevision({ ...ok, expectedHeads: [r.restored] })).rejects.toThrow(/pending sync apply/)
    const db2 = tablet.db(); await tablet.service.arm(plan.transaction, echoOf(plan, applyPlanToDb(structuredClone(db2), plan))); tablet.save(applyPlanToDb(db2, plan))
    expect((await tablet.service.finish(plan.transaction, true)).state).toBe('applied'); expect(tablet.db().botPresets.map((p: any) => p.id)).toEqual(['p1']); expect(tablet.service.state().localApply).toEqual([])
    expect((await tablet.service.publish()).failed).toEqual([])
    // The peer applies it as a linear descendant: presets (and their sealed key) are back, chats untouched.
    const pulled = await pc.service.pull(); expect(pulled.admitted).toHaveLength(1)
    const next = await pc.service.plan(); expect(next.pending).toEqual([]); expect(next.settings.botPresets.map((p: any) => p.id)).toEqual(['p1']); expect(next.chats).toEqual([])
    const db3 = pc.db(); await pc.service.arm(next.transaction, echoOf(next, applyPlanToDb(structuredClone(db3), next))); pc.save(applyPlanToDb(db3, next))
    expect((await pc.service.finish(next.transaction, true)).state).toBe('applied'); expect(pc.db().botPresets[0]).toMatchObject({ id: 'p1', openAIKey: S('preset') })
    expect(pc.db().characters[0].chats.map((c: any) => c.id)).toEqual(pcChatsBefore) // the recovery touched no chat
    for (const d of [tablet, pc]) await assertNoSentinel(d.dataRoot)
})

test('pending-roots: the admitted-but-unapplied work is listed by root (chat roots with their local chat ids, branches included) without creating a plan or consuming anything, and it is still there after a service restart; applying clears it', async t => {
    const dav = fixtureDav(), tablet = await seedTablet(t, dav)
    const phone = await device(t, dav, 'phone', baseDb({ openAIKey: 'phone-key' }))
    phone.service.enable({ workspaceId: 'ws-fixture' })
    expect((await phone.service.pendingRoots()).roots).toEqual([]) // nothing pulled yet
    await phone.service.pull()
    const view = phone.service.pendingRoots()
    expect(view.plan).toBeNull(); expect(phone.service.state().plan).toBeNull() // read-only: no plan was prepared
    const chat = view.roots.find((r: any) => r.domain === 'play' && r.type === 'chat'); expect(chat).toMatchObject({ root: 'chat', chatIds: ['chat'] })
    expect(view.roots.some((r: any) => r.domain === 'settings' && r.root === 'prompt-presets')).toBe(true)
    expect(view.roots.some((r: any) => r.type === 'character' && r.root === 'card')).toBe(true)
    const again = phone.make(); expect(again.pendingRoots().roots.length).toBe(view.roots.length) // durable across restart: received work waits for a safe apply
    const plan = await again.plan(); expect(again.pendingRoots().plan).toBe(plan.transaction)
    const db = phone.db(); await again.arm(plan.transaction, echoOf(plan, applyPlanToDb(structuredClone(db), plan))); phone.save(applyPlanToDb(db, plan))
    expect((await again.finish(plan.transaction, true)).state).toBe('applied')
    expect(again.pendingRoots()).toEqual({ roots: [], plan: null })
    void tablet
})

test('personas: two devices add different entries, merge without a library choice, preserve local selection/note, restart and no echo', async t => {
    const dav = fixtureDav(); const a = { id: 'a', name: 'A', personaPrompt: 'A prompt', note: 'A note' };
    const initial = { characters: [], personas: [a], selectedPersona: 0, username: 'A', userIcon: '', personaPrompt: a.personaPrompt, userNote: a.note };
    const left = await device(t, dav, 'merge-left', initial), right = await device(t, dav, 'merge-right', initial);
    for (const d of [left, right]) d.service.enable({ workspaceId: 'persona-merge' });
    await left.service.snapshot(); await left.service.publish(); await right.service.pull(); await settle(right);
    const l = left.db(), r = right.db();
    l.personas.push({ id: 'b', name: 'B', personaPrompt: 'B prompt', note: 'B note' }); l.selectedPersona = 1; l.userNote = 'B note'; l.username = 'B'; l.personaPrompt = 'B prompt'; left.save(l);
    r.personas.push({ id: 'c', name: 'C', personaPrompt: 'C prompt', note: 'C note' }); right.save(r);
    for (const d of [left, right]) { await d.service.snapshot(); await d.service.publish(); }
    await right.service.pull(); const plan = await settle(right);
    expect(plan.pending).toEqual([]); expect(right.db().personas.map((p: any) => p.id)).toEqual(['a', 'c', 'b']); // local A,C order survives; only B is appended
    expect(right.db().personas[right.db().selectedPersona].id).toBe('a'); expect(right.db().userNote).toBe('A note');
    await right.service.publish(); await left.service.pull(); await settle(left);
    expect(left.db().personas.map((p: any) => p.id)).toEqual(['a', 'b', 'c']); expect(left.db().personas[left.db().selectedPersona].id).toBe('b'); expect(left.db().userNote).toBe('B note');
    expect((await left.make().snapshot()).committed).toBeNull(); expect((await right.service.snapshot()).committed).toBeNull();
    const changedSelection = left.db(); changedSelection.selectedPersona = 0; changedSelection.username = 'A'; changedSelection.userNote = 'A note'; changedSelection.personaPrompt = 'A prompt'; left.save(changedSelection);
    expect((await left.service.snapshot()).committed).toBeNull();
})

test('legacy userNote revisions are acknowledged without overwriting the selected persona or becoming conflicts', async t => {
    const { makeRevision } = require('./nas-sync-core.cjs'); const dav = fixtureDav();
    const d = await device(t, dav, 'note-legacy', { characters: [], personas: [{ id: 'p', name: 'P', personaPrompt: 'prompt', note: 'keep' }], selectedPersona: 0, userNote: 'keep' });
    d.service.enable({ workspaceId: 'note-legacy' });
    const legacy = makeRevision({ domain: 'settings', type: 'group', root: 'userNote', content: { userNote: 'another persona note' } });
    d.service.store().commit([legacy]);
    const peer = await device(t, dav, 'note-peer', { characters: [], personas: [], userNote: '' }); peer.service.enable({ workspaceId: 'note-legacy' });
    await d.service.publish(); await peer.service.pull(); await settle(peer);
    expect(peer.db().userNote).toBe(''); expect(peer.service.pendingRoots().roots).toEqual([]);
    expect(d.service.conflicts().some((c: any) => c.id === 'userNote')).toBe(false);
    await expect(peer.service.restoreRevision({ root: 'settings\ngroup\nuserNote', confirmed: true })).rejects.toThrow(/persona note/);
    expect(d.service.store().graph.get(legacy.id)).toBeTruthy();
})

test('receipt-only message differences are state conflicts, not new conversation branches', async t => {
    const dav = fixtureDav(), left = await seedTablet(t, dav)
    const right = await device(t, dav, 'receipt-right', { characters: [], personas: [], modules: [], plugins: [], botPresets: [] })
    right.service.enable({ workspaceId: 'ws-fixture' }); await right.service.pull(); await settle(right)
    const receipts = new Map()
    for (const [d, eventId] of [[left, 'left-event'], [right, 'right-event']] as const) {
        const db = d.db(), receipt = { sourceMessageIds: ['m1'], eventIds: [eventId], changes: [], warnings: [], recordedAt: '2026-10-22T00:00:00Z' }
        db.characters[0].chats[0].message[0].risubardCanonicalReceipt = receipt; d.save(db); receipts.set(d, receipt)
        await d.service.snapshot(); await d.service.publish()
    }
    await left.service.pull(); await right.service.pull()
    const conflict = left.service.conflicts().find((c: any) => c.type === 'chat')
    expect(conflict.sameMessages).toBe(true); expect(conflict.differs).toContain('state'); expect(conflict.differs).not.toContain('messages')
    expect(conflict.state).not.toBe('branches-preserved')
    const plan = await right.service.plan()
    expect(plan.chats ?? []).toHaveLength(0); expect(plan.pending.some((p: any) => p.reason === 'same-messages')).toBe(true)
    for (const d of [left, right]) {
        expect(d.db().characters[0].chats).toHaveLength(1)
        expect(d.db().characters[0].chats[0].message[0].risubardCanonicalReceipt).toEqual(receipts.get(d))
    }
    const edited = right.db(); edited.characters[0].chats[0].message[0].data += ' 실제 본문 변경'; right.save(edited)
    await right.service.snapshot(); await right.service.publish(); await left.service.pull()
    expect(left.service.conflicts().find((c: any) => c.type === 'chat')).toMatchObject({ sameMessages: false, differs: expect.arrayContaining(['messages']) })
})

test('same messages with two Wiki revisions do not create duplicate chats, expose no message content, and show Wiki counts after receipt', async t => {
    const dav = fixtureDav();
    const left = await seedTablet(t, dav); const right = await device(t, dav, 'wiki-right', { characters: [], personas: [], modules: [], plugins: [], botPresets: [] });
    right.service.enable({ workspaceId: 'ws-fixture' }); await right.service.pull(); await settle(right);
    for (const [d, text] of [[left, '왼쪽 기억'], [right, '오른쪽 기억']] as const) {
        await d.memory.saveMarkdownWikiTurn({ characterId: 'card', chatId: 'chat', sourceMessageIds: ['m1'], markdown: '## 사건\n\n' + text });
        await d.service.snapshot(); await d.service.publish();
    }
    await left.service.pull(); await right.service.pull();
    const conflict = left.service.conflicts().find((c: any) => c.type === 'chat');
    expect(conflict.sameMessages).toBe(true); expect(conflict.differs).toContain('wiki'); expect(conflict.title).toContain('표본');
    expect(conflict.variants.every((v: any) => !('content' in v))).toBe(true);
    const overview = await right.service.overview(); expect(overview.peerApplied).toBe('unconfirmed'); expect(overview.chats[0].wikiFiles).toBeGreaterThan(0);
    const plan = await right.service.plan(); expect(plan.chats ?? []).toHaveLength(0); expect(plan.pending.some((p: any) => p.reason === 'same-messages')).toBe(true);
    expect(right.db().characters[0].chats).toHaveLength(1);
    const newcomer = await device(t, dav, 'wiki-newcomer', { characters: [], personas: [], modules: [], plugins: [], botPresets: [] });
    newcomer.service.enable({ workspaceId: 'ws-fixture' }); await newcomer.service.pull();
    const held = await settle(newcomer); expect(held.pending.some((p: any) => p.reason === 'same-messages')).toBe(true);
    const choice = newcomer.service.conflicts().find((c: any) => c.type === 'chat');
    expect(choice.title).toContain('표본'); expect(choice.sameMessages).toBe(true);
    await newcomer.service.resolveConflict({ root: choice.root, keep: choice.variants[0].heads[0] }); await settle(newcomer);
    expect(newcomer.db().characters[0].chats).toHaveLength(1);
})


test('last applied timestamp requires saved data and finished memory, survives reopen, and is not changed by receiving', async t => {
    const dav = fixtureDav(); await seedTablet(t, dav)
    const phone = await device(t, dav, 'last-apply', { characters: [], personas: [], modules: [], plugins: [], botPresets: [] })
    phone.service.enable({ workspaceId: 'ws-fixture' })
    expect(phone.service.status().lastAppliedAt).toBeNull()
    await phone.service.pull(); expect(phone.service.status().lastAppliedAt).toBeNull()
    const plan = await phone.service.plan(), db = applyPlanToDb(phone.db(), plan)
    await phone.service.arm(plan.transaction, echoOf(plan, db))
    expect(phone.service.status().lastAppliedAt).toBeNull()
    phone.save(db); await phone.service.finish(plan.transaction, true)
    expect(phone.service.status().lastAppliedAt).toBe(clock)
    await phone.service.pull(); expect(phone.service.status().lastAppliedAt).toBe(clock)
    expect((await phone.service.finish(plan.transaction, true)).completedAt).toBe(clock)
    expect(phone.make().status().lastAppliedAt).toBe(clock)
})


test('a lost rollback response has a durable receipt and never clears a newer plan, including orphan journal cleanup', async t => {
    const dav = fixtureDav(); await seedTablet(t, dav)
    const phone = await device(t, dav, 'rollback-receipt', { characters: [], personas: [], modules: [], plugins: [], botPresets: [] })
    phone.service.enable({ workspaceId: 'ws-fixture' }); await phone.service.pull()
    const plan = await phone.service.plan(), before = JSON.stringify(phone.db())
    await phone.service.arm(plan.transaction, echoOf(plan, applyPlanToDb(structuredClone(phone.db()), plan)))
    // Capture the actual journal path through the fixture tree, not a second copy of production path construction.
    const journal = (await walk(join(phone.dataRoot, 'nas-sync'))).find(p => p.endsWith(plan.transaction + '.json') && !p.includes('recovery'))!
    expect(journal).toBeTruthy(); const journalBytes = await readFile(journal)
    expect((await phone.service.finish(plan.transaction, false)).state).toBe('rolled-back') // pretend this reply was lost
    await writeFile(journal, journalBytes) // crash after durable verdict but before journal cleanup
    const reopened = phone.make()
    expect(reopened.status().plan).toBeNull(); expect(existsSync(journal)).toBe(false)
    expect((await reopened.finish(plan.transaction, false)).state).toBe('rolled-back')
    expect(reopened.status().lastAppliedAt).toBeNull(); expect(JSON.stringify(phone.db())).toBe(before)
    const next = await reopened.plan()
    expect((await reopened.finish(plan.transaction, false)).state).toBe('rolled-back')
    expect(reopened.status().plan.transaction).toBe(next.transaction)
    await reopened.finish(next.transaction, false)
})


test('card-only upload publishes a downloaded card without hydrating its stub and keeps the preference after restart', async t => {
    const dav = fixtureDav()
    const input: any = { characters: [{ chaId: 'downloaded', name: 'Downloaded card', type: 'character', description: 'card prompt', chats: [{ id: 'not-started', name: 'Chat 1', _stub: true }] }] }
    const before = structuredClone(input)
    const sender = await device(t, dav, 'card-only', { characters: [] }, MASTER, { readDatabase: async () => structuredClone(input) })
    sender.service.enable({ workspaceId: 'card-only-ws' })
    await expect(sender.service.snapshot()).rejects.toMatchObject({ code: 'CHAT_NOT_HYDRATED' })
    await sender.service.setCardOnlyUpload({ characterId: 'downloaded', enabled: true })
    expect(sender.make().status().cardOnlyUploads).toEqual(['downloaded'])
    expect((await sender.service.overview()).chats[0].state).toBe('card-only')
    await sender.service.snapshot(); await sender.service.publish()
    expect(input).toEqual(before)
    expect(sender.service.store().graph.classify('play\nchat\nnot-started').state).toBe('absent')
    const receiver = await device(t, dav, 'card-only-receiver', { characters: [] })
    receiver.service.enable({ workspaceId: 'card-only-ws' }); await receiver.service.pull(); await settle(receiver)
    expect(receiver.db().characters[0]).toMatchObject({ chaId: 'downloaded', description: 'card prompt', chats: [] })
    // A different unresolved character remains an error, not a silently omitted conversation.
    input.characters.push({ chaId: 'other', chats: [{ id: 'other-chat', _stub: true }] })
    await expect(sender.service.snapshot()).rejects.toMatchObject({ code: 'CHAT_NOT_HYDRATED' })
    input.characters.pop()
    await sender.service.setCardOnlyUpload({ characterId: 'downloaded', enabled: false })
    await expect(sender.service.snapshot()).rejects.toMatchObject({ code: 'CHAT_NOT_HYDRATED' })
    input.characters[0].chats = [{ id: 'not-started', name: 'Chat 1', message: [{ role: 'user', data: 'Started playing' }] }]
    await sender.service.snapshot(); await sender.service.publish(); await receiver.service.pull(); await settle(receiver)
    expect(receiver.db().characters[0].chats[0].message[0].data).toBe('Started playing')
})

test('card-only updates preserve published chat membership, history and Wiki instead of emitting deletions', async t => {
    const dav = fixtureDav(), sender = await seedTablet(t, dav)
    const graph = sender.service.store().graph, key = 'play\nchat\nchat'
    const heads = [...graph.classify(key).liveHeads]
    const receiver = await device(t, dav, 'card-history-receiver', { characters: [] })
    receiver.service.enable({ workspaceId: 'ws-fixture' }); await receiver.service.pull(); await settle(receiver)
    const receivedChats = structuredClone(receiver.db().characters[0].chats)
    await sender.service.setCardOnlyUpload({ characterId: 'card', enabled: true })
    const edited = sender.db(); edited.characters[0].description = 'new card description'; edited.characters[0].chats = []
    sender.save(edited)
    await sender.service.snapshot(); await sender.service.publish()
    expect(graph.classify(key).liveHeads).toEqual(heads)
    expect(graph.classify(key).tombstoneHeads).toEqual([])
    const ck = 'library\ncharacter\ncard'
    expect(graph.get(graph.classify(ck).liveHeads[0]).content.chatIds).toContain('chat')
    await receiver.service.pull(); await settle(receiver)
    expect(receiver.db().characters[0].description).toBe('new card description')
    expect(receiver.db().characters[0].chats).toEqual(receivedChats)
    expect(Object.keys(graph.get(heads[0]).dependencies).some(k => k.startsWith('bard:'))).toBe(true)
})
