import { test, expect, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, readdir, open, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import { createRequire } from 'node:module'
import { snapshotPlaySet } from '../../shared/play-set/snapshot'
import { hashBytes, revisionOf } from '../../shared/play-set/protocol'

const require = createRequire(import.meta.url)
const { writePlaySetArchive, openPlaySetArchive } = require('./play-set-archive.cjs')
const { ZipFile } = require('yazl')

async function sample() {
    const result = await snapshotPlaySet({
        database: { characters: [{ chaId: 'card', name: '합성 카드', chats: [{ id: 'chat', message: [{ role: 'char', data: '저장된 대화' }], scriptstate: { count: 7 } }], chatPage: 0 }] },
        origin: 'source', asset: async () => null, cold: async () => null, inlay: async () => null,
    }, { characterId: 'card', chatIds: ['chat'], primaryChatId: 'chat', setId: 'set', characterChatsOnly: true })
    const data = new Blob(['위키 Markdown 원문']), hash = await hashBytes(new Uint8Array(await data.arrayBuffer()))
    result.manifest.version = 2
    result.manifest.bard = [{ character: result.manifest.primaryCharacter, chat: result.manifest.primaryChat,
        sourceCharacterId: 'card', sourceChatId: 'chat', files: [{ path: 'wiki/locations/place.md', hash, entry: `blobs/${hash}`, bytes: data.size }], slots: [] }]
    result.blobs.set(`blobs/${hash}`, data)
    result.manifest.revision = await revisionOf(result.manifest)
    return result
}
async function temporary(t: { onTestFinished: (fn: () => Promise<void>) => void }) {
    const root = await mkdtemp(join(tmpdir(), 'bard-play-archive-'))
    t.onTestFinished(() => rm(root, { recursive: true, force: true }))
    return root
}
test('real streaming ZIP roundtrip preserves records and Bard blocks; extraction never overwrites a file', async t => {
    const root = await temporary(t), snapshot = await sample()
    const path = await writePlaySetArchive(snapshot, root), read = await openPlaySetArchive(path, root)
    try {
        expect(read.manifest).toEqual(snapshot.manifest)
        expect(read.records).toEqual(snapshot.records)
        const target = join(root, 'wiki.md'), entry = snapshot.manifest.bard![0].files[0].entry
        await read.copyEntry(entry, target)
        expect(await readFile(target, 'utf8')).toBe('위키 Markdown 원문')
        await expect(read.copyEntry(entry, target)).rejects.toThrow()
        expect(await readFile(target, 'utf8')).toBe('위키 Markdown 원문')
    } finally { await Promise.all([read.close(), read.close()]); await read.close() }
})
test('a binary block beyond the old 64MiB cap streams without whole-file arrayBuffer allocation', async t => {
    const root = await temporary(t), snapshot = await sample(), size = 65 * 1024 * 1024 + 17
    const chunk = Buffer.alloc(256 * 1024, 119), digest = createHash('sha256')
    for (let offset = 0; offset < size; offset += chunk.length) digest.update(chunk.subarray(0, Math.min(chunk.length, size - offset)))
    const hash = digest.digest('hex'), entry = `blobs/${hash}`
    snapshot.manifest.bard![0].files.push({ path: 'binary.dat', hash, entry, bytes: size })
    snapshot.blobs.set(entry, { size, type: 'application/octet-stream', arrayBuffer: async () => { throw new Error('whole file allocation forbidden') },
        slice: (start, end) => ({ arrayBuffer: async () => Uint8Array.from(chunk.subarray(0, end - start)).buffer }) })
    snapshot.manifest.revision = await revisionOf(snapshot.manifest)
    const path = await writePlaySetArchive(snapshot, root)
    expect((await stat(path)).size).toBeGreaterThan(64 * 1024 * 1024)
    const read = await openPlaySetArchive(path, root)
    try { expect(read.manifest.bard[0].files.at(-1).bytes).toBe(size) } finally { await read.close() }
}, 20_000)
test('source changes fail export and remove only its own temporary files', async t => {
    const root = await temporary(t), snapshot = await sample()
    await writeFile(join(root, 'keep'), 'unrelated')
    const block = snapshot.manifest.bard![0].files[0]
    snapshot.blobs.set(block.entry, new Blob([new Uint8Array(block.bytes)]))
    await expect(writePlaySetArchive(snapshot, root)).rejects.toThrow(/hash changed/)
    expect(await readdir(root)).toEqual(['keep'])
})

test('insufficient storage rejects writing and receiving without touching existing files', async t => {
    const root = await temporary(t), snapshot = await sample()
    const archive = await writePlaySetArchive(snapshot, root)
    await writeFile(join(root, 'keep'), 'unrelated')
    const before = await readdir(root)
    const disk = vi.spyOn(require('node:fs/promises'), 'statfs').mockResolvedValue({ bavail: 0n, bsize: 4096n })
    try {
        await expect(writePlaySetArchive(snapshot, root)).rejects.toThrow(/storage space/)
        await expect(openPlaySetArchive(archive, root)).rejects.toThrow(/space/i)
        expect(await readdir(root)).toEqual(before)
        expect(await readFile(join(root, 'keep'), 'utf8')).toBe('unrelated')
    } finally { disk.mockRestore() }
})
for (const kind of ['duplicate', 'symlink', 'truncated']) test(`rejects ${kind} archive input`, async t => {
    const root = await temporary(t), path = join(root, 'bad.risuplay')
    if (kind === 'truncated') await writeFile(path, 'PK\x03\x04broken')
    else {
        const zip = new ZipFile(), written = pipeline(zip.outputStream, createWriteStream(path))
        zip.addBuffer(Buffer.from('{}'), 'manifest.json', { mode: kind === 'symlink' ? 0o120777 : 0o100600 })
        if (kind === 'duplicate') zip.addBuffer(Buffer.from('{}'), 'manifest.json')
        zip.end(); await written
    }
    await expect(openPlaySetArchive(path, root)).rejects.toThrow()
})
test('rechecks streamed bytes when an opened archive changes after initial verification', async t => {
    const root = await temporary(t), snapshot = await sample(), path = await writePlaySetArchive(snapshot, root)
    const read = await openPlaySetArchive(path, root)
    try {
        const bytes = await readFile(path), body = Buffer.from('위키 Markdown 원문'), offset = bytes.indexOf(body)
        expect(offset).toBeGreaterThan(0)
        const handle = await open(path, 'r+'); await handle.write(Buffer.alloc(body.length, 97), 0, body.length, offset); await handle.close()
        const target = join(root, 'altered')
        await expect(read.copyEntry(snapshot.manifest.bard![0].files[0].entry, target)).rejects.toThrow(/changed/)
        expect(await readdir(root)).not.toContain('altered')
    } finally { await read.close() }
})
