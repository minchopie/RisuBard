import { afterEach, describe, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { fixtureDav } from '../nas-sync-dav-fixture'
const { createContentUpdates, validPointer, NAMESPACE } = require('./content-updates.cjs')

const roots: string[] = []
function root() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-content-updates-')); roots.push(dir); return dir }
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex')
const route = { endpointFor: async (config: any) => ({ url: config.url, servername: '' }) }
function device(dav = fixtureDav(), name = 'tablet') {
    return { dav, updates: createContentUpdates({ dataRoot: root(), secrets: dav.secrets, route, fetch: dav.fetch, deviceName: () => name }) }
}
const card = Buffer.from('PK fake charx bytes for 1.2.34-argon.4')
const meta = { key: 'character:마물소녀도감', kind: 'character', title: '마물소녀도감 1.2.34-argon.4 ver', version: '1.2.34-argon.4', fileName: 'MGE_v1.2.34-argon.4_Full.charx' }

describe('content updates', () => {
    test('without NAS settings nothing is published or asked', async () => {
        const updates = createContentUpdates({ dataRoot: root(), secrets: { get: async () => ({}) }, route, fetch: async () => { throw new Error('no network') } })
        expect(await updates.overview()).toEqual({ configured: false, items: [], pending: [] })
        await expect(updates.publish(Readable.from([card]), meta)).rejects.toThrow(/NAS/)
    })

    test('publishing stores the file under its SHA-256 and the pointer; the publisher is not asked, another device is', async () => {
        const dav = fixtureDav()
        const pc = device(dav, 'pc'), tablet = device(dav, 'tablet')
        const item = await pc.updates.publish(Readable.from([card]), meta)
        expect(item).toMatchObject({ key: meta.key, sha256: sha(card), bytes: card.length, file: `${sha(card)}.charx`, publishedBy: 'pc' })
        expect(dav.paths()).toEqual([`${NAMESPACE}${sha(card)}.charx`, `${NAMESPACE}latest.json`].sort())
        expect((await pc.updates.overview()).pending).toEqual([])
        const other = await tablet.updates.overview()
        expect(other.pending.map((x: any) => x.key)).toEqual([meta.key])
        const { file } = await tablet.updates.download(meta.key, item.sha256)
        expect(fs.readFileSync(file)).toEqual(card)
        fs.rmSync(file)
        tablet.updates.decide(meta.key, item.sha256, 'applied')
        expect((await tablet.updates.overview()).pending).toEqual([])
    })

    test('a new version under the same key replaces the old entry and is asked again; other keys stay', async () => {
        const dav = fixtureDav(), pc = device(dav, 'pc'), phone = device(dav, 'phone')
        const first = await pc.updates.publish(Readable.from([card]), meta)
        const persona = Buffer.from('persona png bytes')
        await pc.updates.publish(Readable.from([persona]), { key: 'persona:함건희(보어·용사지망)', kind: 'persona', title: '함건희(보어·용사지망)', version: '1.0.30-aspirant.6', fileName: 'a.png' })
        phone.updates.decide(meta.key, first.sha256, 'declined')
        expect((await phone.updates.overview()).pending.map((x: any) => x.kind)).toEqual(['persona'])
        const next = Buffer.from('PK fake charx bytes for 1.2.34-argon.5')
        await pc.updates.publish(Readable.from([next]), { ...meta, version: '1.2.34-argon.5' })
        const overview = await phone.updates.overview()
        expect(overview.items).toHaveLength(2)
        expect(overview.pending.map((x: any) => x.version).sort()).toEqual(['1.0.30-aspirant.6', '1.2.34-argon.5'])
        // reset forgets only the answer for that exact file
        phone.updates.decide(meta.key, sha(next), 'declined')
        phone.updates.decide(meta.key, sha(next), 'reset')
        expect((await phone.updates.overview()).pending.some((x: any) => x.key === meta.key)).toBe(true)
    })

    test('a changed or damaged NAS file is refused and leaves nothing behind', async () => {
        const dav = fixtureDav(), pc = device(dav, 'pc'), tablet = device(dav, 'tablet')
        const item = await pc.updates.publish(Readable.from([card]), meta)
        dav.files.set(`${NAMESPACE}${item.file}`, Buffer.from('tampered!'.padEnd(card.length, '!')))
        await expect(tablet.updates.download(meta.key, item.sha256)).rejects.toThrow(/배포본과 달라요/)
        await expect(tablet.updates.download(meta.key, 'f'.repeat(64))).rejects.toThrow(/바뀌었어요/)
        // roots[1] is the tablet's data root
        expect(fs.readdirSync(path.join(roots[1], 'content-updates', 'tmp'))).toEqual([])
    })

    test('rejects bad keys, kinds, file types and pointer contents', async () => {
        const { updates } = device()
        await expect(updates.publish(Readable.from([card]), { ...meta, key: 'persona:x' })).rejects.toThrow(/배포 이름/)
        await expect(updates.publish(Readable.from([card]), { ...meta, key: 'character:' })).rejects.toThrow(/배포 이름/)
        await expect(updates.publish(Readable.from([card]), { ...meta, fileName: 'card.exe' })).rejects.toThrow(/형식/)
        await expect(updates.publish(Readable.from([card]), { ...meta, kind: 'persona', key: 'persona:x', fileName: 'x.charx' })).rejects.toThrow(/형식/)
        expect(() => updates.decide('character:x', 'nothex', 'applied')).toThrow()
        expect(() => updates.decide('character:x', 'a'.repeat(64), 'whatever')).toThrow()
        const good = { key: 'character:a', kind: 'character', title: 'a', version: '', file: `${'a'.repeat(64)}.charx`, fileName: 'a.charx', sha256: 'a'.repeat(64), bytes: 3, publishedAt: new Date().toISOString() }
        expect(validPointer({ schema: 1, items: [good] }).items).toHaveLength(1)
        expect(() => validPointer({ schema: 1, items: [good, good] })).toThrow(/Duplicate/)
        expect(() => validPointer({ schema: 1, items: [{ ...good, file: '../x.charx' }] })).toThrow()
        expect(() => validPointer({ schema: 1, items: [{ ...good, fileName: '../a.charx' }] })).toThrow()
        expect(() => validPointer({ schema: 1, items: [{ ...good, kind: 'persona' }] })).toThrow()
        expect(() => validPointer({ schema: 2, items: [] })).toThrow()
    })

    test('state survives a restart and an unreadable state file starts empty', async () => {
        const dav = fixtureDav(), dir = root()
        const make = () => createContentUpdates({ dataRoot: dir, secrets: dav.secrets, route, fetch: dav.fetch })
        const item = await device(dav, 'pc').updates.publish(Readable.from([card]), meta)
        make().decide(meta.key, item.sha256, 'applied')
        expect((await make().overview()).pending).toEqual([])
        fs.writeFileSync(path.join(dir, 'content-updates', 'state.json'), '{broken')
        expect((await make().overview()).pending).toHaveLength(1)
    })

    test('two devices publishing at the same time both stay listed (NAS lock), and the lock is released', async () => {
        const dav = fixtureDav(), pc = device(dav, 'pc'), tablet = device(dav, 'tablet'), phone = device(dav, 'phone')
        const a = Buffer.from('card A'), b = Buffer.from('persona B png')
        await Promise.all([
            pc.updates.publish(Readable.from([a]), meta),
            tablet.updates.publish(Readable.from([b]), { key: 'persona:B', kind: 'persona', title: 'B', version: '', fileName: 'b.png' }),
        ])
        expect((await phone.updates.overview()).items.map((x: any) => x.key).sort()).toEqual(['character:마물소녀도감', 'persona:B'])
        expect(dav.paths().some(p => p.endsWith('latest.lock'))).toBe(false)
        expect(dav.paths().filter(p => /latest-.*\.json$/.test(p))).toEqual([])
    })

    test('a stale lock left by a stopped device is taken over and released', async () => {
        const dav = fixtureDav(), pc = device(dav, 'pc')
        await pc.updates.publish(Readable.from([card]), meta)
        dav.files.set(`${NAMESPACE}latest.lock`, Buffer.from(JSON.stringify({ at: Date.now() - 10 * 60_000, by: 'gone' })))
        const next = Buffer.from('card v2')
        await pc.updates.publish(Readable.from([next]), { ...meta, version: 'v2' })
        expect((await pc.updates.overview()).items[0].sha256).toBe(sha(next))
        expect(dav.paths().some(p => p.endsWith('latest.lock'))).toBe(false)
    })

    test('a publish that would make the list unreadably large is refused and leaves the list as it was', async () => {
        const dav = fixtureDav(), pc = device(dav, 'pc')
        const items: any[] = []
        const long = '가'.repeat(190)
        for (let i = 0; ; i++) {
            const h = createHash('sha256').update(String(i)).digest('hex')
            const item = { key: `character:${i}-${'나'.repeat(100)}`, kind: 'character', title: long, version: '', file: `${h}.charx`, fileName: `${long}.charx`, sha256: h, bytes: 1, publishedAt: new Date().toISOString(), publishedBy: '' }
            // Fill the list to just under the 256 KiB read limit (still readable), so one more long item goes over it.
            if (Buffer.byteLength(JSON.stringify(validPointer({ schema: 1, items: [...items, item] }), null, 2)) > 256 * 1024 - 300) break
            items.push(item)
        }
        dav.dirs.add(NAMESPACE.replace(/\/$/, ''))
        const before = Buffer.from(JSON.stringify({ schema: 1, items }, null, 2))
        dav.files.set(`${NAMESPACE}latest.json`, before)
        await expect(pc.updates.publish(Readable.from([card]), { ...meta, title: long, fileName: `${long}.charx` })).rejects.toThrow(/너무 커요/)
        expect(dav.files.get(`${NAMESPACE}latest.json`)).toEqual(before)
        expect(dav.paths().some(p => p.endsWith('latest.lock'))).toBe(false)
    })
})
