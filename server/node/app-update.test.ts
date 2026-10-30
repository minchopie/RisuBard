import { afterEach, describe, expect, test, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pipeline } from 'node:stream/promises'
import { spawnSync } from 'node:child_process'
import { fixtureDav } from './nas-sync-dav-fixture'
const core = require('./app-update/core.cjs')
const { connect } = require('./app-update/remote.cjs')
const { ZipFile } = require('yazl')
const roots: string[] = []
const runtime = 'a'.repeat(64)
function root() { const result = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-code-update-')); roots.push(result); return result }
function put(dir: string, name: string, value: string) { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value) }
function installed(dir: string) {
    put(dir, 'package.json', JSON.stringify({ version: '0.9.90', type: 'commonjs' }))
    put(dir, 'server/node/server.cjs', 'old server')
    put(dir, 'dist/index.html', 'old UI')
    put(dir, 'save/settings.json', '{"api":"untouched","nas":"untouched"}')
    put(dir, 'save/chat.json', '{"messages":["preserve"]}')
    put(dir, 'backups/original.bin', 'original backup')
}
async function archive(dir: string, additions: Record<string, string> = {}, version = '0.9.91') {
    const zip = new ZipFile(), file = path.join(dir, `test-${Math.random()}.zip`)
    const done = pipeline(zip.outputStream, fs.createWriteStream(file))
    for (const [name, value] of Object.entries({ 'package.json': JSON.stringify({ version, type: 'commonjs' }), 'server/node/server.cjs': 'new server', 'dist/index.html': 'new UI', ...additions })) zip.addBuffer(Buffer.from(value), name)
    zip.end(); await done
    const sha256 = await core.hashFile(file)
    return { file, release: { schema: 1, version, runtime, sha256, bytes: fs.statSync(file).size, file: `RisuBard-code-${version}-${sha256}.zip` } }
}
afterEach(() => { vi.restoreAllMocks(); for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

describe('NAS app code patches', () => {
    test('compares numeric versions and rejects data, loader, and escaping paths', () => {
        expect(core.newer('0.9.100', '0.9.91')).toBe(true)
        for (const version of ['0.9.90', '0.9.89', '../latest']) expect(core.newer(version, '0.9.90')).toBe(false)
        for (const name of ['save/chat.json', 'backups/a', 'server/node/../../save/a', 'dist\\a', 'package.json:stream', 'server/node/app-update/bootstrap.cjs', 'server/node/data-root.cjs']) expect(() => core.codePath(name)).toThrow()
    })
    test('applies code, commits only after healthy start, and preserves data/settings bytes', async () => {
        const dir = root(); installed(dir); put(dir, '.portable', '')
        const { file, release } = await archive(dir, { 'dist/new.js': 'new asset' })
        const before = ['save/settings.json', 'save/chat.json', 'backups/original.bin'].map(name => fs.readFileSync(path.join(dir, name)))
        core.apply(dir, await core.stage(dir, file, release))
        expect(core.journal(dir).phase).toBe('awaiting-start')
        expect(fs.existsSync(path.join(dir, '.installed-version'))).toBe(false)
        core.markHealthy(dir)
        expect(fs.readFileSync(path.join(dir, '.installed-version'), 'utf8')).toBe('v0.9.91')
        expect(core.rollback(dir)).toBe(false)
        expect(['save/settings.json', 'save/chat.json', 'backups/original.bin'].map(name => fs.readFileSync(path.join(dir, name)))).toEqual(before)
    })
    test('restores interrupted copies and unconfirmed startup, including removal of only newly created code', async () => {
        for (const interrupt of [true, false]) {
            const dir = root(); installed(dir)
            const { file, release } = await archive(dir, { 'dist/new.js': 'new asset' })
            const staged = await core.stage(dir, file, release)
            if (interrupt) expect(() => core.apply(dir, staged, () => { throw new Error('power loss') })).toThrow('power loss')
            else core.apply(dir, staged)
            expect(core.rollback(dir)).toBe(true)
            expect(fs.readFileSync(path.join(dir, 'server/node/server.cjs'), 'utf8')).toBe('old server')
            expect(fs.readFileSync(path.join(dir, 'dist/index.html'), 'utf8')).toBe('old UI')
            expect(fs.existsSync(path.join(dir, 'dist/new.js'))).toBe(false)
            expect(fs.readFileSync(path.join(dir, 'save/chat.json'), 'utf8')).toContain('preserve')
            expect(core.rollback(dir)).toBe(false)
        }
    })
    test('rejects damaged and non-code bundles before changing installed files', async () => {
        const dir = root(); installed(dir)
        const { file, release } = await archive(dir)
        await expect(core.stage(dir, file, { ...release, sha256: '0'.repeat(64), file: `RisuBard-code-${release.version}-${'0'.repeat(64)}.zip` })).rejects.toThrow('incomplete')
        const bad = await archive(dir, { 'save/chat.json': 'overwrite' })
        await expect(core.stage(dir, bad.file, bad.release)).rejects.toThrow('non-code')
        const dup = await archive(dir, { 'DIST/index.html': 'duplicate' })
        await expect(core.stage(dir, dup.file, dup.release)).rejects.toThrow()
        expect(fs.readFileSync(path.join(dir, 'save/chat.json'), 'utf8')).toContain('preserve')
    })
    test('WebDAV publishes payload before latest and verifies download; failed upload keeps previous pointer', async () => {
        const dir = root(), dav = fixtureDav()
        const fetch = async (url: string, options: any) => {
            if (options.method === 'HEAD') {
                const response = await dav.fetch(url, { ...options, method: 'GET' }); response.resume(); return response
            }
            return dav.fetch(url, options)
        }
        const remote = await connect(dir, { secrets: dav.secrets, fetch, network: { transport: 'cellular' } })
        expect(await remote.latest()).toBeNull()
        const first = await archive(dir)
        await remote.publish(first.release, first.file)
        expect((await remote.latest()).sha256).toBe(first.release.sha256)
        const next = await archive(dir, {}, '0.9.92')
        dav.hooks.push((req: { method: string; path: string }) => { if (req.method === 'PUT' && req.path.endsWith('.part')) { dav.files.set(req.path, Buffer.from('truncated')); throw new Error('connection lost') } })
        await expect(remote.publish(next.release, next.file)).rejects.toThrow('connection lost')
        expect((await remote.latest()).sha256).toBe(first.release.sha256)
        dav.hooks.length = 0
        await remote.publish(next.release, next.file)
        expect((await remote.latest()).sha256).toBe(next.release.sha256)
    })
    test.each(['applying', 'awaiting-start'])('a full package update supersedes an old %s journal', async phase => {
        const dir = root(); installed(dir)
        const bundle = await archive(dir)
        const staged = await core.stage(dir, bundle.file, bundle.release)
        if (phase === 'applying') expect(() => core.apply(dir, staged, () => { throw new Error('interrupted') })).toThrow()
        else core.apply(dir, staged)
        put(dir, 'package.json', JSON.stringify({ version: '0.9.92' }))
        put(dir, 'server/node/server.cjs', 'full package server')
        expect(core.rollback(dir)).toBe(false)
        expect(core.journal(dir).phase).toBe('superseded')
        expect(fs.readFileSync(path.join(dir, 'server/node/server.cjs'), 'utf8')).toBe('full package server')
    })
    test('insufficient space rejects the stage while preserving existing code', async () => {
        const dir = root(); installed(dir)
        const bundle = await archive(dir)
        vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 0, bsize: 4096 } as any)
        await expect(core.stage(dir, bundle.file, bundle.release)).rejects.toThrow('Not enough space')
        expect(fs.readFileSync(path.join(dir, 'dist/index.html'), 'utf8')).toBe('old UI')
    })
    test('cancels a stalled NAS request without changing saved credentials', async () => {
        const dir = root(), dav = fixtureDav(), signal = AbortSignal.timeout(30)
        const fetch = async (_url: string, options: any) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
        })
        const remote = await connect(dir, { secrets: dav.secrets, fetch, signal, network: { transport: 'cellular' } })
        await expect(remote.latest()).rejects.toThrow()
        expect(dav.files.size).toBe(0)
    })
    test('same-PID bootstrap loads new code before data opens and keeps the data-root lock', async () => {
        const dir = root(); installed(dir); put(dir, '.portable', '')
        const loaderDir = path.join(dir, 'server/node/app-update')
        fs.cpSync(path.resolve('server/node/app-update'), loaderDir, { recursive: true })
        for (const name of ['data-root.cjs', 'data-root-lock.cjs']) fs.copyFileSync(path.resolve('server/node', name), path.join(dir, 'server/node', name))
        fs.symlinkSync(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'junction')
        put(dir, 'server/node/app-update/runtime.json', JSON.stringify({ fingerprint: runtime }))
        const entry = `if (require('./app-update/bootstrap.cjs').start(__filename)) return;\nconst b=require('./app-update/bootstrap.cjs'); if(!b.ownsDataRoot(process.env.RISUBARD_DATA_ROOT))throw Error('missing lock'); b.ready(); console.log('VERSION='+require('../../package.json').version);`
        put(dir, 'server/node/server.cjs', entry)
        const bundle = await archive(dir, { 'server/node/server.cjs': entry })
        // An interrupted/corrupt cached download must not permanently block a valid NAS patch.
        put(dir, '.app-updates/ready.json', JSON.stringify(bundle.release))
        put(dir, `.app-updates/ready-${bundle.release.sha256}.zip`, 'truncated')
        const staleDownload = '.app-updates/download-00000000-0000-0000-0000-000000000000.part'
        put(dir, staleDownload, 'interrupted')
        put(dir, 'server/node/app-update/remote.cjs', `exports.connect=async()=>({latest:async()=>(${JSON.stringify(bundle.release)}),download:async(_,dest)=>require('node:fs').copyFileSync(${JSON.stringify(bundle.file)},dest)});`)
        const result = spawnSync(process.execPath, [path.join(dir, 'server/node/server.cjs')], { cwd: dir, env: { ...process.env, RISUBARD_EMBEDDED_ANDROID: '1', RISUBARD_DATA_ROOT: path.join(dir, 'save') }, encoding: 'utf8', timeout: 15000 })
        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout, result.stderr).toContain('VERSION=0.9.91')
        expect(core.journal(dir).phase).toBe('healthy')
        expect(fs.existsSync(path.join(dir, '.app-updates/ready.json'))).toBe(false)
        expect(fs.existsSync(path.join(dir, `.app-updates/ready-${bundle.release.sha256}.zip`))).toBe(false)
        expect(fs.existsSync(path.join(dir, staleDownload))).toBe(false)
        expect(fs.readFileSync(path.join(dir, 'save/chat.json'), 'utf8')).toContain('preserve')
    })
    test.each(['offline', 'same', 'incompatible', 'bad-start', 'async-bad-start'])('bootstrap preserves installed data on %s', async kind => {
        const dir = root(); installed(dir); put(dir, '.portable', '')
        fs.cpSync(path.resolve('server/node/app-update'), path.join(dir, 'server/node/app-update'), { recursive: true })
        for (const name of ['data-root.cjs', 'data-root-lock.cjs']) fs.copyFileSync(path.resolve('server/node', name), path.join(dir, 'server/node', name))
        fs.symlinkSync(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'junction')
        put(dir, 'server/node/app-update/runtime.json', JSON.stringify({ fingerprint: runtime }))
        const entry = `if(require('./app-update/bootstrap.cjs').start(__filename))return; require('./app-update/bootstrap.cjs').ready(); console.log('OLD-OK');`
        put(dir, 'server/node/server.cjs', entry)
        const broken = kind === 'async-bad-start' ? `setImmediate(()=>{throw Error('broken async patch')});` : `throw Error('broken patch');`
        const bundle = await archive(dir, { 'server/node/server.cjs': `if(require('./app-update/bootstrap.cjs').start(__filename))return; ${broken}` }, kind === 'same' ? '0.9.90' : '0.9.91')
        if (kind === 'incompatible') bundle.release.runtime = 'b'.repeat(64)
        put(dir, 'server/node/app-update/remote.cjs', kind === 'offline' ? `exports.connect=async()=>{throw Error('offline')};`
            : `exports.connect=async()=>({latest:async()=>(${JSON.stringify(bundle.release)}),download:async(_,dest)=>require('node:fs').copyFileSync(${JSON.stringify(bundle.file)},dest)});`)
        const run = () => spawnSync(process.execPath, [path.join(dir, 'server/node/server.cjs')], { cwd: dir, env: { ...process.env, RISUBARD_EMBEDDED_ANDROID: '1', RISUBARD_DATA_ROOT: path.join(dir, 'save') }, encoding: 'utf8', timeout: 15000 })
        const first = run()
        expect(first.status, first.stderr).toBe(kind.endsWith('bad-start') ? 1 : 0)
        if (kind.endsWith('bad-start')) {
            expect(run().stdout).toContain('OLD-OK')
            if (kind === 'async-bad-start') expect(run().stdout).toContain('OLD-OK')
            expect(run().status).toBe(1)
            if (kind === 'async-bad-start') expect(run().stdout).toContain('OLD-OK')
            core.status(dir, { state: 'kept-installed', reason: 'timeout' })
            expect(core.readJson(path.join(dir, '.app-updates/status.json')).attempts).toBe(2)
            expect(run().stdout).toContain('OLD-OK')
            expect(core.readJson(path.join(dir, '.app-updates/status.json')).attempts).toBe(2)
            const fixed = await archive(dir, { 'server/node/server.cjs': entry.replace('OLD-OK', 'FIXED-OK') }, '0.9.92')
            put(dir, 'server/node/app-update/remote.cjs', `exports.connect=async()=>({latest:async()=>(${JSON.stringify(fixed.release)}),download:async(_,dest)=>require('node:fs').copyFileSync(${JSON.stringify(fixed.file)},dest)});`)
            const recovered = run()
            expect(recovered.status, recovered.stderr).toBe(0)
            expect(recovered.stdout).toContain('FIXED-OK')
            expect(core.readJson(path.join(dir, '.app-updates/status.json')).attempts).toBe(0)
        } else expect(first.stdout).toContain('OLD-OK')
        expect(fs.readFileSync(path.join(dir, 'save/settings.json'), 'utf8')).toBe('{"api":"untouched","nas":"untouched"}')
        expect(fs.readFileSync(path.join(dir, 'save/chat.json'), 'utf8')).toContain('preserve')
        expect(fs.readFileSync(path.join(dir, 'backups/original.bin'), 'utf8')).toBe('original backup')
    })
    test('slow download finishes during the session and applies on next cold start without NAS', async () => {
        const dir = root(); installed(dir); put(dir, '.portable', '')
        fs.cpSync(path.resolve('server/node/app-update'), path.join(dir, 'server/node/app-update'), { recursive: true })
        for (const name of ['data-root.cjs', 'data-root-lock.cjs']) fs.copyFileSync(path.resolve('server/node', name), path.join(dir, 'server/node', name))
        fs.symlinkSync(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'junction')
        put(dir, 'server/node/app-update/runtime.json', JSON.stringify({ fingerprint: runtime }))
        const entry = `if(require('./app-update/bootstrap.cjs').start(__filename))return; require('./app-update/bootstrap.cjs').ready(); console.log(require('../../package.json').version); if(process.env.WAIT_PATCH==='1')setTimeout(()=>{},800);`
        put(dir, 'server/node/server.cjs', entry)
        const bundle = await archive(dir, { 'server/node/server.cjs': entry })
        put(dir, 'server/node/app-update/remote.cjs', `exports.connect=async()=>({latest:async()=>(${JSON.stringify(bundle.release)}),download:async(_,dest)=>{await new Promise(r=>setTimeout(r,2300));require('node:fs').copyFileSync(${JSON.stringify(bundle.file)},dest)}});`)
        const run = (wait: string) => spawnSync(process.execPath, [path.join(dir, 'server/node/server.cjs')], { cwd: dir, env: { ...process.env, RISUBARD_EMBEDDED_ANDROID: '1', WAIT_PATCH: wait, RISUBARD_DATA_ROOT: path.join(dir, 'save') }, encoding: 'utf8', timeout: 15000 })
        const first = run('1')
        expect(first.status, first.stderr).toBe(0)
        expect(first.stdout).toContain('0.9.90')
        expect(fs.existsSync(path.join(dir, '.app-updates/ready.json'))).toBe(true)
        expect(core.journal(dir)).toBeNull()
        put(dir, 'server/node/app-update/remote.cjs', `exports.connect=async()=>{throw Error('offline')};`)
        const second = run('0')
        expect(second.status, second.stderr).toBe(0)
        expect(second.stdout).toContain('0.9.91')
        expect(core.journal(dir).phase).toBe('healthy')
    })
    test('slow credential/route detection cannot hold startup past the discovery budget', async () => {
        const dir = root(); installed(dir)
        fs.cpSync(path.resolve('server/node/app-update'), path.join(dir, 'server/node/app-update'), { recursive: true })
        for (const name of ['data-root.cjs', 'data-root-lock.cjs']) fs.copyFileSync(path.resolve('server/node', name), path.join(dir, 'server/node', name))
        fs.symlinkSync(path.resolve('node_modules'), path.join(dir, 'node_modules'), 'junction')
        put(dir, 'server/node/app-update/runtime.json', JSON.stringify({ fingerprint: runtime }))
        put(dir, 'server/node/app-update/remote.cjs', `exports.connect=()=>new Promise(resolve=>setTimeout(()=>resolve(null),30000).unref());`)
        put(dir, 'server/node/server.cjs', `if(require('./app-update/bootstrap.cjs').start(__filename))return; console.log('OLD-READY');`)
        const started = Date.now()
        const result = spawnSync(process.execPath, [path.join(dir, 'server/node/server.cjs')], { cwd: dir, env: { ...process.env, RISUBARD_EMBEDDED_ANDROID: '1', RISUBARD_DATA_ROOT: path.join(dir, 'save') }, encoding: 'utf8', timeout: 14000 })
        expect(result.status, result.stderr).toBe(0)
        expect(result.stdout).toContain('OLD-READY')
        expect(Date.now() - started).toBeLessThan(12000)
    }, 15000)
})
