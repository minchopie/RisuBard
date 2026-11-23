import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { fixtureDav } from '../nas-sync-dav-fixture'
const { createContentUpdates, validItem, recordName, recordNames, NAMESPACE, MAX_ITEMS, PLUGIN_LIMIT, MODULE_LIMIT } = require('./content-updates.cjs')

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

// 0.9.92-ver11: a plugin script (.js) is a fourth kind; a client that does not list the kinds it imports (ver10 and older) never sees it.
describe('content updates: plugins', () => {
    const plugin = Buffer.from('//@name argon\n//@display-name Argon\n//@version 1.0.3\n//@api 3.0\nRisuai.log("argon")\n')
    const pluginMeta = { key: 'plugin:argon', kind: 'plugin', title: 'argon', version: '1.0.3', fileName: 'argon_1.0.3.js' }
    const ALL = ['character', 'persona', 'preset', 'plugin']

    test('a .js plugin is published under its SHA-256, listed to a client that imports plugins and downloaded with its hash check', async () => {
        const dav = fixtureDav(), pc = device(dav, 'pc'), tablet = device(dav, 'tablet')
        const item = await pc.updates.publish(Readable.from([plugin]), pluginMeta)
        expect(item).toMatchObject({ key: 'plugin:argon', kind: 'plugin', title: 'argon', version: '1.0.3', file: `${sha(plugin)}.js`, sha256: sha(plugin), bytes: plugin.length, publishedBy: 'pc' })
        expect(dav.paths()).toEqual([`${NAMESPACE}${sha(plugin)}.js`, `${NAMESPACE}items/${recordName(pluginMeta.key)}`].sort())
        expect((await tablet.updates.overview(ALL)).pending.map((x: any) => x.key)).toEqual(['plugin:argon'])
        const { file } = await tablet.updates.download(pluginMeta.key, item.sha256)
        expect(fs.readFileSync(file)).toEqual(plugin)
        fs.rmSync(file)
        tablet.updates.decide(pluginMeta.key, item.sha256, 'applied')
        expect((await tablet.updates.overview(ALL)).pending).toEqual([])
    })

    test('a plugin must be a .js file under the plugin size limit, published under a plugin: name', async () => {
        const { updates } = device()
        await expect(updates.publish(Readable.from([plugin]), { ...pluginMeta, fileName: 'argon.ts' })).rejects.toThrow(/형식/)
        await expect(updates.publish(Readable.from([plugin]), { ...pluginMeta, fileName: 'argon.charx' })).rejects.toThrow(/형식/)
        await expect(updates.publish(Readable.from([plugin]), { ...pluginMeta, key: 'character:argon' })).rejects.toThrow(/배포 이름/)
        await expect(updates.publish(Readable.from([plugin]), { ...meta, kind: 'character', key: 'character:argon', fileName: 'argon.js' })).rejects.toThrow(/형식/)
        await expect(updates.publish(Readable.from([Buffer.alloc(PLUGIN_LIMIT + 1, 32)]), pluginMeta)).rejects.toThrow(/size/)
        const good = { key: 'plugin:argon', kind: 'plugin', title: 'argon', version: '', file: `${'a'.repeat(64)}.js`, fileName: 'a.js', sha256: 'a'.repeat(64), bytes: 3, publishedAt: new Date().toISOString() }
        expect(validItem(good)).toMatchObject({ kind: 'plugin' })
        expect(() => validItem({ ...good, file: `${'a'.repeat(64)}.png`, fileName: 'a.png' })).toThrow()
        expect(() => validItem({ ...good, bytes: PLUGIN_LIMIT + 1 })).toThrow()
        expect(() => validItem({ ...good, kind: 'character' })).toThrow()
    })

    test('a client that sends no kinds (0.9.92-ver10 and older) is not shown plugin items, also through the HTTP route', async () => {
        const dav = fixtureDav(), pc = device(dav, 'pc'), tablet = device(dav, 'tablet')
        await pc.updates.publish(Readable.from([plugin]), pluginMeta)
        await pc.updates.publish(Readable.from([card]), meta)
        expect((await tablet.updates.overview()).items.map((x: any) => x.kind)).toEqual(['character'])
        expect((await tablet.updates.overview(['character', 'plugin', 'unknown'])).items.map((x: any) => x.kind).sort()).toEqual(['character', 'plugin'])
        const handlers: Record<string, Function> = {}
        const server = createContentUpdates({ dataRoot: root(), secrets: dav.secrets, route, fetch: dav.fetch, appCode: { enabled: false } })
        server.registerRoutes({ post: (p: string, h: Function) => { handlers[p] = h } }, { auth: async () => true })
        const overviewOf = async (body: any) => {
            let sent: any
            const res: any = { headersSent: false, json: (value: any) => { sent = value }, status: () => res }
            await handlers['/api/play-transfer/content-updates/overview']({ body }, res)
            return sent
        }
        expect((await overviewOf({})).pending.map((x: any) => x.kind)).toEqual(['character']) // the ver10 client's request body
        expect((await overviewOf({ kinds: ALL })).pending.map((x: any) => x.kind).sort()).toEqual(['character', 'plugin'])
    })
})

// 0.9.96-ver4: a module (.risum, assets included) is a fifth kind; clients that list four kinds (0.9.92-ver11 … 0.9.96-ver3) or none never see it.
describe('content updates: modules', () => {
    const risum = Buffer.concat([Buffer.from([111, 0]), Buffer.alloc(4), Buffer.alloc(300 * 1024, 7), Buffer.from([0])])
    const moduleMeta = { key: 'module:삶은계란', kind: 'module', title: '라이프 모듈 v.7.2-mge.1', version: '7.2-mge.1', fileName: '라이프 모듈 v.7.2-mge.1.risum' }
    const FOUR = ['character', 'persona', 'preset', 'plugin'], FIVE = [...FOUR, 'module']

    test('a .risum module is published under its SHA-256, listed to a client that imports modules and downloaded with its hash check', async () => {
        const dav = fixtureDav(), pc = device(dav, 'pc'), tablet = device(dav, 'tablet')
        const item = await pc.updates.publish(Readable.from([risum]), moduleMeta)
        expect(item).toMatchObject({ ...moduleMeta, file: `${sha(risum)}.risum`, sha256: sha(risum), bytes: risum.length, publishedBy: 'pc' })
        expect(dav.paths()).toEqual([`${NAMESPACE}${sha(risum)}.risum`, `${NAMESPACE}items/${recordName(moduleMeta.key)}`].sort())
        expect((await tablet.updates.overview(FIVE)).pending.map((x: any) => x.key)).toEqual(['module:삶은계란'])
        const { file } = await tablet.updates.download(moduleMeta.key, item.sha256)
        expect(fs.readFileSync(file)).toEqual(risum)
        fs.rmSync(file)
        tablet.updates.decide(moduleMeta.key, item.sha256, 'applied')
        expect((await tablet.updates.overview(FIVE)).pending).toEqual([])
    })

    test('a module must be a .risum file under the module size limit (above the plugin limit), published under a module: name', async () => {
        const { updates } = device()
        expect(MODULE_LIMIT).toBe(512 * 1024 * 1024) // 2026-11-24: the card limit (64 MiB before)
        expect(MODULE_LIMIT).toBeGreaterThan(PLUGIN_LIMIT)
        await expect(updates.publish(Readable.from([risum]), { ...moduleMeta, fileName: 'life.json' })).rejects.toThrow(/형식/)
        await expect(updates.publish(Readable.from([risum]), { ...moduleMeta, key: 'plugin:삶은계란' })).rejects.toThrow(/배포 이름/)
        await expect(updates.publish(Readable.from([risum]), { ...pluginLike(), fileName: 'x.risum' })).rejects.toThrow(/형식/)
        await expect(updates.publish(Readable.from([Buffer.alloc(MODULE_LIMIT + 1, 1)]), moduleMeta)).rejects.toThrow(/size/)
        const good = { key: 'module:삶은계란', kind: 'module', title: 'L', version: '', file: `${'a'.repeat(64)}.risum`, fileName: 'a.risum', sha256: 'a'.repeat(64), bytes: PLUGIN_LIMIT + 1, publishedAt: new Date().toISOString() }
        expect(validItem(good)).toMatchObject({ kind: 'module', bytes: PLUGIN_LIMIT + 1 })
        expect(() => validItem({ ...good, bytes: MODULE_LIMIT + 1 })).toThrow()
        expect(() => validItem({ ...good, file: `${'a'.repeat(64)}.js`, fileName: 'a.js' })).toThrow()
        expect(() => validItem({ ...good, kind: 'plugin' })).toThrow()
    })
    // 2026-11-24 (user decision): the module limit is the card limit, 512 MiB (64 MiB before); the other kinds' limits are unchanged.
    test('a module over the old 64 MiB limit is accepted up to the card limit (512 MiB); one byte more is refused; other kinds keep their limits', async () => {
        const OLD = 64 * 1024 * 1024, CARD = 512 * 1024 * 1024
        const record = (kind: string, ext: string, bytes: number) => ({ key: `${kind}:x`, kind, title: 'x', version: '', file: `${'a'.repeat(64)}.${ext}`, fileName: `x.${ext}`, sha256: 'a'.repeat(64), bytes, publishedAt: new Date().toISOString() })
        expect(validItem(record('module', 'risum', OLD + 1))).toMatchObject({ kind: 'module', bytes: OLD + 1 })
        expect(validItem(record('module', 'risum', 100 * 1024 * 1024))).toMatchObject({ bytes: 100 * 1024 * 1024 })
        expect(validItem(record('module', 'risum', CARD))).toMatchObject({ bytes: CARD })
        expect(() => validItem(record('module', 'risum', CARD + 1))).toThrow(/size/)
        for (const [kind, ext] of [['character', 'charx'], ['persona', 'png'], ['preset', 'risup']]) {
            expect(validItem(record(kind, ext, CARD))).toMatchObject({ kind })
            expect(() => validItem(record(kind, ext, CARD + 1))).toThrow(/size/)
        }
        expect(PLUGIN_LIMIT).toBe(8 * 1024 * 1024)
        expect(validItem(record('plugin', 'js', PLUGIN_LIMIT))).toMatchObject({ kind: 'plugin' })
        expect(() => validItem(record('plugin', 'js', PLUGIN_LIMIT + 1))).toThrow(/size/)
    })

    test('a 70 MiB module (over the old 64 MiB limit) is published in 1 MiB chunks, listed to a module client, hidden from older clients and downloaded with its hash check', async () => {
        const big = Buffer.concat([Buffer.from([111, 0]), Buffer.alloc(4), Buffer.alloc(70 * 1024 * 1024, 7), Buffer.from([0])])
        const chunks = function* () { for (let at = 0; at < big.length; at += 1024 * 1024) yield big.subarray(at, at + 1024 * 1024) }
        const dav = fixtureDav(), pc = device(dav, 'pc'), tablet = device(dav, 'tablet')
        const mapMeta = { key: 'module:mge_map', kind: 'module', title: '마물소녀도감 지도 v1.0.1', version: '1.0.1', fileName: 'MGE_지도_v1.0.1.risum' }
        const item = await pc.updates.publish(Readable.from(chunks()), mapMeta)
        expect(item).toMatchObject({ ...mapMeta, bytes: big.length, sha256: sha(big), file: `${sha(big)}.risum` })
        expect((await tablet.updates.overview(FIVE)).pending.map((x: any) => x.key)).toEqual(['module:mge_map'])
        expect((await tablet.updates.overview(FOUR)).items).toEqual([])
        expect((await tablet.updates.overview()).items).toEqual([])
        const { file } = await tablet.updates.download(mapMeta.key, item.sha256)
        expect(fs.statSync(file).size).toBe(big.length)
        expect(sha(fs.readFileSync(file))).toBe(item.sha256)
        fs.rmSync(file)
    }, 120_000)
    const pluginLike = () => ({ key: 'plugin:x', kind: 'plugin', title: 'x', version: '', fileName: 'x.js' })

    test('older clients — none (0.9.92-ver10 and older) or four kinds (0.9.92-ver11 … 0.9.96-ver3) — are not shown module items, also through the HTTP route', async () => {
        const dav = fixtureDav(), pc = device(dav, 'pc'), tablet = device(dav, 'tablet')
        await pc.updates.publish(Readable.from([risum]), moduleMeta)
        await pc.updates.publish(Readable.from([Buffer.from('//@name argon\nx')]), { key: 'plugin:argon', kind: 'plugin', title: 'argon', version: '', fileName: 'a.js' })
        await pc.updates.publish(Readable.from([card]), meta)
        expect((await tablet.updates.overview()).items.map((x: any) => x.kind)).toEqual(['character'])
        expect((await tablet.updates.overview(FOUR)).items.map((x: any) => x.kind).sort()).toEqual(['character', 'plugin'])
        expect((await tablet.updates.overview(FIVE)).items.map((x: any) => x.kind).sort()).toEqual(['character', 'module', 'plugin'])
        const handlers: Record<string, Function> = {}
        const server = createContentUpdates({ dataRoot: root(), secrets: dav.secrets, route, fetch: dav.fetch, appCode: { enabled: false } })
        server.registerRoutes({ post: (p: string, h: Function) => { handlers[p] = h } }, { auth: async () => true })
        const overviewOf = async (body: any) => {
            let sent: any
            const res: any = { headersSent: false, json: (value: any) => { sent = value }, status: () => res }
            await handlers['/api/play-transfer/content-updates/overview']({ body }, res)
            return sent
        }
        expect((await overviewOf({})).pending.map((x: any) => x.kind)).toEqual(['character'])
        expect((await overviewOf({ kinds: FOUR })).pending.map((x: any) => x.kind).sort()).toEqual(['character', 'plugin'])
        expect((await overviewOf({ kinds: FIVE })).pending.map((x: any) => x.kind).sort()).toEqual(['character', 'module', 'plugin'])
    })
})

// 0.9.92-ver4: a dropped download resumes from the bytes on disk (HTTP Range), up to 5 attempts, each with a fresh route.
describe('content update download resume', () => {
    const big = Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => i % 251))
    const bigMeta = { ...meta, fileName: 'big.charx' }
    const createWriteStream = fs.createWriteStream
    let dropAfterWrite: (() => void) | undefined
    beforeEach(() => {
        vi.spyOn(fs, 'createWriteStream').mockImplementation((target, options) => {
            const drop = dropAfterWrite
            if (!drop) return createWriteStream(target, options)
            dropAfterWrite = undefined
            const writer = createWriteStream(target, { ...(typeof options === 'string' ? { encoding: options } : options), highWaterMark: 1 })
            writer.once('drain', drop)
            return writer
        })
    })
    afterEach(() => { dropAfterWrite = undefined; vi.mocked(fs.createWriteStream).mockRestore() })
    // Wait for the real file writer to acknowledge the partial write before dropping the socket.
    const dropping = (data: Buffer, statusCode: number, headers: Record<string, string>, cut: number) => {
        const stream = new Readable({ read() {} })
        stream.push(data.subarray(0, cut))
        dropAfterWrite = () => stream.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }))
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
            return dropping(rest, start ? 206 : 200, start ? { 'content-range': `bytes ${start}-${big.length - 1}/${big.length}` } : {}, cut)
        })
        const { file } = await tablet(dav, []).download(bigMeta.key, item.sha256)
        expect(fs.readFileSync(file)).toEqual(big)
        expect(n).toBe(5)
        fs.rmSync(file)
    })

    // 0.9.96-ver5: drops that each bring new bytes do not use up the attempts (a slow line with a large card).
    test('keeps resuming past 5 drops while every attempt brings new bytes, and ends with the exact file', async () => {
        const dav = fixtureDav(), item = await device(dav, 'pc').updates.publish(Readable.from([big]), bigMeta)
        const seen: string[] = []
        dav.hooks.push(({ method, path, headers }: any) => {
            if (method !== 'GET' || !path.endsWith(item.file)) return undefined
            seen.push(headers.Range ?? 'whole')
            const start = headers.Range ? Number(/bytes=(\d+)-/.exec(headers.Range)![1]) : 0
            if (seen.length <= 8) return dropping(big.subarray(start), start ? 206 : 200, start ? { 'content-range': `bytes ${start}-${big.length - 1}/${big.length}` } : {}, 5_000)
            return ranged(big, headers.Range)
        })
        const { file } = await tablet(dav, []).download(bigMeta.key, item.sha256)
        expect(fs.readFileSync(file)).toEqual(big)
        expect(seen).toEqual(['whole', ...Array.from({ length: 8 }, (_, i) => `bytes=${(i + 1) * 5_000}-`)])
        fs.rmSync(file)
    })

    test('after a drop that brought bytes, gives up only at the 5th drop in a row without new bytes', async () => {
        const dav = fixtureDav(), item = await device(dav, 'pc').updates.publish(Readable.from([big]), bigMeta)
        let n = 0
        dav.hooks.push(({ method, path }: any) => {
            if (method !== 'GET' || !path.endsWith(item.file)) return undefined
            if (++n === 1) return dropping(big, 200, {}, 5_000)
            return Object.assign(new Readable({ read() { this.destroy(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })) } }), { statusCode: 200, headers: {} })
        })
        await expect(tablet(dav, []).download(bigMeta.key, item.sha256)).rejects.toThrow(/socket hang up/)
        expect(n).toBe(6) // 1 with progress + 5 in a row without
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
