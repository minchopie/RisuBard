import { afterAll, expect, test } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { createClient } from './helpers/client.js'
import { createSeedBackup } from './helpers/seed.js'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeBackup } from './helpers/decode.js'
import { decodeRisuDat } from './helpers/normalize.js'
const { encodeRisuSaveLegacyBuffer } = require('../../server/node/utils.cjs')
const { atomicWriteJson } = require('../../server/node/file-store.cjs')
const key = 'database/database.bin'
const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(server => server.cleanup())) })

// Files edited by another program while an acknowledged save still waits for
// its debounce: the checksum fallback has no metadata baseline to merge with.
// Loading the page must not stop on that, and the app's edit must not vanish.
async function fixture() {
    const server = await spawnServer(); servers.push(server)
    const client = await createClient(server.port, server.password)
    const entries = decodeBackup(createSeedBackup({ characterCount: 2, chatsPerCharacter: 2 }))
    const database: any = decodeRisuDat(entries[0].data)
    database.modules = []; database.loreBook = []; database.personas[0].id = 'persona-1'
    entries[0].data = encodeRisuSaveLegacyBuffer(database)
    expect((await client.importBackup(encodeBackup(entries))).ok).toBe(true)
    const session = await client.fetch('/api/session', { method: 'POST', headers: { 'x-session-id': 'pending-test' } })
    const headers = { 'x-session-id': 'pending-test', 'x-user-active': '1', cookie: session.headers.get('set-cookie')!.split(';', 1)[0] }
    const read = () => client.fetch('/api/read', { headers: { ...headers, 'file-path': Buffer.from(key).toString('hex') } })
    expect((await read()).ok).toBe(true)
    const root = path.join(server.cwd, 'save')
    // Acknowledged now, written only after the 5 second debounce.
    const pendingChat = async () => expect((await client.fetch('/api/chat-content/test-char-0/0', {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-chat-id': 'chat-0-0' },
        body: JSON.stringify({ id: 'chat-0-0', name: 'Chat 0', message: [{ role: 'user', data: 'pending-chat' }], localLore: [] }),
    })).ok).toBe(true)
    const recoveryFiles = async () => {
        const directory = path.join(root, 'trash/live-files-recovery')
        const names = (await readdir(directory)).filter(name => name !== 'pending.json' && name.endsWith('.json'))
        return Promise.all(names.map(async name => JSON.parse(await readFile(path.join(directory, name), 'utf8'))))
    }
    const exported = async () => decodeRisuDat(decodeBackup(await client.exportBackup()).find(entry => entry.name === 'database.risudat')!.data) as any
    return { client, headers, read, root, pendingChat, recoveryFiles, exported }
}

test('a character file edited during a pending save loads and keeps the pending chat', async () => {
    const f = await fixture()
    await f.pendingChat()
    const file = 'characters/test-char-0/metadata.json'
    const metadata = JSON.parse(await readFile(path.join(f.root, file), 'utf8'))
    atomicWriteJson(f.root, file, { ...metadata, name: 'Renamed outside' })

    const response = await f.read()
    expect(response.status, await response.clone().text()).toBe(200)
    expect(response.headers.get('x-live-files-recovery')).toMatch(/^trash\/live-files-recovery\/.+\.json$/)
    const loaded: any = decodeRisuDat(Buffer.from(await response.arrayBuffer()))
    expect(loaded.characters.find((character: any) => character.chaId === 'test-char-0').name).toBe('Renamed outside')
    // The notice is shown once.
    expect((await f.read()).headers.get('x-live-files-recovery')).toBeNull()

    const database = await f.exported()
    const character = database.characters.find((value: any) => value.chaId === 'test-char-0')
    expect(character.name).toBe('Renamed outside')
    expect(character.chats[0].message[0].data).toBe('pending-chat')
    const [recovery] = await f.recoveryFiles()
    expect(recovery.baseline).toBeNull()
    expect(recovery.pending.characters[0].chats[0].message[0].data).toBe('pending-chat')
})

test('accepting a reload-only external change during a pending save keeps the app state in recovery', async () => {
    const f = await fixture()
    await f.pendingChat()
    const settings = JSON.parse(await readFile(path.join(f.root, 'settings/app.json'), 'utf8'))
    atomicWriteJson(f.root, 'settings/app.json', { ...settings, customCSS: 'body { color: blue; }' })

    const { pending } = await (await f.client.fetch('/api/external-changes', { headers: f.headers })).json()
    expect(pending).toMatchObject({ reloadOnAccept: true })
    const resolved = await f.client.fetch('/api/external-changes/resolve', {
        method: 'POST', headers: { ...f.headers, 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'accept', revision: pending.revision }),
    })
    expect(resolved.status, await resolved.clone().text()).toBe(200)
    expect(await resolved.json()).toMatchObject({ resolved: true, reload: true })

    const response = await f.read()
    expect(response.status, await response.clone().text()).toBe(200)
    expect(response.headers.get('x-live-files-recovery')).toMatch(/^trash\/live-files-recovery\//)
    expect((await f.exported()).customCSS).toBe('body { color: blue; }')
    const [recovery] = await f.recoveryFiles()
    expect(recovery.pending.characters[0].chats[0].message[0].data).toBe('pending-chat')
})
