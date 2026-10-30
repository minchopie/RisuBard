import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(__dirname, '..', '..')
const sqliteRuntime = /better-sqlite3|new\s+Database\s*\(|(?<!\.)\.db(?:['"`]|\b)/i

function runtimeFiles(directory: string): string[] {
    const files: string[] = []
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        const target = path.join(directory, entry.name)
        if (entry.isDirectory()) files.push(...runtimeFiles(target))
        else if (/\.(?:cjs|mjs|js|ts)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) files.push(target)
    }
    return files
}

describe('native SQLite removal', () => {
    it('distinguishes object spread from SQLite file paths', () => {
        expect(sqliteRuntime.test('return { ...db, characters }')).toBe(false)
        expect(sqliteRuntime.test("open('risuai.db')")).toBe(true)
        expect(sqliteRuntime.test('new Database(file)')).toBe(true)
    })
    it('has no runtime SQLite import or database creation', () => {
        const offenders = runtimeFiles(path.join(root, 'server'))
            // db.cjs is the one-shot dispatcher that notices an old risuai.db;
            // only the importer may load a SQLite reader.
            .filter(file => !['legacy-sqlite-import.cjs', 'db.cjs'].includes(path.basename(file)))
            .filter(file => sqliteRuntime.test(fs.readFileSync(file, 'utf8')))
            .map(file => path.relative(root, file))
        expect(offenders).toEqual([])
    })

    it('does not declare or package better-sqlite3', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
        expect(pkg.dependencies?.['better-sqlite3']).toBeUndefined()
        expect(JSON.stringify(pkg.build ?? {})).not.toContain('better-sqlite3')
    })

    it('does not retain the obsolete SQL chunk store', () => {
        expect(fs.existsSync(path.join(root, 'server', 'node', 'chunkStore.cjs'))).toBe(false)
    })

    it('does not expose the obsolete WAL checkpoint route or dashboard control', () => {
        const server = fs.readFileSync(path.join(root, 'server', 'node', 'server.cjs'), 'utf8')
        const dashboard = fs.readFileSync(
            path.join(root, 'src', 'lib', 'Setting', 'Pages', 'SystemDashboard.svelte'),
            'utf8',
        )

        expect(server).not.toContain("app.post('/api/db/wal-checkpoint'")
        expect(dashboard).not.toContain('/api/db/wal-checkpoint')
        expect(dashboard).not.toContain('walCleanupOpen')
    })

    it('does not retain no-op WAL maintenance hooks', () => {
        const server = fs.readFileSync(path.join(root, 'server', 'node', 'server.cjs'), 'utf8')
        const fileKv = fs.readFileSync(path.join(root, 'server', 'node', 'file-kv.cjs'), 'utf8')

        expect(fileKv).not.toContain('checkpointWal')
        expect(server).not.toMatch(/WAL checkpoint|checkpoint WAL|SQLite DB/)
    })

    it('does not render nonexistent WAL or SHM storage metrics', () => {
        const dashboard = fs.readFileSync(
            path.join(root, 'src', 'lib', 'Setting', 'Pages', 'SystemDashboard.svelte'),
            'utf8',
        )

        expect(dashboard).not.toMatch(/stats\.files\.(?:wal|shm)/)
        expect(dashboard).not.toMatch(/storageRow(?:Wal|Shm)/)
        expect(dashboard).not.toMatch(/stats\.chunks/)
    })

    it('does not retain obsolete entity or SQL-chunk helpers', () => {
        const server = fs.readFileSync(path.join(root, 'server', 'node', 'server.cjs'), 'utf8')
        const fileKv = fs.readFileSync(path.join(root, 'server', 'node', 'file-kv.cjs'), 'utf8')

        expect(fileKv).not.toContain('clearEntities')
        expect(fileKv).not.toContain('isDbBlobChunked')
        expect(server).not.toMatch(/\bclearEntities\s*\(/)
        expect(server).not.toMatch(/\bisDbBlobChunked\s*\(/)
        expect(server).not.toContain('function clearExistingData')
    })

    it('isolates native storage metrics from the legacy SQLite response', () => {
        const server = fs.readFileSync(path.join(root, 'server', 'node', 'server.cjs'), 'utf8')
        const dashboard = fs.readFileSync(
            path.join(root, 'src', 'lib', 'Setting', 'Pages', 'SystemDashboard.svelte'),
            'utf8',
        )

        expect(server).toContain("storage: { reclaimable, mode: 'file-native' }")
        expect(server).toContain('sqlite: {')
        expect(dashboard).toContain('stats.storage.reclaimable')
        expect(dashboard).not.toContain('stats.sqlite.reclaimable')
        expect(dashboard).toContain('payload.storage ??')
        expect(dashboard).toContain('payload.sqlite?.reclaimable ?? 0')
        const statsInterface = dashboard.match(/interface Stats \{[\s\S]*?\n    \}/)?.[0] ?? ''
        expect(statsInterface).not.toContain('sqlite:')
        expect(server).not.toMatch(/const (?:pageSize|pageCount|freelistCount|journalMode|autoVacuum) =/)
    })

    it('uses physical object-store bytes and reports bytes deleted by file GC', () => {
        const server = fs.readFileSync(path.join(root, 'server', 'node', 'server.cjs'), 'utf8')

        expect(server).toContain('objectStoreBytes')
        expect(server).toContain('const fileStoreBytes = objectStoreBytes();')
        expect(server).toContain('const preStoreBytes = objectStoreBytes();')
        expect(server).toContain('const gcResult = gcChunks();')
        expect(server).toContain('reclaimed: gcResult.bytes')
    })

    it('does not create automatic compatibility snapshots and runs grace-period object GC instead', () => {
        const server = fs.readFileSync(path.join(root, 'server', 'node', 'server.cjs'), 'utf8')

        expect(server).not.toContain('function createBackupAndRotate')
        expect(server).not.toContain('BACKUP_INTERVAL_MS')
        expect(server).not.toContain('createBackupAndRotate()')
        expect(server).toContain('function maybeCollectUnreferencedObjects')
        expect(server).toContain('gcChunks({ minAgeMs: GC_MIN_AGE_MS, maxDeletes: GC_BATCH_SIZE, now })')
    })

    it('does not retain stale SQLite runtime wording in active frontend paths', () => {
        const server = fs.readFileSync(path.join(root, 'server', 'node', 'server.cjs'), 'utf8')
        const dashboard = fs.readFileSync(
            path.join(root, 'src', 'lib', 'Setting', 'Pages', 'SystemDashboard.svelte'),
            'utf8',
        )
        const chatDraft = fs.readFileSync(
            path.join(root, 'src', 'ts', 'storage', 'chatDraft.ts'),
            'utf8',
        )
        const diskSpaceError = 'Insufficient disk space for file-store optimization'

        expect(server).not.toContain(diskSpaceError)
        expect(dashboard).not.toContain(diskSpaceError)
        expect(dashboard).not.toContain('VACUUM')
        expect(chatDraft).not.toContain('server SQLite `kv` table')
    })

    it('uses one destructive apply sequence for both save-folder import paths', () => {
        const server = fs.readFileSync(path.join(root, 'server', 'node', 'server.cjs'), 'utf8')
        const migrationBlock = server.slice(
            server.indexOf('// ── Save-folder migration endpoints'),
            server.indexOf('// ── Storage dashboard endpoints'),
        )

        expect(migrationBlock.match(/await flushPendingDb\(\)/g)).toHaveLength(1)
        expect(migrationBlock.match(/maybeCollectUnreferencedObjects\(\)/g)).toHaveLength(1)
        expect(migrationBlock.match(/invalidateDbCache\(\)/g)).toHaveLength(1)
        expect(migrationBlock.match(/kvReplaceAllAsync\(/g)).toHaveLength(1)
    })
})
