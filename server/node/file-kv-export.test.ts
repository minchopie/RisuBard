import { afterEach, describe, expect, test, vi } from 'vitest'
import fs, { mkdtempSync, rmSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// kvExportFile is the transfer/NAS staging reader (play-set-service, nas-sync-service).
// It must serve exactly the bytes kvGet serves, from the same location kvGetOriginal
// would read, and it must never hide a corrupt or missing source behind another copy.
const { createFileKv } = require('./file-kv.cjs')

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'risubard-kv-export-'))
    roots.push(root)
    const dataRoot = join(root, 'data'), out = join(root, 'out')
    await mkdir(dataRoot)
    await mkdir(out)
    const kv = createFileKv({ dataRoot })
    let count = 0
    return {
        dataRoot, kv,
        destination: () => join(out, `export-${++count}.bin`),
        objectPath: (digest: string) => join(dataRoot, 'kv', 'objects', digest),
        // Upstream v0.9.84 keeps content-addressed asset keys in asset-store/<2>/<digest>.<ext>.
        storeFile: (digest: string, ext = 'png') => join(dataRoot, 'asset-store', digest.slice(0, 2), `${digest}.${ext}`),
    }
}
const absent = (path: string) => expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
const hasAssetStore = (kv: any) => typeof kv.assetStoreStatus === 'function'

// The same test file runs on the fork base and on every reviewed upstream target; only
// targets that ship the asset store (upstream v0.9.84+) can build store-only fixtures.
const probeRoot = mkdtempSync(join(tmpdir(), 'risubard-kv-export-probe-'))
const assetStoreSupported = hasAssetStore(createFileKv({ dataRoot: probeRoot }))
rmSync(probeRoot, { recursive: true, force: true })

test('the verified NAS source is direct and a cached digest cannot hide same-size external changes', async () => {
    const f = await fixture()
    const key = 'assets/legacy.png', bytes = Buffer.from('original'), hash = sha(bytes)
    const source = f.objectPath(hash)
    const fixed = new Date('2026-01-01T00:00:00Z')
    expect(await f.kv.kvVerifiedAssetFile(key)).toBeNull()
    f.kv.kvSet(key, bytes)
    await utimes(source, fixed, fixed)
    expect(await f.kv.kvVerifiedAssetFile(key)).toEqual({ path: source, hash })
    expect(await f.kv.kvVerifiedAssetFile(key)).toEqual({ path: source, hash })
    await writeFile(source, 'modified')
    await utimes(source, fixed, fixed)
    await expect(f.kv.kvVerifiedAssetFile(key)).rejects.toThrow(/checksum mismatch/)
    await unlink(source)
    await expect(f.kv.kvVerifiedAssetFile(key)).rejects.toMatchObject({ code: 'ENOENT' })
})

async function checkpointFixture(count: number) {
    const f = await fixture(), { atomicWriteJson } = require('./file-store.cjs')
    const objects = Array.from({ length: count }, (_, i) => {
        const key = 'assets/file-' + i + '.png', value = Buffer.from(String(i).padStart(4, '0'))
        return { key, value, object: sha(value) }
    })
    await mkdir(join(f.dataRoot, 'kv', 'objects'), { recursive: true })
    await Promise.all(objects.map(({ object, value }) => writeFile(f.objectPath(object), value)))
    atomicWriteJson(f.dataRoot, 'kv/manifest.json', { schemaVersion: 1, updatedAt: 1,
        entries: Object.fromEntries(objects.map(({ key, object, value }) => [key, { object, size: value.length, updatedAt: 1 }])) })
    return { ...f, objects, checkpoint: join(f.dataRoot, 'kv', 'nas-asset-verification.json') }
}

test('an interrupted verification checkpoint resumes with a fresh KV instance and checks changed files', async () => {
    const f = await checkpointFixture(257), { objects, checkpoint } = f
    const kv = createFileKv({ dataRoot: f.dataRoot })
    await expect(kv.kvWithNasAssetVerification(async () => {
        for (const entry of objects.slice(0, 256)) await kv.kvVerifiedAssetFile(entry.key)
        throw new Error('capture interrupted')
    })).rejects.toThrow('capture interrupted')
    expect(JSON.parse(await readFile(checkpoint, 'utf8')).entries).toHaveLength(256)
    await writeFile(f.objectPath(objects[255].object), 'oops')
    const restarted = createFileKv({ dataRoot: f.dataRoot })
    const reads = vi.spyOn(fs, 'createReadStream')
    try {
        await restarted.kvWithNasAssetVerification(async () => {
            for (const entry of objects.slice(0, 255)) await restarted.kvVerifiedAssetFile(entry.key)
            expect(reads).not.toHaveBeenCalled()
            await expect(restarted.kvVerifiedAssetFile(objects[255].key)).rejects.toThrow(/checksum mismatch/)
            await restarted.kvVerifiedAssetFile(objects[256].key)
            expect(reads).toHaveBeenCalledTimes(2)
        })
    } finally { reads.mockRestore() }
    await absent(checkpoint)
    await absent(checkpoint + '.sha256')
})

test.each(['primary', 'both', 'interrupted replace'])('recovers only validated checkpoint generations after %s', async mode => {
    const f = await checkpointFixture(512)
    const { objects, checkpoint } = f
    const kv = createFileKv({ dataRoot: f.dataRoot })
    const renameSync = fs.renameSync
    const rename = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (mode === 'interrupted replace' && to === checkpoint && fs.existsSync(checkpoint)) {
            throw new Error('simulated interruption before replacing checkpoint')
        }
        return renameSync(from, to)
    })
    try {
        await expect(kv.kvWithNasAssetVerification(async () => {
            for (const entry of objects) await kv.kvVerifiedAssetFile(entry.key)
            throw new Error('capture interrupted')
        })).rejects.toThrow('capture interrupted')
    } finally { rename.mockRestore() }
    const main = JSON.parse(await readFile(checkpoint, 'utf8'))
    const backup = JSON.parse(await readFile(checkpoint + '.bak', 'utf8'))
    expect(main.entries).toHaveLength(mode === 'interrupted replace' ? 256 : 512)
    expect(backup.entries).toHaveLength(256)
    await absent(checkpoint + '.sha256')
    await absent(checkpoint + '.bak.sha256')
    if (mode !== 'interrupted replace') {
        main.entries.pop()
        await writeFile(checkpoint, JSON.stringify(main))
    }
    if (mode === 'both') await writeFile(checkpoint + '.bak', '{"entries":[],"checksum":"torn"}')
    const reopened = createFileKv({ dataRoot: f.dataRoot })
    const reads = vi.spyOn(fs, 'createReadStream')
    try {
        await reopened.kvWithNasAssetVerification(async () => {
            await reopened.kvVerifiedAssetFile(objects[0].key)
            expect(reads).toHaveBeenCalledTimes(mode === 'both' ? 1 : 0)
            await reopened.kvVerifiedAssetFile(objects[511].key)
            expect(reads).toHaveBeenCalledTimes(mode === 'both' ? 2 : 1)
        })
    } finally { reads.mockRestore() }
    await absent(checkpoint)
    await absent(checkpoint + '.bak')
})

describe('kvExportFile on KV objects', () => {
    test('exports a legacy object byte-for-byte and reports a missing key as false', async () => {
        const f = await fixture()
        const bytes = Buffer.from('legacy object bytes')
        f.kv.kvSet('misc/legacy.bin', bytes)
        const target = f.destination()
        await expect(f.kv.kvExportFile('misc/legacy.bin', target)).resolves.toBe(true)
        expect(await readFile(target)).toEqual(bytes)
        expect(Buffer.from(f.kv.kvGet('misc/legacy.bin'))).toEqual(bytes)

        const nothing = f.destination()
        await expect(f.kv.kvExportFile('misc/absent.bin', nothing)).resolves.toBe(false)
        await absent(nothing)
    })

    test('never overwrites an existing destination and leaves the source untouched', async () => {
        const f = await fixture()
        const bytes = Buffer.from('source bytes')
        f.kv.kvSet('misc/source.bin', bytes)
        const target = f.destination()
        await writeFile(target, 'keep')
        await expect(f.kv.kvExportFile('misc/source.bin', target)).rejects.toMatchObject({ code: 'EEXIST' })
        expect(await readFile(target, 'utf8')).toBe('keep')
        expect(await readFile(f.objectPath(sha(bytes)))).toEqual(bytes)
    })

    test('a corrupt object is an error, not an export', async () => {
        const f = await fixture()
        const bytes = Buffer.from('intact bytes')
        f.kv.kvSet('misc/corrupt.bin', bytes)
        await writeFile(f.objectPath(sha(bytes)), 'corrupt')
        const target = f.destination()
        await expect(f.kv.kvExportFile('misc/corrupt.bin', target)).rejects.toThrow(/checksum mismatch/)
        await absent(target)
    })

    test('a missing object whose key names a different digest stays missing (ENOENT, no fallback)', async () => {
        const f = await fixture()
        const bytes = Buffer.from('entry bytes'), other = Buffer.from('other bytes')
        const key = `assets/${sha(other)}.png` // key digest != entry.object
        f.kv.kvReplacePrefixes([{ key, value: bytes }], [])
        await unlink(f.objectPath(sha(bytes)))
        if (assetStoreSupported) {
            // A store file with the key's own name exists, but its digest is not the entry's object.
            await mkdir(join(f.dataRoot, 'asset-store', sha(other).slice(0, 2)), { recursive: true })
            await writeFile(f.storeFile(sha(other)), other)
            f.kv.reloadManifest()
        }
        const target = f.destination()
        await expect(f.kv.kvExportFile(key, target)).rejects.toMatchObject({ code: 'ENOENT' })
        await absent(target)
    })
})

describe.skipIf(!assetStoreSupported)('kvExportFile on the upstream asset store (v0.9.84+)', () => {
    test('a store-only asset exports the bytes kvGet serves', async () => {
        const f = await fixture()
        const bytes = Buffer.from('store-only asset'), key = `assets/${sha(bytes)}.png`
        f.kv.kvSet(key, bytes)
        await absent(f.objectPath(sha(bytes)))
        expect((await stat(f.storeFile(sha(bytes)))).size).toBe(bytes.length)
        const target = f.destination()
        await expect(f.kv.kvExportFile(key, target)).resolves.toBe(true)
        expect(await readFile(target)).toEqual(bytes)
        expect(Buffer.from(f.kv.kvGet(key))).toEqual(bytes)
        expect(await f.kv.kvVerifiedAssetFile(key)).toEqual({ path: f.storeFile(sha(bytes)), hash: sha(bytes) })
    })

    test('a manifest entry whose object is gone falls back to the same-digest store file, like kvGetOriginal', async () => {
        const f = await fixture()
        const bytes = Buffer.from('manifest shadowed asset'), key = `assets/${sha(bytes)}.png`
        f.kv.kvSet(key, bytes) // store file
        f.kv.kvReplacePrefixes([{ key, value: bytes }], []) // manifest entry + kv object (manifest wins)
        expect(await f.kv.kvVerifiedAssetFile(key)).toEqual({ path: f.objectPath(sha(bytes)), hash: sha(bytes) })
        await unlink(f.objectPath(sha(bytes)))
        expect(await f.kv.kvVerifiedAssetFile(key)).toEqual({ path: f.storeFile(sha(bytes)), hash: sha(bytes) })
        const target = f.destination()
        await expect(f.kv.kvExportFile(key, target)).resolves.toBe(true)
        expect(await readFile(target)).toEqual(bytes)
        expect(Buffer.from(f.kv.kvGet(key))).toEqual(bytes)
    })

    test('a retired entry whose object is gone falls back to the same-digest store file', async () => {
        const f = await fixture()
        const bytes = Buffer.from('retired shadowed asset'), key = `assets/${sha(bytes)}.png`
        f.kv.kvReplacePrefixes([{ key, value: bytes }], [])
        expect(f.kv.retireAssets('card', [{ key, object: sha(bytes), size: bytes.length }])).toEqual({ retired: 1 })
        await mkdir(join(f.dataRoot, 'asset-store', sha(bytes).slice(0, 2)), { recursive: true })
        await writeFile(f.storeFile(sha(bytes)), bytes)
        f.kv.reloadManifest()
        await unlink(f.objectPath(sha(bytes)))
        expect(await f.kv.kvVerifiedAssetFile(key)).toEqual({ path: f.storeFile(sha(bytes)), hash: sha(bytes) })
        const target = f.destination()
        await expect(f.kv.kvExportFile(key, target)).resolves.toBe(true)
        expect(await readFile(target)).toEqual(bytes)
        expect(Buffer.from(f.kv.kvGet(key))).toEqual(bytes)
    })

    test('a corrupt object is reported even when a valid store file with the same digest exists', async () => {
        const f = await fixture()
        const bytes = Buffer.from('object corrupt, store valid'), key = `assets/${sha(bytes)}.png`
        f.kv.kvSet(key, bytes)
        f.kv.kvReplacePrefixes([{ key, value: bytes }], [])
        await writeFile(f.objectPath(sha(bytes)), 'corrupt')
        await expect(f.kv.kvVerifiedAssetFile(key)).rejects.toThrow(/checksum mismatch/)
        const target = f.destination()
        await expect(f.kv.kvExportFile(key, target)).rejects.toThrow(/checksum mismatch/)
        await absent(target)
        expect(await readFile(f.storeFile(sha(bytes)))).toEqual(bytes)
    })

    test('a store-only export never overwrites an existing destination', async () => {
        const f = await fixture()
        const bytes = Buffer.from('store asset, destination taken'), key = `assets/${sha(bytes)}.png`
        f.kv.kvSet(key, bytes)
        const target = f.destination()
        await writeFile(target, 'keep')
        await expect(f.kv.kvExportFile(key, target)).rejects.toMatchObject({ code: 'EEXIST' })
        expect(await readFile(target, 'utf8')).toBe('keep')
        expect(await readFile(f.storeFile(sha(bytes)))).toEqual(bytes)
    })

    test('a store file removed behind the index is an I/O error, not false and not another copy', async () => {
        const f = await fixture()
        const bytes = Buffer.from('store asset removed externally'), key = `assets/${sha(bytes)}.png`
        f.kv.kvSet(key, bytes)
        await unlink(f.storeFile(sha(bytes)))
        const target = f.destination()
        await expect(f.kv.kvExportFile(key, target)).rejects.toMatchObject({ code: 'ENOENT' })
        await absent(target)
    })
})
