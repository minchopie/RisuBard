import { afterEach, describe, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
const { createAppCodeWatch, loaderActive } = require('./app-code-watch.cjs')
const core = require('../app-update/core.cjs')

const roots: string[] = []
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })
const RUNTIME = 'a'.repeat(64)
function app(version = '0.9.92-ver1') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-app-code-watch-')); roots.push(root)
    fs.mkdirSync(path.join(root, 'server/node/app-update'), { recursive: true })
    fs.writeFileSync(path.join(root, 'server/node/app-update/runtime.json'), JSON.stringify({ schema: 1, fingerprint: RUNTIME }))
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ version }))
    return root
}
function release(version: string, bytes = Buffer.from(`code ${version}`), runtime = RUNTIME) {
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    return { manifest: { schema: 1, version, runtime, sha256, bytes: bytes.length, file: `RisuBard-code-${version}-${sha256}.zip` }, bytes }
}
function nas(published: ReturnType<typeof release> | null, log: string[] = []) {
    return async (_dataRoot: string, options: any) => {
        log.push(`connect ${JSON.stringify(options.network)}`)
        return {
            latest: async () => published?.manifest ?? null,
            download: async (r: any, destination: string) => { log.push(`download ${r.version}`); fs.writeFileSync(destination, published!.bytes, { flag: 'wx' }) },
        }
    }
}
const watch = (appRoot: string, connect: any, extra: any = {}) =>
    createAppCodeWatch({ appRoot, dataRoot: appRoot, secrets: {}, route: { network: async () => ({ transport: 'wifi', ssid: 'home' }) }, enabled: true, connect, ...extra })

describe('app code watch', () => {
    test('downloads a newer patch into the loader cache (ready.json + ready-<sha>.zip) and reports it ready', async () => {
        const root = app(), r = release('0.9.92-ver2'), log: string[] = []
        const w = watch(root, nas(r, log))
        const status = await w.check()
        expect(status).toMatchObject({ enabled: true, current: '0.9.92-ver1', ready: '0.9.92-ver2', state: 'ready' })
        const cache = core.stateRoot(root)
        expect(core.readJson(path.join(cache, 'ready.json'))).toEqual(r.manifest)
        expect(fs.readFileSync(path.join(cache, `ready-${r.manifest.sha256}.zip`))).toEqual(r.bytes)
        expect(fs.readdirSync(cache).filter(f => f.endsWith('.part'))).toEqual([])
        expect(log).toEqual(['connect {"transport":"wifi","ssid":"home"}', 'download 0.9.92-ver2'])
        // Already cached: no second download.
        await w.check()
        expect(log.filter(l => l.startsWith('download'))).toHaveLength(1)
    })

    test('a newer release replaces an older cached one', async () => {
        const root = app()
        await watch(root, nas(release('0.9.92-ver2'))).check()
        const r3 = release('0.9.92-ver3')
        expect((await watch(root, nas(r3)).check()).ready).toBe('0.9.92-ver3')
        expect(fs.readdirSync(core.stateRoot(root)).filter(f => f.startsWith('ready-'))).toEqual([`ready-${r3.manifest.sha256}.zip`])
    })

    test('nothing newer, another runtime, a patch that failed twice, or no NAS: nothing is downloaded', async () => {
        const root = app('0.9.92-ver2'), log: string[] = []
        expect(await watch(root, nas(release('0.9.92-ver2'), log)).check()).toMatchObject({ ready: null, state: 'current' })
        const other = release('0.9.92-ver3', undefined, 'b'.repeat(64))
        expect(await watch(root, nas(other, log)).check()).toMatchObject({ ready: null, state: 'full-package-required', version: '0.9.92-ver3' })
        const failed = release('0.9.92-ver4')
        core.status(root, { failedHash: failed.manifest.sha256, attempts: 2, state: 'rolled-back' })
        expect(await watch(root, nas(failed, log)).check()).toMatchObject({ ready: null, state: 'failed-before' })
        expect(await watch(root, async () => null).check()).toMatchObject({ ready: null, state: 'no-nas' })
        expect(log.filter(l => l.startsWith('download'))).toEqual([])
    })

    test('a patch rolled back just now is not "ready" (the next start skips it, like the loader); after that start it is', async () => {
        const root = app(), r = release('0.9.92-ver2')
        const w = watch(root, nas(r))
        await w.check()
        core.status(root, { failedHash: r.manifest.sha256, attempts: 1, state: 'rolled-back' })
        expect(await w.check()).toMatchObject({ ready: null, state: 'retry-next-launch' })
        core.status(root, { failedHash: r.manifest.sha256, attempts: 1, state: 'retry-next-launch' })
        expect(await w.check()).toMatchObject({ ready: '0.9.92-ver2', state: 'ready' })
    })

    test('a newer release cached by another writer while downloading is kept; this download is dropped', async () => {
        const root = app(), older = release('0.9.92-ver2'), newer = release('0.9.92-ver3')
        const cache = core.stateRoot(root)
        const connect = async () => ({
            latest: async () => older.manifest,
            download: async (_r: any, destination: string) => {
                // The loader's slow start-up download finishing meanwhile with a newer release.
                fs.mkdirSync(cache, { recursive: true })
                fs.writeFileSync(path.join(cache, `ready-${newer.manifest.sha256}.zip`), newer.bytes)
                core.saveState(root, 'ready.json', newer.manifest)
                fs.writeFileSync(destination, older.bytes, { flag: 'wx' })
            },
        })
        expect(await watch(root, connect).check()).toMatchObject({ ready: '0.9.92-ver3', state: 'ready', version: '0.9.92-ver3' })
        expect(core.readJson(path.join(cache, 'ready.json')).version).toBe('0.9.92-ver3')
        expect(fs.readdirSync(cache).filter(f => f.endsWith('.zip') || f.endsWith('.part'))).toEqual([`ready-${newer.manifest.sha256}.zip`])
    })

    test('a failed download leaves no partial file and no ready record', async () => {
        const root = app(), r = release('0.9.92-ver2')
        const connect = async () => ({ latest: async () => r.manifest, download: async (_r: any, d: string) => { fs.writeFileSync(d, 'half'); throw new Error('cut') } })
        expect(await watch(root, connect).check()).toMatchObject({ ready: null, state: 'error', error: 'cut' })
        expect(fs.readdirSync(core.stateRoot(root))).toEqual([])
    })

    test('concurrent checks share one run', async () => {
        const root = app(); let connects = 0
        const connect = async (...args: any[]) => { connects++; return nas(release('0.9.92-ver2'))(args[0], args[1]) }
        const w = watch(root, connect)
        await Promise.all([w.check(), w.check(), w.check()])
        expect(connects).toBe(1)
    })

    test('off outside the loader (no Android runtime, no portable package): no network, status says off', async () => {
        const root = app()
        expect(loaderActive(root, {}, 'linux')).toBe(false)
        expect(loaderActive(root, { RISUBARD_EMBEDDED_ANDROID: '1' }, 'linux')).toBe(true)
        expect(loaderActive(root, { RISUBARD_EMBEDDED_ANDROID: '1', RISUBARD_APP_UPDATE: '0' }, 'linux')).toBe(false)
        expect(loaderActive(root, {}, 'win32')).toBe(false)
        fs.writeFileSync(path.join(root, '.portable'), '')
        expect(loaderActive(root, {}, 'win32')).toBe(true)
        let called = false
        const w = watch(root, async () => { called = true; return null }, { enabled: false })
        expect(await w.check()).toEqual({ enabled: false, current: null, ready: null, state: 'off' })
        expect(called).toBe(false)
    })
})
