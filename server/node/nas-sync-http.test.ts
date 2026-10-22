// Real server process (same harness as play-transfer-http.test.ts): default-disabled behaviour, auth/active-session on the new
// routes, the sync write gate as ordinary saves see it with no plan and with a real pending plan (matching header accepted,
// absent/wrong header refused), and the app's own DB-snapshot restore announcing itself to sync. Synthetic data root, the
// in-process WebDAV fixture for seeding only, no network beyond loopback, no real NAS.
import { test, expect } from 'vitest'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fixtureDav } from './nas-sync-dav-fixture'
const require = createRequire(import.meta.url)
const { createUserDataRepository } = require('./user-data-repository.cjs')
const { createFileKv } = require('./file-kv.cjs')
const { encodeRisuSaveLegacyBuffer, decodeRisuSave } = require('./utils.cjs')
const { createNasSyncService } = require('./nas-sync-service.cjs')
const { createRuntimeMemoryService } = require('./risubard-memory-runtime.cjs')
const { androidProtector } = require('./transfer-secrets.cjs')
const { vaultMasterStore } = require('./nas-sync-vault.cjs')
const DEVICE_KEY = '11'.repeat(32), MASTER = Buffer.from('ab'.repeat(32), 'hex')

test('sync routes: auth and default-disabled; the write gate with no plan and with a real pending plan; a DB snapshot restore marks sync', async t => {
    const root = await fs.mkdtemp(join(tmpdir(), 'bard-sync-http-')), dataRoot = join(root, 'data')
    t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }))
    const seed: any = { language: 'ko', botPresets: [], modules: [], personas: [], loreBook: [], plugins: [], characters: [{ chaId: 'card', type: 'character', name: '합성', chats: [{ id: 'chat', name: '보존', note: '', localLore: [], message: [{ role: 'char', data: '디스크 보존' }] }] }] }
    const repository = createUserDataRepository({ dataRoot }); repository.importLegacyDatabase(seed, { mode: 'sync' })
    const kv = createFileKv({ dataRoot })
    kv.kvSet('database/database.bin', encodeRisuSaveLegacyBuffer(seed))
    kv.kvSet('database/canonical-projection-revision', Buffer.from(repository.getProjectionRevision())) // compatibility blob + projection marker, as the live-files harness seeds
    kv.kvSet('database/dbbackup-1000.bin', encodeRisuSaveLegacyBuffer({ ...seed, language: 'ja' })) // an older DB snapshot the app can restore
    await fs.writeFile(join(dataRoot, '__password'), 'synthetic-sync-test')
    let child: ReturnType<typeof spawn> | undefined, base = '', logs = ''
    const start = async () => {
        await fs.rm(join(dataRoot, '.android-server.json'), { force: true })
        child = spawn(process.execPath, [join(process.cwd(), 'server/node/server.cjs')], { cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, RISUBARD_DATA_ROOT: dataRoot, RISUBARD_EMBEDDED_ANDROID: '1', RISUBARD_TRANSFER_KEY: DEVICE_KEY, PORT: '0', OPEN_BROWSER: '0', RISU_UPDATE_CHECK: 'false' } })
        child.stdout!.on('data', b => { logs += b }); child.stderr!.on('data', b => { logs += b })
        for (let n = 0; n < 150; n++) {
            if (child.exitCode !== null) throw new Error(logs)
            try { const ready = JSON.parse(await fs.readFile(join(dataRoot, '.android-server.json'), 'utf8')); base = `http://127.0.0.1:${ready.port}`; return }
            catch { await new Promise(resolve => setTimeout(resolve, 100)) }
        }
        throw new Error('Server did not start: ' + logs)
    }
    // Idempotent: the explicit stop at the end and the onTestFinished hook must both be safe; a signal-terminated child has
    // exitCode null but signalCode set, so termination is checked on both and the reference is cleared before waiting.
    const stop = async () => {
        const proc = child; child = undefined
        if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
        const ended = new Promise(resolve => proc.once('exit', resolve)); proc.kill(); await ended
    }
    t.onTestFinished(stop)
    let token = '', database: any = null
    const headers = (extra: Record<string, string> = {}) => ({ 'risu-auth': token, 'x-session-id': 'sync-http-test', 'content-type': 'application/json', ...extra })
    /** Login, register the session and take the initial read: the handshake every client does before its first save. */
    const handshake = async () => {
        const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'synthetic-sync-test' }) })
        expect(login.ok, await login.clone().text()).toBe(true); token = (await login.json()).token
        expect((await fetch(base + '/api/session', { method: 'POST', headers: headers(), body: '{}' })).ok).toBe(true)
        const initial = await fetch(base + '/api/read', { headers: { ...headers(), 'file-path': Buffer.from('database/database.bin').toString('hex') } })
        expect(initial.ok, await initial.clone().text()).toBe(true)
        database = await decodeRisuSave(Buffer.from(await initial.arrayBuffer()))
    }
    const write = (db: any, extra: Record<string, string> = {}) => fetch(base + '/api/write', { method: 'POST', headers: { ...headers(), 'content-type': 'application/octet-stream', 'file-path': Buffer.from('database/database.bin').toString('hex'), ...extra }, body: encodeRisuSaveLegacyBuffer(db) })
    const post = (path: string, body: unknown = {}) => fetch(base + '/api/nas-sync' + path, { method: 'POST', headers: headers(), body: JSON.stringify(body) })
    const status = async () => { const r = await fetch(base + '/api/nas-sync/status', { headers: headers() }); expect(r.ok, await r.clone().text()).toBe(true); return r.json() }

    // ---- fresh install: authenticated, disabled by default, ordinary saves untouched, a stray sync header is refused by the sync gate ----
    await start(); await handshake()
    expect((await fetch(base + '/api/nas-sync/status')).status).toBeGreaterThanOrEqual(400)
    expect(await status()).toMatchObject({ enabled: false, plan: null, retained: 0, pendingRestore: null })
    expect(await (await fetch(base + '/api/nas-sync/recovery', { headers: headers() })).json()).toEqual([])
    const disabled = await post('/plan'); expect(disabled.status).toBe(400); expect((await disabled.json()).error).toContain('꺼져')
    // pending-roots (the client's safe-window preview): authenticated, GET, disabled → the same disabled error, never a plan side effect.
    expect((await fetch(base + '/api/nas-sync/pending-roots')).status).toBeGreaterThanOrEqual(400)
    const rootsDisabled = await fetch(base + '/api/nas-sync/pending-roots', { headers: headers() }); expect(rootsDisabled.status).toBe(400); expect((await rootsDisabled.json()).error).toContain('꺼져')
    const ok = await write(database); expect(ok.ok, await ok.clone().text()).toBe(true)
    const bogus = await write(database, { 'x-nas-sync-id': 'not-a-plan' }); expect(bogus.status).toBe(423); expect((await bogus.json()).code).toBe('NAS_SYNC_BUSY')
    const again = await write(database); expect(again.ok, await again.clone().text()).toBe(true)
    await stop()

    // ---- seed a real pending plan: another device published to the WebDAV fixture; this install pulled it (in-process, server stopped) ----
    const dav = fixtureDav()
    const tabletRoot = await fs.mkdtemp(join(tmpdir(), 'bard-sync-http-tablet-')); t.onTestFinished(() => fs.rm(tabletRoot, { recursive: true, force: true }))
    const tabletRepo = createUserDataRepository({ dataRoot: tabletRoot }); tabletRepo.importLegacyDatabase({ language: 'en', botPresets: [], modules: [], personas: [], loreBook: [], plugins: [], characters: [] }, { mode: 'sync' })
    await vaultMasterStore(tabletRoot, androidProtector(DEVICE_KEY)).importMaster(MASTER)
    const tablet = createNasSyncService({ dataRoot: tabletRoot, readDatabase: async () => tabletRepo.exportLegacyDatabase(), memory: createRuntimeMemoryService(tabletRoot), storage: createFileKv({ dataRoot: tabletRoot }), secrets: dav.secrets, fetch: dav.fetch, protect: androidProtector(DEVICE_KEY) })
    tablet.enable({ workspaceId: 'ws-http' }); expect((await tablet.snapshot()).committed).toMatchObject({ sequence: 1 }); expect((await tablet.publish()).failed).toEqual([])
    await vaultMasterStore(dataRoot, androidProtector(DEVICE_KEY)).importMaster(MASTER) // same protector selection the server makes from RISUBARD_TRANSFER_KEY
    const local = createNasSyncService({ dataRoot, readDatabase: async () => repository.exportLegacyDatabase(), memory: createRuntimeMemoryService(dataRoot), storage: kv, secrets: dav.secrets, fetch: dav.fetch, protect: androidProtector(DEVICE_KEY) })
    local.enable({ workspaceId: 'ws-http' }); expect((await local.pull()).admitted).toHaveLength(1)

    // ---- running server with the pending plan: plan → arm moves the gate; absent/wrong header refused, matching header accepted; finish applies ----
    await start(); await handshake()
    expect(await status()).toMatchObject({ enabled: true, plan: null })
    // pending-roots preview over HTTP (server running, sync enabled, one admitted commit): read-only, nothing prepared.
    const rootsLive = await fetch(base + '/api/nas-sync/pending-roots', { headers: headers() }); expect(rootsLive.ok, await rootsLive.clone().text()).toBe(true)
    const preview = await rootsLive.json(); expect(preview.plan).toBeNull(); expect(preview.roots.length).toBeGreaterThan(0); expect(preview.roots.every((r: any) => typeof r.domain === 'string' && typeof r.root === 'string')).toBe(true)
    expect((await status()).plan).toBeNull() // the preview prepared nothing
    const planned = await post('/plan'); expect(planned.ok, await planned.clone().text()).toBe(true)
    const plan = await planned.json(); expect(plan.empty).toBeUndefined(); expect(plan.settings.language).toBe('en'); expect(plan.chats).toEqual([])
    expect(JSON.stringify(await status())).toContain(plan.transaction)
    const snapshotPending = await post('/snapshot'); expect(snapshotPending.status).toBe(400)
    expect(await snapshotPending.json()).toMatchObject({ error: 'Finish the pending sync apply before taking a snapshot', code: 'NAS_SYNC_PLAN_PENDING' })
    expect((await status()).plan.transaction).toBe(plan.transaction)
    const beforeArm = await write(database); expect(beforeArm.ok, await beforeArm.clone().text()).toBe(true) // prepared, not yet armed: ordinary saves still flow
    const applied = structuredClone(database)
    for (const [k, v] of Object.entries(plan.settings)) { if (v === null) delete applied[k]; else applied[k] = v }
    const echo = { transaction: plan.transaction, chats: [], settings: Object.fromEntries(Object.keys(plan.settings).map(k => [k, applied[k] ?? null])), characters: [...plan.characters, ...plan.newCharacters.map((c: any) => { const { chatIds: _i, chats: _c, chatPage: _p, ...fields } = c; return { chaId: c.chaId, fields: { ...fields, chaId: c.chaId } } })], modules: plan.modules, plugins: plan.plugins, pluginEnabled: plan.pluginEnabled, keptDeletions: [] }
    const armed = await post('/arm', echo); expect(armed.ok, await armed.clone().text()).toBe(true)
    const noHeader = await write(applied); expect(noHeader.status).toBe(423); expect(await noHeader.json()).toMatchObject({ code: 'NAS_SYNC_BUSY', transaction: plan.transaction }) // real HTTP: armed plan names its transaction
    const wrongHeader = await write(applied, { 'x-nas-sync-id': 'another-transaction' }); expect(wrongHeader.status).toBe(423); expect((await wrongHeader.json()).code).toBe('NAS_SYNC_BUSY')
    const owned = await write(applied, { 'x-nas-sync-id': plan.transaction }); expect(owned.ok, await owned.clone().text()).toBe(true)
    const finished = await post('/finish', { transaction: plan.transaction, confirmed: true }); expect(finished.ok, await finished.clone().text()).toBe(true)
    expect(await finished.json()).toMatchObject({ state: 'applied', transaction: plan.transaction, commits: 1 })
    const read = await fetch(base + '/api/read', { headers: { ...headers(), 'file-path': Buffer.from('database/database.bin').toString('hex') } })
    expect((await decodeRisuSave(Buffer.from(await read.arrayBuffer()))).language).toBe('en')
    const afterFinish = await write(applied); expect(afterFinish.ok, await afterFinish.clone().text()).toBe(true) // gate released
    expect(await status()).toMatchObject({ enabled: true, plan: null })
    // Publishing is a report, never an error: nothing to store here; the ACK of the applied commit cannot leave (no NAS credentials on
    // this server) and is reported as failed for the retry schedule.
    const idle = await post('/publish'); expect(idle.ok, await idle.clone().text()).toBe(true)
    const idleReport = await idle.json(); expect(idleReport.stored).toEqual([]); for (const f of idleReport.failed) expect(f.ack || f.checkpoint).toBeTruthy()

    // ---- the app's own DB snapshot restore announces itself to sync before copying; the next snapshot consumes the mark ----
    const restore = await fetch(base + '/api/db/snapshots/restore', { method: 'POST', headers: headers(), body: JSON.stringify({ key: 'database/dbbackup-1000.bin' }) })
    expect(restore.ok, await restore.clone().text()).toBe(true)
    expect((await status()).pendingRestore).toMatchObject({ source: 'db-snapshot', restoredAt: 1000, basesFrom: 'none' })
    const snapshot = await post('/snapshot'); expect(snapshot.ok, await snapshot.clone().text()).toBe(true)
    const snapped = await snapshot.json(); expect(snapped).toMatchObject({ provenance: 'restored-backup', restore: expect.objectContaining({ source: 'db-snapshot' }) })
    expect((await status()).pendingRestore).toBeNull()
    // No NAS credentials are configured on this server: a commit to send stays queued for retry and is reported as failed (200, no request leaves).
    const publish = await post('/publish'); expect(publish.ok, await publish.clone().text()).toBe(true)
    const report = await publish.json(); expect(report.stored).toEqual([])
    if (snapped.committed) expect(report.failed).toEqual(expect.arrayContaining([expect.objectContaining({ sequence: snapped.committed.sequence })]))
    for (const f of await fs.readdir(join(dataRoot, 'nas-sync'))) expect(f).not.toMatch(/\.part$/)
    await stop()
}, 180_000)
