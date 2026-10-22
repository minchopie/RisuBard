import { test, expect } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, rm, cp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { snapshotPlaySet } from '../../shared/play-set/snapshot'
import { applyCharacterChats } from '../../shared/play-set/characterChats'
import { remapBardChat, remapBardRecord } from '../../shared/play-set/bardIdentity'
import { encodeMemorySaveChat, decodeMemorySaveChat } from '../../src/ts/risubard/memorySaveCodec'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'
import { memorySaveWorkspaceId } from './risubard-memory-save'
import { saveStoreDirectory } from './risubard-memory-save-store'

const require = createRequire(import.meta.url)
const { createRuntimeMemoryService } = require('./risubard-memory-runtime.cjs')
const { attachPlaySetMemory, playSetMemoryMaterials } = require('./play-set-memory.cjs')
const { writePlaySetArchive, openPlaySetArchive } = require('./play-set-archive.cjs')
const { relinkWorkspace } = require('./play-set-relink.cjs')
const identities = () => ({ characters: new Map([['card', 'receiver']]), chats: new Map([['chat', 'received-chat']]),
    slots: new Map([['slot', 'received-slot']]), sources: new Map<string, string>(), inlays: new Map<string, string>(),
    assets: new Map<string, string>(), hashes: new Map<string, string>() })

test('typed evidence relinks without replacing prose, Lua variables or graph node IDs', () => {
    const map = identities()
    expect(remapBardRecord({ storyId: 'card', branchId: 'chat', sourceId: 'card', targetId: 'chat',
        evidence: { chatId: 'chat', messageId: 'first-message:chat:0' }, content: 'chat card' }, map))
        .toEqual({ storyId: 'receiver', branchId: 'received-chat', sourceId: 'card', targetId: 'chat',
            evidence: { chatId: 'received-chat', messageId: 'first-message:received-chat:0' }, content: 'chat card' })
    const source = { id: 'chat', message: [{ data: 'chat card' }], scriptstate: { chatId: 'chat' }, bardPainter: { anchor: { characterId: 'card', chatId: 'chat' } } }
    const remapped = remapBardChat(source, map)
    expect(remapped.scriptstate).toEqual(source.scriptstate)
    expect(remapped.message).toEqual(source.message)
    expect(remapped.bardPainter.anchor.chatId).toBe('received-chat')
})

test('v2 wiki and saved slot survive new character/chat/slot IDs and load through the existing runtime', async t => {
    const root = await mkdtemp(join(tmpdir(), 'bard-relink-'))
    t.onTestFinished(() => rm(root, { recursive: true, force: true }))
    const source = join(root, 'source'), receiver = join(root, 'receiver'), temporaryDirectory = join(root, 'temp')
    await mkdir(source); await mkdir(receiver); await mkdir(temporaryDirectory)
    const service = createRuntimeMemoryService(source)
    await service.saveMarkdownWikiTurn({ characterId: 'card', chatId: 'chat', sourceMessageIds: ['first-message:chat:0'], markdown: '## 보존 사건\n\n본문의 chat 문자열은 그대로.' })
    const chat = { id: 'chat', name: '합성 채팅', note: '', localLore: [], scriptstate: { day: 7 }, message: [{ role: 'char', data: '보존' }] }
    await service.createMemorySave({ characterId: 'card', sourceChatId: 'chat', saveId: 'slot', sourceChatName: '슬롯', turnCount: 1, chatBytes: encodeMemorySaveChat(chat as any) })
    const capture = await service.capturePlaySetMemory({ characterId: 'card', chatIds: ['chat'], temporaryDirectory })
    const snapshot = await snapshotPlaySet({ database: { characters: [{ chaId: 'card', name: '캐릭터', chats: [chat] }] }, origin: 'source',
        asset: async () => null, cold: async () => null, inlay: async () => null, chatMaterials: (c, ch) => playSetMemoryMaterials(capture, c, ch) },
        { characterId: 'card', chatIds: ['chat'], primaryChatId: 'chat', setId: 'set', characterChatsOnly: true })
    const bundled = await attachPlaySetMemory(snapshot, capture)
    const archive = await openPlaySetArchive(await writePlaySetArchive(bundled, temporaryDirectory), temporaryDirectory)
    try {
        await expect(applyCharacterChats({ characters: [] }, archive.manifest, archive.records, new Map(), 'tx')).rejects.toThrow(/journaled/)
        const planned = await applyCharacterChats({ characters: [{ chaId: 'receiver', name: '캐릭터', chats: [] }] }, archive.manifest, archive.records, new Map(), 'tx', {}, true)
        expect(planned.database.characters).toHaveLength(1)
        const result = await relinkWorkspace({ archive, workspace: archive.manifest.bard[0], directory: join(root, 'staging'), identities: identities(), destinationChatId: 'received-chat' })
        const current = resolveMemoryWorkspace(receiver, 'receiver', 'received-chat').directory
        await cp(result.current, current, { recursive: true })
        const slot = resolveMemoryWorkspace(receiver, 'receiver', memorySaveWorkspaceId('received-slot')).directory
        await cp(result.slots[0].directory, slot, { recursive: true })
        await cp(join(root, 'staging/pages'), saveStoreDirectory(slot), { recursive: true })
        const fresh = createRuntimeMemoryService(receiver)
        const slots = await fresh.listMemorySaves({ characterId: 'receiver', sourceChatId: 'received-chat' })
        expect(slots[0].saveId).toBe('received-slot')
        const saved = decodeMemorySaveChat(await readFile(join(slot, 'chat.bin'))) as any
        expect(saved.id).toBe('received-chat'); expect(saved.scriptstate).toEqual({ day: 7 })
        const loaded = await fresh.prepareMemorySaveLoad({ characterId: 'receiver', saveId: 'received-slot', destinationChatId: 'load-destination' })
        expect(loaded).toBeTruthy()
        const files = await import('node:fs/promises').then(m => m.readdir(current + '/wiki/events'))
        const text = await readFile(join(current, 'wiki/events', files.find(f => f.endsWith('.md'))!), 'utf8')
        expect(text).toContain('first-message:received-chat:0'); expect(text).toContain('본문의 chat 문자열은 그대로.')
    } finally { await archive.close(); await capture.cleanup() }
})
