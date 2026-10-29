/**
 * Chat bodies the chat store holds ahead of disk must survive every rebuild
 * of that store. Right after a restart or a backup import the database cache
 * is cold; a body saved then sits only in the chat store until the debounced
 * persist, and the first /api/patch cold-loaded the cache by rebuilding the
 * store from disk. A chat whose body arrives before the patch that adds its
 * entry has no copy on disk at all. Ported from an upstream fork (2026-10).
 */
import { describe, test, expect, beforeAll, afterAll } from 'vitest'
import { fileURLToPath } from 'node:url'
import { writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { normalizeBackup, decodeRisuDat } from './helpers/normalize.js'

const { calculateHash, encodeRisuSaveLegacyBuffer, decodeRisuSave } = require('../../server/node/utils.cjs')

const DB_KEY_HEX = Buffer.from('database/database.bin').toString('hex')
const CHA = 'test-char-0'
const CHAT = 'chat-0-0'
const NEW = 'chat-new'

let srv: ServerHandle
let client: RisuClient
let headers: Record<string, string>

beforeAll(async () => {
  const preload = fileURLToPath(new URL('./helpers/fail-import-swap-preload.cjs', import.meta.url))
  srv = await spawnServer({ env: { NODE_OPTIONS: `--require ${JSON.stringify(preload)}` } })
  client = await createClient(srv.port, srv.password)
  const session = 'cold-load'
  const sessionResponse = await client.fetch('/api/session', { method: 'POST', headers: { 'x-session-id': session } })
  const cookie = sessionResponse.headers.get('set-cookie')!.split(';', 1)[0]
  headers = { 'x-session-id': session, 'x-user-active': '1', cookie }
})
afterAll(async () => { await srv?.cleanup() })

// An import leaves the server as a restart does: no database cache, chat
// store built from disk.
async function coldStart(messagesPerChat = 2) {
  const result = await client.importBackup(createSeedBackup({ characterCount: 1, messagesPerChat }))
  expect(result.ok).toBe(true)
}

async function getChat(chatId = CHAT, index = 0) {
  const res = await client.fetch(`/api/chat-content/${CHA}/${index}`, { headers: { ...headers, 'x-chat-id': chatId } })
  if (res.status !== 200) return { status: res.status, chat: null as any }
  return { status: 200, chat: await decodeRisuSave(Buffer.from(await res.arrayBuffer())) as any }
}

async function lastMessage(chatId = CHAT, index = 0) {
  const { status, chat } = await getChat(chatId, index)
  expect(status).toBe(200)
  return chat.message.at(-1).data
}

async function postChat(chat: any, chatId = CHAT, index = 0) {
  const res = await client.fetch(`/api/chat-content/${CHA}/${index}`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/octet-stream', 'x-chat-id': chatId },
    body: new Uint8Array(encodeRisuSaveLegacyBuffer(chat)),
  })
  expect(res.status).toBe(200)
}

async function saveChatWith(text: string) {
  const { chat } = await getChat()
  await postChat({ ...chat, message: [...chat.message, { role: 'user', data: text }] })
}

// A chat created on the client: its body goes up first, its entry in the
// database only with the patch that follows.
async function postNewChat(text: string) {
  await postChat({ id: NEW, name: 'New', message: [{ role: 'user', data: text }], note: '', localLore: [] }, NEW, 1)
}

function patch(ops: unknown[], expectedHash: string) {
  return client.fetch('/api/patch', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', 'file-path': DB_KEY_HEX },
    body: JSON.stringify({ patch: ops, expectedHash }),
  })
}

const stalePatch = () => patch([], 'stale')

async function readDb() {
  const res = await client.fetch('/api/read', { headers: { ...headers, 'file-path': DB_KEY_HEX } })
  expect(res.status).toBe(200)
  return decodeRisuDat(Buffer.from(await res.arrayBuffer())) as any
}

async function addNewChatEntry() {
  const db = await readDb()
  const res = await patch([{ op: 'add', path: '/characters/0/chats/1', value: { id: NEW, name: 'New', _stub: true } }], calculateHash(db).toString(16))
  expect(res.status, await res.clone().text()).toBe(200)
}

async function lastMessageOnDisk(chatId = CHAT) {
  // Export flushes the pending persist and reads database.bin from disk.
  const { raw } = normalizeBackup(await client.exportBackup()) as any
  const chat = raw.characters.find((c: any) => c.chaId === CHA).chats.find((c: any) => c.id === chatId)
  return chat?.message.at(-1).data
}

describe('chat body saved while the database cache is cold', () => {
  test('survives the cold load of the first /api/patch', async () => {
    await coldStart()
    await saveChatWith('saved before the first patch')

    // The client's patch after a restart carries its old hash: 409, but the
    // server cold-loads the cache first.
    expect((await stalePatch()).status).toBe(409)

    expect(await lastMessage()).toBe('saved before the first patch')
    expect(await lastMessageOnDisk()).toBe('saved before the first patch')
  })

  test('a new chat saved before the first patch keeps its body once the client adds it to the database', async () => {
    await coldStart()
    await postNewChat('first message of a new chat')
    expect((await stalePatch()).status).toBe(409)

    await addNewChatEntry()

    expect(await lastMessage(NEW, 1)).toBe('first message of a new chat')
    expect(await lastMessageOnDisk(NEW)).toBe('first message of a new chat')
  })
})

describe('chat body saved before the database lists the chat', () => {
  test('a new chat survives a persist that runs before its entry arrives', async () => {
    await coldStart()
    await readDb() // warm cache

    await postNewChat('posted before its entry')
    // Any persist rebuilds the chat store from what it wrote; export runs one.
    await client.exportBackup()

    await addNewChatEntry()

    expect(await lastMessage(NEW, 1)).toBe('posted before its entry')
    expect(await lastMessageOnDisk(NEW)).toBe('posted before its entry')
  })

  test('a new chat deleted again before the next persist stays deleted', async () => {
    await coldStart()
    const db = await readDb() // warm cache

    await postNewChat('posted, listed, then deleted')
    const stub = { id: NEW, name: 'New', _stub: true }
    expect((await patch([{ op: 'add', path: '/characters/0/chats/1', value: stub }], calculateHash(db).toString(16))).status).toBe(200)
    db.characters[0].chats.splice(1, 0, stub)
    expect((await patch([{ op: 'remove', path: '/characters/0/chats/1' }], calculateHash(db).toString(16))).status).toBe(200)

    // The persist that export runs rebuilds the store from a database
    // without the chat; the post must not bring the body back.
    expect(await lastMessageOnDisk(NEW)).toBeUndefined()
    expect((await getChat(NEW, 1)).status).toBe(404)
  })
})

describe('writes that replace database.bin', () => {
  test('bulk-write refuses database.bin', async () => {
    await coldStart()
    const { raw: seeded } = normalizeBackup(createSeedBackup({ characterCount: 1, messagesPerChat: 3 })) as any
    const res = await client.fetch('/api/assets/bulk-write', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify([{ key: 'database/database.bin', value: Buffer.from(encodeRisuSaveLegacyBuffer(seeded)).toString('base64') }]),
    })
    expect(res.status).toBe(400)
    expect(await lastMessageOnDisk()).toBe('Message 1 in chat 0 of char 0')
  })

  test('an import that fails after committing its database leaves no older chat in memory', async () => {
    await coldStart()
    expect(await lastMessage()).toBe('Message 1 in chat 0 of char 0')

    const flag = path.join(srv.cwd, 'fail-import-swap')
    await writeFile(flag, '')
    try {
      const result = await client.importBackup(createSeedBackup({ characterCount: 1, messagesPerChat: 3 }))
      expect(result.ok).not.toBe(true)
    } finally {
      await rm(flag, { force: true })
    }

    // The imported database is on disk; the chat must come from it.
    expect(await lastMessage()).toBe('Message 2 in chat 0 of char 0')
    expect((await stalePatch()).status).toBe(409)
    expect(await lastMessageOnDisk()).toBe('Message 2 in chat 0 of char 0')
  })
})
