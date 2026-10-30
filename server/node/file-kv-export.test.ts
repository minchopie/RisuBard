import { afterEach, describe, expect, test } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { access, mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
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
    })

    test('a manifest entry whose object is gone falls back to the same-digest store file, like kvGetOriginal', async () => {
        const f = await fixture()
        const bytes = Buffer.from('manifest shadowed asset'), key = `assets/${sha(bytes)}.png`
        f.kv.kvSet(key, bytes) // store file
        f.kv.kvReplacePrefixes([{ key, value: bytes }], []) // manifest entry + kv object (manifest wins)
        await unlink(f.objectPath(sha(bytes)))
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
