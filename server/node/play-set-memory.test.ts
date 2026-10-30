import { test, expect } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, rm, readFile, readdir, writeFile, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { snapshotPlaySet } from '../../shared/play-set/snapshot'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'
import { resolveLegacySourceSnapshotWorkspace } from './risubard-source-workspace'
import { memorySaveWorkspaceId, createMemorySaveSlot } from './risubard-memory-save'
import { parseSavedFiles, restoreWorkspaceFromStore, saveStoreDirectory } from './risubard-memory-save-store'
import * as nodeFs from 'node:fs/promises'
import { encodeMemorySaveChat, decodeMemorySaveChat } from '../../src/ts/risubard/memorySaveCodec'
import type { Chat } from '../../src/ts/storage/database.svelte'

const require = createRequire(import.meta.url)
const { capturePlaySetMemory, attachPlaySetMemory, playSetMemoryMaterials } = require('./play-set-memory.cjs')
const { createRuntimeMemoryService } = require('./risubard-memory-runtime.cjs')
const { writePlaySetArchive, openPlaySetArchive } = require('./play-set-archive.cjs')
const slotChat = { id: 'chat', name: '슬롯 채팅', note: '메모', localLore: [], scriptstate: { day: 7 }, message: [{ role: 'char', data: '저장된 슬롯 채팅', promptInfo: { promptText: 'private request fixture', model: 'model label' } }] } as unknown as Chat

async function fixture(t: { onTestFinished: (fn: () => Promise<void>) => void }) {
    const root = await mkdtemp(join(tmpdir(), 'bard-play-memory-'))
    t.onTestFinished(() => rm(root, { recursive: true, force: true }))
    const data = join(root, 'data'), temporaryDirectory = join(root, 'temporary')
    await mkdir(data); await mkdir(temporaryDirectory)
    const service = createRuntimeMemoryService(data)
    await service.saveMarkdownWikiTurn({ characterId: 'card', chatId: 'chat', sourceMessageIds: ['m1'], markdown: '## 합성 사건\n\n그는 문을 열었다.' })
    const slot = resolveMemoryWorkspace(data, 'card', memorySaveWorkspaceId('slot'))
    await createMemorySaveSlot({ userDataDirectory: data, characterId: 'card', sourceChatId: 'chat', saveId: 'slot', sourceChatName: '원본 슬롯', turnCount: 1, chatBytes: encodeMemorySaveChat(slotChat) })
    const input = { userDataDirectory: data, characterId: 'card', chatIds: ['chat'], temporaryDirectory }
    return { root, data, service, slot, input }
}

test('captures actual Wiki, slot metadata, binary chat, and only referenced shared pages into a verified archive', async t => {
    const { data, service, slot, input, root } = await fixture(t)
    const extra = resolveMemoryWorkspace(data, 'card', 'unrelated')
    await mkdir(extra.directory); await writeFile(join(extra.directory, 'private.md'), 'not selected')
    const capture = await service.capturePlaySetMemory(input)
    expect(capture.workspaces).toHaveLength(1)
    expect(capture.workspaces[0].files.some((file: { path: string }) => file.path.endsWith('.md'))).toBe(true)
    expect(capture.workspaces[0].files.some((file: { path: string }) => file.path.endsWith('private.md'))).toBe(false)
    const snapshot = await snapshotPlaySet({ database: { characters: [{ chaId: 'card', name: '합성 캐릭터', chats: [{ id: 'chat', message: [{ role: 'char', data: '보존 검사' }] }] }] },
        origin: 'source', cold: async () => null, asset: async () => null, inlay: async () => null,
            chatMaterials: (characterId, chatId) => playSetMemoryMaterials(capture, characterId, chatId) },
        { characterId: 'card', chatIds: ['chat'], primaryChatId: 'chat', setId: 'set', characterChatsOnly: true })
    const attached = await attachPlaySetMemory(snapshot, capture)
    expect(snapshot.manifest.version).toBe(1)
    const archive = await writePlaySetArchive(attached, input.temporaryDirectory)
    // Live edits after capture cannot change the export bytes.
    await service.saveMarkdownWikiTurn({ characterId: 'card', chatId: 'chat', sourceMessageIds: ['m2'], markdown: '## 나중 사건\n\n이 내용은 캡처 뒤의 편집이다.' })
    const opened = await openPlaySetArchive(archive, input.temporaryDirectory)
    try {
        const saved = opened.manifest.bard[0].slots[0]
        const restoredSlot = join(root, 'restored-slot'), restoredStore = join(root, 'restored-store'), restoredWiki = join(root, 'restored-wiki')
        await mkdir(restoredSlot); await mkdir(restoredStore); await mkdir(restoredWiki)
        for (const file of saved.files) await opened.copyEntry(file.entry, join(restoredSlot, file.path))
        for (const page of saved.pages) {
            await mkdir(join(restoredStore, page.hash.slice(0, 2)), { recursive: true })
            await opened.copyEntry(page.entry, join(restoredStore, page.path))
        }
        const entries = parseSavedFiles(await readFile(join(restoredSlot, 'risubard-save-files.json'), 'utf8'))
        await restoreWorkspaceFromStore(nodeFs, entries, restoredStore, restoredWiki)
        const decoded = decodeMemorySaveChat(await readFile(join(restoredSlot, 'chat.bin')))
        expect(decoded).toEqual({ ...slotChat, message: [{ ...slotChat.message[0], promptInfo: { model: 'model label' } }] })
        expect(decodeMemorySaveChat(await readFile(join(slot.directory, 'chat.bin')))).toEqual(slotChat)
        expect(attached.excluded).toContainEqual({ path: 'slot/chat.bin/message/0/promptInfo/promptText', reason: 'Recorded request prompt' })
        expect(JSON.parse(await readFile(join(restoredSlot, 'risubard-save.json'), 'utf8')).sourceChatName).toBe('원본 슬롯')
        for (const entry of entries) expect(await readFile(join(restoredWiki, entry.path))).toEqual(await readFile(join(saveStoreDirectory(slot.directory), entry.hash.slice(0, 2), entry.hash)))
        expect(saved.pages).toHaveLength(new Set(entries.map(entry => entry.hash)).size)
    } finally { await opened.close(); await capture.cleanup() }
})

test('an exported slot loads through the existing runtime in a new process without the source directory', async t => {
    const { service, input, root } = await fixture(t)
    await service.saveMarkdownWikiTurn({ characterId: 'card', chatId: 'chat', sourceMessageIds: ['m2'], markdown: '## 저장 이후\n\n이 사건은 슬롯에 없어야 한다.' })
    const capture = await service.capturePlaySetMemory(input)
    const snapshot = await snapshotPlaySet({ database: { characters: [{ chaId: 'card', name: '합성 캐릭터', chats: [slotChat as never] }] },
        origin: 'source', cold: async () => null, asset: async () => null, inlay: async () => null,
            chatMaterials: (characterId, chatId) => playSetMemoryMaterials(capture, characterId, chatId) },
        { characterId: 'card', chatIds: ['chat'], primaryChatId: 'chat', setId: 'set', characterChatsOnly: true })
    const archive = await writePlaySetArchive(await attachPlaySetMemory(snapshot, capture), input.temporaryDirectory)
    const opened = await openPlaySetArchive(archive, input.temporaryDirectory)
    const destination = join(root, 'receiver')
    await mkdir(destination)
    try {
        const workspace = opened.manifest.bard[0], slot = workspace.slots[0]
        const current = resolveMemoryWorkspace(destination, 'card', 'chat')
        const saved = resolveMemoryWorkspace(destination, 'card', memorySaveWorkspaceId(slot.sourceId))
        for (const [directory, files] of [[current.directory, workspace.files], [saved.directory, slot.files], [saveStoreDirectory(saved.directory), slot.pages]] as const) {
            for (const file of files) {
                const target = join(directory, file.path)
                await mkdir(dirname(target), { recursive: true })
                await opened.copyEntry(file.entry, target)
            }
        }
    } finally { await opened.close(); await capture.cleanup() }
    const runtimePath = require.resolve('./risubard-memory-runtime.cjs')
    const codecPath = require.resolve('../../src/ts/risubard/memorySaveCodec.ts')
    const child = await promisify(execFile)(process.execPath, ['-e', `
        const {createRuntimeMemoryService}=require(process.argv[1]);
        const {decodeMemorySaveChat}=require(process.argv[2]);
        (async()=>{
            const service=createRuntimeMemoryService(process.argv[3]);
            const current=await service.loadCatalog('card','chat');
            const slots=await service.listMemorySaves({characterId:'card',sourceChatId:'chat'});
            const prepared=await service.prepareMemorySaveLoad({characterId:'card',saveId:'slot',destinationChatId:'loaded-slot'});
            await service.completeMemoryFork({characterId:'card',destinationChatId:'loaded-slot',forkToken:prepared.fork.forkToken,action:'finalize'});
            const restarted=createRuntimeMemoryService(process.argv[3]);
            const loaded=await restarted.loadCatalog('card','loaded-slot');
            process.stdout.write(JSON.stringify({current:current.documents.map(d=>d.title),loaded:loaded.documents.map(d=>d.title),slots,chat:decodeMemorySaveChat(prepared.chatBytes)}));
        })().catch(error=>{console.error(error);process.exitCode=1});
    `, runtimePath, codecPath, destination], { windowsHide: true, timeout: 20_000 })
    const restored = JSON.parse(child.stdout)
    expect(restored.current).toContain('저장 이후')
    expect(restored.loaded).toContain('합성 사건')
    expect(restored.loaded).not.toContain('저장 이후')
    expect(restored.slots).toHaveLength(1)
    expect(restored.slots[0]).toMatchObject({ saveId: 'slot', sourceChatId: 'chat', sourceChatName: '원본 슬롯' })
    expect(restored.chat.scriptstate).toEqual(slotChat.scriptstate)
    expect(restored.chat.message[0].data).toBe(slotChat.message[0].data)
    expect(restored.chat.message[0].promptInfo.promptText).toBeUndefined()
})

test('a capture waits for previous saves and holds later renames and wiki writes until all files are copied', async t => {
    const { data, input } = await fixture(t)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const service = createRuntimeMemoryService(data, { createSaveSlot: async () => { await gate; return {} } })
    const priorSave = service.createMemorySave({ characterId: 'card', sourceChatId: 'chat', saveId: 'other', chatBytes: Buffer.from('other') })
    const pending = service.capturePlaySetMemory(input)
    const rename = service.renameMemorySave({ characterId: 'card', saveId: 'slot', name: '변경된 슬롯' })
    const write = service.saveMarkdownWikiTurn({ characterId: 'card', chatId: 'chat', sourceMessageIds: ['m3'], markdown: '## 후속 편집\n\n캡처 중에는 대기한다.' })
    release(); await priorSave
    const capture = await pending
    try {
        const saved = capture.workspaces[0].slots[0].files.find((file: { path: string }) => file.path === 'risubard-save.json')
        expect(JSON.parse(await readFile(capture.blocks.get(saved.entry), 'utf8')).sourceChatName).toBe('원본 슬롯')
        await Promise.all([rename, write])
        expect((await service.listMemorySaves({ characterId: 'card', sourceChatId: 'chat' }))[0].sourceChatName).toBe('변경된 슬롯')
    } finally { await capture.cleanup() }
})

for (const broken of ['page', 'chat', 'manifest', 'recovery']) test(`missing or damaged ${broken} is reported and temporary files are removed`, async t => {
    const { data, slot, input } = await fixture(t)
    let damagedPage: string | undefined
    if (broken === 'page') {
        const entries = parseSavedFiles(await readFile(join(slot.directory, 'risubard-save-files.json'), 'utf8'))
        const page = entries[0]
        damagedPage = page.path
        await writeFile(join(saveStoreDirectory(slot.directory), page.hash.slice(0, 2), page.hash), 'damaged')
    } else if (broken === 'chat') await rm(join(slot.directory, 'chat.bin'))
    else if (broken === 'manifest') await writeFile(join(slot.directory, 'risubard-save.json'), '{}')
    else {
        const path = join(resolveMemoryWorkspace(data, 'card', 'chat').directory, 'wiki', '.risubard-recovery')
        await mkdir(path, { recursive: true }); await writeFile(join(path, 'pending'), 'pending')
    }
    const attempted = capturePlaySetMemory(input)
    await expect(attempted).rejects.toThrow(broken === 'recovery' ? /recovery/ : /slot/)
    if (damagedPage) await expect(attempted).rejects.toThrow(damagedPage)
    expect(await readdir(input.temporaryDirectory)).toEqual([])
})

test('a conflicting shared page size names its slot and logical path', async t => {
    const { slot, input } = await fixture(t)
    const listPath = join(slot.directory, 'risubard-save-files.json')
    const entries = parseSavedFiles(await readFile(listPath, 'utf8'))
    const duplicate = { ...entries[0], path: 'wiki/events/conflicting.md', size: entries[0].size + 1 }
    await writeFile(listPath, JSON.stringify({ schemaVersion: 1, files: [...entries, duplicate] }))
    const before = await readFile(listPath)
    const attempted = capturePlaySetMemory(input)
    await expect(attempted).rejects.toThrow('Memory save slot:')
    await expect(attempted).rejects.toThrow(duplicate.path)
    await expect(attempted).rejects.toThrow(duplicate.hash)
    expect(await readdir(input.temporaryDirectory)).toEqual([])
    expect(await readFile(listPath)).toEqual(before)
})

test('a linked workspace ancestor cannot leak an outside directory', async t => {
    const { data, root, input } = await fixture(t)
    const workspace = resolveMemoryWorkspace(data, 'card', 'chat').directory
    const outside = join(root, 'outside'); await mkdir(outside)
    await writeFile(join(outside, 'secret'), 'outside fixture')
    await rm(workspace, { recursive: true }); await symlink(outside, workspace, 'junction')
    await expect(capturePlaySetMemory(input)).rejects.toThrow(/symbolic link/)
    expect(await readdir(input.temporaryDirectory)).toEqual([])
    expect(await readFile(join(outside, 'secret'), 'utf8')).toBe('outside fixture')
})

test('wiki and saved-chat-only images use the same scanner and missing materials remain visible', async t => {
    const { data, slot, input, service } = await fixture(t)
    const workspace = resolveMemoryWorkspace(data, 'card', 'chat').directory
    await writeFile(join(workspace, 'wiki', 'image-note.md'), '# 이미지\n\n![원본](assets/wiki.png) {{inlay::wiki-inlay}}')
    const saved = structuredClone(slotChat)
    saved.message[0].data += ' ![](assets/slot.png) ![](assets/missing.png)'
    await writeFile(join(slot.directory, 'chat.bin'), encodeMemorySaveChat(saved))
    const capture = await service.capturePlaySetMemory(input)
    try {
        const loaded: string[] = []
        const snapshot = await snapshotPlaySet({ database: { characters: [{ chaId: 'card', name: '캐릭터', chats: [{ id: 'chat', message: [] }] }] },
            origin: 'source', cold: async () => null,
            asset: async path => { loaded.push(path); return path === 'assets/missing.png' ? null : new Blob([path]) },
            inlay: async id => ({ metadata: { name: id }, data: new Blob(['inlay fixture']) }),
            chatMaterials: (characterId, chatId) => playSetMemoryMaterials(capture, characterId, chatId) },
            { characterId: 'card', chatIds: ['chat'], primaryChatId: 'chat', setId: 'set', characterChatsOnly: true })
        expect(loaded).toEqual(expect.arrayContaining(['assets/wiki.png', 'assets/slot.png', 'assets/missing.png']))
        expect(snapshot.manifest.items.filter(item => item.kind === 'inlay')).toHaveLength(1)
        expect(snapshot.missing).toContainEqual(expect.objectContaining({ reason: 'Missing local asset: assets/missing.png' }))
        const attached = await attachPlaySetMemory(snapshot, capture)
        await expect(writePlaySetArchive(attached, input.temporaryDirectory)).rejects.toThrow(/Missing play-set material/)
    } finally { await capture.cleanup() }
})

test('legacy source snapshots and baseline follow the same modern-first fallback as the running app', async t => {
    const { data, input, service } = await fixture(t)
    const legacy = resolveLegacySourceSnapshotWorkspace(data, 'card', 'chat')
    await mkdir(legacy.directory, { recursive: true })
    const original = '{"schemaVersion":1,"sources":[]}\n'
    await writeFile(legacy.sourceSnapshotFile, original)
    await writeFile(legacy.baselineFile, '이전 저장 경로의 기준 요약')
    const modern = resolveMemoryWorkspace(data, 'card', 'chat').directory
    await writeFile(join(modern, 'baseline-summary.txt'), '현재 기준 요약')
    const capture = await service.capturePlaySetMemory(input)
    try {
        const contents = async (name: string) => readFile(capture.blocks.get(capture.workspaces[0].files.find((file: { path: string }) => file.path === name).entry), 'utf8')
        expect(await contents('source-snapshot.json')).toBe(original)
        expect(await contents('baseline-summary.txt')).toBe('현재 기준 요약')
        expect(await readFile(legacy.baselineFile, 'utf8')).toBe('이전 저장 경로의 기준 요약')
    } finally { await capture.cleanup() }
})

test('v2 repeated export and return to a known revision keep a valid lineage', async t => {
    const { service, input } = await fixture(t)
    const capture = await service.capturePlaySetMemory(input)
    try {
        const chat = { id: 'chat', name: 'Chat', message: [{ role: 'char', data: 'original' }] }
        const database: any = { characters: [{ chaId: 'card', name: 'Card', chats: [chat] }], risuPlaySets: { generations: [] } }
        const source = { database, origin: 'source', cold: async () => null, asset: async () => null, inlay: async () => null,
            chatMaterials: (characterId: string, chatId: string) => playSetMemoryMaterials(capture, characterId, chatId) }
        const selection = { characterId: 'card', chatIds: ['chat'], primaryChatId: 'chat', setId: 'set', characterChatsOnly: true }
        const first = await attachPlaySetMemory(await snapshotPlaySet(source, selection), capture)
        const remember = (snapshot: any) => database.risuPlaySets.generations.push({ exported: true, manifest: snapshot.manifest, ids: Object.fromEntries(snapshot.localIds) })
        remember(first)
        const again = await attachPlaySetMemory(await snapshotPlaySet(source, selection), capture)
        expect(again.manifest.revision).toBe(first.manifest.revision)
        expect(again.manifest.parent).toBe(first.manifest.parent)
        chat.message[0].data = 'changed'
        const changed = await attachPlaySetMemory(await snapshotPlaySet(source, selection), capture)
        expect(changed.manifest.parent).toBe(first.manifest.revision)
        remember(changed)
        chat.message[0].data = 'original'
        const reverted = await attachPlaySetMemory(await snapshotPlaySet(source, selection), capture)
        expect(reverted.manifest).toEqual(first.manifest)
    } finally { await capture.cleanup() }
})

test('frozen slot jobs do not block export, and painter image IDs are collected without changing the slot', async t => {
    const { service, input, slot } = await fixture(t)
    const saved: any = structuredClone(slotChat)
    saved.isStreaming = true
    saved.risuBardWikiReboot = { stagingChatId: 'old job' }
    saved.bardPainter = { results: [{ assetId: 'stored-image', compressionPending: true }], settings: { context: { referenceAssetId: 'reference-image' } } }
    await writeFile(join(slot.directory, 'chat.bin'), encodeMemorySaveChat(saved))
    const capture = await service.capturePlaySetMemory(input)
    try {
        const block = capture.workspaces[0].slots[0].files.find((file: { path: string }) => file.path === 'chat.bin')
        const portable: any = decodeMemorySaveChat(await readFile(capture.blocks.get(block.entry)))
        expect(portable.isStreaming).toBeUndefined()
        expect(portable.risuBardWikiReboot).toBeUndefined()
        expect(portable.bardPainter.results).toEqual([{ assetId: 'stored-image' }])
        expect(capture.excluded.filter((issue: any) => issue.reason.startsWith('Inactive'))).toHaveLength(3)
        const loaded: string[] = []
        const snapshot = await snapshotPlaySet({ database: { characters: [{ chaId: 'card', name: 'Card', chats: [{ id: 'chat', message: [] }] }] },
            origin: 'source', cold: async () => null, asset: async () => null,
            inlay: async id => { loaded.push(id); return { metadata: { name: id }, data: new Blob([id]) } },
            chatMaterials: (characterId, chatId) => playSetMemoryMaterials(capture, characterId, chatId) },
            { characterId: 'card', chatIds: ['chat'], primaryChatId: 'chat', setId: 'set', characterChatsOnly: true })
        expect(loaded.sort()).toEqual(['reference-image', 'stored-image'])
        expect(snapshot.manifest.items.filter(item => item.kind === 'inlay')).toHaveLength(2)
        expect(decodeMemorySaveChat(await readFile(join(slot.directory, 'chat.bin')))).toEqual(saved)
    } finally { await capture.cleanup() }
})

test('a configured junction data root is supported while workspace links remain forbidden', async t => {
    const { input, data, root } = await fixture(t)
    const linked = join(root, 'data-link')
    await symlink(data, linked, 'junction')
    const capture = await capturePlaySetMemory({ ...input, userDataDirectory: linked })
    try { expect(capture.workspaces[0].slots).toHaveLength(1) }
    finally { await capture.cleanup() }
})

test('attachment refuses a caller that skipped Bard image collection', async t => {
    const { service, input } = await fixture(t)
    const capture = await service.capturePlaySetMemory(input)
    try {
        const snapshot = await snapshotPlaySet({ database: { characters: [{chaId:'card',name:'Card',chats:[{id:'chat',message:[]}]}] },
            origin:'source',cold:async()=>null,asset:async()=>null,inlay:async()=>null },
            {characterId:'card',chatIds:['chat'],primaryChatId:'chat',setId:'set',characterChatsOnly:true})
        await expect(attachPlaySetMemory(snapshot,capture)).rejects.toThrow('Scan Bard')
    } finally { await capture.cleanup() }
})

test('a v1 ancestor reused by an intermediate snapshot cannot replace v2 item parents', async t => {
 const {service,input}=await fixture(t)
 const capture=await service.capturePlaySetMemory(input)
 try {
  const chat={id:'chat',name:'Chat',message:[{role:'char',data:'original'}]}
  const database:any={characters:[{chaId:'card',name:'Card',chats:[chat]}],risuPlaySets:{generations:[]}}
  const source={database,origin:'source',cold:async()=>null,asset:async()=>null,inlay:async()=>null,chatMaterials:(characterId:string,chatId:string)=>playSetMemoryMaterials(capture,characterId,chatId)}
  const selection={characterId:'card',chatIds:['chat'],primaryChatId:'chat',setId:'set',characterChatsOnly:true}
  const remember=(snapshot:any)=>database.risuPlaySets.generations.push({exported:true,manifest:snapshot.manifest,ids:Object.fromEntries(snapshot.localIds)})
  const first=await snapshotPlaySet(source,selection)
  remember(first)
  chat.message[0].data='changed'
  const changed=await attachPlaySetMemory(await snapshotPlaySet(source,selection),capture)
  remember(changed)
  chat.message[0].data='original'
  const v1=await snapshotPlaySet(source,selection)
  const before=structuredClone(v1.manifest)
  const reverted=await attachPlaySetMemory(v1,capture)
  expect(v1.manifest).toEqual(before)
  expect(reverted.manifest.parent).toBe(changed.manifest.revision)
  const changedChat=changed.manifest.items.find((item:any)=>item.kind==='chat')
  expect(reverted.manifest.items.find((item:any)=>item.id===changedChat.id).parent).toBe(changedChat.hash)
 } finally {await capture.cleanup()}
})

test('frozen gallery keeps references to other selected chats and leaves saved bytes intact',async t=>{
 const {service,input,slot}=await fixture(t)
 const saved:any=structuredClone(slotChat)
 saved.risuBardGallery={slots:[{id:'cross',sourceChatId:'second',messages:[{data:'selected excerpt'}]},{id:'other',sourceChatId:'private',messages:[{data:'unselected excerpt'}]}]}
 await writeFile(join(slot.directory,'chat.bin'),encodeMemorySaveChat(saved))
 const capture=await service.capturePlaySetMemory({...input,chatIds:['chat','second']})
 try {
  const block=capture.workspaces[0].slots[0].files.find((file:any)=>file.path==='chat.bin')
  const portable:any=decodeMemorySaveChat(await readFile(capture.blocks.get(block.entry)))
  expect(portable.risuBardGallery.slots.map((s:any)=>s.id)).toEqual(['cross'])
  expect(decodeMemorySaveChat(await readFile(join(slot.directory,'chat.bin')))).toEqual(saved)
 } finally {await capture.cleanup()}
})

test('invalid UTF-8 material reports the workspace file instead of a pathless decode error',async t=>{
 const {service,input,data}=await fixture(t)
 const workspace=resolveMemoryWorkspace(data,'card','chat')
 await writeFile(join(workspace.directory,'broken.md'),new Uint8Array([0xff]))
 const capture=await service.capturePlaySetMemory(input)
 try {
  await expect((async()=>{for await(const _ of playSetMemoryMaterials(capture,'card','chat')){}})()).rejects.toThrow('broken.md')
 } finally {await capture.cleanup()}
})
