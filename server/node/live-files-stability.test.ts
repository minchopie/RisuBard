import { expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const { mergePendingLiveDatabase, createLiveCharacterFiles } = require('./live-character-files.cjs')
const { createUserDataRepository } = require('./user-data-repository.cjs')
const { createCharacterAssets } = require('./character-assets.cjs')
const { createFileKv } = require('./file-kv.cjs')

test('new V3 portrait supports app replacement followed by external replacement without resurrecting old assets', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bard-v3-roundtrip-'))
    try {
        const repository = createUserDataRepository({ dataRoot: root, allowDirectoryMapping: true, newCharacterPackages: true })
        const store = createFileKv({ dataRoot: root })
        store.kvSet('assets/a.png', Buffer.from('first'))
        store.kvSet('assets/b.png', Buffer.from('second'))
        const db = { characters: [{ chaId: 'one', name: 'One', type: 'character', image: 'assets/a.png', additionalAssets: [], emotionImages: [], chats: [] }], loreBook: [] }
        repository.importLegacyDatabase(db, { mode: 'sync' })
        store.characterAssets.sync(db)
        const live = createLiveCharacterFiles({ repository, watch: false, settleMs: 0, writeAsset: store.kvSet, reloadAssets: store.characterAssets.reload })
        live.reconcile()
        db.characters[0].image = 'assets/b.png'
        repository.importLegacyDatabase(db, { mode: 'sync' })
        store.characterAssets.sync(db)
        live.accept(db)
        live.invalidate()
        live.reconcile()
        const record = JSON.parse(fs.readFileSync(path.join(root, 'index/character-asset-replicas.json'), 'utf8')).characters.one
        const portrait = record.entries.find((entry: any) => entry.key === 'assets/b.png')
        const folder = repository.characterDirectoryStatus('one').directory
        fs.writeFileSync(path.join(root, 'characters', folder, 'assets', portrait.filename), 'edited')
        live.invalidate()
        const adopted = live.reconcile().database
        expect(adopted.characters[0].image).not.toBe('assets/b.png')
        expect(store.kvGet(adopted.characters[0].image).toString()).toBe('edited')
        expect(adopted.characters[0].additionalAssets).toEqual([])
        expect(store.kvGet('assets/a.png').toString()).toBe('first')
        expect(store.kvGet('assets/b.png').toString()).toBe('second')
        store.characterAssets.sync(adopted)
        live.accept(adopted)
        live.invalidate()
        expect(live.reconcile()).toBeNull()
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('pending adoption survives restart and completion stops replay without deleting its archive', () => {
    const { createLiveFileRecovery } = require('./live-character-files.cjs')
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bard-live-recovery-'))
    try {
        const recovery = createLiveFileRecovery(root)
        expect(recovery.load()).toBeNull()
        const record = { pending: { characters: [{ chaId: 'one', desc: 'A' }] }, baseline: { characters: [{ chaId: 'one', desc: 'C' }] }, conflicts: [{ field: 'desc', local: 'A' }] }
        const info = recovery.save(record)
        expect(createLiveFileRecovery(root).load().record).toMatchObject(record)
        recovery.complete()
        expect(createLiveFileRecovery(root).load()).toBeNull()
        expect(JSON.parse(fs.readFileSync(path.join(root, info.path), 'utf8'))).toMatchObject(record)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('records acknowledged same-field conflicts, including deletion and global lore', () => {
    const before = { characters: [{ chaId: 'one', desc: 'C', name: 'old' }], loreBook: [] }
    const pending = { characters: [{ chaId: 'one', desc: 'A', name: 'app', chats: [{ id: 'chat' }] }], loreBook: [{ id: 'app' }] }
    const external = { characters: [{ chaId: 'one', desc: 'B' }], loreBook: [{ id: 'external' }] }
    const conflicts: any[] = []
    const result = mergePendingLiveDatabase(pending, before, external, conflicts)
    expect(result.characters[0]).toEqual({ chaId: 'one', desc: 'B', chats: [{ id: 'chat' }] })
    expect(conflicts).toEqual([
        { characterId: 'one', field: 'desc', local: 'A', external: 'B', baseline: 'C' },
        { characterId: 'one', field: 'name', local: 'app', external: undefined, baseline: 'old' },
        { field: 'loreBook', local: [{ id: 'app' }], external: [{ id: 'external' }], baseline: [] },
    ])
})

test('a replica published after a live index still replaces the portrait reference', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bard-live-index-'))
    try {
        const repository = createUserDataRepository({ dataRoot: root, allowDirectoryMapping: true })
        const db = { characters: [{ chaId: 'one', name: 'One', type: 'character', image: 'assets/portrait.png', additionalAssets: [], emotionImages: [], chats: [] }], loreBook: [], modules: [], personas: [], botPresets: [] }
        repository.importLegacyDatabase(db, { mode: 'sync' })
        const writes = new Map()
        const live = createLiveCharacterFiles({ repository, watch: false, settleMs: 0, writeAsset: (key: string, value: Buffer) => writes.set(key, value) })
        const assetRoot = path.join(root, 'characters/one/assets')
        fs.mkdirSync(assetRoot, { recursive: true })
        fs.writeFileSync(path.join(assetRoot, 'extra.png'), 'extra')
        live.reconcile()
        const assets = createCharacterAssets({ dataRoot: root, sourceSize: () => 3, readOriginal: () => Buffer.from('old') })
        assets.migrate(repository.exportLegacyDatabase(), 'one')
        const index = JSON.parse(fs.readFileSync(path.join(root, 'index/character-asset-replicas.json'), 'utf8'))
        const portrait = index.characters.one.entries.find((e: any) => e.key === 'assets/portrait.png')
        fs.writeFileSync(path.join(assetRoot, portrait.filename), 'new')
        live.invalidate()
        const result = live.reconcile().database.characters[0]
        expect(result.image).not.toBe('assets/portrait.png')
        expect(writes.get(result.image).toString()).toBe('new')
        expect(result.additionalAssets).toHaveLength(1)
    } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test.each(['saved', 'conflict', 'pending'])('enabling monitoring settles acknowledged writes before replacing their baseline: %s', async (outcome) => {
    const source = fs.readFileSync(path.join(import.meta.dirname, 'server.cjs'), 'utf8')
    const start = source.indexOf("app.post('/api/live-files/monitoring'")
    const body = source.slice(start, source.indexOf("app.post('/api/live-files/sync'", start))
    let handler: any
    const calls: string[] = []
    const errors: unknown[] = []
    const deps: any = {
        app: { post: (_path: string, fn: any) => { handler = fn } },
        checkAuth: async () => true, checkActiveSession: () => true,
        queueStorageOperation: async (fn: any) => fn(),
        externalEditSession: { isActive: () => false }, liveFilesAdoption: null,
        liveFilesPendingWrites: true, liveFilesRevision: 'before',
        liveCharacterFiles: { isEnabled: () => false, setEnabled: () => { calls.push('enable'); return { enabled: true } } },
        nodeCrypto: { randomUUID: () => 'after' },
        liveFileEvents: { notify: () => {} },
        flushPendingDbWithinQueue: async () => {
            calls.push('flush')
            if (outcome === 'conflict') throw new Error('CANONICAL_FILES_CHANGED')
            if (outcome === 'saved') deps.liveFilesPendingWrites = false
        },
    }
    new Function('deps', `with (deps) { ${body} }`)(deps)
    let status = 200
    const res = { status: (code: number) => { status = code; return res }, json: (value: any) => value }
    await handler({ body: { enabled: true } }, res, (error: unknown) => errors.push(error))
    expect(calls).toEqual(outcome === 'saved' ? ['flush', 'enable'] : ['flush'])
    expect(errors.length).toBe(outcome === 'conflict' ? 1 : 0)
    expect(status).toBe(outcome === 'pending' ? 409 : 200)
})

test.each(['before-publication', 'after-publication'])('failed adoption retries without watcher events: %s', (failureStage) => {
    const source = fs.readFileSync(path.join(import.meta.dirname, 'server.cjs'), 'utf8')
    const body = source.slice(source.indexOf('function adoptExternallyChangedCanonicalProjection('), source.indexOf('\nexternalEditSession = createExternalEditSession'))
    const before = { characters: [{ chaId: 'one', desc: 'C', chats: [] }], loreBook: [] }
    const pending = structuredClone(before); pending.characters[0].desc = 'A'
    const external = structuredClone(before); external.characters[0].desc = 'B'
    let reconciles = 0, persists = 0
    let invalidated = false, published = false
    const cache: any = { db: pending }
    const archives: any[] = []
    const run = new Function('deps', `with (deps) { let liveFilesAdoption = null, liveFilesRecovery = null, liveFilesChatPrevious = []; let liveFilesPendingWrites = true; let liveFilesRevision = 'old'; let dbEtag, externallyAdoptedDbEtag; ${body}; return adoptExternallyChangedCanonicalProjection; }`)({
        canonicalProjectionReady: true,
        liveCharacterFiles: {
            isEnabled: () => true,
            reconcile: () => reconciles++ === 0 ? { database: external, previous: before, revision: 'revision' }
                : invalidated && published ? { database: external, previous: external, revision: 'published' } : null,
            accept: () => {}, invalidate: () => { invalidated = true },
        },
        canonicalProjectionSync: { loadExternalChanges: () => null, accept: () => {} },
        normalizeJSON: (x: any) => structuredClone(x), reassembleFullDb: (x: any) => x, stripChatsFromDb: (x: any) => x,
        dbCache: cache, DB_HEX_KEY: 'db', mergePendingLiveDatabase,
        preserveLiveFileRecovery: (value: any) => archives.push(structuredClone(value)),
        liveFileRecovery: { complete: () => {} },
        persistCanonicalProjection: (_db: any, options: any) => {
            if (persists++ === 0) { published = failureStage === 'after-publication'; throw new Error('disk full') }
            if (published && options.externalRevision !== 'published') throw new Error('stale revision blocks retry')
            return { acceptedRevision: 'saved-revision' }
        },
        saveTimers: {}, directWriteTracker: { clear: () => {} }, encodeRisuSaveLegacyBuffer: JSON.stringify,
        kvSet: () => {}, initChatStore: () => {}, computeBufferEtag: () => 'etag', nodeCrypto: { randomUUID: () => 'new' }, logger: { info: () => {} },
    })
    expect(() => run(true)).toThrow('disk full')
    expect(cache.db.characters[0].desc).toBe('A')
    expect(run(true)).toMatchObject({ revision: published ? 'published' : 'revision' })
    expect(cache.db.characters[0].desc).toBe('B')
    expect(archives[0].conflicts[0].local).toBe('A')
})

test.each([false, true])('canonical fallback preserves pending writes when no merge baseline exists (monitoring %s)', enabled => {
    const source = fs.readFileSync(path.join(import.meta.dirname, 'server.cjs'), 'utf8')
    const body = source.slice(source.indexOf('function adoptExternallyChangedCanonicalProjection('), source.indexOf('\nexternalEditSession = createExternalEditSession'))
    const pending = { characters: [{ chaId: 'one', desc: 'Acknowledged app edit', chats: [] }], loreBook: [] }
    const external = { characters: [{ chaId: 'one', desc: 'External edit', chats: [] }], loreBook: [] }
    const cache = { db: pending }
    const timers = { db: 'pending-save' }
    const published: unknown[] = []
    const deps: any = {
        canonicalProjectionReady: true, liveFilesAdoption: null, liveFilesPendingWrites: true,
        liveCharacterFiles: { isEnabled: () => enabled, reconcile: () => null, invalidate: () => {}, accept: () => {} },
        canonicalProjectionSync: { loadExternalChanges: () => ({ database: external, revision: 'external' }), accept: () => {} },
        normalizeJSON: (x: any) => structuredClone(x), reassembleFullDb: (x: any) => x, stripChatsFromDb: (x: any) => x,
        dbCache: cache, DB_HEX_KEY: 'db', saveTimers: timers,
        directWriteTracker: { clear: () => {} }, clearTimeout: () => {},
        encodeRisuSaveLegacyBuffer: JSON.stringify, kvSet: (_key: string, value: unknown) => published.push(value),
        initChatStore: () => {}, computeBufferEtag: () => 'etag', nodeCrypto: { randomUUID: () => 'new' },
        liveFileRecovery: { complete: () => {} }, logger: { info: () => {} },
    }
    const run = new Function('deps', `with (deps) { ${body}; return adoptExternallyChangedCanonicalProjection; }`)(deps)
    expect(() => run()).toThrow(expect.objectContaining({ code: 'CANONICAL_FILES_CHANGED' }))
    expect(cache.db).toBe(pending)
    expect(cache.db.characters[0].desc).toBe('Acknowledged app edit')
    expect(timers.db).toBe('pending-save')
    expect(published).toEqual([])
    expect(deps.liveFilesAdoption).toBeNull()
    expect(deps.liveFilesPendingWrites).toBe(true)
})
