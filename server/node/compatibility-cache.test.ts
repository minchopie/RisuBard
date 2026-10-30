import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const { createFileKv } = require('./file-kv.cjs')
const { createUserDataRepository } = require('./user-data-repository.cjs')
const { encodeRisuSaveLegacyBuffer, decodeRisuSave } = require('./utils.cjs')
let attachCompatibilityCache: any
try { ({ attachCompatibilityCache } = require('./compatibility-cache.cjs')) } catch {}
const roots: string[] = []
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }) })
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-p1-')); roots.push(root)
    const database = { language: 'ko', modules: [], botPresets: [], personas: [], loreBook: [], characters: [
        { chaId: 'char-1', name: 'Character', chats: [{ id: 'chat-1', name: 'Chat', message: [{ role: 'user', data: 'old' }] }] },
    ] }
    const store = createFileKv({ dataRoot: root })
    const repository = createUserDataRepository({ dataRoot: root })
    repository.importLegacyDatabase(database, { mode: 'sync' })
    store.kvSet('database/database.bin', encodeRisuSaveLegacyBuffer(database))
    const observation = vi.fn()
    const cache = attachCompatibilityCache({ store, repository, dataRoot: root, enabled: true, record: observation,
        canInvalidate: () => !fs.existsSync(path.join(root, 'risuai.db')) })
    expect(cache.canDefer()).toBe(false)
    cache.setVerified(true)
    return { root, database, store, repository, cache, observation }
}

describe('P1 regenerable compatibility cache', () => {
    it('retains the pending save observer when a legacy reader rebuilds the cache', () => {
        const f = fixture(); f.cache.invalidate()
        const { createCanonicalProjectionSync } = require('./canonical-projection-sync.cjs')
        const { commitTransaction, observeWrites } = require('./file-store.cjs')
        const sync = createCanonicalProjectionSync({ repository: f.repository, readAcceptedRevision: () => null, writeAcceptedRevision: () => {} })
        sync.accept()
        const save = sync.beginSave()
        const target = 'characters/char-1/metadata.json'
        const original = JSON.parse(fs.readFileSync(path.join(f.root, target), 'utf8'))
        const external = JSON.stringify({ ...original, name: 'external' })
        expect(() => observeWrites(save, () => commitTransaction(f.root, [
            { path: 'presets/first.json', data: Buffer.from('{}') },
            { path: target, data: Buffer.from(JSON.stringify({ ...original, name: 'app' })) },
        ], { failAfterPublish: 1 }))).toThrow('simulated crash')
        fs.writeFileSync(path.join(f.root, target), external)
        f.cache.setRecoveryHandler(() => observeWrites(save, () => f.repository.recoverPendingTransactions()))
        expect(() => f.store.kvListWithSizes()).toThrow(expect.objectContaining({ code: 'CANONICAL_FILES_CHANGED' }))
        expect(fs.readFileSync(path.join(f.root, target), 'utf8')).toBe(external)
        expect(fs.readdirSync(path.join(f.root, '.journal')).filter(name => name.endsWith('.json'))).toHaveLength(1)
    })

    it('requires a matching shadow baseline and revokes eligibility after a mismatch', () => {
        const f = fixture()
        expect(f.cache.canDefer()).toBe(true)
        f.cache.setVerified(false)
        expect(f.cache.canDefer()).toBe(false)
    })
    it('durably invalidates before canonical writes without deleting object bytes', async () => {
        const f = fixture()
        const oldEntry = JSON.parse(fs.readFileSync(path.join(f.root, 'kv/manifest.json'), 'utf8')).entries['database/database.bin']
        expect(f.cache.canDefer()).toBe(true)
        f.cache.invalidate()
        expect(JSON.parse(fs.readFileSync(path.join(f.root, 'kv/manifest.json'), 'utf8')).entries['database/database.bin']).toBeUndefined()
        expect(fs.existsSync(path.join(f.root, 'kv/objects', oldEntry.object))).toBe(true)
        f.database.characters[0].chats[0].message[0].data = 'latest'
        f.repository.syncLegacyChatState(f.database, { chats: [{ characterId: 'char-1', chatId: 'chat-1' }] })
        expect(await decodeRisuSave(f.store.kvGet('database/database.bin'))).toEqual(f.database)
        expect(f.observation).toHaveBeenCalledWith(expect.objectContaining({ kind: 'compatibility-materialize', outcome: 'success' }))
    })

    it.each(['size', 'list', 'list-with-sizes', 'copy'])('materializes before legacy %s consumers see the database', async operation => {
        const f = fixture(); f.cache.invalidate()
        f.database.characters[0].chats[0].message[0].data = 'latest'
        f.repository.importLegacyDatabase(f.database, { mode: 'sync' })
        if (operation === 'size') expect(f.store.kvSize('database/database.bin')).toBeGreaterThan(0)
        if (operation === 'list') expect(f.store.kvList('database/')).toContain('database/database.bin')
        if (operation === 'list-with-sizes') expect(f.store.kvListWithSizes()).toContainEqual(expect.objectContaining({ key: 'database/database.bin', size: expect.any(Number) }))
        if (operation === 'copy') f.store.kvCopyValue('database/database.bin', 'database/dbbackup-test.bin')
        expect(await decodeRisuSave(f.store.kvGet(operation === 'copy' ? 'database/dbbackup-test.bin' : 'database/database.bin'))).toEqual(f.database)
    })

    it('does not rebuild for unrelated assets or GC and does not defer SQLite roots', () => {
        const f = fixture(); f.cache.invalidate()
        f.store.kvList('assets/'); f.store.kvListWithSizes('assets/'); f.store.kvSize('assets/missing')
        f.store.gcChunks({ minAgeMs: 3600000, maxDeletes: 0 })
        expect(f.observation).not.toHaveBeenCalled()
        fs.writeFileSync(path.join(f.root, 'risuai.db'), 'legacy placeholder')
        expect(f.cache.canDefer()).toBe(false)
    })

    it.each([false, true])('a fresh process recovers after invalidation with published=%s', published => {
        const f = fixture(); f.cache.invalidate()
        if (published) {
            f.database.characters[0].chats[0].message[0].data = 'committed'
            f.repository.importLegacyDatabase(f.database, { mode: 'sync' })
        }
        const source = `const db=require('./server/node/db.cjs');require('./server/node/utils.cjs').decodeRisuSave(db.kvGet('database/database.bin')).then(x=>process.stdout.write(x.characters[0].chats[0].message[0].data));`
        const output = execFileSync(process.execPath, ['-e', source], { cwd: process.cwd(), env: { ...process.env, RISUBARD_DATA_ROOT: f.root }, encoding: 'utf8' })
        expect(output).toBe(published ? 'committed' : 'old')
    })

    it('keeps the cache absent if rebuilding fails and succeeds on retry', async () => {
        const f = fixture(); f.cache.invalidate()
        const original = f.repository.exportLegacyDatabase
        f.repository.exportLegacyDatabase = () => { throw Object.assign(new Error('read failure'), { code: 'EIO' }) }
        expect(() => f.store.kvGet('database/database.bin')).toThrow('read failure')
        expect(JSON.parse(fs.readFileSync(path.join(f.root, 'kv/manifest.json'), 'utf8')).entries['database/database.bin']).toBeUndefined()
        f.repository.exportLegacyDatabase = original
        expect(await decodeRisuSave(f.store.kvGet('database/database.bin'))).toEqual(f.database)
    })

    it('recovers a partially published journal through the pre-P1 missing-cache reader', () => {
        const f = fixture(); f.cache.invalidate()
        f.database.characters[0].name = 'committed-name'
        f.database.characters[0].chats[0].message[0].data = 'committed-body'
        const rename = fs.renameSync
        let interrupted = false
        const spy = vi.spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
            if (!interrupted && String(source).includes('.stage') && String(destination).endsWith('messages.jsonl')) {
                interrupted = true
                throw Object.assign(new Error('simulated interruption'), { code: 'EIO' })
            }
            return rename(source, destination)
        })
        try {
            expect(() => f.repository.syncLegacyChatState(f.database, {
                chats: [{ characterId: 'char-1', chatId: 'chat-1' }],
            })).toThrow('simulated interruption')
        } finally { spy.mockRestore() }
        // Frozen pre-P1 read algorithm: no new cache facade or deferred flag.
        // createFileKv recovers the prepared canonical journal before reading.
        const source = `
            const {createFileKv}=require('./server/node/file-kv.cjs');
            const {createUserDataRepository}=require('./server/node/user-data-repository.cjs');
            const {encodeRisuSaveLegacyBuffer,decodeRisuSave}=require('./server/node/utils.cjs');
            const store=createFileKv({dataRoot:process.env.RISUBARD_DATA_ROOT});
            const repository=createUserDataRepository({dataRoot:process.env.RISUBARD_DATA_ROOT});
            let value=store.kvGet('database/database.bin');
            if(!value){value=encodeRisuSaveLegacyBuffer(repository.exportLegacyDatabase());store.kvSet('database/database.bin',value);}
            decodeRisuSave(value).then(db=>process.stdout.write(JSON.stringify(db)));
        `
        const output=execFileSync(process.execPath,['-e',source],{cwd:process.cwd(),env:{...process.env,RISUBARD_DATA_ROOT:f.root},encoding:'utf8'})
        expect(JSON.parse(output)).toEqual(f.database)
        expect(fs.readdirSync(path.join(f.root,'.journal'))).toEqual([])
    })
})
