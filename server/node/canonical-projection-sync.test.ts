import { afterEach, describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { createUserDataRepository } = require('./user-data-repository.cjs')
let createCanonicalProjectionSync: any
try {
    ({ createCanonicalProjectionSync } = require('./canonical-projection-sync.cjs'))
} catch {
    createCanonicalProjectionSync = undefined
}

const roots: string[] = []

function replaceCanonicalJson(dataRoot: string, relativePath: string, value: unknown) {
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    const target = path.join(dataRoot, relativePath)
    fs.writeFileSync(target, bytes)
    fs.writeFileSync(`${target}.sha256`, `${crypto.createHash('sha256').update(bytes).digest('hex')}\n`)
}
afterEach(() => {
    roots.splice(0).forEach(value => fs.rmSync(value, { recursive: true, force: true }))
})

describe('canonical projection sync', () => {
    it('loads externally edited canonical files and advances the accepted revision only after adoption', () => {
        expect(createCanonicalProjectionSync).toBeTypeOf('function')
        if (!createCanonicalProjectionSync) return

        const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-projection-sync-'))
        roots.push(dataRoot)
        const repository = createUserDataRepository({ dataRoot })
        repository.importLegacyDatabase({
            language: 'ko',
            botPresets: [{ id: 'preset-1', name: 'Original' }],
            modules: [], personas: [], loreBook: [], characters: [],
        }, { mode: 'merge' })

        let acceptedRevision: string | null = null
        const sync = createCanonicalProjectionSync({
            repository,
            readAcceptedRevision: () => acceptedRevision,
            writeAcceptedRevision: (revision: string) => { acceptedRevision = revision },
        })

        const initial = sync.loadExternalChanges()
        expect(initial?.database.botPresets[0].name).toBe('Original')
        expect(acceptedRevision).toBeNull()
        sync.accept(initial.revision)
        expect(sync.hasExternalChanges).toBeTypeOf('function')
        if (!sync.hasExternalChanges) return
        expect(sync.hasExternalChanges()).toBe(false)
        expect(sync.loadExternalChanges()).toBeNull()

        const presetPath = path.join(dataRoot, 'presets', 'preset-1.json')
        const preset = JSON.parse(fs.readFileSync(presetPath, 'utf8'))
        preset.name = 'Externally edited'
        replaceCanonicalJson(dataRoot, 'presets/preset-1.json', preset)

        expect(sync.hasExternalChanges()).toBe(true)
        // The rewrite refreshed its checksum, yet the review still sees which file changed.
        expect(sync.changedFiles()).toEqual([{ path: 'presets/preset-1.json', status: 'changed' }])
        const changed = sync.loadExternalChanges()
        expect(changed?.database.botPresets[0].name).toBe('Externally edited')
        expect(acceptedRevision).toBe(initial.revision)
        sync.accept(changed.revision)
        expect(acceptedRevision).toBe(changed.revision)
        expect(sync.loadExternalChanges()).toBeNull()
    })

    it('reconciles the sidebar before returning an externally edited compatibility projection', () => {
        expect(createCanonicalProjectionSync).toBeTypeOf('function')
        if (!createCanonicalProjectionSync) return

        const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-projection-sync-'))
        roots.push(dataRoot)
        const repository = createUserDataRepository({ dataRoot })
        repository.importLegacyDatabase({
            language: 'ko', botPresets: [], modules: [], personas: [], loreBook: [],
            characters: [{
                chaId: 'char-1', name: 'Original', modification_date: 1_700_000_000,
                globalLore: [{ key: 'old' }], chats: [],
            }],
        }, { mode: 'sync' })

        let acceptedRevision = repository.getProjectionRevision()
        const sync = createCanonicalProjectionSync({
            repository,
            readAcceptedRevision: () => acceptedRevision,
            writeAcceptedRevision: (revision: string) => { acceptedRevision = revision },
        })
        const metadata = repository.loadCharacter('char-1')
        metadata.name = 'External character'
        metadata.modification_date = 1_800_000_000
        metadata.globalLore = [{ key: 'new' }]
        replaceCanonicalJson(dataRoot, 'characters/char-1/metadata.json', metadata)

        const changed = sync.loadExternalChanges()

        expect(changed?.database.characters[0]).toMatchObject({
            name: 'External character',
            globalLore: [{ key: 'new' }],
        })
        expect(repository.loadSidebarIndex().characters[0]).toMatchObject({
            name: 'External character',
            updatedAt: 1_800_000_000_000,
        })
        expect(changed?.database).toStrictEqual(repository.exportLegacyDatabase())
        expect(changed?.revision).toBe(repository.getProjectionRevision())
    })

    it('invalidates a character whose globalLore changed while display summaries stayed the same', () => {
        expect(createCanonicalProjectionSync).toBeTypeOf('function')
        if (!createCanonicalProjectionSync) return

        const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-projection-sync-'))
        roots.push(dataRoot)
        const repository = createUserDataRepository({ dataRoot })
        repository.importLegacyDatabase({
            botPresets: [], modules: [], personas: [], loreBook: [],
            characters: [{
                chaId: 'char-1', name: 'Same name', modification_date: 1_800_000_000,
                globalLore: [{ key: 'old' }], chats: [],
            }],
        }, { mode: 'sync' })
        let acceptedRevision = repository.getProjectionRevision()
        const sync = createCanonicalProjectionSync({
            repository,
            readAcceptedRevision: () => acceptedRevision,
            writeAcceptedRevision: (revision: string) => { acceptedRevision = revision },
        })
        const metadata = repository.loadCharacter('char-1')
        metadata.globalLore = [{ key: 'new' }]
        metadata.modification_date = 1_800_000_001
        replaceCanonicalJson(dataRoot, 'characters/char-1/metadata.json', metadata)

        const changed = sync.loadExternalChanges()

        expect(changed?.sidebarWritten).toBe(true)
        expect(changed?.database.characters[0].globalLore).toEqual([{ key: 'new' }])
        expect(repository.loadSidebarIndex().characters[0]).toMatchObject({
            name: 'Same name',
            updatedAt: 1_800_000_001_000,
        })
    })
})

describe('canonical save racing an external edit', () => {
    const { observeWrites } = require('./file-store.cjs')
    const chat = (id: string) => ({ id, name: id, message: [{ role: 'user', data: 'hi', chatId: `${id}-m1` }], note: '', localLore: [] })
    const character = (chaId: string, desc: string) => ({
        type: 'character', chaId, name: chaId, desc, firstMessage: '', chats: [chat(`${chaId}-chat`)], chatPage: 0, additionalAssets: [],
    })

    function fixture() {
        const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-save-race-'))
        roots.push(dataRoot)
        const repository = createUserDataRepository({ dataRoot })
        const database = { characters: [character('bot', 'app'), character('other', 'o')], botPresets: [], modules: [], personas: [], loreBook: [] }
        const save = (db = database) => repository.importLegacyDatabase(structuredClone(db), { mode: 'sync' })
        save()
        let acceptedRevision: string | null = null
        const sync = createCanonicalProjectionSync({
            repository,
            readAcceptedRevision: () => acceptedRevision,
            writeAcceptedRevision: (revision: string) => { acceptedRevision = revision },
        })
        sync.accept()
        const metadata = fs.readdirSync(path.join(dataRoot, 'characters'))
            .map(name => `characters/${name}/metadata.json`)
            .find(file => fs.existsSync(path.join(dataRoot, file)) && JSON.parse(fs.readFileSync(path.join(dataRoot, file), 'utf8')).chaId === 'bot')!
        const desc = () => JSON.parse(fs.readFileSync(path.join(dataRoot, metadata), 'utf8')).desc
        // Like the bot factory installer: rename a new file in, leave the old checksum.
        const editExternally = () => {
            const target = path.join(dataRoot, metadata)
            const value = JSON.parse(fs.readFileSync(target, 'utf8'))
            value.desc = 'external'
            fs.writeFileSync(`${target}.tmp`, JSON.stringify(value, null, 2))
            fs.renameSync(`${target}.tmp`, target)
        }
        return { repository, database, save, sync, metadata, desc, editExternally }
    }

    it('accepts a save that no other program interrupted', () => {
        const f = fixture()
        f.database.characters[1].chats[0].message.push({ role: 'char', data: 'yo', chatId: 'other-m2' })
        const save = f.sync.beginSave()
        observeWrites(save, () => f.save())
        expect(save.settle()).toBeTypeOf('string')
        expect(f.sync.hasExternalChanges()).toBe(false)
    })

    it('a journal retry preserves a later external edit instead of publishing over it', () => {
        const f = fixture()
        const {commitTransaction,recoverTransactions}=require('./file-store.cjs')
        const save=f.sync.beginSave()
        const changed={...JSON.parse(fs.readFileSync(path.join(f.repository.dataRoot,f.metadata),'utf8')),desc:'app retry'}
        expect(()=>observeWrites(save,()=>commitTransaction(f.repository.dataRoot,[
            {path:'presets/first.json',data:Buffer.from('{}')},
            {path:f.metadata,data:Buffer.from(JSON.stringify(changed))},
        ],{failAfterPublish:1}))).toThrow('simulated crash')
        f.editExternally()
        expect(()=>observeWrites(save,()=>recoverTransactions(f.repository.dataRoot))).toThrow(expect.objectContaining({code:'CANONICAL_FILES_CHANGED'}))
        expect(f.desc()).toBe('external')
        expect(fs.readdirSync(path.join(f.repository.dataRoot,'.journal')).filter(name=>name.endsWith('.json'))).toHaveLength(1)
    })

    it.each([false, true])('asset failure settles published files while preserving real external changes: %s', external => {
        const f = fixture()
        f.database.characters[1].desc = 'acknowledged app edit'
        const source = fs.readFileSync(path.join(import.meta.dirname, 'server.cjs'), 'utf8')
        const begin = source.indexOf('function persistCanonicalProjection(')
        const body = source.slice(begin, source.indexOf('function adoptExternallyChangedCanonicalProjection(', begin))
        const deps = {
            elapsedMs: () => 0, nodeCrypto: crypto, reportImportProgress() {}, externalEditSession: null,
            canonicalProjectionSync: f.sync, observeWrites,
            writeCanonicalProjection: () => ({ result: f.save(), strategy: 'full-sync' }),
            userDataRepository: f.repository, canonicalProjectionReady: true,
            characterAssets: { sync() { if (external) f.editExternally(); throw new Error('asset write failed') } },
            saveObservation: { record() {} },
        }
        const persist = new Function('deps', `with (deps) { ${body}; return persistCanonicalProjection; }`)(deps)
        expect(() => persist(f.database)).toThrow('asset write failed')
        expect(f.sync.hasExternalChanges()).toBe(external)
        expect(JSON.parse(fs.readFileSync(path.join(f.repository.dataRoot, 'characters/other/metadata.json'), 'utf8')).desc).toBe('acknowledged app edit')
        if (external) expect(f.desc()).toBe('external')
    })

    it('leaves a file edited during an unrelated save pending for review', () => {
        const f = fixture()
        f.database.characters[1].chats[0].message.push({ role: 'char', data: 'yo', chatId: 'other-m2' })
        const save = f.sync.beginSave()
        observeWrites(save, () => f.save())
        f.editExternally()
        expect(save.settle()).toBeNull()
        expect(f.sync.hasExternalChanges()).toBe(true)
        expect(f.sync.changedFiles()).toEqual([{ path: f.metadata, status: 'changed' }])
    })

    it.each([false, true])('adoption never accepts a later external edit it did not load (merge: %s)', merge => {
        const f = fixture()
        f.editExternally()
        const changed = f.sync.loadExternalChanges()
        changed.previous = structuredClone(f.database)
        const pending = structuredClone(f.database)
        pending.characters[1].desc = 'pending app change'
        const editLater = () => {
            const target = path.join(f.repository.dataRoot, f.metadata)
            const value = JSON.parse(fs.readFileSync(target, 'utf8'))
            value.desc = 'later external edit'
            fs.writeFileSync(target, JSON.stringify(value))
        }
        const source = fs.readFileSync(path.join(import.meta.dirname, 'server.cjs'), 'utf8')
        const begin = source.indexOf('function adoptExternallyChangedCanonicalProjection(')
        const body = source.slice(begin, source.indexOf('async function adoptSettledExternalProjection(', begin))
        const deps = {
            canonicalProjectionReady: true,
            canonicalProjectionSync: { ...f.sync, loadExternalChanges: () => changed },
            liveCharacterFiles: { isEnabled: () => false, invalidate() {}, accept() {} },
            liveFilesAdoption: null, liveFilesPendingWrites: merge,
            normalizeJSON: (value: unknown) => structuredClone(value),
            reassembleFullDb: () => pending, stripChatsFromDb: (value: unknown) => value,
            mergePendingLiveDatabase: require('./live-character-files.cjs').mergePendingLiveDatabase,
            preserveLiveFileRecovery: () => ({}),
            persistCanonicalProjection: (database: unknown) => {
                const save = f.sync.beginSave()
                observeWrites(save, () => f.save(database as typeof f.database))
                editLater()
                return { acceptedRevision: save.settle() }
            },
            userDataRepository: f.repository,
            dbCache: { db: {} }, DB_HEX_KEY: 'db', saveTimers: {}, directWriteTracker: { clear() {} },
            encodeRisuSaveLegacyBuffer: (value: unknown) => { if (!merge) editLater(); return JSON.stringify(value) },
            kvSet() {}, initChatStore() {}, computeBufferEtag: () => 'etag',
            dbEtag: null, externallyAdoptedDbEtag: null, liveFileRecovery: { complete() {} },
            liveFilesRecovery: null, liveFilesRevision: null, liveFilesChatPrevious: null,
            nodeCrypto: crypto, logger: { info() {} },
        }
        const adopt = new Function('deps', `with (deps) { ${body}; return adoptExternallyChangedCanonicalProjection; }`)(deps)
        if (merge) expect(() => adopt()).toThrow(expect.objectContaining({ code: 'CANONICAL_FILES_CHANGED' }))
        else adopt()
        expect(f.sync.hasExternalChanges()).toBe(true)
        expect(f.desc()).toBe('later external edit')
        if (merge) expect(deps.liveFilesAdoption).not.toBeNull()
    })

    it('refuses to replace a file another program rewrote after the save began', () => {
        const f = fixture()
        f.database.characters[0].desc = 'app edit'
        const save = f.sync.beginSave()
        f.editExternally()
        expect(() => observeWrites(save, () => f.save())).toThrow(expect.objectContaining({ code: 'CANONICAL_FILES_CHANGED' }))
        expect(f.desc()).toBe('external')
        expect(save.settle()).toBeNull()
        expect(f.sync.hasExternalChanges()).toBe(true)
        expect(f.sync.changedFiles()).toEqual([{ path: f.metadata, status: 'changed' }])
    })

    it('reports a file the app left unchanged as pending after the transaction stops', () => {
        const f = fixture()
        const save = f.sync.beginSave()
        f.editExternally()
        expect(() => observeWrites(save, () => f.save())).toThrow(expect.objectContaining({ code: 'CANONICAL_FILES_CHANGED' }))
        save.settle()
        expect(f.sync.hasExternalChanges()).toBe(true)
        expect(f.desc()).toBe('external')
    })
})
