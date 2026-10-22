import { test, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, readFile, readdir } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { encodeMemorySaveChat, decodeMemorySaveChat } from '../../src/ts/risubard/memorySaveCodec'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'
const require = createRequire(import.meta.url)
const { createPlaySetService } = require('./play-set-service.cjs')
const { createFileKv } = require('./file-kv.cjs')
const { createRuntimeMemoryService } = require('./risubard-memory-runtime.cjs')
const { createUserDataRepository } = require('./user-data-repository.cjs')
const promiseFiles = require('node:fs/promises')
const syncFiles = require('node:fs')

async function fixture(t: { onTestFinished(fn: () => Promise<void>): void }) {
    const root = await mkdtemp(join(tmpdir(), 'bard-transfer-service-'))
    t.onTestFinished(() => rm(root, { recursive: true, force: true }))
    const state = { characters: [{ chaId: 'source', name: '같은 캐릭터', chats: [{ id: 'source-chat', name: '새 대화', note: '', localLore: [], message: [{ role: 'char', data: '전송할 대화' }], scriptstate: { day: 7 } }] }] } as any
    const receiver = { characters: [{ chaId: 'receiver', name: '같은 캐릭터', chats: [{ id: 'keep', message: [{ data: '원래 대화' }] }] }], openAIKey: 'local-only-fixture' } as any
    const create = async (name: string, db: any) => {
        const dataRoot = join(root, name); await mkdir(dataRoot, { recursive: true })
        return createPlaySetService({ dataRoot, readDatabase: async () => structuredClone(db), memory: createRuntimeMemoryService(dataRoot),
            storage: createFileKv({ dataRoot }), readInlay: async () => null, installInlay: async () => {}, removeInlay: async () => {} })
    }
    const sender = await create('sender', state)
    const sent = await sender.exportSet({ characterId: 'source', chatIds: ['source-chat'], primaryChatId: 'source-chat' })
    const receiving = await create('receiver', receiver)
    const entry = await receiving.ingest(createReadStream(await sender.file(sent.id)))
    return { root, receiver, receiving, create, entry }
}

test('v2 imports only additional chats, commits after durable save, and repeats without duplicates', async t => {
    const { receiver, receiving, entry } = await fixture(t)
    const original = structuredClone(receiver.characters[0])
    const plan = await receiving.prepare(entry.id)
    expect(plan.added).toHaveLength(1); expect(plan.newCharacters).toHaveLength(0)
    await receiving.arm(entry.id, plan.transaction, plan.added)
    await expect(receiving.finish(entry.id, true)).rejects.toThrow(/save/)
    receiver.characters[0].chats.push(plan.added[0].chat); receiver.risuPlaySets = plan.registry
    expect((await receiving.finish(entry.id, true)).state).toBe('applied')
    expect(receiver.characters[0].chats[0]).toEqual(original.chats[0]); expect(receiver.openAIKey).toBe('local-only-fixture')
    const second = await receiving.ingest(createReadStream(await receiving.file(entry.id)))
    const duplicate = await receiving.prepare(second.id)
    expect(duplicate.duplicate).toBe(true); expect(duplicate.added).toHaveLength(0)
})

test('restart rolls back only uncommitted staging and preserves incoming queue and unrelated data', async t => {
    const { root, receiver, receiving, create, entry } = await fixture(t)
    await receiving.prepare(entry.id)
    const before = structuredClone(receiver)
    const fresh = await create('receiver', receiver)
    expect(await fresh.pending()).toHaveLength(1)
    expect((await fresh.finish(entry.id)).state).toBe('waiting')
    expect(receiver).toEqual(before)
    expect(await readFile(join(root, 'receiver/play-transfer', entry.id, 'incoming.risuplay'))).not.toHaveLength(0)
})

test('restart makes an interrupted receive cancellable without deleting its partial file automatically', async t => {
    const { root, receiver, create, entry } = await fixture(t)
    const path = join(root, 'receiver/play-transfer', entry.id)
    const record = JSON.parse(await readFile(join(path, 'state.json'), 'utf8'))
    await promiseFiles.rename(join(path, 'incoming.risuplay'), join(path, 'incoming.part'))
    require('./file-store.cjs').atomicWriteJson(path, 'state.json', { ...record, state: 'receiving' })
    const fresh = await create('receiver', receiver)
    const recovered = (await fresh.list()).find((item: any) => item.id === entry.id)
    expect(recovered.state).toBe('failed')
    expect(await readFile(join(path, 'incoming.part'))).not.toHaveLength(0)
    await fresh.cancel(entry.id)
    await expect(readFile(join(path, 'incoming.part'))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('restart completes a saved chat without applying twice and refuses mismatched saved content', async t => {
    const { receiver, receiving, create, entry } = await fixture(t)
    const plan = await receiving.prepare(entry.id)
    await receiving.arm(entry.id, plan.transaction, plan.added)
    receiver.characters[0].chats.push(plan.added[0].chat); receiver.risuPlaySets = plan.registry
    receiver.characters[0].chats[1].message[0].data = 'unexpected'
    const fresh = await create('receiver', receiver)
    await expect(fresh.finish(entry.id)).rejects.toThrow(/does not match/)
    expect(await fresh.pending()).toHaveLength(1)
    receiver.characters[0].chats[1].message[0].data = '전송할 대화'
    expect((await fresh.finish(entry.id)).state).toBe('applied')
    expect(receiver.characters[0].chats).toHaveLength(2)
    expect(await fresh.pending()).toHaveLength(0)
})

test('explicit recovery hold releases saving but retains the archive, staging, plan and changed chat', async t => {
    const { root, receiver, receiving, create, entry } = await fixture(t)
    const plan = await receiving.prepare(entry.id)
    await receiving.arm(entry.id, plan.transaction, plan.added)
    receiver.characters[0].chats.push(plan.added[0].chat); receiver.risuPlaySets = plan.registry
    delete receiver.characters[0].chats[1].scriptstate
    const fresh = await create('receiver', receiver)
    await expect(fresh.finish(entry.id)).rejects.toThrow('does not match')
    const before = structuredClone(receiver)
    expect((await fresh.holdRecovery(entry.id)).state).toBe('recovery-held')
    expect(receiver).toEqual(before)
    expect(await fresh.pending()).toHaveLength(0)
    const record = (await fresh.list()).find((row: any) => row.id === entry.id)
    expect(record.retainedPlan.transaction).toBe(plan.transaction)
    expect(await readFile(join(root, 'receiver/play-transfer', entry.id, 'incoming.risuplay'))).not.toHaveLength(0)
    await readdir(join(root, 'receiver/play-transfer', entry.id, plan.transaction))
    const restart = await create('receiver', receiver)
    expect(() => restart.assertWrite({ path: '/api/write', headers: {} })).not.toThrow()
})

test('missing exports and ambiguous preparations remove only their incomplete working directories', async t => {
    const { root, receiver, receiving, create, entry } = await fixture(t)
    const exportState = { characters: [{ chaId: 'card', name: 'missing', image: 'assets/missing.png', chats: [{ id: 'chat', message: [] }] }] }
    const sender = await create('missing', exportState)
    expect((await sender.exportSet({ characterId: 'card', chatIds: ['chat'], primaryChatId: 'chat' })).missing.length).toBeGreaterThan(0)
    expect((await readdir(join(root, 'missing/play-transfer'))).filter((name: string) => /^[a-f0-9-]{36}$/.test(name))).toHaveLength(0)
    receiver.characters.push({ chaId: 'same-name', name: '같은 캐릭터', chats: [] })
    await expect(receiving.prepare(entry.id)).rejects.toThrow()
    expect((await readdir(join(root, 'receiver/play-transfer', entry.id))).filter((name: string) => /^[a-f0-9-]{36}$/.test(name))).toHaveLength(0)
    expect((await receiving.inspect(entry.id)).characters[0].candidates).toHaveLength(2)
})

test('failed plan persistence removes its unrecorded staging and leaves the incoming archive retryable', async t => {
    const { root, receiving, entry } = await fixture(t)
    const rename = syncFiles.renameSync
    const fault = vi.spyOn(syncFiles, 'renameSync').mockImplementation((from: any, to: any) => {
        if (String(to).endsWith(`${entry.id}\\state.json`) || String(to).endsWith(`${entry.id}/state.json`))
            throw Object.assign(new Error('synthetic plan write failure'), { code: 'ENOSPC' })
        return rename(from, to)
    })
    try { await expect(receiving.prepare(entry.id)).rejects.toThrow('plan write failure') }
    finally { fault.mockRestore() }
    expect((await readdir(join(root, 'receiver/play-transfer', entry.id))).filter((name: string) => /^[a-f0-9-]{36}$/.test(name))).toHaveLength(0)
    expect((await receiving.list())[0].state).toBe('waiting')
    expect((await receiving.prepare(entry.id)).added).toHaveLength(1)
})

test('fingerprint failure never leaves a sendable export without its deduplication registry', async t => {
    const { root, create } = await fixture(t)
    const dataRoot = join(root, 'fingerprint-failure')
    const db = { characters: [{ chaId: 'card', name: 'card', chats: [{ id: 'chat', message: [] }] }] }
    const sender = await create('fingerprint-failure', db)
    await createRuntimeMemoryService(dataRoot).saveMarkdownWikiTurn({ characterId: 'card', chatId: 'chat', sourceMessageIds: ['first-message:chat:0'], markdown: '## 기억\n\n내용' })
    const read = promiseFiles.readFile
    const fault = vi.spyOn(promiseFiles, 'readFile').mockImplementation(async (...args: any[]) => {
        if (String(args[0]).includes('export-work-') && syncFiles.readdirSync(join(dataRoot, 'play-transfer')).some((name: string) => syncFiles.existsSync(join(dataRoot, 'play-transfer', name, 'export.risuplay')))) {
            throw new Error('synthetic fingerprint read failure')
        }
        return read(...args)
    })
    try { await expect(sender.exportSet({ characterId: 'card', chatIds: ['chat'], primaryChatId: 'chat' })).rejects.toThrow('fingerprint read failure') }
    finally { fault.mockRestore() }
    expect(await sender.list()).toEqual([])
    expect((await readdir(join(dataRoot, 'play-transfer'))).filter((name: string) => /^[a-f0-9-]{36}$/.test(name))).toHaveLength(0)
})

test('completed acknowledgements require a committed import; other writers and stale save tokens are fenced', async t => {
    const { receiving, entry, receiver } = await fixture(t)
    await expect(receiving.finish(entry.id, true)).rejects.toThrow(/not been saved/)
    const plan = await receiving.prepare(entry.id)
    const request = (token?: string) => ({ path: '/api/write', headers: token ? { 'x-play-transfer-id': token } : {} })
    expect(() => receiving.assertWrite(request())).toThrow(/recovery/)
    expect(() => receiving.assertWrite(request(plan.transaction))).not.toThrow()
    // A second received file must not release the first import's writer fence.
    await receiving.ingest(createReadStream(await receiving.file(entry.id)))
    expect(() => receiving.assertWrite(request())).toThrow(/recovery/)
    receiver.characters[0].chats.push(plan.added[0].chat)
    await expect(receiving.finish(entry.id)).rejects.toThrow(/recovery retained/)
    receiver.characters[0].chats.pop()
    await receiving.finish(entry.id)
    expect(() => receiving.assertWrite(request(plan.transaction))).toThrow(/recovery/)
    expect(() => receiving.assertWrite(request())).not.toThrow()
})

test('canonical disk save, process restart, transferred Wiki and saved-slot load preserve references and media', async t => {
    const root = await mkdtemp(join(tmpdir(), 'bard-transfer-canonical-'))
    t.onTestFinished(() => rm(root, { recursive: true, force: true }))
    const chat: any = { id: 'source-chat', name: '보존', note: '', localLore: [], message: [{ role: 'char', data: '{{inlay::source-image}}' }], scriptstate: { day: 7 } }
    const source: any = { language: 'ko', characters: [{ chaId: 'source', type: 'character', name: '캐릭터', chats: [chat] }], modules: [], botPresets: [], personas: [], loreBook: [] }
    const dest: any = { ...structuredClone(source), characters: [{ chaId: 'receiver', type: 'character', name: '캐릭터', chats: [{ ...chat, id: 'keep', message: [] }] }] }
    const senderRoot = join(root, 'sender'), receiverRoot = join(root, 'receiver')
    const make = (dataRoot: string) => {
        const repository = createUserDataRepository({ dataRoot }), memory = createRuntimeMemoryService(dataRoot)
        const service = createPlaySetService({ dataRoot, readDatabase: async () => repository.exportLegacyDatabase(), memory,
            storage: createFileKv({ dataRoot }), readInlay: async () => ({ metadata: { type: 'image', ext: 'png', width: 1, height: 1 }, data: new Blob(['synthetic-image']) }),
            installInlay: async () => {}, removeInlay: async () => {} })
        return { repository, memory, service }
    }
    const sender = make(senderRoot); sender.repository.importLegacyDatabase(source, { mode: 'sync' })
    await sender.memory.saveMarkdownWikiTurn({ characterId: 'source', chatId: chat.id, sourceMessageIds: ['first-message:source-chat:0'], markdown: '## 전송 기억\n\n보존 내용 {{inlay::source-image}}' })
    await sender.memory.createMemorySave({ characterId: 'source', sourceChatId: chat.id, saveId: 'slot', sourceChatName: '저장 슬롯', turnCount: 1, chatBytes: encodeMemorySaveChat(chat) })
    const sent = await sender.service.exportSet({ characterId: 'source', chatIds: [chat.id], primaryChatId: chat.id })
    source.risuPlaySets = sent.registry; sender.repository.importLegacyDatabase(source, { mode: 'sync' })
    expect(sent.missing).toEqual([])
    expect((await readdir(join(senderRoot, 'play-transfer', sent.id))).sort()).toEqual(['export.risuplay', 'state.json', 'state.json.sha256'])
    const receiver = make(receiverRoot); receiver.repository.importLegacyDatabase(dest, { mode: 'sync' })
    const incoming = await receiver.service.ingest(createReadStream(await sender.service.file(sent.id)))
    const plan = await receiver.service.prepare(incoming.id)
    await receiver.service.arm(incoming.id, plan.transaction, plan.added)
    const next = receiver.repository.exportLegacyDatabase()
    next.characters[0].chats.push(plan.added[0].chat); next.risuPlaySets = plan.registry
    receiver.repository.importLegacyDatabase(next, { mode: 'sync' })
    // Fresh objects read only canonical disk files; no in-memory sender/receiver DB is used.
    const restarted = make(receiverRoot)
    const rename = promiseFiles.rename;
    let publications = 0;
    const interrupted = vi.spyOn(promiseFiles, 'rename').mockImplementation(async (...args: any[]) => {
        if (String(args[0]).includes('memory-') && ++publications === 2) throw Object.assign(new Error('synthetic storage interruption'), { code: 'ENOSPC' })
        return rename(...args)
    });
    try { await expect(restarted.service.finish(incoming.id)).rejects.toThrow('storage interruption') }
    finally { interrupted.mockRestore() }
    expect((await restarted.service.finish(incoming.id)).state).toBe('applied')
    expect((await restarted.service.finish(incoming.id, true)).state).toBe('applied')
    const received = restarted.repository.exportLegacyDatabase().characters[0].chats[1]
    expect(received.scriptstate).toEqual({ day: 7 }); expect(received.id).not.toBe(chat.id)
    const returned = await restarted.service.exportSet({ characterId: 'receiver', chatIds: [received.id], primaryChatId: received.id })
    const returnEntry = await sender.service.ingest(createReadStream(await restarted.service.file(returned.id)))
    const returnPlan = await sender.service.prepare(returnEntry.id)
    expect(returnPlan.duplicate).toBe(true)
    await sender.service.finish(returnEntry.id)
    await restarted.memory.saveMarkdownWikiTurn({ characterId: 'receiver', chatId: received.id, sourceMessageIds: ['first-message:source-chat:0'], markdown: '## 새 기억\n\n받은 기기에서 추가한 기억' })
    const modified = await restarted.service.exportSet({ characterId: 'receiver', chatIds: [received.id], primaryChatId: received.id })
    const changedEntry = await sender.service.ingest(createReadStream(await restarted.service.file(modified.id)))
    const changedPlan = await sender.service.prepare(changedEntry.id)
    expect(changedPlan.duplicate).toBe(false); expect(changedPlan.added).toHaveLength(1)
    await sender.service.finish(changedEntry.id)
    const slots = await restarted.memory.listMemorySaves({ characterId: 'receiver', sourceChatId: received.id })
    expect(slots).toHaveLength(1)
    const saved = decodeMemorySaveChat(await restarted.memory.previewMemorySave({ characterId: 'receiver', saveId: slots[0].saveId })) as any
    expect(saved.id).toBe(received.id); expect(saved.risuTransferMedia).toEqual(received.risuTransferMedia)
    const loaded = await restarted.memory.prepareMemorySaveLoad({ characterId: 'receiver', saveId: slots[0].saveId, destinationChatId: 'loaded-slot' })
    await restarted.memory.completeMemoryFork({ characterId: 'receiver', destinationChatId: 'loaded-slot', forkToken: loaded.fork.forkToken, action: 'finalize' })
    const events = join(resolveMemoryWorkspace(receiverRoot, 'receiver', 'loaded-slot').directory, 'wiki/events')
    const page = await readFile(join(events, (await readdir(events)).find(f => f.endsWith('.md'))!), 'utf8')
    expect(page).toContain('보존 내용'); expect(page).not.toContain('first-message:source-chat:0')
    const again = make(receiverRoot)
    expect(await again.memory.listMemorySaves({ characterId: 'receiver', sourceChatId: received.id })).toHaveLength(1)
    expect(again.repository.exportLegacyDatabase().characters[0].chats[0].id).toBe('keep')
})
