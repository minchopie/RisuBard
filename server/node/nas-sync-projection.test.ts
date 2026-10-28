import { test, expect } from 'vitest'
import { readFile, mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createMemorySaveSlot, memorySaveWorkspaceId } from './risubard-memory-save'
import { encodeMemorySaveChat } from '../../src/ts/risubard/memorySaveCodec'
const { SETTINGS_GROUPS, DEVICE_LOCAL, COLLECTIONS, MIRROR, THEME_PRESET_LOCAL, syncedThemePresets, ownerOf, collectReferences, projectDatabase, diffProjection, rootKeyOf, envelopeIdentity } = require('./nas-sync-projection.cjs')
const { createVault } = require('./nas-sync-vault.cjs')
const { createGraph } = require('./nas-sync-core.cjs')
const { createRuntimeMemoryService } = require('./risubard-memory-runtime.cjs')
const { playSetMemoryMaterials } = require('./play-set-memory.cjs')

const S = (n: string) => `SENTINEL-${n}-never-leaves-vault`
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')
const master = Buffer.from('ab'.repeat(32), 'hex')
const text = (v: unknown) => JSON.stringify(v)
async function temp(t: any) { const root = await mkdtemp(join(tmpdir(), 'bard-sync-proj-')); t.onTestFinished(() => rm(root, { recursive: true, force: true })); return root }

/** Every key of the real `Database` interface is owned exactly once: a group, device-local, a collection, or its own independent root. */
test('ownership is disjoint and total over the real Database interface; the preset mirror has one owner', async () => {
    const source = await readFile(resolve(__dirname, '../../src/ts/storage/database.svelte.ts'), 'utf8')
    const body = source.slice(source.indexOf('export interface Database{'))
    const keys = [...body.slice(0, body.indexOf('\n}')).matchAll(/^    ([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map(m => m[1])
    expect(keys.length).toBeGreaterThan(300)
    const owners = new Map<string, string>()
    for (const [groupName, groupKeys] of Object.entries(SETTINGS_GROUPS) as [string, string[]][]) for (const key of groupKeys) { expect(owners.has(key), `${key} owned twice`).toBe(false); owners.set(key, groupName) }
    for (const key of DEVICE_LOCAL) expect(owners.has(key), `${key} grouped and local`).toBe(false)
    for (const key of Object.keys(COLLECTIONS)) expect(owners.has(key) || DEVICE_LOCAL.has(key)).toBe(false)
    for (const key of ['ooba', 'ainconfig', 'promptTemplate', 'customFlags', 'NAIadventure', 'outputImageModal', 'seperateParameters', 'memoryAlgorithmType']) expect(ownerOf(key)).toBe('settings:prompt-presets')
    for (const key of MIRROR) expect(ownerOf(key)).toBe('settings:prompt-presets')
    const classified = keys.map(key => [key, ownerOf(key)])
    expect(classified.filter(([, o]) => o === 'local').length).toBeGreaterThan(50)
    expect(classified.filter(([, o]) => o === 'collection').map(([k]) => k).sort()).toEqual(['characters', 'modules', 'plugins'])
    // Listed owners must be real keys (typo guard): every grouped/local key appears in the interface or is a known mirror/dynamic key.
    // Legacy keys: removed from the Database interface upstream (v0.9.76 dropped the Bard-chan toggles) but still owned, so values
    // v0.9.81 also removed personaNote. Values already stored on devices keep syncing instead of becoming unowned optional keys. Documented here; never silently widened.
    const LEGACY_OWNED = ['risuBardBardChanEnabled', 'risuBardBardChanModelMode', 'personaNote']
    for (const key of LEGACY_OWNED) expect(ownerOf(key), `${key} must stay owned by a settings group`).toMatch(/^settings:/)
    // mobileMessageActionsInline: upstream v0.9.84 display toggle, declared device-local ahead of that Database interface
    // so the fork assembled on an older upstream never publishes it as an unknown settings root.
    const known = new Set([...keys, ...MIRROR, ...LEGACY_OWNED, 'risuPlaySets', 'formatversion', 'personaEnabledModules', 'hypaV3Settings', 'pluginDevelopMode', 'mobileMessageActionsInline'])
    const stale = [...Object.values(SETTINGS_GROUPS).flat(), ...DEVICE_LOCAL].filter(k => !known.has(k))
    expect(stale).toEqual([])
    expect(ownerOf('nodeOnlyModelModeLock')).toBe('settings:model-presets'); expect(ownerOf('nodeOnlyScrollButtonType')).toBe('local')
    expect(ownerOf('someFutureOptionalKey')).toBe('settings:someFutureOptionalKey') // unknown optional keys are preserved, never dropped
})

test('mobileMessageActionsInline (upstream v0.9.84 message-toolbar toggle) is device-local: flipping it changes no projected root', async t => {
    const f = await fixture(t), vault = createVault(master)
    const run = async (db: any) => projectDatabase({ database: db, vault, captures: new Map([['card', f.capture]]), materials: playSetMemoryMaterials, ...f.readers })
    expect(ownerOf('mobileMessageActionsInline')).toBe('local')
    const base = await run(f.database())
    const graph = createGraph(), initial = diffProjection(graph, base.desired); graph.addAll(initial.revisions)
    const lineage = Object.fromEntries(base.desired.map((d: any, i: number) => [d.lineageKey, initial.revisions[i].id]))
    const flipped: any = f.database(); flipped.mobileMessageActionsInline = true
    const projected = await run(flipped)
    expect(diffProjection(graph, projected.desired, lineage)).toMatchObject({ revisions: [], diverged: [] })
    expect(projected.desired.some((d: any) => text(d.content).includes('mobileMessageActionsInline'))).toBe(false)
})

test('collectReferences follows the manual snapshot rules for assets, inlays and painter pointers', () => {
    const refs = collectReferences({ image: 'assets/icon.png', note: 'see assets/bg.webp and https://cdn.example/assets/remote.png', message: [{ data: '{{inlay::draw1}} {{inlayed::draw2}}' }], bardPainter: { results: [{ assetId: 'paint1' }], settings: { context: { referenceAssetId: 'ref1' } } }, emotionImages: [['joy', 'assets/joy.png']] }, 'chat')
    expect([...refs.assets].sort()).toEqual(['assets/bg.webp', 'assets/icon.png', 'assets/joy.png'])
    expect([...refs.inlays].sort()).toEqual(['draw1', 'draw2', 'paint1', 'ref1'])
    expect([...collectReferences('plain text with assets/in-text.png', 'chat').assets]).toEqual(['assets/in-text.png'])
})

async function fixture(t: any) {
    const root = await temp(t), data = join(root, 'data'), tmp = join(root, 'tmp'); await mkdir(data); await mkdir(tmp)
    const memory = createRuntimeMemoryService(data)
    await memory.saveMarkdownWikiTurn({ characterId: 'card', chatId: 'chat', sourceMessageIds: ['m1'], markdown: '## 사건\n\n위키 전용 그림 {{inlay::wiki-only}} 과 assets/wiki-only.png' })
    const slotChat = { id: 'chat', name: '슬롯', note: '', localLore: [], scriptstate: { day: 3 }, message: [{ role: 'char', data: '슬롯 전용 그림 {{inlay::slot-only}}', promptInfo: { promptText: 'private request' } }] }
    await createMemorySaveSlot({ userDataDirectory: data, characterId: 'card', sourceChatId: 'chat', saveId: 'slot', sourceChatName: '슬롯', turnCount: 1, chatBytes: encodeMemorySaveChat(slotChat as any) })
    const capture = await memory.capturePlaySetMemory({ characterId: 'card', chatIds: ['chat'], temporaryDirectory: tmp })
    const assets: Record<string, Buffer> = { 'assets/icon.png': Buffer.from('icon-bytes'), 'assets/persona.png': Buffer.from('persona-bytes'), 'assets/wiki-only.png': Buffer.from('wiki-bytes'), 'assets/local-alias-target.png': Buffer.from('alias-target') }
    const assetFiles: Record<string, string> = {}
    for (const [key, bytes] of Object.entries(assets)) { const file = join(root, key.replace('/', '_')); await writeFile(file, bytes); assetFiles[key] = file }
    const inlays: Record<string, { metadata: any; data: Buffer | string }> = { draw1: { metadata: { type: 'image', ext: 'png', name: '그림' }, data: Buffer.from('inlay-draw1') }, 'slot-only': { metadata: { type: 'image', ext: 'png' }, data: Buffer.from('inlay-slot') }, 'wiki-only': { metadata: { type: 'image', ext: 'png' }, data: Buffer.from('inlay-wiki') }, 'actual-inlay': { metadata: { type: 'image', ext: 'png' }, data: Buffer.from('inlay-actual') } }
    const database = () => ({
        openAIKey: S('openai'), proxyKey: S('proxy'), forceReplaceUrl: 'https://proxy.example/v1', aiModel: 'gpt', mainPrompt: '프롬프트', ooba: { temp: 1 }, botPresets: [{ id: 'p1', name: '프리셋', openAIKey: S('preset') }], botPresetsId: 0,
        personas: [{ id: 'me', name: '나', icon: 'assets/persona.png', personaPrompt: '설명' }], selectedPersona: 0, userIcon: '',
        hordeConfig: { apiKey: S('horde'), model: 'm' }, language: 'ko', textAreaSize: 12, account: { token: S('account'), id: 'me', data: {} }, risuPlaySets: { generations: [] },
        modules: [{ id: 'mod', name: '모듈', assets: [['bg', 'assets/icon.png', 'png']] }], enabledModules: ['mod'],
        plugins: [{ name: 'plug', script: '', arguments: {}, realArg: { api_key: S('plugin') }, enabled: true, customLink: [], argMeta: {} }],
        futureOptional: { keep: true },
        characters: [{ chaId: 'card', type: 'character', name: '표본', image: 'assets/icon.png', chatPage: 1, viewScreen: 'x', lastInteraction: 5, oaiTTSConfig: { apiKey: S('tts'), baseURL: 'https://tts.example' },
            chats: [{ id: 'chat', name: '현재', note: '', localLore: [], scriptstate: { day: 7 }, message: [{ role: 'char', data: '본문 {{inlay::draw1}} {{inlay::alias-inlay}} assets/alias.png', promptInfo: { promptText: 'private' } }],
                risuTransferMedia: { assets: { 'assets/alias.png': 'assets/local-alias-target.png' }, inlays: { 'alias-inlay': 'actual-inlay' } }, activeStreamingDisplayOptimizationMode: 'x' }] }],
    })
    const readers = { readAsset: async (path: string) => assetFiles[path] ? { path: assetFiles[path], hash: sha(assets[path]) } : null, readInlay: async (id: string) => inlays[id] ?? null, inlayMeta: async (id: string) => ({ createdAt: 1, updatedAt: 2, charId: 'card', chatId: 'chat' }) }
    return { root, data, memory, capture, database, readers, assets, inlays, slotChat }
}

test('projection: secrets leave only as per-slot envelopes, media from chat/slot/Wiki/persona/alias scope becomes dependencies, local fields stay out', async t => {
    const f = await fixture(t), vault = createVault(master)
    const result = await projectDatabase({ database: f.database(), vault, captures: new Map([['card', f.capture]]), materials: playSetMemoryMaterials, ...f.readers })
    expect(result.missing).toEqual([])
    const all = text(result.desired) + text([...result.blobs.values()].map(b => b.bytes?.toString('utf8') ?? ''))
    expect(all).not.toContain('SENTINEL'); expect(all).not.toContain('private request'); expect(all).not.toContain('private"')
    const byKey = new Map(result.desired.map((d: any) => [d.key, d]))
    const chat = byKey.get(rootKeyOf('play', 'chat', 'chat'))
    expect(chat.content.scriptstate).toEqual({ day: 7 }); expect(chat.content.activeStreamingDisplayOptimizationMode).toBeUndefined()
    expect(chat.content.risuTransferMedia).toEqual({ assets: { 'assets/alias.png': 'assets/local-alias-target.png' }, inlays: { 'alias-inlay': 'actual-inlay' } }) // alias tables travel with the chat
    expect(Object.keys(chat.dependencies).sort()).toEqual(expect.arrayContaining(['inlay:draw1', 'inlay-metadata:draw1', 'inlay:actual-inlay', 'asset:assets/local-alias-target.png', 'inlay:slot-only', 'inlay:wiki-only', 'asset:assets/wiki-only.png', 'slot:slot:chat.bin', 'slot:slot:risubard-save.json']))
    expect(Object.keys(chat.dependencies).some(k => k.startsWith('bard:') && k.endsWith('.md'))).toBe(true)
    expect(result.blobs.get(chat.dependencies['inlay:slot-only']).bytes).toEqual(Buffer.from('inlay-slot'))
    expect(JSON.parse(result.blobs.get(chat.dependencies['inlay-metadata:draw1']).bytes.toString())).toEqual({ metadata: { type: 'image', ext: 'png', name: '그림' }, ownership: { createdAt: 1, updatedAt: 2, charId: 'card', chatId: 'chat' } })
    const character = byKey.get(rootKeyOf('library', 'character', 'card'))
    expect(character.content).not.toHaveProperty('chats'); expect(character.content).not.toHaveProperty('chatPage'); expect(character.content).not.toHaveProperty('lastInteraction')
    expect(character.content.chatIds).toEqual(['chat']); expect(character.content.oaiTTSConfig.apiKey).toBe('')
    expect(character.dependencies).toEqual({ 'asset:assets/icon.png': sha(f.assets['assets/icon.png']), ['envelope:/characters/card/oaiTTSConfig/apiKey']: expect.stringMatching(/^[a-f0-9]{64}$/) })
    expect(result.envelopes.get(character.dependencies['envelope:/characters/card/oaiTTSConfig/apiKey'])).toMatch(/^[a-f0-9]{64}$/)
    const personas = byKey.get(rootKeyOf('settings', 'group', 'personas'))
    expect(personas.dependencies).toEqual({ 'asset:assets/persona.png': sha(f.assets['assets/persona.png']) }) // persona-only image
    const provider = byKey.get(rootKeyOf('settings', 'group', 'provider-main'))
    expect(provider.content).toMatchObject({ openAIKey: '', proxyKey: '', aiModel: 'gpt' }); expect(provider.content).not.toHaveProperty('ooba')
    expect(Object.keys(provider.dependencies).sort()).toEqual(['envelope:/openAIKey', 'envelope:/proxyKey'])
    expect(byKey.get(rootKeyOf('settings', 'group', 'prompt-presets')).content).toMatchObject({ ooba: { temp: 1 }, mainPrompt: '프롬프트', botPresetsId: 0 })
    expect(byKey.get(rootKeyOf('settings', 'group', 'activation')).content).toEqual({ enabledModules: ['mod'], pluginEnabled: { plug: true } })
    expect(byKey.get(rootKeyOf('library', 'plugin', 'plug')).content).not.toHaveProperty('enabled')
    expect(byKey.get(rootKeyOf('library', 'module', 'mod')).dependencies).toEqual({ 'asset:assets/icon.png': sha(f.assets['assets/icon.png']) })
    expect(byKey.get(rootKeyOf('settings', 'group', 'futureOptional')).content).toEqual({ futureOptional: { keep: true } })
    expect(byKey.has(rootKeyOf('settings', 'group', 'textAreaSize'))).toBe(false); expect(byKey.has(rootKeyOf('settings', 'group', 'account'))).toBe(false)
    const envelopes = [...result.blobs.values()].filter(b => b.label === 'vault-envelope').map(b => JSON.parse(b.bytes.toString()))
    expect(envelopes.map(e => e.slot).sort()).toEqual(['/botPresets/p1/openAIKey', '/characters/card/oaiTTSConfig/apiKey', '/hordeConfig/apiKey', '/openAIKey', '/plugins/plug/realArg/api_key', '/proxyKey'])
    expect(vault.open(envelopes.find(e => e.slot === '/openAIKey'))).toBe(S('openai'))
})

test('semantic secret identity: two independently initialized devices with the same DB and master converge; ciphertext never enters revision identity (Codex 11)', async t => {
    const f = await fixture(t)
    const deviceA = createVault(master), deviceB = createVault(master) // separate installs, separate nonces, no shared cache
    const run = async (vault: any, db = f.database()) => projectDatabase({ database: db, vault, captures: new Map([['card', f.capture]]), materials: playSetMemoryMaterials, ...f.readers })
    const a = await run(deviceA), b = await run(deviceB)
    const identity = (r: any) => r.desired.map((d: any) => [d.lineageKey, d.contentHash, d.dependencyHash]).sort()
    expect(identity(a)).toEqual(identity(b))
    const provider = (r: any) => r.desired.find((d: any) => d.key === rootKeyOf('settings', 'group', 'provider-main'))
    expect(provider(a).dependencies).toEqual(provider(b).dependencies)
    const semantic = provider(a).dependencies['envelope:/openAIKey']
    expect(semantic).toMatch(/^[a-f0-9]{64}$/)
    // Physical ciphertexts differ per device/run and are transported through the mapping, not through revision dependencies.
    expect(a.envelopes.get(semantic)).not.toBe(b.envelopes.get(semantic))
    expect([...a.blobs.values()].some(x => x.label === 'vault-envelope' && sha(x.bytes) === a.envelopes.get(semantic))).toBe(true)
    const envelope = JSON.parse(a.blobs.get(a.envelopes.get(semantic)).bytes.toString())
    expect(envelopeIdentity(envelope)).toBe(semantic); expect(deviceB.open(envelope)).toBe(S('openai')) // B can validate A's ciphertext with the shared master
    expect(text([...a.blobs.values()].filter(x => x.label === 'vault-envelope'))).not.toContain('SENTINEL')
    // Same device twice, and after a restart (new vault instance): zero revisions.
    const graph = createGraph(), initial = diffProjection(graph, a.desired); graph.addAll(initial.revisions)
    const lineage = Object.fromEntries(a.desired.map((d: any, i: number) => [d.lineageKey, initial.revisions[i].id]))
    expect(diffProjection(graph, (await run(deviceA)).desired, lineage)).toMatchObject({ revisions: [], diverged: [] })
    expect(diffProjection(graph, (await run(createVault(master))).desired, lineage)).toMatchObject({ revisions: [], diverged: [] })
    expect(diffProjection(graph, b.desired, lineage)).toMatchObject({ revisions: [], diverged: [] }) // B's projection is identical to A's
    // One rotated secret changes exactly its group; another master (unknown epoch) changes every credential root but nothing else.
    const changed = f.database(); changed.hordeConfig.apiKey = S('horde-rotated')
    expect(diffProjection(graph, (await run(deviceA, changed)).desired, lineage).revisions.map((r: any) => r.root)).toEqual(['horde'])
    const foreign = diffProjection(graph, (await run(createVault(Buffer.from('cd'.repeat(32), 'hex')))).desired, lineage)
    expect(foreign.revisions.map((r: any) => r.root).sort()).toEqual(['card', 'chat', 'horde', 'plug', 'prompt-presets', 'provider-main'].sort()) // every credential-bearing root plus the chat pinned to that provider identity; activation has no secrets
})

test('busy or unhydrated chats make the projection fail instead of being sanitized into a complete snapshot', async t => {
    const f = await fixture(t), vault = createVault(master)
    for (const [field, code] of [['isStreaming', 'CHAT_BUSY'], ['risuBardWikiReboot', 'CHAT_BUSY'], ['risuPlayContext', 'CHAT_BUSY'], ['_stub', 'CHAT_NOT_HYDRATED'], ['_placeholder', 'CHAT_NOT_HYDRATED']] as const) {
        const db = f.database(); (db.characters[0].chats[0] as any)[field] = field === 'risuPlayContext' ? { context: {} } : true
        await expect(projectDatabase({ database: db, vault, ...f.readers })).rejects.toThrow(expect.objectContaining({ code }))
    }
    const cold = f.database(); cold.characters[0].chats[0].message = [{ role: 'char', data: 'COLDSTORAGEkey' } as any]
    await expect(projectDatabase({ database: cold, vault, ...f.readers })).rejects.toThrow(expect.objectContaining({ code: 'CHAT_NOT_HYDRATED' }))
    const missing = await projectDatabase({ database: f.database(), vault, readAsset: async () => null, readInlay: async () => null })
    expect(missing.missing.map((m: any) => m.reason).sort()).toEqual(expect.arrayContaining(['Missing asset: assets/icon.png', 'Missing inlay: actual-inlay', 'Missing inlay: draw1']))
})

test('cold storage projects the same chat without mutating saved data or timestamps', async t => {
    const f = await fixture(t), vault = createVault(master), original = f.database()
    const normal = await projectDatabase({ database: original, vault, ...f.readers })
    const archived = structuredClone(original), chat = archived.characters[0].chats[0]
    const full = structuredClone(chat)
    chat.message = [{ role: 'char', data: '\uEF01COLDSTORAGE\uEF01key' }] as any
    chat.scriptstate = { day: 0 }
    const before = JSON.stringify(archived)
    const restored = await projectDatabase({ database: archived, vault, ...f.readers, readColdChat: async (key: string) => { expect(key).toBe('key'); return full } })
    expect(restored.desired).toEqual(normal.desired)
    expect(JSON.stringify(archived)).toBe(before)
    const legacy = structuredClone(original); legacy.characters[0].chats[0].message = chat.message
    expect((await projectDatabase({ database: legacy, vault, ...f.readers, readColdChat: async () => full.message })).desired).toEqual(normal.desired)
    expect((await projectDatabase({ database: legacy, vault, ...f.readers, readColdChat: async () => ({ message: full.message, scriptstate: null, localLore: null }) })).desired).toEqual(normal.desired)
    for (const cold of [null, {}, { message: chat.message }, { message: [null] }, { message: [{}] }, { _stub: true, message: full.message }])
        await expect(projectDatabase({ database: archived, vault, ...f.readers, readColdChat: async () => cold })).rejects.toMatchObject({ code: 'CHAT_NOT_HYDRATED', characterId: 'card', chatId: 'chat' })
    archived.characters[0].chats[0].message.push({ role: 'char', data: 'keep me' } as any)
    await expect(projectDatabase({ database: archived, vault, ...f.readers, readColdChat: async () => full })).rejects.toMatchObject({ code: 'CHAT_NOT_HYDRATED' })
})

test('diffProjection continues each item lineage: equal head skips, linear edit, sibling branch keeps its root, diverged without lineage is reported', async t => {
    const f = await fixture(t), vault = createVault(master), graph = createGraph()
    const db = f.database()
    const base = await projectDatabase({ database: db, vault, ...f.readers })
    const first = diffProjection(graph, base.desired); graph.addAll(first.revisions)
    const lineage: Record<string, string> = Object.fromEntries(base.desired.map((d: any, i: number) => [d.lineageKey, first.revisions[i].id]))
    const chatKey = rootKeyOf('play', 'chat', 'chat')
    // Linear edit from the known lineage head.
    db.characters[0].chats[0].message.push({ role: 'user', data: '둘째' } as any)
    const edited = diffProjection(graph, (await projectDatabase({ database: db, vault, ...f.readers })).desired, lineage)
    expect(edited.revisions.map((r: any) => r.key ?? r.root)).toEqual(['chat'])
    expect(edited.revisions[0].parents).toEqual([lineage[chatKey + '#chat']]); graph.addAll(edited.revisions); lineage[chatKey + '#chat'] = edited.revisions[0].id
    // A sibling branch chat (materialized from another device's concurrent head) projects onto the same root with its own lineage.
    const other = first.revisions.find((r: any) => r.root === 'chat').id // the other device branched from the genesis head, concurrently with the edit above
    db.characters[0].chats.push({ ...db.characters[0].chats[0], id: 'chat~ab12cd34', message: [{ role: 'char', data: '다른 기기 가지' }] } as any)
    const branched = await projectDatabase({ database: db, vault, branches: { 'chat~ab12cd34': { root: 'chat', segment: 'ab12cd34' } }, ...f.readers })
    const sibling = branched.desired.find((d: any) => d.lineageKey === chatKey + '#chat~ab12cd34')
    expect(sibling.key).toBe(chatKey); expect(sibling.content.id).toBe('chat')
    expect(branched.desired.find((d: any) => d.key === rootKeyOf('library', 'character', 'card')).content.chatIds).toEqual(['chat']) // membership is per root: a sibling branch adds no member
    const result = diffProjection(graph, branched.desired, { ...lineage, [chatKey + '#chat~ab12cd34']: other })
    expect(result.revisions.filter((r: any) => r.root === 'chat')).toHaveLength(1) // only the sibling changed; it continues its own base
    expect(result.revisions.find((r: any) => r.root === 'chat').parents).toEqual([other])
    // Without a lineage entry on a diverged root nothing is guessed.
    graph.addAll(result.revisions)
    const blind = diffProjection(graph, branched.desired, {})
    expect(blind.diverged).toEqual(expect.arrayContaining([chatKey + '#chat', chatKey + '#chat~ab12cd34']))
})

test('dependency pins follow runtime semantics and carry stable secret refs: same preset id with another key is a different pin, ciphertext never matters', async t => {
    const f = await fixture(t), vault = createVault(master)
    const { pinsFor } = require('./nas-sync-projection.cjs')
    const pub = (db: any) => vault.project(db).public
    const base = f.database(), rotated = f.database(); rotated.botPresets[0].openAIKey = S('preset-rotated')
    const chatOf = (db: any) => db.characters[0].chats[0], charOf = (db: any) => db.characters[0]
    const a = pinsFor(pub(base), charOf(pub(base)), chatOf(pub(base))), b = pinsFor(pub(rotated), charOf(pub(rotated)), chatOf(pub(rotated)))
    expect(a['pin:preset:active']).not.toBe(b['pin:preset:active'])
    expect(a['pin:character:card']).toBe(b['pin:character:card']); expect(a['pin:provider-main']).toBe(b['pin:provider-main'])
    expect(pinsFor(pub(base), charOf(pub(base)), chatOf(pub(base)))).toEqual(a) // fresh ciphertext, identical pins
    const ttsRotated = f.database(); ttsRotated.characters[0].oaiTTSConfig.apiKey = S('tts-rotated')
    expect(pinsFor(pub(ttsRotated), charOf(pub(ttsRotated)), chatOf(pub(ttsRotated)))['pin:character:card']).not.toBe(a['pin:character:card'])
    // Regime: lock 'none' reads only the chat's own choice; the new-chat default is never consulted (modelPresetBinding.ts parity).
    const legacy = f.database(); legacy.useModelPresetByDefault = true
    expect(Object.keys(pinsFor(pub(legacy), charOf(pub(legacy)), chatOf(pub(legacy))))).toContain('pin:provider-main')
    const own = f.database(); own.characters[0].chats[0].useModelPreset = true; own.characters[0].chats[0].modelBinding = { main: 'mp-main', separateAux: false, aux: {} }; own.modelPresets = [{ id: 'mp-main', name: 'm', profileSnapshot: { schema: [], auth: { fields: [] }, endpoint: { kind: 'static', url: 'https://m.example' } }, userValues: {} }]
    const ownPins = pinsFor(pub(own), charOf(pub(own)), chatOf(pub(own)))
    expect(Object.keys(ownPins)).toContain('pin:model-preset:mp-main'); expect(Object.keys(ownPins)).not.toContain('pin:provider-main')
    // Under the preset lock a chat without a bundle falls back to the global default bundle; 'none' has no fallback.
    const locked = f.database(); locked.nodeOnlyModelModeLock = 'preset'; locked.defaultModelBinding = { main: 'mp-default', separateAux: false, aux: {} }; locked.modelPresets = [{ id: 'mp-default', name: 'd', profileSnapshot: { schema: [], auth: { fields: [] }, endpoint: { kind: 'static', url: 'https://d.example' } }, userValues: {} }]
    expect(Object.keys(pinsFor(pub(locked), charOf(pub(locked)), chatOf(pub(locked))))).toContain('pin:model-preset:mp-default')
    const none = f.database(); none.defaultModelBinding = locked.defaultModelBinding; none.modelPresets = locked.modelPresets; none.characters[0].chats[0].useModelPreset = true
    expect(Object.keys(pinsFor(pub(none), charOf(pub(none)), chatOf(pub(none))))).not.toContain('pin:model-preset:mp-default')
    // Module override wins regardless of regime once its master switch is on; globally enabled modules are pinned for every chat.
    const override = f.database(); override.moduleModelBindingsEnabled = true; override.moduleModelBindings = { mod: 'mp-mod' }; override.modelPresets = [{ id: 'mp-mod', name: 'o', profileSnapshot: { schema: [], auth: { fields: [] }, endpoint: { kind: 'static', url: 'https://o.example' } }, userValues: {} }]
    const o = pinsFor(pub(override), charOf(pub(override)), chatOf(pub(override)))
    expect(Object.keys(o)).toEqual(expect.arrayContaining(['pin:module:mod', 'pin:model-preset:mp-mod', 'pin:activation', 'pin:plugin:plug', 'pin:persona:me']))
})

test('diffProjection restore mode: recorded bases or genesis, never the current frontier; a base behind the frontier is re-published as a restored revision; a deleted root is un-deleted; equal heads are matched', async t => {
    const f = await fixture(t), vault = createVault(master), graph = createGraph()
    const db = f.database()
    const first = diffProjection(graph, (await projectDatabase({ database: db, vault, ...f.readers })).desired); graph.addAll(first.revisions)
    const chatKey = rootKeyOf('play', 'chat', 'chat'), genesis = first.revisions.find((r: any) => r.root === 'chat').id
    const backup = structuredClone(db)
    db.characters[0].chats[0].message.push({ role: 'user', data: 'B' } as any)
    const b = diffProjection(graph, (await projectDatabase({ database: db, vault, ...f.readers })).desired, { [chatKey + '#chat']: genesis }); graph.addAll(b.revisions)
    const bHead = b.revisions.find((r: any) => r.root === 'chat').id
    const chatOf = (diff: any) => diff.revisions.find((r: any) => r.root === 'chat')
    // Restored content equal to its recorded base, which is no longer a head: an explicit restored revision continues the base; B stays a sibling.
    const restoredA = (await projectDatabase({ database: backup, vault, ...f.readers })).desired
    const withBase = diffProjection(graph, restoredA, { [chatKey + '#chat']: genesis }, { restore: true })
    expect(chatOf(withBase).parents).toEqual([genesis]); expect(withBase.matched).not.toHaveProperty(chatKey + '#chat')
    // Edited restored content continues the recorded base; without a base it is of unknown origin (genesis) in restore AND edit mode: a device
    // that never applied the frontier head must not publish its own content as that head's successor (regression: the frontier was continued).
    backup.characters[0].chats[0].message.push({ role: 'user', data: 'A2' } as any)
    const a2 = (await projectDatabase({ database: backup, vault, ...f.readers })).desired
    expect(chatOf(diffProjection(graph, a2, { [chatKey + '#chat']: genesis }, { restore: true })).parents).toEqual([genesis])
    expect(chatOf(diffProjection(graph, a2, {}, { restore: true })).parents).toEqual([])
    expect(chatOf(diffProjection(graph, a2, {})).parents).toEqual([])
    // Equal to the current head: matched, nothing new (restore or not).
    const current = (await projectDatabase({ database: db, vault, ...f.readers })).desired
    expect(diffProjection(graph, current, { [chatKey + '#chat']: bHead }, { restore: true })).toMatchObject({ revisions: [], matched: { [chatKey + '#chat']: bHead } })
    expect(diffProjection(graph, current, {}).matched[chatKey + '#chat']).toBe(bHead)
    // Deleted root: a restore continues the tombstone (un-delete); in edit mode a tombstone base is a lost lineage.
    const [tomb] = graph.tombstones('op', [{ domain: 'play', type: 'chat', root: 'chat', base: bHead }]); graph.add(tomb)
    expect(chatOf(diffProjection(graph, a2, { [chatKey + '#chat']: genesis }, { restore: true })).parents).toEqual([tomb.id])
    expect(diffProjection(graph, a2, { [chatKey + '#chat']: tomb.id }).diverged).toContain(chatKey + '#chat')
})

test('theme-preset entries are projected without the device-local layout fields the active-preset mirror writes into them: the list is exactly mirror-reads ∩ DEVICE_LOCAL, changing every such field leaves the projected entry equal, unknown fields survive', async () => {
    // Parity with the real client mirror: every `db.<key>` the mirror reads that is a device-local root key, and nothing else.
    const client = await readFile(resolve(process.cwd(), 'src/ts/storage/database.svelte.ts'), 'utf8')
    const at = client.indexOf('function currentThemePresetFromMirror'), body = client.slice(at, client.indexOf('\n}\n', at))
    const reads = [...new Set([...body.matchAll(/db\.([A-Za-z0-9_]+)/g)].map(m => m[1]))]
    expect([...THEME_PRESET_LOCAL].sort()).toEqual(reads.filter(k => DEVICE_LOCAL.has(k)).sort())
    const local = Object.fromEntries([...THEME_PRESET_LOCAL].map((f, i) => [f, i]))
    const changed = Object.fromEntries([...THEME_PRESET_LOCAL].map((f, i) => [f, i + 100]))
    const a = [{ name: '테마', font: 'f', lineHeight: 1.4, futureField: { keep: true }, ...local }, null, 'odd'], b = [{ name: '테마', font: 'f', lineHeight: 1.4, futureField: { keep: true }, ...changed }, null, 'odd']
    expect(syncedThemePresets(a)).toEqual([{ name: '테마', font: 'f', lineHeight: 1.4, futureField: { keep: true } }, null, 'odd'])
    expect(sha(JSON.stringify(syncedThemePresets(a)))).toBe(sha(JSON.stringify(syncedThemePresets(b)))) // every local field changed: same projected entry
    expect(syncedThemePresets(undefined)).toBeUndefined()
    expect(a[0]).toHaveProperty('zoomsize') // never mutates the database
})

test('a root this device never applied (no lineage, one received frontier head) forks as a genesis sibling instead of continuing that head: differing content → diverged root for bootstrap/resolution; equal content → matched; lineage present → linear as before (live .78: joining phone\'s presets promoted over the tablet\'s)', async t => {
    const f = await fixture(t), vault = createVault(master), graph = createGraph()
    const tabletDb = f.database(); tabletDb.botPresets = [{ id: 'p1', name: '하나' }, { id: 'p2', name: '둘' }, { id: 'p3', name: '셋' }]; tabletDb.botPresetsId = 2
    const tablet = diffProjection(graph, (await projectDatabase({ database: tabletDb, vault, ...f.readers })).desired); graph.addAll(tablet.revisions)
    const presetsKey = rootKeyOf('settings', 'group', 'prompt-presets'), tabletHead = tablet.revisions.find((r: any) => r.key === presetsKey || r.root === 'prompt-presets').id
    expect(graph.classify(presetsKey)).toMatchObject({ state: 'live', heads: [tabletHead] })
    // The phone received the tablet's revision (admitted into its graph) but never applied it (vault-pending); its own DB has one preset.
    const phoneDb = f.database(); phoneDb.botPresets = [{ id: 'default', name: '기본' }]; phoneDb.botPresetsId = 0
    const phone = diffProjection(graph, (await projectDatabase({ database: phoneDb, vault, ...f.readers })).desired, {})
    const forked = phone.revisions.find((r: any) => r.root === 'prompt-presets')
    expect(forked.parents).toEqual([]) // regression: was [tabletHead] — a linear successor every device then applied
    expect(phone.diverged).toEqual([])
    graph.addAll(phone.revisions)
    expect(graph.classify(presetsKey)).toMatchObject({ state: 'diverged' }); expect(graph.classify(presetsKey).variants).toHaveLength(2)
    // Equal content without lineage is still matched (nothing to publish), and a recorded lineage still yields a linear edit.
    const same = diffProjection(graph, (await projectDatabase({ database: tabletDb, vault, ...f.readers })).desired, {})
    expect(same.revisions.find((r: any) => r.root === 'prompt-presets')).toBeUndefined()
    tabletDb.botPresets[0].name = '하나-수정'
    const linear = diffProjection(graph, (await projectDatabase({ database: tabletDb, vault, ...f.readers })).desired, { [presetsKey + '#prompt-presets']: tabletHead })
    expect(linear.revisions.find((r: any) => r.root === 'prompt-presets').parents).toEqual([tabletHead])
})
