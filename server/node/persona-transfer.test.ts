import { test, expect } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const require = createRequire(import.meta.url)
const { createPlaySetService } = require('./transfer-sync/play-set-service.cjs')
const { createFileKv } = require('./file-kv.cjs')
const { createRuntimeMemoryService } = require('./risubard-memory-runtime.cjs')
const { readPersonaBundle, isPersonaBundle, buildPersonaBundle, bundleName, MANIFEST } = require('./transfer-sync/persona-bundle.cjs')
const { zipSync, strToU8, unzipSync } = require('fflate')
const { readShareArchive } = require('./transfer-sync/nas-sync-share.cjs')
const { createHash } = require('node:crypto')
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])

async function fixture(t: { onTestFinished(fn: () => Promise<void>): void }, db: any) {
    const root = await mkdtemp(join(tmpdir(), 'bard-persona-transfer-'))
    t.onTestFinished(() => rm(root, { recursive: true, force: true }))
    const create = async (name: string, state: any, assets: Record<string, Buffer> = {}) => {
        const dataRoot = join(root, name); await mkdir(dataRoot, { recursive: true })
        const storage = createFileKv({ dataRoot })
        for (const [key, value] of Object.entries(assets)) storage.kvSet(key, value)
        return createPlaySetService({ dataRoot, readDatabase: async () => structuredClone(state), memory: createRuntimeMemoryService(dataRoot),
            storage, readInlay: async () => null, installInlay: async () => {}, removeInlay: async () => {} })
    }
    const sender = await create('sender', db, { 'assets/face.png': PNG, 'assets/module.bin': Buffer.from('module-file'), 'assets/module-icon.png': PNG })
    return { root, create, sender }
}

const senderDb = () => ({
    characters: [], selectedPersona: 0,
    personas: [
        { id: 'p1', name: '함건희', personaPrompt: '설명 1', note: '메모', icon: 'assets/face.png', largePortrait: true, portraitPrompt: { style: 'a' } },
        { id: 'p2', name: '용사 지망', personaPrompt: '설명 2', icon: '',
            embeddedModule: { id: 'm1', name: '모듈', description: '', icon: 'assets/module-icon.png', assets: [['map', 'assets/module.bin', 'webp'], ['gone', 'assets/missing.bin', 'png']] } },
        { id: 'p3', name: '그림 없음', personaPrompt: '설명 3', icon: 'assets/absent.png' },
        { id: 'p4', name: 'A\nB', personaPrompt: '줄바꿈 이름', icon: '../outside-of-storage' },
        { id: 'p5', name: 'A', personaPrompt: 'a', icon: '' }, { id: 'p6', name: 'B', personaPrompt: 'b', icon: '' },
    ],
})

test('persona export makes one send entry (same file every transfer method sends); the receiver queues it as a persona file, not a play set', async t => {
    const { create, sender } = await fixture(t, senderDb())
    const sent = await sender.exportPersonas({ personaIds: ['p1', 'p2', 'p3'] })
    expect(sent).toMatchObject({ direction: 'send', state: 'ready', kind: 'persona', name: '페르소나 함건희 외 2개.risuplay', personas: ['함건희', '용사 지망', '그림 없음'] })
    expect(sent.excluded.map((e: any) => e.path)).toEqual(['페르소나 「용사 지망」 모듈 에셋 gone', '페르소나 「그림 없음」 그림'])
    // GitHub keeps one file per backup key: the same set of names gets the same key, whatever the order.
    const record = (await sender.list()).find((r: any) => r.id === sent.id)
    expect(record.backupKey).toMatch(/^[a-f0-9]{64}$/)
    // Name boundaries are kept: ["A", "B"] and ["A\nB"] are different backups. A picture that cannot be read is left out, not fatal.
    const pair = await sender.exportPersonas({ personaIds: ['p5', 'p6'] }), joined = await sender.exportPersonas({ personaIds: ['p4'] })
    const key = (id: string) => sender.list().then((rows: any[]) => rows.find(r => r.id === id).backupKey)
    expect(await key(pair.id)).not.toBe(await key(joined.id))
    expect(joined.excluded.map((e: any) => e.path)).toEqual(['페르소나 「A\nB」 그림'])
    expect(joined.excluded[0].reason).toContain('그림 없이 보내요')
    const again = await sender.exportPersonas({ personaIds: ['p3', 'p1', 'p2'] })
    expect((await sender.list()).find((r: any) => r.id === again.id).backupKey).toBe(record.backupKey)

    const receiver = await create('receiver', { characters: [], personas: [] })
    const entry = await receiver.ingest(createReadStream(await sender.file(sent.id)))
    expect(entry).toMatchObject({ direction: 'receive', state: 'waiting', kind: 'persona', name: '페르소나 함건희 외 2개.risuplay' })
    // Asking first needs names only: inspect carries no pictures.
    const inspected = await receiver.inspect(entry.id)
    expect(inspected).toMatchObject({ kind: 'persona', characters: [], personas: [{ name: '함건희' }, { name: '용사 지망' }, { name: '그림 없음' }] })
    expect(JSON.stringify(inspected)).not.toContain('base64')
    expect(Object.keys(inspected.personas[0]).sort()).toEqual(['name', 'transferId'])
    expect(inspected.personas[0].transferId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(new Set(inspected.personas.map((p: any) => p.transferId)).size).toBe(3)
    await expect(receiver.prepare(entry.id)).rejects.toThrow('페르소나 가져오기')

    const received = await receiver.receivedPersonas(entry.id)
    const [one, two, three] = received.personas
    // The stable ids are the same ones the confirm step saw (a file applied again finds what it added before).
    expect(received.personas.map((p: any) => p.transferId)).toEqual(inspected.personas.map((p: any) => p.transferId))
    expect(one).toMatchObject({ name: '함건희', personaPrompt: '설명 1', note: '메모', largePortrait: true, portraitPrompt: { style: 'a' } })
    // Each distinct picture is sent once; personas refer to it by key (the shared PNG is one blob for the face and the module icon).
    expect(one.image).toBe(`blobs/${sha(PNG)}`); expect(two.moduleIcon).toBe(one.image)
    expect(Object.keys(received.blobs).sort()).toEqual([`blobs/${sha(PNG)}`, `blobs/${sha(Buffer.from('module-file'))}`].sort())
    expect(Buffer.from(received.blobs[one.image], 'base64')).toEqual(PNG)
    expect(two.image).toBeNull()
    expect(two.embeddedModule).toMatchObject({ id: 'm1', assets: [['map', '', 'webp']] })
    expect(two.embeddedModule.icon).toBeUndefined()
    expect(Buffer.from(received.blobs[two.moduleAssets[0]], 'base64').toString()).toBe('module-file')
    expect(three.image).toBeNull()

    // The client records which local persona each row goes to; it comes back with the rows (and survives a restart).
    const [t0, t1] = inspected.personas.map((p: any) => p.transferId)
    await expect(receiver.personaMap(entry.id, { 'not-an-id': 'x' })).rejects.toThrow('형식')
    await receiver.personaMap(entry.id, { [t0]: 'local-a' }); await receiver.personaMap(entry.id, { [t1]: t1 })
    const reopened = await create('receiver', { characters: [], personas: [] })
    expect((await reopened.inspect(entry.id)).personas.slice(0, 3).map((p: any) => p.localId)).toEqual(['local-a', t1, undefined])
    expect((await reopened.receivedPersonas(entry.id)).personas[0]).toMatchObject({ transferId: t0, localId: 'local-a' })

    expect((await receiver.personaApplied(entry.id)).state).toBe('applied')
    await expect(receiver.personaMap(entry.id, { [t0]: 'x' })).rejects.toThrow('이미')
    await expect(receiver.personaApplied(entry.id)).rejects.toThrow('이미')
    await expect(receiver.receivedPersonas(entry.id)).rejects.toThrow('이미')
    // A restart keeps the entry as a persona file.
    const restarted = await create('receiver', { characters: [], personas: [] })
    expect((await restarted.list()).find((r: any) => r.id === entry.id)).toMatchObject({ kind: 'persona', state: 'applied' })
})

test('persona export refuses unknown or empty selections and leaves no half-made entry', async t => {
    const { sender } = await fixture(t, senderDb())
    await expect(sender.exportPersonas({ personaIds: [] })).rejects.toThrow('골라')
    await expect(sender.exportPersonas({ personaIds: ['p1', 'p1'] })).rejects.toThrow('골라')
    await expect(sender.exportPersonas({ personaIds: ['nope'] })).rejects.toThrow('찾지 못')
    expect(await sender.list()).toEqual([])
})

test('a declined or cancelled persona file stays listed, can be asked again, and cancel removes the file', async t => {
    const { create, sender } = await fixture(t, senderDb())
    const sent = await sender.exportPersonas({ personaIds: ['p1'] })
    const receiver = await create('receiver', { characters: [], personas: [] })
    const entry = await receiver.ingest(createReadStream(await sender.file(sent.id)), { applyRequested: true })
    expect(entry).toMatchObject({ kind: 'persona', applyRequested: true })
    expect((await receiver.requestApply(entry.id, false)).applyRequested).toBe(false)
    expect((await receiver.cancel(entry.id)).state).toBe('cancelled')
    await expect(receiver.receivedPersonas(entry.id)).rejects.toThrow()
})

test('bundle validation: play sets and other files are not persona files; damaged persona files are refused', async () => {
    const { bytes } = await buildPersonaBundle([{ name: 'A', personaPrompt: 'p', icon: 'k' }], async () => PNG)
    expect(await isPersonaBundle(bytes)).toBe(true)
    expect((await readPersonaBundle(bytes)).personas[0]).toMatchObject({ name: 'A', image: `blobs/${sha(PNG)}` })
    const blob = (b: Uint8Array) => ({ [`blobs/${sha(b)}`]: b })
    expect(await isPersonaBundle(Buffer.from('not a zip'))).toBe(false)
    expect(await isPersonaBundle(Buffer.from(zipSync({ 'manifest.json': strToU8('{}') })))).toBe(false)
    const make = (manifest: any, extra: Record<string, Uint8Array> = {}) => Buffer.from(zipSync({ [MANIFEST]: strToU8(JSON.stringify(manifest)), ...extra }))
    const ok = { type: 'risubard-personas', version: 1, personas: [{ name: 'A', personaPrompt: 'p', image: null }] }
    expect((await readPersonaBundle(make(ok))).personas).toHaveLength(1)
    await expect(readPersonaBundle(make({ ...ok, type: 'other' }))).rejects.toThrow('페르소나 전송 파일이 아니에요')
    await expect(readPersonaBundle(make({ ...ok, version: 2 }))).rejects.toThrow('업데이트')
    await expect(readPersonaBundle(make({ ...ok, personas: [] }))).rejects.toThrow('1~200')
    await expect(readPersonaBundle(make({ ...ok, personas: Array.from({ length: 201 }, () => ok.personas[0]) }))).rejects.toThrow('1~200')
    await expect(readPersonaBundle(make({ ...ok, personas: [{ name: ' ', personaPrompt: 'p' }] }))).rejects.toThrow('이름')
    await expect(readPersonaBundle(make({ ...ok, personas: [{ name: 'A', personaPrompt: 'p', image: 'images/0.bin' }] }))).rejects.toThrow('그림')
    await expect(readPersonaBundle(make({ ...ok, personas: [{ name: 'A', personaPrompt: 'p', image: '../x.bin' }] }, { '../x.bin': PNG }))).rejects.toThrow()
    // An unreferenced member outside the native rule is refused as Android would, not skipped.
    await expect(readPersonaBundle(make(ok, { '../unused': PNG }))).rejects.toThrow()
    await expect(readPersonaBundle(make(ok, { 'records/x.json': PNG }))).rejects.toThrow('알 수 없는 항목')
    // Every member must be used by a persona.
    await expect(readPersonaBundle(make(ok, blob(PNG)))).rejects.toThrow('쓰이지 않는')
    await expect(readPersonaBundle(make({ ...ok, personas: [{ name: 'A', personaPrompt: 'p', moduleAssets: [] }] }))).rejects.toThrow('모듈')
    await expect(readPersonaBundle(make({ ...ok, personas: [{ name: 'A', personaPrompt: 'p', image: `blobs/${sha(PNG)}` }] }, { [`blobs/${sha(PNG)}`]: Buffer.from('other') }))).rejects.toThrow('손상')
    expect((await readPersonaBundle(make({ ...ok, personas: [{ name: 'A', personaPrompt: 'p', image: `blobs/${sha(PNG)}` }] }, blob(PNG)))).files.size).toBe(1)
    // A member whose real size differs from its declared size is refused (the declared sizes bound the memory used).
    const lying = Buffer.from(make({ ...ok, personas: [{ name: 'A', personaPrompt: 'p', image: `blobs/${sha(PNG)}` }] }, blob(PNG)))
    const name = Buffer.from(`blobs/${sha(PNG)}`)
    for (let at = lying.indexOf(name); at >= 0; at = lying.indexOf(name, at + 1)) {
        const central = lying.readUInt32LE(at - 46) === 0x02014b50, local = lying.readUInt32LE(at - 30) === 0x04034b50
        if (central) lying.writeUInt32LE(1, at - 46 + 24)
        if (local) lying.writeUInt32LE(1, at - 30 + 22)
    }
    await expect(readPersonaBundle(lying)).rejects.toThrow()
    expect(await isPersonaBundle(lying)).toBe(true) // detection reads the manifest only; the full read refuses it
    expect(bundleName(['a/b:c'])).toBe('페르소나 abc.risuplay')
})

test('the bundle follows the native archive member rules, shares one blob per picture and is not taken for a sync key file', async () => {
    const { bytes } = await buildPersonaBundle([{ name: 'A', personaPrompt: 'p', icon: 'k1' }, { name: 'B', personaPrompt: 'q', icon: 'k2' }], async () => PNG)
    const names = Object.keys(unzipSync(bytes))
    // Android PlaySetArchive.entryName and shared/play-set/protocol entryPath accept only these members.
    for (const name of names) expect(name).toMatch(/^(manifest\.json|records\/[a-f0-9]{64}\.json|blobs\/[a-f0-9]{64})$/)
    expect(names.sort()).toEqual([`blobs/${sha(PNG)}`, 'manifest.json'])
    const file = join(tmpdir(), `persona-${Date.now()}.risuplay`)
    await require('node:fs/promises').writeFile(file, bytes)
    try { expect(await readShareArchive(file)).toBeNull() } finally { await rm(file, { force: true }) }
})

test('a play-set archive is not a persona bundle', async t => {
    const root = await mkdtemp(join(tmpdir(), 'bard-persona-playset-'))
    t.onTestFinished(() => rm(root, { recursive: true, force: true }))
    const state = { characters: [{ chaId: 'c', name: 'C', chats: [{ id: 'chat', name: 'n', note: '', localLore: [], message: [{ role: 'char', data: 'hi' }] }] }] }
    const service = createPlaySetService({ dataRoot: root, readDatabase: async () => structuredClone(state), memory: createRuntimeMemoryService(root),
        storage: createFileKv({ dataRoot: root }), readInlay: async () => null, installInlay: async () => {}, removeInlay: async () => {} })
    const sent = await service.exportSet({ characterId: 'c', chatIds: ['chat'], primaryChatId: 'chat' })
    expect(await isPersonaBundle(await readFile(await service.file(sent.id)))).toBe(false)
    const back = await service.ingest(createReadStream(await service.file(sent.id)))
    expect(back.kind).toBeUndefined(); expect(back.state).toBe('waiting')
})

test('an ordinary file that is not a persona bundle still goes through the play-set check (and fails as before)', async t => {
    const { create } = await fixture(t, senderDb())
    const receiver = await create('receiver', { characters: [], personas: [] })
    const junk = join(tmpdir(), `junk-${Date.now()}.risuplay`)
    await require('node:fs/promises').writeFile(junk, Buffer.from(zipSync({ 'manifest.json': strToU8('{}') })))
    t.onTestFinished(() => rm(junk, { force: true }))
    await expect(receiver.ingest(createReadStream(junk))).rejects.toThrow()
    const failed = (await receiver.list())[0]
    expect(failed).toMatchObject({ state: 'failed' }); expect(failed.kind).toBeUndefined()
    expect((await readFile(junk)).length).toBeGreaterThan(0)
})
