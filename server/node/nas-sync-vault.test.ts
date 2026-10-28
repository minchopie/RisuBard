import { test, expect } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { createVault, vaultMasterStore, inventory, sameSecret, splitUrl, splitParams, REFS } = require('./nas-sync-vault.cjs')
const { androidProtector } = require('./transfer-secrets.cjs')
const { makeRevision, encodeRevision } = require('./nas-sync-core.cjs')

const S = (n: string) => `SENTINEL-${n}-never-leaves-vault`
const schema = [{ key: 'apiKey', type: 'secret', label: 'k', secret: true, mapsTo: { target: 'auth', path: 'x' } }, { key: 'saToken', type: 'string', label: 's', mapsTo: { target: 'auth', path: 'y' } }, { key: 'temperature', type: 'number', label: 't' }]
const snapshot = (url = 'https://profile.example/v1') => ({ profileId: 'p', schema, auth: { kind: 'bearer', fields: ['legacyAuth'] }, endpoint: { kind: 'static', url } })
function fixture() {
    return {
        openAIKey: S('openai'), proxyKey: S('proxy'), forceReplaceUrl: 'https://proxy.example/v1', claudeAPIKey: S('claude'), vertexPrivateKey: S('vertex'), vertexClientEmail: 'svc@example.test',
        vertexAccessToken: S('vertex-token'), mistralKey: '', aiModel: 'gpt-4.1', apiType: 'openai',
        hordeConfig: { apiKey: S('horde'), model: 'm' }, novelai: { token: S('nai'), model: 'clio' }, deeplOptions: { key: S('deepl'), freeApi: true },
        deeplXOptions: { url: 'https://deeplx.example/translate', token: S('deeplx') }, google: { accessToken: S('google'), projectId: 'p' },
        hypaCustomSettings: { url: 'https://embed.example/v1', key: S('hypa'), model: 'e' }, openaiCompatImage: { url: 'https://img.example', key: S('img'), model: 'i' },
        wavespeedImage: { key: S('wave'), model: 'w' }, account: { token: S('account'), id: 'me', data: { refresh_token: S('refresh'), access_token: S('access'), expires_in: 3600 } },
        OaiCompAPIKeys: { 'https://a.example': S('oaicomp-a'), 'https://b.example': S('oaicomp-b') },
        customModels: [{ id: 'cm1', url: 'https://custom.example/v1', key: S('custom'), name: 'c', params: `temperature=0.5\nheader::Authorization=Bearer ${S('param-auth')}\nheader::X-Title=public\nheader::X-Api-Key={{none}}` }, { id: 'cm2', url: '', key: '', name: 'nokey', params: '' }],
        apiKeyPool: { pool1: { id: 'pool1', name: 'n', key: S('pool'), createdAt: 1, updatedAt: 1 } },
        authRefreshes: [{ url: 'https://auth.example/a', tokenUrl: 'https://auth.example/t', refreshToken: S('refresh2'), clientId: 'cid', clientSecret: S('csecret') }],
        botPresets: [{ id: 'bp1', name: '프리셋', openAIKey: S('preset-key'), proxyKey: S('preset-proxy'), forceReplaceUrl: 'https://preset-proxy.example/' }, { name: 'no-id', openAIKey: S('preset-noid') }],
        characters: [{ chaId: 'card', name: '표본', oaiTTSConfig: { apiKey: S('tts'), baseURL: 'https://tts.example/v1', voice: 'v' }, chats: [{ id: 'chat', message: [{ data: 'key token password prose stays' }] }] }],
        modelPresets: [
            { id: 'mp1', name: 'mp', profileSnapshot: snapshot(), userValues: { apiKey: S('mp-userkey'), saToken: S('mp-sa'), legacyAuth: S('mp-legacy'), temperature: 0.7, model: 'public' }, customHeaders: { Authorization: S('bearer'), 'X-Api-Key': S('xapi'), 'X-Title': 'public' }, additionalParamsText: `header::anthropic-auth-token=${S('mp-param')}\nmax_tokens=5` },
            { id: 'mp2', name: 'inline', profileSnapshot: snapshot('https://inline.example'), userValues: {}, inlineCredential: { apiKey: S('inline-object'), region: 'kr' } },
            { id: 'mp3', name: 'inline-string', profileSnapshot: snapshot(''), userValues: {}, inlineCredential: S('inline-string'), apiKeyRef: 'pool1' },
        ],
        plugins: [{ name: 'plug', realArg: { api_key: S('plugin-key'), threshold: 3, label: 'public' } }],
        textgenWebUIStreamURL: 'https://user:' + S('urlpass') + '@textgen.example/api?key=' + S('urlquery') + '&x=1',
        koboldURL: 'not a url', ollamaURL: 'http://localhost:11434',
    }
}
const text = (v: unknown) => JSON.stringify(v)
const master = Buffer.from('ab'.repeat(32), 'hex'), otherMaster = Buffer.from('cd'.repeat(32), 'hex')
const EXPECTED_SLOTS = ['/openAIKey', '/proxyKey', '/claudeAPIKey', '/vertexPrivateKey', '/vertexAccessToken', '/hordeConfig/apiKey', '/novelai/token', '/deeplOptions/key', '/deeplXOptions/token', '/google/accessToken',
    '/hypaCustomSettings/key', '/openaiCompatImage/key', '/wavespeedImage/key', '/account/token', '/account/data/refresh_token', '/account/data/access_token', '/OaiCompAPIKeys/https:~1~1a.example', '/OaiCompAPIKeys/https:~1~1b.example',
    '/customModels/cm1/key', '/customModels/cm1/params#header:Authorization', '/apiKeyPool/pool1/key', '/authRefreshes/https:~1~1auth.example~1a/refreshToken', '/authRefreshes/https:~1~1auth.example~1a/clientSecret',
    '/botPresets/bp1/openAIKey', '/botPresets/bp1/proxyKey', '/botPresets/1/openAIKey', '/characters/card/oaiTTSConfig/apiKey',
    '/modelPresets/mp1/userValues/apiKey', '/modelPresets/mp1/userValues/saToken', '/modelPresets/mp1/userValues/legacyAuth', '/modelPresets/mp1/customHeaders/Authorization', '/modelPresets/mp1/customHeaders/X-Api-Key',
    '/modelPresets/mp1/additionalParamsText#header:anthropic-auth-token', '/modelPresets/mp2/inlineCredential', '/modelPresets/mp3/inlineCredential', '/plugins/plug/realArg/api_key',
    '/textgenWebUIStreamURL#userinfo', '/textgenWebUIStreamURL#query:key'].sort()

test('projection removes every inventoried credential; public record, envelopes and revision text carry no sentinel', () => {
    const db = fixture(), before = text(db), vault = createVault(master)
    const { public: pub, envelopes } = vault.project(db)
    expect(text(db)).toBe(before)
    for (const out of [text(pub), text(envelopes), encodeRevision(makeRevision({ domain: 'settings', type: 'db', root: 'main', content: pub }))]) expect(out).not.toContain('SENTINEL')
    expect(pub.vertexClientEmail).toBe('svc@example.test'); expect(pub.aiModel).toBe('gpt-4.1'); expect(pub.mistralKey).toBe('')
    expect(pub.modelPresets[0].customHeaders['X-Title']).toBe('public'); expect(pub.modelPresets[0].userValues).toMatchObject({ apiKey: '', temperature: 0.7, model: 'public' })
    expect(pub.modelPresets[0].additionalParamsText).toBe('header::anthropic-auth-token=\nmax_tokens=5')
    expect(pub.modelPresets[1].inlineCredential).toBe(''); expect(pub.modelPresets[2]).toMatchObject({ inlineCredential: '', apiKeyRef: 'pool1' })
    expect(pub.customModels[0].params).toBe('temperature=0.5\nheader::Authorization=\nheader::X-Title=public\nheader::X-Api-Key={{none}}')
    expect(pub.characters[0].chats[0].message[0].data).toContain('key token password') // chat prose is never read as a parameter line
    expect(pub.plugins[0].realArg.threshold).toBe(3)
    expect(pub.characters[0].chats[0].message[0].data).toBe('key token password prose stays')
    expect(pub.customModels[1]).toEqual({ id: 'cm2', url: '', key: '', name: 'nokey', params: '' })
    expect(pub.koboldURL).toBe('not a url')
    expect(pub.textgenWebUIStreamURL).toBe('https://textgen.example/api?key=&x=1')
    expect(pub[REFS].map((r: any) => r.slot)).toEqual(EXPECTED_SLOTS)
    expect(envelopes).toHaveLength(EXPECTED_SLOTS.length)
    const ref = (slot: string) => pub[REFS].find((r: any) => r.slot === slot)
    expect(ref('/customModels/cm1/key').origin).toBe('https://custom.example')
    expect(ref('/customModels/cm1/params#header:Authorization').origin).toBe('https://custom.example')
    expect(ref('/proxyKey').origin).toBe('https://proxy.example')
    expect(ref('/botPresets/bp1/proxyKey').origin).toBe('https://preset-proxy.example')
    expect(ref('/openAIKey').origin).toBe('/openAIKey')
    expect(ref('/modelPresets/mp1/userValues/apiKey').origin).toBe('https://profile.example')
    expect(ref('/modelPresets/mp1/customHeaders/Authorization').origin).toBe('https://profile.example')
    expect(ref('/modelPresets/mp2/inlineCredential')).toMatchObject({ kind: 'json', origin: 'https://inline.example' })
    expect(ref('/modelPresets/mp3/inlineCredential')).toMatchObject({ kind: 'field', origin: '/modelPresets/mp3/inlineCredential' })
    expect(ref('/textgenWebUIStreamURL#userinfo').origin).toBe('https://textgen.example')
    for (const env of envelopes) { expect(env.epoch).toBe(vault.epoch); expect(env.data).toMatch(/^[A-Za-z0-9+/=]+$/) }
    expect(() => vault.project(pub)).toThrow(/already carries/)
})

test('apply restores the exact original; equal secrets give equal public references across devices', () => {
    const db = fixture(), tablet = createVault(master), phone = createVault(master)
    const first = tablet.project(db), second = phone.project(db)
    expect(first.public).toEqual(second.public) // nonce/ciphertext differ, references do not
    expect(first.envelopes.map((e: any) => e.data)).not.toEqual(second.envelopes.map((e: any) => e.data))
    expect(first.envelopes.every((a: any, i: number) => sameSecret(a, second.envelopes[i]))).toBe(true)
    const applied = phone.apply(first.public, first.envelopes, { stale: true })
    expect(applied).toMatchObject({ applied: true, pending: [] })
    expect(applied.value).toEqual(db)
    expect(Object.hasOwn(applied.value, REFS)).toBe(false)
    expect(phone.apply({ plain: 1 }, [], null)).toEqual({ applied: true, pending: [], value: { plain: 1 } })
    expect(tablet.version('/openAIKey', '/openAIKey', 'x')).not.toBe(tablet.version('/proxyKey', '/proxyKey', 'x'))
    expect(tablet.version('/proxyKey', 'https://a.example', 'x')).not.toBe(tablet.version('/proxyKey', 'https://b.example', 'x'))
})

test('missing key, unknown epoch or tamper leave the current profile and keep the whole group pending', () => {
    const db = fixture(), tablet = createVault(master), current = { working: 'profile' }
    const { public: pub, envelopes } = tablet.project(db)
    const unknown = createVault(otherMaster).apply(pub, envelopes, current)
    expect(unknown.applied).toBe(false); expect(unknown.value).toBe(current)
    expect(unknown.pending.every((p: any) => p.reason === 'VAULT_EPOCH')).toBe(true); expect(unknown.pending).toHaveLength(EXPECTED_SLOTS.length)
    expect(tablet.apply(pub, envelopes.slice(1), current)).toMatchObject({ applied: false, pending: [{ slot: envelopes[0].slot, reason: 'missing' }], value: current })
    const tampered = envelopes.map((e: any) => ({ ...e }))
    const bytes = Buffer.from(tampered[0].data, 'base64'); bytes[0] ^= 1; tampered[0].data = bytes.toString('base64')
    expect(tablet.apply(pub, tampered, current)).toMatchObject({ applied: false, pending: [{ slot: tampered[0].slot, reason: 'VAULT_TAMPER' }] })
    expect(() => tablet.open({ ...envelopes[0], slot: '/other' })).toThrow(/authentication/)
    expect(() => tablet.open({ ...envelopes[0], origin: 'https://evil.example' })).toThrow(/authentication/)
    expect(() => tablet.open({ v: 2 })).toThrow(expect.objectContaining({ code: 'VAULT_SCHEMA' }))
    // A reference pointing at a location the inventory does not define is not applied anywhere.
    const foreign = { ...pub, [REFS]: [{ ...pub[REFS][0], slot: '/mainPrompt', path: '/mainPrompt', kind: 'field' }] }
    expect(tablet.apply(foreign, [{ ...envelopes.find((e: any) => e.slot === pub[REFS][0].slot), slot: '/mainPrompt' }], current)).toMatchObject({ applied: false, pending: [{ slot: '/mainPrompt', reason: 'inventory' }] })
    // A public field that still holds a plaintext value is never silently overwritten.
    const occupied = JSON.parse(text(pub)); occupied.openAIKey = 'typed-locally'
    expect(tablet.apply(occupied, envelopes, current).pending).toEqual([{ slot: '/openAIKey', reason: 'occupied' }])
})

test('a valid envelope is never rebound to a different public endpoint (Codex review 01, P1)', () => {
    const vault = createVault(master), current = { forceReplaceUrl: 'https://original.example/v1', proxyKey: 'current-working' }
    const { public: pub, envelopes } = vault.project({ forceReplaceUrl: 'https://original.example/v1', proxyKey: S('proxy') })
    expect(vault.apply(pub, envelopes, current).value).toEqual({ forceReplaceUrl: 'https://original.example/v1', proxyKey: S('proxy') })
    const moved = JSON.parse(text(pub)); moved.forceReplaceUrl = 'https://different.example/v1'
    expect(vault.apply(moved, envelopes, current)).toEqual({ applied: false, pending: [{ slot: '/proxyKey', reason: 'origin' }], value: current })
    const removed = JSON.parse(text(pub)); removed.forceReplaceUrl = ''
    expect(vault.apply(removed, envelopes, current)).toMatchObject({ applied: false, pending: [{ slot: '/proxyKey', reason: 'origin' }] })
    const invalid = JSON.parse(text(pub)); invalid.forceReplaceUrl = 'not a url'
    expect(vault.apply(invalid, envelopes, current)).toMatchObject({ applied: false, pending: [{ slot: '/proxyKey', reason: 'origin' }] })
    // Both metadata copies agree with each other but not with the public endpoint: still pending.
    const forged = JSON.parse(text(moved)); forged[REFS][0].origin = 'https://original.example'
    expect(vault.apply(forged, envelopes, current).pending).toEqual([{ slot: '/proxyKey', reason: 'origin' }])
    // Tablet moved the endpoint and re-sealed: same key value, new origin => a distinct secret version; old envelopes do not satisfy it.
    const next = vault.project({ forceReplaceUrl: 'https://different.example/v1', proxyKey: S('proxy') })
    expect(next.envelopes[0].version).not.toBe(envelopes[0].version)
    expect(vault.apply(next.public, envelopes, current).pending).toEqual([{ slot: '/proxyKey', reason: 'missing' }])
    expect(vault.apply(next.public, next.envelopes, current).value.forceReplaceUrl).toBe('https://different.example/v1')
    // Both endpoint variants coexist in one envelope set (retained divergent settings, history, recovery): each public record selects its own.
    const both = [...envelopes, ...next.envelopes]
    expect(vault.apply(pub, both, current).value).toEqual({ forceReplaceUrl: 'https://original.example/v1', proxyKey: S('proxy') })
    expect(vault.apply(next.public, both, current).value).toEqual({ forceReplaceUrl: 'https://different.example/v1', proxyKey: S('proxy') })
    expect(vault.apply(pub, [...next.envelopes, ...envelopes], current).applied).toBe(true)
    // Re-sealing the same value at the same endpoint keeps the reference stable (no false revision from a fresh nonce).
    const again = vault.project({ forceReplaceUrl: 'https://original.example/v1', proxyKey: S('proxy') })
    expect(again.public).toEqual(pub); expect(again.envelopes[0].data).not.toBe(envelopes[0].data)
    // Nested: model preset credentials follow the preset's own profile endpoint; URL credentials follow the URL host.
    const preset = { modelPresets: [{ id: 'mp', profileSnapshot: snapshot('https://a.example'), userValues: { apiKey: S('k') }, customHeaders: { Authorization: S('h') }, additionalParamsText: `header::X-Api-Key=${S('p')}` }], textgenWebUIStreamURL: 'https://u:' + S('pw') + '@host.example/?token=' + S('q') }
    const projected = vault.project(preset)
    const rehosted = JSON.parse(text(projected.public)); rehosted.modelPresets[0].profileSnapshot.endpoint.url = 'https://b.example'; rehosted.textgenWebUIStreamURL = 'https://other.example/?token='
    const result = vault.apply(rehosted, projected.envelopes, current)
    expect(result.value).toBe(current)
    expect(result.pending.map((p: any) => p.slot).sort()).toEqual(['/modelPresets/mp/additionalParamsText#header:X-Api-Key', '/modelPresets/mp/customHeaders/Authorization', '/modelPresets/mp/userValues/apiKey', '/textgenWebUIStreamURL#query:token', '/textgenWebUIStreamURL#userinfo'])
    expect(result.pending.every((p: any) => p.reason === 'origin')).toBe(true)
    expect(vault.apply(projected.public, projected.envelopes, current).value).toEqual(preset)
})

test('array rows resolve only through their declared identity; duplicates and unresolved schemas pause the projection', () => {
    const vault = createVault(master)
    const db = { botPresets: [{ id: '1', openAIKey: S('id-one') }, { name: 'no-id-at-0' }, { id: 'x', openAIKey: S('x') }] }
    expect(() => vault.project(db)).toThrow(expect.objectContaining({ code: 'VAULT_IDENTITY' })) // row index 1 collides with id '1'
    const ok = { botPresets: [{ name: 'first' }, { id: '1', openAIKey: S('id-one') }, { id: 'x', openAIKey: S('x') }] }
    const { public: pub, envelopes } = vault.project(ok)
    expect(pub[REFS].map((r: any) => r.slot)).toEqual(['/botPresets/1/openAIKey', '/botPresets/x/openAIKey'])
    // Reordered rows: identity still selects the right row.
    const reordered = { ...pub, botPresets: [pub.botPresets[2], pub.botPresets[1], pub.botPresets[0]] }
    const applied = vault.apply(reordered, envelopes, null)
    expect(applied.value.botPresets).toEqual([{ id: 'x', openAIKey: S('x') }, { id: '1', openAIKey: S('id-one') }, { name: 'first' }])
    expect(() => vault.project({ customModels: [{ id: 'dup', key: S('a') }, { id: 'dup', key: S('b') }] })).toThrow(/Ambiguous sync identity/)
    expect(vault.apply({ ...pub, botPresets: [pub.botPresets[0], pub.botPresets[1], { ...pub.botPresets[2], id: 'x' }, { id: 'x' }] }, envelopes, 'cur')).toMatchObject({ applied: false, pending: [{ slot: '*', reason: 'VAULT_IDENTITY' }], value: 'cur' })
    const noSchema = { modelPresets: [{ id: 'm', userValues: { apiKey: S('hidden') } }] }
    expect(() => vault.project(noSchema)).toThrow(expect.objectContaining({ code: 'VAULT_INVENTORY' }))
    expect(vault.project({ modelPresets: [{ id: 'm', profileSnapshot: { schema: [] } }] }).envelopes).toEqual([])
    expect(inventory({ customModels: [{ id: 'a', url: 'https://x.example/v1', key: '', params: 'header::Authorization=' }] }).map((e: any) => [e.slot, e.kind, e.origin]))
        .toEqual([['/customModels/a/key', 'field', 'https://x.example'], [null, 'params', 'https://x.example'], [null, 'url', 'https://x.example']])
})

test('URL userinfo, credential query values and header:: parameter lines are secrets; other text is left byte-identical', () => {
    expect(splitUrl('https://host.example/path?x=1')).toBeNull()
    expect(splitUrl('/relative?key=abc')).toBeNull()
    expect(splitUrl('ftp://u:p@host.example/')).toBeNull()
    expect(splitUrl('http://u:p@host.example/a?api_key=k&keep=1')).toEqual({ public: 'http://host.example/a?api_key=&keep=1', secrets: [{ kind: 'userinfo', value: 'u:p' }, { kind: 'query', param: 'api_key', value: 'k' }] })
    expect(splitParams('a=1\nheader::X-Title=t\nheader::Authorization={{none}}')).toBeNull()
    expect(splitParams('a=1\r\nheader::Authorization=Bearer z\nheader::x-api-key=q')).toEqual({ public: 'a=1\nheader::Authorization=\nheader::x-api-key=', secrets: [{ param: 'header:Authorization', value: 'Bearer z' }, { param: 'header:x-api-key', value: 'q' }] })
    // Body parameters are API credentials too (Codex review 03 addendum); {{none}} and non-credential keys stay as typed.
    expect(splitParams('# note=comment\ntemperature=0.2\n api_key = sk-' + S('body') + '\nauth=json::{"token":"' + S('json') + '"}\ntoken={{none}}'))
        .toEqual({ public: '# note=comment\ntemperature=0.2\n api_key =\nauth=\ntoken={{none}}', secrets: [{ param: 'body:api_key', value: ' sk-' + S('body') }, { param: 'body:auth', value: 'json::{"token":"' + S('json') + '"}' }] })
    const vault = createVault(master)
    const db = { ollamaURL: 'http://localhost:11434', customModels: [{ id: 'a', url: 'https://u:' + S('p') + '@h.example/v1?token=' + S('t'), key: '', name: 'n', params: `header::Authorization=${S('h')}\nx=1\napi_key=${S('body')}` }, { id: 'm', url: 'https://example.com', params: 'api_key=' + S('codex') }],
        pluginCustomStorage: { p: { apiKey: S('plugin-storage'), cache: [1, 2] }, q: 'raw-' + S('plugin-string'), r: 7, list: [{ apiKey: S('plugin-array') }], none: null, flag: false, empty: '' } }
    const { public: pub, envelopes } = vault.project(db)
    expect(text(pub)).not.toContain('SENTINEL'); expect(pub.ollamaURL).toBe('http://localhost:11434')
    expect(pub.customModels[1].params).toBe('api_key='); expect(pub.pluginCustomStorage).toEqual({ p: '', q: '', r: '', list: '', none: '', flag: '', empty: '' })
    expect(pub[REFS].map((r: any) => r.slot)).toEqual(['/customModels/a/params#body:api_key', '/customModels/a/params#header:Authorization', '/customModels/a/url#query:token', '/customModels/a/url#userinfo', '/customModels/m/params#body:api_key', '/pluginCustomStorage/flag', '/pluginCustomStorage/list', '/pluginCustomStorage/none', '/pluginCustomStorage/p', '/pluginCustomStorage/q', '/pluginCustomStorage/r'])
    expect(pub[REFS].filter((r: any) => r.slot.startsWith('/pluginCustomStorage/')).every((r: any) => r.kind === (r.slot.endsWith('/q') ? 'field' : 'json'))).toBe(true)
    expect(pub[REFS].find((r: any) => r.slot === '/customModels/m/params#body:api_key').origin).toBe('https://example.com')
    expect(vault.apply(pub, envelopes, null).value).toEqual(db)
    expect(() => vault.project({ customModels: [{ id: 'd', params: 'api_key=a\napi_key=b' }] })).toThrow(/Duplicate secret slot/)
})

test('vault master lives in its own device-protected file, serializes first use, and keeps a recovery copy on explicit replace', async t => {
    const root = await mkdtemp(join(tmpdir(), 'bard-sync-vault-'))
    t.onTestFinished(() => rm(root, { recursive: true, force: true }))
    const store = vaultMasterStore(root, androidProtector('11'.repeat(32)))
    const [a, b, c] = await Promise.all([store.load(), store.load(), store.load()])
    expect(a).toHaveLength(32); expect(a.equals(b) && b.equals(c)).toBe(true)
    expect(await readdir(root)).toEqual(['sync-vault-master.dat', 'sync-vault-master.dat.sha256']) // atomicWriteJson sidecar
    const saved = await readFile(join(root, 'sync-vault-master.dat'), 'utf8')
    expect(saved).not.toContain(a.toString('base64')); expect(saved).not.toContain(a.toString('hex'))
    expect((await vaultMasterStore(root, androidProtector('11'.repeat(32))).load()).equals(a)).toBe(true)
    await expect(vaultMasterStore(root, androidProtector('22'.repeat(32))).load()).rejects.toThrow()
    await expect(store.importMaster(otherMaster)).rejects.toThrow(/already installed/)
    await store.importMaster(a)
    expect((await readdir(root)).filter(f => f.includes('recovery'))).toEqual([])
    await store.importMaster(otherMaster, { replace: true })
    expect((await store.load()).equals(otherMaster)).toBe(true)
    const files = await readdir(root)
    expect(files.filter(f => /^sync-vault-master\.recovery-.*\.dat$/.test(f))).toHaveLength(1)
    const recovery = JSON.parse(await readFile(join(root, files.find(f => f.includes('recovery'))!), 'utf8'))
    expect((await androidProtector('11'.repeat(32))(Buffer.from(recovery.data, 'base64'), true)).equals(a)).toBe(true) // previous key stays recoverable
    await expect(store.importMaster(Buffer.alloc(16))).rejects.toThrow(/32 bytes/)
    expect(() => createVault(Buffer.alloc(16))).toThrow(/32 bytes/)
    expect(createVault(a).epoch).not.toBe(createVault(otherMaster).epoch)
})

test('model preset credentials bind to the effective request endpoint and cover defaults, templates, body and orphans (Codex review 02)', () => {
    const vault = createVault(master), current = { working: true }
    const overrideSchema = [...schema, { key: 'endpointUrl', type: 'string', label: 'e', mapsTo: { target: 'custom', path: 'endpointUrl' } }, { key: 'authHeader', type: 'string', label: 'h', mapsTo: { target: 'header', path: 'x-api-key' } }, { key: 'googleKey', type: 'string', label: 'g', mapsTo: { target: 'query', path: 'key' } }]
    const db = { modelPresets: [{ id: 'p', profileSnapshot: { ...snapshot('https://static.example/v1'), schema: overrideSchema, defaults: { apiKey: S('default-key'), temperature: 1, client_secret: S('default-secret') }, headerTemplate: { Authorization: 'Bearer ' + S('template'), 'X-Title': 'public' }, bodyTemplate: { api_key: S('body-template'), stream: true } },
        userValues: { endpointUrl: 'https://u:' + S('override-user') + '@override.example/v1?key=' + S('override-query'), authHeader: S('header-mapped'), googleKey: S('query-mapped'), temperature: 0.5 },
        orphanValues: { oldApiKey: S('orphan'), legacyObject: { token: S('orphan-object') }, count: 2, history: [S('orphan-array')] }, customBody: { api_token: S('custom-body'), model: 'public' } }] }
    const { public: pub, envelopes } = vault.project(db)
    expect(text(pub)).not.toContain('SENTINEL')
    const slots = pub[REFS].map((r: any) => r.slot)
    expect(slots).toEqual(['/modelPresets/p/customBody/api_token', '/modelPresets/p/orphanValues/count', '/modelPresets/p/orphanValues/history', '/modelPresets/p/orphanValues/legacyObject', '/modelPresets/p/orphanValues/oldApiKey', '/modelPresets/p/profileSnapshot/bodyTemplate/api_key',
        '/modelPresets/p/profileSnapshot/defaults/apiKey', '/modelPresets/p/profileSnapshot/defaults/client_secret', '/modelPresets/p/profileSnapshot/headerTemplate/Authorization',
        '/modelPresets/p/userValues/authHeader', '/modelPresets/p/userValues/endpointUrl#query:key', '/modelPresets/p/userValues/endpointUrl#userinfo', '/modelPresets/p/userValues/googleKey'])
    expect(pub.modelPresets[0].orphanValues).toEqual({ oldApiKey: '', legacyObject: '', count: '', history: '' })
    expect(pub.modelPresets[0].userValues.endpointUrl).toBe('https://override.example/v1?key=')
    // Effective endpoint is the schema override, not the unchanged static snapshot url.
    expect(pub[REFS].every((r: any) => r.origin === 'https://override.example')).toBe(true)
    expect(vault.apply(pub, envelopes, current).value).toEqual(db)
    const rehosted = JSON.parse(text(pub)); rehosted.modelPresets[0].userValues.endpointUrl = 'https://attacker.example/v1?key='
    const result = vault.apply(rehosted, envelopes, current)
    expect(result.value).toBe(current); expect(result.pending).toHaveLength(slots.length); expect(result.pending.every((p: any) => p.reason === 'origin')).toBe(true)
    // Removing the override falls back to the static url: still a different destination, still pending.
    const fallback = JSON.parse(text(pub)); delete fallback.modelPresets[0].userValues.endpointUrl
    expect(vault.apply(fallback, envelopes, current).applied).toBe(false)
    // Without an override the static url is the binding, and changing only the static url is rejected too.
    const plain = { modelPresets: [{ id: 'q', profileSnapshot: snapshot('https://static.example/v1'), userValues: { apiKey: S('k') } }] }
    const projected = vault.project(plain)
    expect(projected.public[REFS][0].origin).toBe('https://static.example')
    const movedStatic = JSON.parse(text(projected.public)); movedStatic.modelPresets[0].profileSnapshot.endpoint.url = 'https://elsewhere.example/v1'
    expect(vault.apply(movedStatic, projected.envelopes, current).pending).toEqual([{ slot: '/modelPresets/q/userValues/apiKey', reason: 'origin' }])
    // Vertex: the host comes from the location field; the project (path only) needs no service-account secret to bind.
    const vertex = { modelPresets: [{ id: 'v', profileSnapshot: { ...snapshot(''), endpoint: { kind: 'vertex-gemini' }, schema: [{ key: 'location', type: 'string', label: 'l', mapsTo: { target: 'custom', path: 'location' } }, { key: 'serviceAccountJson', type: 'string', label: 's', secret: true, mapsTo: { target: 'auth', path: 'apiKey' } }] }, userValues: { location: 'asia-northeast3', serviceAccountJson: JSON.stringify({ project_id: 'proj', private_key: S('sa') }) } }] }
    const v = vault.project(vertex)
    expect(text(v.public)).not.toContain('SENTINEL'); expect(v.public[REFS][0].origin).toBe('https://asia-northeast3-aiplatform.googleapis.com')
    expect(vault.apply(v.public, v.envelopes, current).value).toEqual(vertex)
    const relocated = JSON.parse(text(v.public)); relocated.modelPresets[0].userValues.location = 'us-central1'
    expect(vault.apply(relocated, v.envelopes, current).pending).toEqual([{ slot: '/modelPresets/v/userValues/serviceAccountJson', reason: 'origin' }])
    // Unresolvable endpoint (unsupported kind) binds to the slot itself and still round-trips.
    const odd = { modelPresets: [{ id: 'o', profileSnapshot: { ...snapshot(''), endpoint: { kind: 'future' } }, userValues: { apiKey: S('odd') } }] }
    const o = vault.project(odd)
    expect(o.public[REFS][0].origin).toBe('/modelPresets/o/userValues/apiKey'); expect(vault.apply(o.public, o.envelopes, current).value).toEqual(odd)
})

test('declared opaque slots seal every JSON shape and round-trip arrays, primitives and null exactly', () => {
    const vault = createVault(master)
    const db = { pluginCustomStorage: { p: [{ apiKey: S('array-entry') }], nested: [[S('deep')], { k: [null, 1.5, true] }], n: null, b: false, z: 0, e: '', o: {}, a: [] } }
    const { public: pub, envelopes } = vault.project(db)
    expect(text(pub)).not.toContain('SENTINEL')
    expect(pub.pluginCustomStorage).toEqual({ p: '', nested: '', n: '', b: '', z: '', e: '', o: '', a: '' })
    expect(envelopes.map((e: any) => e.slot)).toEqual(['/pluginCustomStorage/p', '/pluginCustomStorage/nested', '/pluginCustomStorage/n', '/pluginCustomStorage/b', '/pluginCustomStorage/z', '/pluginCustomStorage/o', '/pluginCustomStorage/a'])
    const applied = vault.apply(pub, envelopes, null)
    expect(applied.applied).toBe(true); expect(applied.value).toEqual(db)
    expect(applied.value.pluginCustomStorage.n).toBeNull(); expect(applied.value.pluginCustomStorage.z).toBe(0); expect(Array.isArray(applied.value.pluginCustomStorage.a)).toBe(true)
    // Same shapes on another device produce identical public references.
    expect(createVault(master).project(db).public).toEqual(pub)
})
