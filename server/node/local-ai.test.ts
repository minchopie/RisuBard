import { afterEach, describe, expect, test, vi } from 'vitest'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import express from 'express'
const require = createRequire(import.meta.url)
const { createLocalAI } = require('./local-ai.cjs')
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const run of cleanup.splice(0).reverse()) await run() })

async function listenForFetch(app: ReturnType<typeof express>) {
    for (let attempt = 0; attempt < 3; attempt++) {
        const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
        const base = `http://127.0.0.1:${(server.address() as any).port}`
        const close = () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) })
        try {
            const probe = await fetch(base + '/api/local-ai'); await probe.body?.cancel()
            cleanup.push(close)
            return base
        } catch (error) {
            await close()
            console.error('Local AI test listener failed', base, error)
            if ((error as Error & { cause?: Error }).cause?.message !== 'bad port' || attempt === 2) throw error
        }
    }
    throw new Error('No fetch-compatible test port')
}

async function fixture(options = {}) {
    const root = await fs.mkdtemp(join(tmpdir(), 'risubard-local-ai-'))
    cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
    const fake = join(root, 'engine.cjs')
    await fs.writeFile(fake, `
const http = require('node:http'), fs = require('node:fs');
const args = process.argv.slice(2), arg = key => args[args.indexOf(key)+1];
if(fs.readFileSync(arg('-m'))[20] === 99) process.exit(1);
http.createServer(async (req,res) => {
 if (req.headers.authorization !== 'Bearer '+process.env.LLAMA_API_KEY) { res.writeHead(401).end(); return; }
 if(req.url === '/props') {res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({default_generation_settings:{n_ctx: +arg('--ctx-size')}}));return;}
 let body=''; for await(const b of req)body+=b; body=JSON.parse(body);
 if(req.url === '/apply-template') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({prompt:body.messages[0]?.content || 'prompt'}));return;}
 if(req.url === '/tokenize') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({tokens:body.content === 'context-full' ? Array(+arg('--ctx-size')).fill(1) : [1,2,3]}));return;}
 if(body.stream){
  res.setHeader('Content-Type','text/event-stream');
  res.write('data: '+JSON.stringify({choices:[{delta:{content:'local'}}]})+'\\n\\n');
  const timer=setTimeout(()=>res.end('data: [DONE]\\n\\n'),body.slow?30000:10);
  res.on('close',()=>clearTimeout(timer));
 } else { res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'local'}}],request:body})); }
}).listen(arg('--host'));`)
    const processes: ReturnType<typeof spawn>[] = []
    const service = createLocalAI({ dataRoot: root, executable: process.execPath,
        spawnProcess: (_file, args, options) => { const child = spawn(process.execPath, [fake, ...args], options); processes.push(child); return child }, ...options })
    cleanup.push(() => service.close())
    await service.status()
    const model = Buffer.alloc(1024); model.write('GGUF'); model.writeUInt32LE(3, 4)
    const upload = (bytes = model, options = {}) => service.importModel(Readable.from([bytes]), { bytes: bytes.length, name: 'model.gguf', ...options })
    return { root, service, processes, model, upload }
}

describe('on-device model storage and process lifecycle', () => {
    test('streamed import, hash, settings restart, no model data in status, and same-ABI process cleanup', async () => {
        const f = await fixture()
        await f.upload()
        expect(await f.service.status()).toMatchObject({ running: true, model: { bytes: 1024, name: 'model.gguf' } })
        expect((await f.service.status()).model.file).toBeUndefined()
        const stored = JSON.parse(await fs.readFile(join(f.root, 'local-ai/settings.json'), 'utf8'))
        expect(stored.model.sha256).toMatch(/^[a-f0-9]{64}$/)
        expect(await fs.readFile(join(f.root, 'local-ai', stored.model.file))).toEqual(f.model)
        await f.service.settings({ enabled: false, context: 2048, output: 256 })
        expect(await f.service.status()).toMatchObject({ running: false, enabled: false, context: 2048 })
        const restarted = createLocalAI({ dataRoot: f.root, executable: process.execPath })
        cleanup.push(() => restarted.close())
        expect(await restarted.status()).toMatchObject({ enabled: false, model: { sha256: stored.model.sha256 } })
        expect(f.processes.every(p => p.exitCode !== null || p.signalCode !== null)).toBe(true)
    })
    test('bad magic, truncated/oversized stream, invalid native model and cancellation preserve selected model', async () => {
        const f = await fixture(); await f.upload()
        const before = await fs.readFile(join(f.root, 'local-ai/settings.json'), 'utf8')
        await expect(f.upload(Buffer.alloc(1024))).rejects.toThrow('GGUF')
        await expect(f.upload(f.model, { bytes: 2048 })).rejects.toThrow('GGUF')
        await expect(f.upload(f.model, { bytes: 24 })).rejects.toThrow('크기')
        const invalid = Buffer.from(f.model); invalid[20] = 99
        await expect(f.upload(invalid)).rejects.toThrow('모델을 실행')
        await expect(f.upload(f.model, { signal: AbortSignal.abort() })).rejects.toThrow()
        expect(await fs.readFile(join(f.root, 'local-ai/settings.json'), 'utf8')).toBe(before)
        expect((await fs.readdir(join(f.root, 'local-ai'))).filter(n => n.endsWith('.gguf'))).toHaveLength(1)
        expect((await fs.readdir(join(f.root, 'local-ai'))).filter(n => n.endsWith('.part'))).toHaveLength(0)
    })
    test('insufficient disk space, invalid token limits and path-like model metadata fail without deleting existing files', async () => {
        const f = await fixture()
        vi.spyOn(fs, 'statfs').mockResolvedValueOnce({ bavail: 0n, bsize: 4096n } as any)
        await expect(f.upload()).rejects.toMatchObject({ status: 507 })
        await expect(f.service.settings({ enabled: true, context: 4096, output: 4096 })).rejects.toThrow('문맥')
        await expect(f.service.settings({ enabled: 'yes', context: 4096, output: 32 })).rejects.toThrow('문맥')
        await fs.writeFile(join(f.root, 'local-ai/settings.json'), JSON.stringify({ enabled: false, context: 2048, output: 32, model: { file: '../private.gguf', name: 'x', sha256: '0'.repeat(64) } }))
        const restarted = createLocalAI({ dataRoot: f.root, executable: process.execPath }); cleanup.push(() => restarted.close())
        expect(await restarted.status()).toMatchObject({ enabled: false, context: 2048, output: 32, model: null })
    })
    test('failed settings commit preserves old model; restart discards only unreferenced service files', async () => {
        const f = await fixture(); await f.upload()
        const before = await fs.readFile(join(f.root, 'local-ai/settings.json'), 'utf8')
        const rename = fs.rename.bind(fs)
        vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
            if (String(to).endsWith('settings.json')) throw Object.assign(new Error('commit failed'), { code: 'ENOSPC' })
            return rename(from, to)
        })
        await expect(f.upload()).rejects.toThrow('commit failed')
        expect(await fs.readFile(join(f.root, 'local-ai/settings.json'), 'utf8')).toBe(before)
        expect((await fs.readdir(join(f.root, 'local-ai'))).filter(n => n.endsWith('.gguf'))).toHaveLength(1)
        vi.restoreAllMocks()
        await fs.writeFile(join(f.root, 'local-ai/11111111-1111-1111-1111-111111111111.gguf'), f.model)
        await fs.writeFile(join(f.root, 'local-ai/22222222-2222-2222-2222-222222222222.part'), f.model)
        await fs.writeFile(join(f.root, 'local-ai/user-note.txt'), 'keep')
        const restarted = createLocalAI({ dataRoot: f.root, executable: process.execPath }); cleanup.push(() => restarted.close())
        expect((await restarted.status()).model.sha256).toBe(JSON.parse(before).model.sha256)
        const names = await fs.readdir(join(f.root, 'local-ai'))
        expect(names).not.toContain('11111111-1111-1111-1111-111111111111.gguf')
        expect(names).not.toContain('22222222-2222-2222-2222-222222222222.part')
        expect(names).toContain('user-note.txt')
    })
    test('authentication, active writer, streaming, disconnect cancellation, busy lock, and restart on demand', async () => {
        const f = await fixture(); await f.upload()
        const app = express(); app.use(express.json())
        f.service.registerRoutes(app, {
            auth: (req, res) => req.headers['risu-auth'] === 'test' || (res.status(401).end(), false),
            activeSession: (req, res) => req.headers['x-session-id'] === 'writer' || (res.status(423).end(), false),
        })
        const base = (await listenForFetch(app)) + '/api/local-ai'
        expect((await fetch(base)).status).toBe(401)
        expect((await fetch(base, { method: 'PUT', headers: { 'risu-auth': 'test' } })).status).toBe(423)
        const headers = { 'risu-auth': 'test', 'x-session-id': 'writer', 'Content-Type': 'application/json' }
        const stop = new AbortController()
        const response = await fetch(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify({ messages: [], stream: true, slow: true }), signal: stop.signal })
        const reader = response.body!.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toContain('local')
        await expect(f.service.settings({ enabled: false, context: 4096, output: 256 })).rejects.toMatchObject({ status: 409 })
        stop.abort(); await reader.cancel().catch(() => {})
        await vi.waitFor(async () => expect((await f.service.status()).busy).toBe(false))
        await f.service.settings({ enabled: true, context: 2048, output: 256 })
        const tokens = await fetch(base + '/tokenize', { method: 'POST', headers, body: JSON.stringify({ content: 'abc' }) })
        expect(await tokens.json()).toEqual({ tokens: [1, 2, 3] })
        expect(f.processes.length).toBe(2)
        const completion = (body: unknown) => fetch(base + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(body) })
        const bounded = await completion({ messages: [], max_tokens: 9999, n_predict: -1, max_completion_tokens: 9999 })
        expect((await bounded.json()).request).toEqual({ messages: [], max_tokens: 256 })
        expect((await completion({ messages: [], max_tokens: -1 })).status).toBe(400)
        expect((await completion([])).status).toBe(400)
        expect((await completion({ messages: [{ role: 'user', content: 'context-full' }] })).status).toBe(422)
        await f.service.close()
        expect(f.processes.every(p => p.exitCode !== null || p.signalCode !== null)).toBe(true)
    })
    test('startup file errors stay offline until an explicit session-only online switch', async () => {
        const f = await fixture()
        vi.spyOn(fs, 'mkdir').mockRejectedValueOnce(new Error('storage unavailable'))
        const restarted = createLocalAI({ dataRoot: f.root, executable: process.execPath }); cleanup.push(() => restarted.close())
        expect(await restarted.status()).toMatchObject({ enabled: true, error: 'storage unavailable' })
        await expect(restarted.settings({ enabled: true, context: 4096, output: 512 })).rejects.toThrow('storage unavailable')
        expect(await restarted.settings({ enabled: false, context: 4096, output: 512 })).toMatchObject({ enabled: false, error: expect.stringContaining('이번 실행') })
        await expect(fs.readFile(join(f.root, 'local-ai/settings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
        const missing = createLocalAI({ dataRoot: f.root, executable: join(f.root, 'missing-engine') }); cleanup.push(() => missing.close())
        expect(await missing.status()).toMatchObject({ enabled: true, error: expect.stringContaining('실행 파일') })
        expect(await missing.settings({ enabled: false, context: 4096, output: 512 })).toMatchObject({ enabled: false, error: expect.stringContaining('저장하지 못했으므로') })
        const saved = JSON.stringify({ enabled: false, context: 2048, output: 32, model: null })
        await fs.writeFile(join(f.root, 'local-ai/settings.json'), saved)
        const savedOnline = createLocalAI({ dataRoot: f.root, executable: join(f.root, 'missing-engine') }); cleanup.push(() => savedOnline.close())
        expect(await savedOnline.status()).toMatchObject({ enabled: false, context: 2048, output: 32, error: expect.stringContaining('실행 파일') })
        expect(await fs.readFile(join(f.root, 'local-ai/settings.json'), 'utf8')).toBe(saved)
    })
    test('an undeletable startup leftover does not disable the selected model or settings', async () => {
        const f = await fixture(); await f.upload(); await f.service.close()
        const leftover = join(f.root, 'local-ai/00000000-0000-0000-0000-000000000000.part')
        await fs.mkdir(leftover)
        const restarted = createLocalAI({ dataRoot: f.root, executable: process.execPath }); cleanup.push(() => restarted.close())
        expect(await restarted.status()).toMatchObject({ model: { bytes: 1024 }, error: expect.stringContaining('정리하지 못했어요') })
        expect(await restarted.settings({ enabled: false, context: 4096, output: 512 })).toMatchObject({ enabled: false, model: { bytes: 1024 } })
        expect((await fs.stat(leftover)).isDirectory()).toBe(true)
    })
    test('a cleanup warning does not hide corrupt-settings recovery instructions', async () => {
        const f = await fixture(); await f.service.close()
        await fs.mkdir(join(f.root, 'local-ai/00000000-0000-0000-0000-000000000000.part'))
        await fs.writeFile(join(f.root, 'local-ai/settings.json'), 'broken')
        const restarted = createLocalAI({ dataRoot: f.root, executable: process.execPath }); cleanup.push(() => restarted.close())
        expect(await restarted.status()).toMatchObject({ model: null, error: expect.stringContaining('모델을 다시 선택') })
    })
    test('mid-upload cancellation and corrupt settings preserve the previously selected model', async () => {
        const f = await fixture(); await f.upload()
        const before = await fs.readFile(join(f.root, 'local-ai/settings.json'), 'utf8')
        const abort = new AbortController()
        const stream = Readable.from((async function* () {
            yield f.model.subarray(0, 32)
            await new Promise<void>(resolve => abort.signal.addEventListener('abort', () => resolve(), { once: true }))
        })())
        const rejected = expect(f.service.importModel(stream, { bytes: f.model.length, name: 'replacement.gguf', signal: abort.signal })).rejects.toThrow()
        await vi.waitFor(async () => expect((await fs.readdir(join(f.root, 'local-ai'))).some(n => n.endsWith('.part'))).toBe(true))
        abort.abort(); await rejected
        expect(await fs.readFile(join(f.root, 'local-ai/settings.json'), 'utf8')).toBe(before)
        await f.service.close()
        await fs.writeFile(join(f.root, 'local-ai/settings.json'), '{broken')
        const restarted = createLocalAI({ dataRoot: f.root, executable: process.execPath }); cleanup.push(() => restarted.close())
        expect(await restarted.status()).toMatchObject({ enabled: true, model: null, error: expect.stringContaining('설정') })
        await restarted.settings({ enabled: false, context: 2048, output: 128 })
        expect(JSON.parse(await fs.readFile(join(f.root, 'local-ai/settings.json'), 'utf8'))).toMatchObject({ enabled: false, preserveUnlinkedModels: true })
        const again = createLocalAI({ dataRoot: f.root, executable: process.execPath }); cleanup.push(() => again.close())
        expect(await again.status()).toMatchObject({ enabled: false, context: 2048, output: 128, model: null })
        expect(await fs.readFile(join(f.root, 'local-ai', JSON.parse(before).model.file))).toEqual(f.model)
    })
    test('successful replacement reclaims superseded models without waiting for restart', async () => {
        const f = await fixture(); await f.upload()
        const before = await fs.readFile(join(f.root, 'local-ai/settings.json'), 'utf8')
        const replacement = Buffer.from(f.model); replacement[30] = 42
        await f.upload(replacement)
        const current = JSON.parse(await fs.readFile(join(f.root, 'local-ai/settings.json'), 'utf8'))
        expect(current.model.file).not.toBe(JSON.parse(before).model.file)
        expect(await fs.readFile(join(f.root, 'local-ai', current.model.file))).toEqual(replacement)
        expect((await fs.readdir(join(f.root, 'local-ai'))).filter(n => n.endsWith('.gguf'))).toEqual([current.model.file])
        await f.service.close()
        const restarted = createLocalAI({ dataRoot: f.root, executable: process.execPath }); cleanup.push(() => restarted.close())
        expect((await restarted.status()).model.sha256).toBe(current.model.sha256)
    })
    test('a real engine closing its socket during a request returns 503 and restarts on retry', async () => {
        const f = await fixture(); await f.upload()
        const enginePath = join(f.root, 'engine.cjs')
        const source = await fs.readFile(enginePath, 'utf8')
        await f.service.settings({ enabled: true, context: 4096, output: 512 })
        await fs.writeFile(enginePath, source.replace("if(req.url === '/apply-template')", "if(req.url === '/apply-template' && body.messages[0]?.content === 'kill-engine') process.exit(7);\n if(req.url === '/apply-template')"))
        const app = express(); app.use(express.json())
        f.service.registerRoutes(app, { auth: () => true, activeSession: () => true })
        const base = await listenForFetch(app)
        const request = (content: string) => fetch(base + '/api/local-ai/chat/completions', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content }] }),
        })
        const stopped = await request('kill-engine')
        expect(stopped.status).toBe(503); expect((await stopped.json()).error).toContain('중단')
        await vi.waitFor(async () => expect((await f.service.status()).running).toBe(false))
        const retry = await request('hello'); expect(retry.status).toBe(200)
        expect((await retry.json()).choices[0].message.content).toBe('local')
    })
    test('native preparation errors and engine death never become a TCP request', async () => {
        let mode = 'kill'
        const sockets: unknown[] = []
        const f = await fixture({ fetchImpl: async (url, options) => {
            sockets.push(options.socketPath)
            if (url.endsWith('/props')) return Response.json({ default_generation_settings: { n_ctx: 4096 } })
            if (url.endsWith('/apply-template')) {
                if (mode === 'busy') return new Response('temporarily loading', { status: 503 })
                if (mode === 'malformed') return new Response('not JSON')
                const current = f.processes.at(-1)!
                const closed = once(current, 'close'); current.kill(); await closed
                return Response.json({ prompt: 'test prompt' })
            }
            return Response.json({ tokens: [1], choices: [{ message: { content: 'unexpected' } }] })
        } })
        await f.upload()
        const app = express(); app.use(express.json())
        f.service.registerRoutes(app, { auth: () => true, activeSession: () => true })
        const base = await listenForFetch(app)
        const request = () => fetch(base + '/api/local-ai/chat/completions', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [] }),
        })
        const stopped = await request(); expect(stopped.status).toBe(503); expect((await stopped.json()).error).toContain('중단')
        expect(sockets.every(socket => typeof socket === 'string' && socket.length > 0)).toBe(true)
        mode = 'busy'; const busy = await request(); expect(busy.status).toBe(503); expect((await busy.json()).error).toContain('준비')
        mode = 'malformed'; expect((await request()).status).toBe(502)
    })
})
