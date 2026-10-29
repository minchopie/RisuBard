import { afterEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { createFileKv } = require('./file-kv.cjs')

const roots: string[] = []
function root() {
    const value = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-kv-'))
    roots.push(value)
    return value
}
afterEach(() => roots.splice(0).forEach(value => fs.rmSync(value, { recursive: true, force: true })))

describe('file-native KV compatibility projection', () => {
    it('updates one key without reparsing the whole in-memory manifest, retaining checksum and reopen compatibility', () => {
        const dataRoot = root()
        const store = createFileKv({ dataRoot })
        store.kvSetMany(Array.from({ length: 100 }, (_, i) => ({ key: `assets/large-index-${i}`, value: Buffer.from(`asset ${i}`) })))
        const parse = vi.spyOn(JSON, 'parse')
        try {
            store.kvSet('database/canonical-projection-revision', Buffer.from('new-revision'))
            expect(parse.mock.calls.filter(([value]) => String(value).includes('assets/large-index-99'))).toHaveLength(0)
        } finally { parse.mockRestore() }
        const bytes = fs.readFileSync(path.join(dataRoot, 'kv/manifest.json'))
        expect(fs.readFileSync(path.join(dataRoot, 'kv/manifest.json.sha256'), 'utf8').trim())
            .toBe(crypto.createHash('sha256').update(bytes).digest('hex'))
        const reopened = createFileKv({ dataRoot })
        expect(reopened.kvGet('database/canonical-projection-revision')?.toString()).toBe('new-revision')
        expect(reopened.kvGet('assets/large-index-99')?.toString()).toBe('asset 99')
        expect(reopened.kvList('assets/')).toHaveLength(100)
    })
    it('prepares bulk asset objects concurrently before publishing one manifest', async () => {
        const dataRoot = root()
        const store = createFileKv({ dataRoot })
        const writeMany = store.kvSetManyAsync

        expect(typeof writeMany).toBe('function')
        if (typeof writeMany !== 'function') return
        await writeMany([
            { key: 'assets/a', value: Buffer.from('asset-a') },
            { key: 'assets/b', value: Buffer.from('asset-b') },
        ])

        const reopened = createFileKv({ dataRoot })
        expect(reopened.kvList('assets/')).toEqual(['assets/a', 'assets/b'])
        expect(reopened.kvGet('assets/a')?.toString()).toBe('asset-a')
    })

    it('routes bulk asset writes through the concurrent file-KV path', () => {
        const server = fs.readFileSync(path.join(process.cwd(), 'server/node/server.cjs'), 'utf8')
        const route = server.slice(
            server.indexOf("app.post('/api/assets/bulk-write'"),
            server.indexOf('// ── Settings-only export', server.indexOf("app.post('/api/assets/bulk-write'")),
        )

        expect(server).toMatch(/const \{[^}]*kvSetManyAsync[^}]*\} = require\('\.\/db\.cjs'\)/s)
        expect(route).toContain('await kvSetManyAsync(')
    })

    it('promotes a verified staged file into the object store without recopying it', async () => {
        const dataRoot = root()
        const stagingRoot = root()
        const sourcePath = path.join(stagingRoot, 'large.bin')
        const value = Buffer.alloc(2 * 1024 * 1024, 0x6b)
        const stagedMtime = new Date('2001-02-03T04:05:06.000Z')
        fs.writeFileSync(sourcePath, value)
        fs.utimesSync(sourcePath, stagedMtime, stagedMtime)

        const store = createFileKv({ dataRoot })
        await store.kvReplacePrefixesFromFilesAsync([
            { key: 'assets/large', sourcePath },
        ], ['assets/'])

        const hash = crypto.createHash('sha256').update(value).digest('hex')
        const objectPath = path.join(dataRoot, 'kv', 'objects', hash)
        expect(fs.existsSync(sourcePath)).toBe(false)
        expect(fs.statSync(objectPath).mtimeMs).toBe(stagedMtime.getTime())
        expect(store.kvGet('assets/large')).toEqual(value)
    })

    it('publishes replacement values from staged files without loading them into entry buffers', async () => {
        const dataRoot = root()
        const stagingRoot = root()
        const sourcePath = path.join(stagingRoot, 'large.bin')
        fs.writeFileSync(sourcePath, Buffer.alloc(2 * 1024 * 1024, 0x6b))
        const store = createFileKv({ dataRoot })
        store.kvSet('assets/old', Buffer.from('old'))

        await store.kvReplacePrefixesFromFilesAsync([
            { key: 'assets/large', sourcePath },
        ], ['assets/'])

        expect(store.kvList('assets/')).toEqual(['assets/large'])
        expect(store.kvSize('assets/large')).toBe(2 * 1024 * 1024)
        expect(store.kvGet('assets/large')).toEqual(Buffer.alloc(2 * 1024 * 1024, 0x6b))
    })

    it('prepares a file replacement without changing the live manifest and reloads it after publication', async () => {
        const dataRoot = root()
        const stagingRoot = root()
        const sourcePath = path.join(stagingRoot, 'replacement.bin')
        fs.writeFileSync(sourcePath, Buffer.from('replacement'))
        const store = createFileKv({ dataRoot })
        store.kvSet('assets/old', Buffer.from('old'))

        const prepared = await store.preparePrefixReplacementFromFilesAsync([
            { key: 'assets/new', sourcePath },
        ], ['assets/'])

        expect(store.kvList('assets/')).toEqual(['assets/old'])
        const { commitTransaction } = require('./file-store.cjs')
        commitTransaction(dataRoot, [{ path: 'kv/manifest.json', data: prepared.manifestBytes }])
        expect(store.kvList('assets/')).toEqual(['assets/old'])
        store.reloadManifest()
        expect(store.kvList('assets/')).toEqual(['assets/new'])
        expect(store.kvGet('assets/new')?.toString()).toBe('replacement')
    })

    it('prepares replacement objects asynchronously before publishing one manifest', async () => {
        const dataRoot = root()
        const store = createFileKv({ dataRoot })

        await store.kvReplaceAllAsync([
            { key: 'database/database.bin', value: Buffer.from('database') },
            { key: 'assets/a', value: Buffer.from('asset-a') },
        ])

        const reopened = createFileKv({ dataRoot })
        expect(reopened.kvList()).toEqual(['assets/a', 'database/database.bin'])
        expect(reopened.kvGet('assets/a')?.toString()).toBe('asset-a')
    })

    it('round-trips binary values and persists only a small manifest plus content objects', () => {
        const dataRoot = root()
        const store = createFileKv({ dataRoot })
        expect(store).not.toHaveProperty('dataRoot')
        store.kvSet('database/database.bin', Buffer.from([0, 1, 2, 255]))

        const reopened = createFileKv({ dataRoot })
        expect(reopened.kvGet('database/database.bin')).toEqual(Buffer.from([0, 1, 2, 255]))
        expect(reopened.kvList()).toEqual(['database/database.bin'])
        expect(fs.existsSync(path.join(dataRoot, 'risuai.db'))).toBe(false)
        expect(fs.readdirSync(path.join(dataRoot, 'kv', 'objects'))).toHaveLength(1)
    })

    it('copies snapshots by content reference and keeps them stable after live data changes', () => {
        const dataRoot = root()
        const store = createFileKv({ dataRoot })
        store.kvSet('database/database.bin', Buffer.from('revision-1'))
        store.kvCopyValue('database/database.bin', 'database/dbbackup-1.bin')
        store.kvSet('database/database.bin', Buffer.from('revision-2'))

        expect(store.kvGet('database/dbbackup-1.bin')?.toString()).toBe('revision-1')
        expect(store.kvGet('database/database.bin')?.toString()).toBe('revision-2')
        expect(store.snapshotFootprint('database/dbbackup-1.bin')).toBe(Buffer.byteLength('revision-1'))
    })

    it('releases a replaced database object right away unless a snapshot shares it', () => {
        const dataRoot = root()
        const store = createFileKv({ dataRoot })
        const objects = () => fs.readdirSync(path.join(dataRoot, 'kv', 'objects')).length
        store.kvSet('database/database.bin', Buffer.from('revision-1'))
        store.kvSet('database/database.bin', Buffer.from('revision-2'))
        store.kvSet('database/database.bin', Buffer.from('revision-3'))
        expect(objects()).toBe(1)

        store.kvCopyValue('database/database.bin', 'database/dbbackup-1.bin')
        store.kvSet('database/database.bin', Buffer.from('revision-4'))
        expect(objects()).toBe(2)
        expect(store.kvGet('database/dbbackup-1.bin')?.toString()).toBe('revision-3')

        store.kvSet('assets/a', Buffer.from('asset-1'))
        store.kvSet('assets/a', Buffer.from('asset-2'))
        expect(objects()).toBe(4)
    })

    it('supports prefix listing, sizes, deletion, and reclaiming unreferenced objects', () => {
        const dataRoot = root()
        const store = createFileKv({ dataRoot })
        store.kvSet('assets/a', Buffer.from('aaa'))
        store.kvSet('assets/b', Buffer.from('bbbb'))
        store.kvSet('settings/c', Buffer.from('cc'))

        expect(store.kvListWithSizes('assets/')).toEqual([
            { key: 'assets/a', size: 3 },
            { key: 'assets/b', size: 4 },
        ])
        expect(store.objectStoreBytes()).toBe(9)
        store.kvDelPrefix('assets/')
        expect(store.kvList()).toEqual(['settings/c'])
        expect(store.reclaimableChunkBytes()).toBe(7)
        expect(store.gcChunks()).toEqual({ count: 2, bytes: 7 })
        expect(store.objectStoreBytes()).toBe(2)
        expect(fs.existsSync(path.join(dataRoot, 'trash'))).toBe(false)
    })

    it('bulk-deletes unique keys with one logical result', () => {
        const dataRoot = root()
        const store = createFileKv({ dataRoot })
        store.kvSet('assets/a', Buffer.from('aaa'))
        store.kvSet('assets/b', Buffer.from('bbbb'))
        store.kvSet('settings/c', Buffer.from('cc'))

        expect(store.kvDelMany(['assets/a', 'assets/b', 'assets/a', 'missing'])).toEqual({
            count: 2,
            bytes: 7,
        })

        const reopened = createFileKv({ dataRoot })
        expect(reopened.kvList()).toEqual(['settings/c'])
        expect(reopened.reclaimableChunkBytes()).toBe(7)
    })

    it('keeps recent unreachable objects during grace-period cleanup', () => {
        const dataRoot = root()
        const store = createFileKv({ dataRoot })
        const objectsDir = path.join(dataRoot, 'kv', 'objects')

        const oldValue = Buffer.from('old-orphan')
        store.kvSet('assets/old', oldValue)
        const oldObject = fs.readdirSync(objectsDir)[0]
        store.kvSet('assets/old', Buffer.from('current-old'))

        const beforeRecent = new Set(fs.readdirSync(objectsDir))
        const recentValue = Buffer.from('recent-orphan')
        store.kvSet('assets/recent', recentValue)
        const recentObject = fs.readdirSync(objectsDir).find(name => !beforeRecent.has(name))!
        store.kvSet('assets/recent', Buffer.from('current-recent'))

        const now = Date.now()
        fs.utimesSync(path.join(objectsDir, oldObject), new Date(now - 2 * 60 * 60 * 1000), new Date(now - 2 * 60 * 60 * 1000))
        fs.utimesSync(path.join(objectsDir, recentObject), new Date(now - 30 * 60 * 1000), new Date(now - 30 * 60 * 1000))

        expect(store.gcChunks({ minAgeMs: 60 * 60 * 1000, now })).toEqual({
            count: 1,
            bytes: oldValue.length,
        })
        expect(fs.existsSync(path.join(objectsDir, oldObject))).toBe(false)
        expect(fs.existsSync(path.join(objectsDir, recentObject))).toBe(true)
    })

    it('limits automatic cleanup work to the requested batch size', () => {
        const dataRoot = root()
        const store = createFileKv({ dataRoot })
        store.kvSet('assets/a', Buffer.from('old-a'))
        store.kvSet('assets/a', Buffer.from('current-a'))
        store.kvSet('assets/b', Buffer.from('old-b'))
        store.kvSet('assets/b', Buffer.from('current-b'))

        expect(store.reclaimableChunkBytes()).toBe(10)
        expect(store.gcChunks({ maxDeletes: 1 })).toEqual({ count: 1, bytes: 5 })
        expect(store.reclaimableChunkBytes()).toBe(5)
    })

    it('imports the legacy hexadecimal save-folder layout once without overwriting canonical values', () => {
        const dataRoot = root()
        const key = 'database/database.bin'
        fs.writeFileSync(path.join(dataRoot, Buffer.from(key).toString('hex')), Buffer.from('legacy'))
        const store = createFileKv({ dataRoot })
        expect(store.kvGet(key)?.toString()).toBe('legacy')

        fs.writeFileSync(path.join(dataRoot, Buffer.from(key).toString('hex')), Buffer.from('changed-legacy'))
        const reopened = createFileKv({ dataRoot })
        expect(reopened.kvGet(key)?.toString()).toBe('legacy')
    })
})
