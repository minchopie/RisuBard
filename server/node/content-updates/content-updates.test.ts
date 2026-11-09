import { afterEach, describe, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { fixtureDav } from '../nas-sync-dav-fixture'
const { createContentUpdates, validItem, recordName, recordNames, NAMESPACE, MAX_ITEMS } = require('./content-updates.cjs')

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

    test('publishing stores the file under its SHA-256 and one record for the name; the publisher is not asked, another device is', async () => {
        const dav = fixtureDav()
        const pc = device(dav, 'pc'), tablet = device(dav, 'tablet')
        const item = await pc.updates.publish(Readable.from([card]), meta)
        expect(item).toMatchObject({ key: meta.key, sha256: sha(card), bytes: card.length, file: `${sha(card)}.charx`, publishedBy: 'pc' })
        expect(dav.paths()).toEqual([`${NAMESPACE}${sha(card)}.charx`, `${NAMESPACE}items/${recordName(meta.key)}`].sort())
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

    test('rejects bad keys, kinds, file types and record contents', async () => {
        const { updates } = device()
        await expect(updates.publish(Readable.from([card]), { ...meta, key: 'persona:x' })).rejects.toThrow(/배포 이름/)
        await expect(updates.publish(Readable.from([card]), { ...meta, key: 'character:' })).rejects.toThrow(/배포 이름/)
        await expect(updates.publish(Readable.from([card]), { ...meta, fileName: 'card.exe' })).rejects.toThrow(/형식/)
        await expect(updates.publish(Readable.from([card]), { ...meta, kind: 'persona', key: 'persona:x', fileName: 'x.charx' })).rejects.toThrow(/형식/)
        await expect(updates.download('../x', 'a'.repeat(64))).rejects.toThrow(/배포 이름/)
        expect(() => updates.decide('character:x', 'nothex', 'applied')).toThrow()
        expect(() => updates.decide('character:x', 'a'.repeat(64), 'whatever')).toThrow()
        const good = { key: 'character:a', kind: 'character', title: 'a', version: '', file: `${'a'.repeat(64)}.charx`, fileName: 'a.charx', sha256: 'a'.repeat(64), bytes: 3, publishedAt: new Date().toISOString() }
        expect(validItem(good)).toMatchObject({ key: 'character:a' })
        expect(() => validItem({ ...good, file: '../x.charx' })).toThrow()
        expect(() => validItem({ ...good, fileName: '../a.charx' })).toThrow()
        expect(() => validItem({ ...good, kind: 'persona' })).toThrow()
        expect(validItem({ ...good, key: 'preset:바드 프롬프트 젬', kind: 'preset', file: `${'a'.repeat(64)}.risup`, fileName: 'gem.risup' })).toMatchObject({ kind: 'preset' })
        expect(() => validItem({ ...good, key: 'preset:x', kind: 'preset', file: `${'a'.repeat(64)}.png`, fileName: 'x.png' })).toThrow()
        expect(recordName('character:a')).toMatch(/^[a-f0-9]{64}\.json$/)
        const h = 'b'.repeat(64)
        expect(recordNames(`<d:multistatus><d:response><d:href>/x/items/</d:href></d:response><d:response><d:href>/x/items/${h}.json</d:href></d:response><d:response><d:href>/x/items/${h}.json.part-1</d:href></d:response><D:response><D:href>https://nas/x/items/../${'c'.repeat(64)}.json</D:href></D:response></d:multistatus>`))
            .toEqual([h + '.json', 'c'.repeat(64) + '.json'])
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

    test('devices publishing different names at the same time both stay listed, with no temporary files left', async () => {
        const dav = fixtureDav(), pc = device(dav, 'pc'), tablet = device(dav, 'tablet'), phone = device(dav, 'phone')
        const a = Buffer.from('card A'), b = Buffer.from('persona B png')
        await Promise.all([
            pc.updates.publish(Readable.from([a]), meta),
            tablet.updates.publish(Readable.from([b]), { key: 'persona:B', kind: 'persona', title: 'B', version: '', fileName: 'b.png' }),
        ])
        expect((await phone.updates.overview()).items.map((x: any) => x.key).sort()).toEqual(['character:마물소녀도감', 'persona:B'])
        expect(dav.paths().filter(p => /\.part/.test(p))).toEqual([])
    })

    test('the same name published by two devices at once: the stored record is one of them, a replaced one says so', async () => {
        const dav = fixtureDav(), pc = device(dav, 'pc'), tablet = device(dav, 'tablet')
        const a = Buffer.from('card from pc'), b = Buffer.from('card from tablet')
        const results = await Promise.allSettled([pc.updates.publish(Readable.from([a]), meta), tablet.updates.publish(Readable.from([b]), meta)])
        const stored = (await device(dav, 'phone').updates.overview()).items
        expect(stored).toHaveLength(1)
        const fulfilled = results.filter(r => r.status === 'fulfilled').map(r => (r as any).value.sha256)
        expect(fulfilled).toContain(stored[0].sha256)
        for (const r of results) if (r.status === 'rejected') expect(String(r.reason)).toMatch(/확인에 실패/)
    })

    const filler = (dav: any, from: number, to: number) => {
        for (let i = from; i < to; i++) {
            const h = createHash('sha256').update(String(i)).digest('hex'), key = `character:filler-${i}`
            const item = { key, kind: 'character', title: key, version: '', file: `${h}.charx`, fileName: 'f.charx', sha256: h, bytes: 1, publishedAt: new Date(Date.now() - i).toISOString(), publishedBy: '' }
            dav.files.set(`${NAMESPACE}items/${recordName(key)}`, Buffer.from(JSON.stringify(item)))
        }
    }

    test('two new names published at once at 199 records both pass the count and are both read by every device', async () => {
        const dav = fixtureDav(), pc = device(dav, 'pc'), tablet = device(dav, 'tablet')
        await pc.updates.publish(Readable.from([card]), meta)
        filler(dav, 1, MAX_ITEMS - 1)
        // both publishers list the records before either writes: each sees 199 and passes the count
        let waiting = 0, armed = true, release = () => {}
        const both = new Promise<void>(resolve => { release = resolve })
        dav.hooks.push(async ({ method, path }) => {
            if (armed && method === 'PROPFIND' && path.endsWith('/items')) { if (++waiting >= 2) { armed = false; release() } await both }
            return undefined
        })
        const results = await Promise.all([
            pc.updates.publish(Readable.from([Buffer.from('x')]), { ...meta, key: 'character:race-x' }),
            tablet.updates.publish(Readable.from([Buffer.from('y')]), { ...meta, key: 'character:race-y' }),
        ])
        const records = dav.paths().filter(p => /\/items\/[a-f0-9]{64}\.json$/.test(p)).length
        expect(records).toBe(MAX_ITEMS + 1)
        const keys = (await device(dav, 'phone').updates.overview()).items.map((x: any) => x.key)
        expect(keys).toHaveLength(records)
        for (const r of results) expect(keys).toContain(r.key)
    })

    test('a damaged record of an existing name at the limit can be republished', async () => {
        const dav = fixtureDav(), pc = device(dav, 'pc')
        await pc.updates.publish(Readable.from([card]), meta)
        filler(dav, 1, MAX_ITEMS)
        dav.files.set(`${NAMESPACE}items/${recordName(meta.key)}`, Buffer.from('{broken'))
        const next = Buffer.from('card v3')
        expect((await pc.updates.publish(Readable.from([next]), meta)).sha256).toBe(sha(next))
    })

    test(`a new name beyond ${200} records is refused; replacing an existing name still works`, async () => {
        const dav = fixtureDav(), pc = device(dav, 'pc')
        await pc.updates.publish(Readable.from([card]), meta)
        filler(dav, 1, MAX_ITEMS)
        await expect(pc.updates.publish(Readable.from([Buffer.from('another')]), { ...meta, key: 'character:new one' })).rejects.toThrow(/너무 많아요/)
        const next = Buffer.from('card v2')
        expect((await pc.updates.publish(Readable.from([next]), { ...meta, version: 'v2' })).sha256).toBe(sha(next))
        expect((await pc.updates.overview()).items).toHaveLength(MAX_ITEMS)
    })

    test('a damaged or misplaced record is skipped; a NAS read error fails the whole check (asked again later)', async () => {
        const dav = fixtureDav(), pc = device(dav, 'pc'), tablet = device(dav, 'tablet')
        await pc.updates.publish(Readable.from([card]), meta)
        dav.files.set(`${NAMESPACE}items/${'d'.repeat(64)}.json`, Buffer.from('{broken'))
        const other = { ...(await pc.updates.overview()).items[0], key: 'character:other' }
        dav.files.set(`${NAMESPACE}items/${'e'.repeat(64)}.json`, Buffer.from(JSON.stringify(other)))
        dav.files.set(`${NAMESPACE}items/${'f'.repeat(64)}.json`, Buffer.alloc(20 * 1024, 32))
        expect((await tablet.updates.overview()).items.map((x: any) => x.key)).toEqual([meta.key])
        dav.hooks.push(({ method, path }) => method === 'GET' && path.includes('/items/') ? Object.assign(Readable.from([Buffer.from('')]), { statusCode: 500, headers: {} }) : undefined)
        await expect(tablet.updates.overview()).rejects.toThrow(/HTTP 500/)
    })
})

// 0.9.92-ver4: a dropped download resumes from the bytes on disk (HTTP Range), up to 5 attempts, each with a fresh route.
describe('content update download resume', () => {
    const big = Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => i % 251))
    const bigMeta = { ...meta, fileName: 'big.charx' }
    // A body that sends `cut` bytes, then fails like a dropped socket.
    const dropping = (data: Buffer, statusCode: number, headers: Record<string, string>, cut: number) => {
        const stream = new Readable({ read() {} })
        stream.push(data.subarray(0, cut)); setTimeout(() => stream.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' })), 5)
        return Object.assign(stream, { statusCode, headers })
    }
    const ranged = (data: Buffer, range: string) => { const start = Number(/bytes=(\d+)-/.exec(range)![1]); return Object.assign(Readable.from([data.subarray(start)]), { statusCode: 206, headers: { 'content-range': `bytes ${start}-${data.length - 1}/${data.length}` } }) }
    const tablet = (dav: any, routes: string[]) => createContentUpdates({ dataRoot: root(), secrets: dav.secrets, fetch: dav.fetch, deviceName: () => 'tablet', retryDelayMs: 0,
        route: { endpointFor: async (config: any) => { routes.push('route'); return { url: config.url, servername: '' } } } })

    test('drops twice, resumes with Range from the bytes received, ends with the exact file', async () => {
        const dav = fixtureDav(), item = await device(dav, 'pc').updates.publish(Readable.from([big]), bigMeta)
        const seen: string[] = [], routes: string[] = []
        let drops = 0
        dav.hooks.push(({ method, path, headers }: any) => {
            if (method !== 'GET' || !path.endsWith(item.file)) return undefined
            seen.push(headers.Range ?? 'whole')
            if (drops++ === 0) return dropping(big, 200, {}, 10_000)
            if (drops === 2) return dropping(big.subarray(10_000), 206, { 'content-range': `bytes 10000-${big.length - 1}/${big.length}` }, 20_000)
            return ranged(big, headers.Range)
        })
        const t = tablet(dav, routes)
        const { file } = await t.download(bigMeta.key, item.sha256)
        expect(fs.readFileSync(file)).toEqual(big)
        expect(seen).toEqual(['whole', 'bytes=10000-', 'bytes=30000-'])
        expect(routes.length).toBe(3 + 0) // one NAS route per attempt (the record read shares the first)
        fs.rmSync(file)
    })

    test('a server that ignores Range sends the whole file again: it is rewritten from the first byte', async () => {
        const dav = fixtureDav(), item = await device(dav, 'pc').updates.publish(Readable.from([big]), bigMeta)
        let n = 0
        dav.hooks.push(({ method, path }: any) => method === 'GET' && path.endsWith(item.file) && n++ === 0 ? dropping(big, 200, {}, 30_000) : undefined)
        const { file } = await tablet(dav, []).download(bigMeta.key, item.sha256)
        expect(fs.readFileSync(file)).toEqual(big)
        fs.rmSync(file)
    })

    test('a 206 for another range than asked starts over; HTTP errors and a damaged file are not retried', async () => {
        const dav = fixtureDav(), item = await device(dav, 'pc').updates.publish(Readable.from([big]), bigMeta)
        let n = 0
        dav.hooks.push(({ method, path }: any) => {
            if (method !== 'GET' || !path.endsWith(item.file)) return undefined
            n++
            if (n === 1) return dropping(big, 200, {}, 10_000)
            if (n === 2) return Object.assign(Readable.from([big.subarray(5)]), { statusCode: 206, headers: { 'content-range': `bytes 5-${big.length - 1}/${big.length}` } })
            return undefined
        })
        const { file } = await tablet(dav, []).download(bigMeta.key, item.sha256)
        expect(fs.readFileSync(file)).toEqual(big)
        expect(n).toBe(3)
        fs.rmSync(file)
        let m = 0
        dav.hooks.splice(0, dav.hooks.length, ({ method, path }: any) => method === 'GET' && path.endsWith(item.file) ? (m++, Object.assign(Readable.from([Buffer.from('')]), { statusCode: 500, headers: {} })) : undefined)
        await expect(tablet(dav, []).download(bigMeta.key, item.sha256)).rejects.toThrow(/HTTP 500/)
        expect(m).toBe(1)
    })

    test('one route decision for the whole download: a retry after the Wi-Fi report aged stays on the home address', async () => {
        const dav = fixtureDav(), item = await device(dav, 'pc').updates.publish(Readable.from([big]), bigMeta)
        const { createNasRoute } = require('../transfer-sync/nas-route.cjs')
        const home = 'https://home.invalid/home/RisuAI/'
        const secrets = { get: async () => ({ ...(await dav.secrets.get()), homeUrl: home, homeSsids: ['HOME'] }) }
        let now = 0
        const nasRoute = createNasRoute({ secrets, now: () => now })
        nasRoute.report({ transport: 'wifi', ssid: 'HOME' })
        const hosts: string[] = []
        const fetch = (url: string, options: any) => { hosts.push(new URL(url).host); return dav.fetch(url.replace(home, dav.base), options) }
        let n = 0
        dav.hooks.push(({ method, path }: any) => {
            if (method !== 'GET' || !path.endsWith(item.file) || n++ > 0) return undefined
            now += 200_000 // the report is older than its 2-minute trust when the retry starts
            return dropping(big, 200, {}, 10_000)
        })
        const { file } = await createContentUpdates({ dataRoot: root(), secrets, route: nasRoute, fetch, retryDelayMs: 0 }).download(bigMeta.key, item.sha256)
        expect(fs.readFileSync(file)).toEqual(big)
        expect(n).toBe(2)
        expect(new Set(hosts)).toEqual(new Set(['home.invalid']))
        fs.rmSync(file)
    })

    test('NAS settings saved during a download: every request keeps the pinned address and its own account', async () => {
        const dav = fixtureDav(), item = await device(dav, 'pc').updates.publish(Readable.from([big]), bigMeta)
        const { createNasRoute } = require('../transfer-sync/nas-route.cjs')
        let saved: any = { ...(await dav.secrets.get()), username: 'account-a' }
        const secrets = { get: async () => saved }
        const nasRoute = createNasRoute({ secrets })
        const auth: string[] = []
        const fetch = (url: string, options: any) => { auth.push(Buffer.from(String(options.headers.Authorization).slice(6), 'base64').toString().split(':')[0]); return dav.fetch(url, options) }
        let n = 0
        dav.hooks.push(({ method, path }: any) => {
            if (method !== 'GET' || !path.endsWith(item.file) || n++ > 0) return undefined
            saved = { ...saved, url: 'https://nas-b.invalid/vault/', username: 'account-b' } // another NAS saved before the retry
            return dropping(big, 200, {}, 10_000)
        })
        const { file } = await createContentUpdates({ dataRoot: root(), secrets, route: nasRoute, fetch, retryDelayMs: 0 }).download(bigMeta.key, item.sha256)
        expect(fs.readFileSync(file)).toEqual(big)
        expect(n).toBe(2)
        expect(new Set(auth)).toEqual(new Set(['account-a']))
        fs.rmSync(file)
    })

    test('the last attempt that brought every byte before its drop is still checked and kept', async () => {
        const dav = fixtureDav(), item = await device(dav, 'pc').updates.publish(Readable.from([big]), bigMeta)
        let n = 0
        dav.hooks.push(({ method, path, headers }: any) => {
            if (method !== 'GET' || !path.endsWith(item.file)) return undefined
            n++
            const start = headers.Range ? Number(/bytes=(\d+)-/.exec(headers.Range)![1]) : 0
            const rest = big.subarray(start), cut = n < 5 ? Math.min(14_000, rest.length - 1) : rest.length
            // the data is pushed, read and written before the drop
            const stream = new Readable({ read() {} }); stream.push(rest.subarray(0, cut))
            setTimeout(() => stream.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' })), 30)
            return Object.assign(stream, start ? { statusCode: 206, headers: { 'content-range': `bytes ${start}-${big.length - 1}/${big.length}` } } : { statusCode: 200, headers: {} })
        })
        const { file } = await tablet(dav, []).download(bigMeta.key, item.sha256)
        expect(fs.readFileSync(file)).toEqual(big)
        expect(n).toBe(5)
        fs.rmSync(file)
    })

    test('gives up after 5 dropped attempts and leaves nothing behind', async () => {
        const dav = fixtureDav(), item = await device(dav, 'pc').updates.publish(Readable.from([big]), bigMeta)
        let n = 0
        dav.hooks.push(({ method, path }: any) => method === 'GET' && path.endsWith(item.file) ? (n++, Object.assign(new Readable({ read() { this.destroy(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })) } }), { statusCode: 200, headers: {} })) : undefined)
        const data = root()
        const t = createContentUpdates({ dataRoot: data, secrets: dav.secrets, route, fetch: dav.fetch, retryDelayMs: 0 })
        await expect(t.download(bigMeta.key, item.sha256)).rejects.toThrow(/socket hang up/)
        expect(n).toBe(5)
        expect(fs.readdirSync(path.join(data, 'content-updates', 'tmp'))).toEqual([])
    })
})
