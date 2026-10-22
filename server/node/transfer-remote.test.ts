import { test, expect } from 'vitest'
import { Readable } from 'node:stream'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { createRemoteTransfers, base64JsonFile, GITHUB_LIMIT, gitHash } = require('./transfer-remote.cjs')
const { createTransferSecrets, androidProtector, dpapi } = require('./transfer-secrets.cjs')
const { legacyDocument, requireContinuation, JSON_LIMIT } = require('./transfer-remote.cjs')
const response = (code: number, data: any) => Object.assign(Readable.from([Buffer.isBuffer(data) ? data : Buffer.from(typeof data === 'string' ? data : JSON.stringify(data))]), { statusCode: code, headers: {} })
const bytes = async (stream: any) => { const chunks = []; for await (const chunk of stream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks) }
async function fixture(t: any, size = 9 * 1024 * 1024 + 1) {
    const root = await mkdtemp(join(tmpdir(), 'bard-remote-'))
    t.onTestFinished(() => rm(root, { recursive: true, force: true }))
    const file = join(root, 'bundle.risuplay'), content = Buffer.alloc(size, 123)
    await writeFile(file, content)
    const db: any = { nas: { url: 'https://nas.invalid/home/RisuAI/', username: 'test', password: 'synthetic' }, github: { repository: 'fixture/private', token: 'synthetic' } }
    const secrets = { get: async (key: string) => db[key] ?? {}, set: async (key: string, value: unknown) => { db[key] = value } }
    const imports: Buffer[] = []
    const transfers = { file: async () => file, list: async () => [{ id: 'out', backupKey: 'a'.repeat(64) }], ingest: async (stream: any) => { imports.push(await bytes(stream)); return { state: 'waiting' } } }
    return { root, file, content, db, secrets, transfers, imports }
}

test('protected settings are ciphertext, survive restart and do not silently reset on wrong key', async t => {
    const f = await fixture(t, 0), protector = androidProtector('ab'.repeat(32))
    const vault = createTransferSecrets(f.root, protector)
    await vault.set('nas', { password: 'private-fixture-password' })
    expect(await readFile(join(f.root, 'transfer-secrets.dat'), 'utf8')).not.toContain('private-fixture-password')
    expect(await createTransferSecrets(f.root, protector).get('nas')).toEqual({ password: 'private-fixture-password' })
    await expect(createTransferSecrets(f.root, androidProtector('cd'.repeat(32))).get('nas')).rejects.toThrow()
    expect(await vault.get('nas')).toEqual({ password: 'private-fixture-password' })
    const before = await readFile(join(f.root, 'transfer-secrets.dat'))
    const changedKey = createTransferSecrets(f.root, androidProtector('cd'.repeat(32)))
    await expect(changedKey.set('nas', null)).rejects.toThrow()
    await changedKey.reset()
    expect(await changedKey.get('nas')).toEqual({})
    const recovery = (await readdir(f.root)).filter(name => /^transfer-secrets\.recovery-.*\.dat$/.test(name))
    expect(recovery).toHaveLength(1); expect(await readFile(join(f.root, recovery[0]))).toEqual(before)
    await changedKey.set('nas', { password: 'new-synthetic' })
    expect(await changedKey.get('nas')).toEqual({ password: 'new-synthetic' })
})

test('unconfigured remote operations explain the missing settings before making a network request', async t => {
    const f = await fixture(t, 0); f.db.nas = {}; f.db.github = {}
    const remote = createRemoteTransfers({ ...f, fetch: async () => { throw new Error('unexpected network call') } })
    await expect(remote.dispatch('nas', 'list')).rejects.toThrow('먼저 저장')
    await expect(remote.dispatch('github', 'list')).rejects.toThrow('먼저 저장')
})
test.skipIf(process.platform !== 'win32')('Windows DPAPI round trip', async () => {
    const original = Buffer.from('synthetic-fixture-not-a-real-secret'), encrypted = await dpapi(original, false)
    expect(encrypted.equals(original)).toBe(false); expect(await dpapi(encrypted, true)).toEqual(original)
})
test('base64 JSON streams correctly across chunk boundaries without a full base64 buffer', async t => {
    const f = await fixture(t)
    const parsed = JSON.parse((await bytes(base64JsonFile(f.file, { branch: 'main', message: '한글' }))).toString())
    expect(Buffer.from(parsed.content, 'base64').equals(f.content)).toBe(true); expect(parsed.branch).toBe('main')
})
test('NAS verifies a staged upload before MOVE and never follows redirects with credentials', async t => {
    const f = await fixture(t, 107), calls: string[] = []
    const remote = createRemoteTransfers({ ...f, fetch: async (url: string, options: any) => {
        calls.push(options.method)
        expect(url.startsWith(f.db.nas.url)).toBe(true)
        if (options.method === 'PUT') { expect(await bytes(options.body)).toEqual(f.content); expect(options.headers['If-None-Match']).toBe('*'); return response(201, '') }
        if (options.method === 'GET') return response(200, f.content)
        expect(options.headers.Overwrite).toBe('F'); return response(201, '')
    } })
    expect((await remote.dispatch('nas', 'upload', { id: 'out' })).state).toBe('delivered')
    expect(calls).toEqual(['PUT', 'GET', 'MOVE'])
    const redirected = createRemoteTransfers({ ...f, fetch: async () => response(302, '') })
    await expect(redirected.dispatch('nas', 'download', { name: 'a.risuplay' })).rejects.toThrow('302')
    await expect(remote.dispatch('nas', 'download', { name: '../a.risuplay' })).rejects.toThrow('filename')
})
test('NAS hash mismatch removes only its temporary file and never publishes it', async t => {
    const f = await fixture(t, 107), calls: string[] = []
    const remote = createRemoteTransfers({ ...f, fetch: async (_url: string, o: any) => { calls.push(o.method); if (o.body) await bytes(o.body); return response(o.method === 'PUT' ? 201 : 200, 'corrupted') } })
    await expect(remote.dispatch('nas', 'upload', { id: 'out' })).rejects.toThrow('hash mismatch')
    expect(calls).toEqual(['PUT', 'GET', 'DELETE'])
})
test('GitHub >8MiB upload checks exact commit and hash; conflict does not delete the previous backup', async t => {
    const f = await fixture(t), sha = await gitHash(f.file, f.content.length), commit = 'b'.repeat(40), previous = 'c'.repeat(40)
    let conflict = false; const methods: string[] = []
    const remote = createRemoteTransfers({ ...f, fetch: async (url: string, o: any) => {
        methods.push(o.method || 'GET')
        expect(url.startsWith('https://api.github.com/repos/fixture/private/')).toBe(true)
        if (url.endsWith('/')) return response(200, { private: true, default_branch: 'main' })
        if (o.method === 'PUT') {
            const body = await bytes(o.body); expect(body.length).toBe(Number(o.headers['Content-Length']))
            const json = JSON.parse(body.toString()); expect(json.sha).toBe(previous); expect(Buffer.from(json.content, 'base64').equals(f.content)).toBe(true)
            return response(conflict ? 409 : 200, { commit: { sha: commit } })
        }
        return response(200, { type: 'file', sha: url.endsWith(commit) ? sha : previous, size: f.content.length })
    } })
    expect((await remote.dispatch('github', 'upload', { id: 'out' })).state).toBe('delivered')
    conflict = true; await expect(remote.dispatch('github', 'upload', { id: 'out' })).rejects.toThrow('409')
    expect(methods).not.toContain('DELETE')
})
test('GitHub fixed revision download verifies bytes before durable ingestion; public repo rejected', async t => {
    const f = await fixture(t, 24), sha = createHash('sha1').update(`blob 24\0`).update(f.content).digest('hex'), commit = 'b'.repeat(40)
    let corrupt = false, publicRepo = false
    const remote = createRemoteTransfers({ ...f, fetch: async (url: string, o: any) => {
        if (url.endsWith('/')) return response(200, { private: !publicRepo })
        expect(url.endsWith(`?ref=${commit}`)).toBe(true)
        return o.headers.Accept.includes('raw') ? response(200, corrupt ? Buffer.alloc(24) : f.content) : response(200, { type: 'file', sha, size: 24 })
    } })
    const input = { name: 'a'.repeat(64) + '.risuplay', commit, sha }
    expect((await remote.dispatch('github', 'download', input)).state).toBe('waiting')
    corrupt = true; await expect(remote.dispatch('github', 'download', input)).rejects.toThrow('hash mismatch')
    expect(f.imports).toHaveLength(1)
    publicRepo = true; await expect(remote.dispatch('github', 'download', input)).rejects.toThrow('비공개')
})
test('GitHub rejects the exact 100000000 boundary before creating an upload stream', async t => {
    const f = await fixture(t, 0)
    await import('node:fs/promises').then(m => m.truncate(f.file, GITHUB_LIMIT))
    let calls = 0
    const remote = createRemoteTransfers({ ...f, fetch: async () => { calls++; return response(200, { private: true, default_branch: 'main' }) } })
    await expect(remote.dispatch('github', 'upload', { id: 'out' })).rejects.toThrow('100,000,000')
    expect(calls).toBe(1)
})

test('legacy JSON keeps its 8MiB limit and refuses shorter or diverged backups', () => {
    const data = { id: 'chat', message: [{ role: 'char', data: '기존' }] }
    const document = JSON.stringify({ type: 'risuChat', ver: 2, data })
    expect(legacyDocument(Buffer.from(document + ' '.repeat(JSON_LIMIT - Buffer.byteLength(document)))).data).toEqual(data)
    expect(() => legacyDocument(Buffer.alloc(JSON_LIMIT + 1))).toThrow('8 MiB')
    expect(() => requireContinuation(data, { ...data, message: [] })).toThrow('기존')
    expect(() => requireContinuation(data, { ...data, message: [{ data: '다른 수정' }] })).toThrow('기존')
    expect(() => requireContinuation(data, { ...data, message: [...data.message, { data: '다음' }] })).not.toThrow()
})

test('legacy GitHub updates its stable path only after verifying the previous blob and verifies the uploaded blob', async t => {
    const f = await fixture(t, 0), calls: string[] = [], blobs = new Map<string, Buffer>()
    const document: any = { type: 'risuChat', ver: 2, privateMobileChatSync: { characterId: 'card' }, data: { id: 'chat', message: [{ data: '기존' }] } }
    const filename = 'latest-' + createHash('sha256').update(JSON.stringify(['card', 'chat'])).digest('hex') + '.json'
    const path = 'chat-uploads/' + filename
    const digest = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
    const prior = Buffer.from(JSON.stringify(document)); let stored = digest(prior); blobs.set(stored, prior)
    const remote = createRemoteTransfers({ ...f, transfers: { ...f.transfers, legacyChat: async () => document }, fetch: async (url: string, o: any) => {
        calls.push(o.method || 'GET')
        if (url.endsWith('/')) return response(200, { private: true, default_branch: 'main' })
        if (url.includes('/git/ref/')) return response(200, { object: { sha: 'd'.repeat(40) } })
        if (url.includes('/git/blobs/')) { const sha = url.split('/').at(-1)!, bytes = blobs.get(sha)!; return response(200, { sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64') }) }
        if (o.method === 'PUT') {
            const body = JSON.parse((await bytes(o.body)).toString()); expect(body.sha).toBe(stored); expect(body.branch).toBe('chat-uploads')
            const uploaded = Buffer.from(body.content, 'base64'); stored = digest(uploaded); blobs.set(stored, uploaded)
            return response(200, { content: { path, sha: stored } })
        }
        expect(url).toContain(path); return response(200, { type: 'file', path, sha: stored, size: blobs.get(stored)!.length })
    } })
    document.data.message.push({ data: '다음' })
    expect((await remote.dispatch('github', 'legacy-upload', {})).name).toBe(filename)
    expect(JSON.parse((await remote.dispatch('github', 'legacy-download', { name: filename, sha: stored, bytes: blobs.get(stored)!.length })).document)).toEqual(document)
    document.data.message.pop()
    await expect(remote.dispatch('github', 'legacy-upload', {})).rejects.toThrow('기존')
    expect(calls.filter(method => method === 'PUT')).toHaveLength(1); expect(calls).not.toContain('DELETE')
    const conflict = await remote.dispatch('github', 'legacy-upload', { promptConflict: true })
    expect(conflict.conflictSha).toBe(stored)
    await expect(remote.dispatch('github', 'legacy-upload', { replaceSha: '0'.repeat(40) })).rejects.toThrow('확인하는 동안')
    expect(calls.filter(method => method === 'PUT')).toHaveLength(1)
    document.data.message[0].data = '명시적으로 선택한 수정본'
    expect((await remote.dispatch('github', 'legacy-upload', { replaceSha: conflict.conflictSha })).state).toBe('delivered')
    expect(calls.filter(method => method === 'PUT')).toHaveLength(2)
    expect(JSON.parse(blobs.get(stored)!.toString()).data.message[0].data).toBe('명시적으로 선택한 수정본')
})

test('NAS home profile: internal URL and home Wi-Fi names are saved with the same account, masked in config, validated, kept when omitted', async t => {
    const f = await fixture(t, 0)
    const { createRemoteTransfers, validateHomeSsids } = require('./transfer-remote.cjs')
    const calls: string[] = []
    const route = { urlFor: async (c: any) => c.homeUrl || c.url, endpointFor: async (c: any) => ({ url: c.homeUrl || c.url, servername: (c.homeUrl ? c.homeCertHost : c.certHost) || '' }), invalidate: () => calls.push('invalidate') }
    const remotes = createRemoteTransfers({ secrets: f.secrets, transfers: f.transfers, fetch: f.fetch, route })
    const saved = await remotes.dispatch('nas', 'configure', { url: 'https://nas.invalid/home/RisuAI/', username: 'test', password: 'synthetic', homeUrl: 'https://nas-home.invalid:5006/home/RisuAI', homeSsids: ['Fixture Home 2G', 'Fixture Home 5G', 'Fixture Home 2G'] })
    expect(saved).toEqual({ url: 'https://nas.invalid/home/RisuAI/', username: 'test', hasPassword: true, homeUrl: 'https://nas-home.invalid:5006/home/RisuAI/', homeSsids: ['Fixture Home 2G', 'Fixture Home 5G'], certHost: '', homeCertHost: '' })
    expect(calls).toContain('invalidate')
    const stored = await f.secrets.get('nas'); expect(stored.password).toBe('synthetic'); expect(stored.homeUrl).toBe('https://nas-home.invalid:5006/home/RisuAI/')
    expect((await remotes.dispatch('nas', 'configure', { url: 'https://nas.invalid/home/RisuAI/', username: 'test', homeUrl: 'https://nas-home.invalid:5006/home/RisuAI/' })).homeSsids).toEqual(['Fixture Home 2G', 'Fixture Home 5G'])
    await expect(remotes.dispatch('nas', 'configure', { url: 'https://nas.invalid/home/RisuAI/', username: 'test', homeUrl: 'http://nas-home.invalid/home/RisuAI/' })).rejects.toThrow() // HTTPS only, no bypass
    expect(() => validateHomeSsids(['ok', 'bad\u0000'])).toThrow(); expect(() => validateHomeSsids(Array.from({ length: 17 }, (_, i) => 's' + i))).toThrow()
})

test('manual NAS transfer on the home/external route: an upload keeps one host for PUT/verify/MOVE/DELETE even when the network flips mid-PUT; the next list/download follow the new network; same account on both', async t => {
    const f = await fixture(t, 4096)
    const { fixtureDav } = await import('./nas-sync-dav-fixture')
    const { createRemoteTransfers } = require('./transfer-remote.cjs'), { createNasRoute } = require('./nas-route.cjs')
    const home = fixtureDav('https://nas-home.invalid:5006/home/RisuAI/'), external = fixtureDav('https://nas.invalid/home/RisuAI/')
    const hosts: string[] = [], auth = new Set<string>()
    const fetch = async (url: string, init?: any) => { hosts.push(new URL(url).host); auth.add(init?.headers?.Authorization ?? ''); return url.startsWith(home.base) ? home.fetch(url, init) : external.fetch(url, init) }
    const secrets = { get: async () => ({ url: external.base, homeUrl: home.base, username: 'fixture', password: 'fixture-password', homeSsids: ['Fixture Home'] }) }
    const route = createNasRoute({ secrets, probe: async () => false })
    route.report({ transport: 'wifi', ssid: 'Fixture Home' })
    const remotes = createRemoteTransfers({ secrets, transfers: f.transfers, fetch, route })
    home.hooks.push(async ({ method }) => { if (method === 'PUT') route.report({ transport: 'wifi', ssid: 'Cafe' }); return null }) // flips while the upload is in flight
    expect((await remotes.dispatch('nas', 'upload', { id: 'out' })).state).toBe('delivered')
    expect(new Set(hosts)).toEqual(new Set(['nas-home.invalid:5006'])); expect(external.log).toEqual([])
    const uploaded = home.paths(); expect(uploaded).toHaveLength(1); expect(uploaded[0]).toMatch(/\.risuplay$/)
    hosts.length = 0
    expect((await remotes.dispatch('nas', 'list')).url).toBe(external.base) // next operation: unknown-to-home network → the listing is served by the external host
    await expect(remotes.dispatch('nas', 'download', { name: uploaded[0].split('/').pop() })).rejects.toThrow() // 404 on the external host, never silently served from home
    expect(new Set(hosts)).toEqual(new Set(['nas.invalid']))
    expect(auth.size).toBe(1); expect([...auth][0]).toMatch(/^Basic /)
})

test('direct-IP NAS: optional certificate names are saved/masked per side and validated; nasRequest carries the servername of the pinned endpoint; request() turns it into SNI + Host without touching validation; DNS-only configs are unchanged', async t => {
    const f = await fixture(t, 0)
    const { createRemoteTransfers, certHost, nasServername, request } = require('./transfer-remote.cjs')
    const seen: any[] = []
    const fetch = async (url: string, init: any) => { seen.push({ host: new URL(url).host, servername: init.servername ?? '' }); return response(207, '<d:multistatus xmlns:d="DAV:"></d:multistatus>') }
    let side = 'external'
    const route = { endpointFor: async (c: any) => side === 'home' ? { url: c.homeUrl, servername: c.homeCertHost || '' } : { url: c.url, servername: c.certHost || '' }, urlFor: async (c: any) => side === 'home' ? c.homeUrl : c.url, invalidate: () => {} }
    const remotes = createRemoteTransfers({ secrets: f.secrets, transfers: f.transfers, fetch, route })
    const base = { url: 'https://203.0.113.10:64470/home/RisuAI/', username: 'test', password: 'synthetic', homeUrl: 'https://192.0.2.5:15006/home/RisuAI/' }
    const saved = await remotes.dispatch('nas', 'configure', { ...base, certHost: 'nas.example', homeCertHost: 'home.nas.example' })
    expect(saved).toMatchObject({ url: base.url, homeUrl: base.homeUrl, certHost: 'nas.example', homeCertHost: 'home.nas.example' }); expect(saved).not.toHaveProperty('password')
    expect((await remotes.dispatch('nas', 'configure', { url: base.url, username: 'test', homeUrl: base.homeUrl })).certHost).toBe('nas.example') // kept when omitted
    for (const bad of ['203.0.113.10', 'has space', 'a..b', '-x.example', 'x'.repeat(254)]) await expect(remotes.dispatch('nas', 'configure', { ...base, certHost: bad })).rejects.toThrow(/인증서 이름/)
    await remotes.dispatch('nas', 'list'); side = 'home'; await remotes.dispatch('nas', 'list')
    expect(seen).toEqual([{ host: '203.0.113.10:64470', servername: 'nas.example' }, { host: '192.0.2.5:15006', servername: 'home.nas.example' }])
    // Without a home URL the home name is dropped; a DNS-only config carries no servername at all.
    expect((await remotes.dispatch('nas', 'configure', { url: base.url, username: 'test', certHost: '', homeUrl: '', homeCertHost: 'home.nas.example' })).homeCertHost).toBe('')
    const dns = { url: 'https://nas.invalid/home/RisuAI/', homeUrl: 'https://nas-home.invalid:5006/home/RisuAI/' }
    expect(nasServername(dns, dns.url)).toBe(''); expect(nasServername(dns, dns.homeUrl)).toBe(''); expect(nasServername({ ...dns, certHost: 'a.example', homeCertHost: 'b.example' }, dns.homeUrl)).toBe('b.example')
    expect(certHost('')).toBe(''); expect(certHost(' Nas.Example ')).toBe('Nas.Example')
    // request(): servername becomes the TLS server name and the Host header (with the URL port); nothing else about TLS changes.
    const https = require('node:https'), original = https.request, calls: any[] = []
    https.request = (url: any, options: any) => { calls.push({ url: String(url), options }); const req: any = new (require('node:events').EventEmitter)(); req.setTimeout = () => {}; req.end = () => setTimeout(() => req.emit('error', new Error('fixture: no network')), 0); req.destroy = () => {}; return req }
    try {
        await expect(request('https://203.0.113.10:64470/x', { servername: 'nas.example', headers: { Depth: '0' } })).rejects.toThrow(/fixture/)
        await expect(request('https://nas.invalid/x', { headers: { Depth: '0' } })).rejects.toThrow(/fixture/)
        expect(() => request('https://203.0.113.10/x', { servername: 'bad name' })).toThrow(/인증서 이름/) // refused before any socket
    } finally { https.request = original }
    expect(calls[0].options).toEqual({ method: 'GET', servername: 'nas.example', headers: { Host: 'nas.example:64470', Depth: '0' } })
    expect(calls[1].options).toEqual({ method: 'GET', headers: { Depth: '0' } }); expect(calls[1].options).not.toHaveProperty('servername')
    for (const c of calls) expect(JSON.stringify(c.options)).not.toMatch(/rejectUnauthorized|checkServerIdentity|insecure/)
})
