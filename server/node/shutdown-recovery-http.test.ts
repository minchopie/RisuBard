import { expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'

const { createUserDataRepository } = require('./user-data-repository.cjs')
const { createFileKv } = require('./file-kv.cjs')
const { encodeRisuSaveLegacyBuffer, decodeRisuSave } = require('./utils.cjs')

test('shutdown preserves acknowledged pending chat separately from an external edit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bard-shutdown-recovery-'))
    const repository = createUserDataRepository({ dataRoot: root })
    const chat = { id: 'chat', name: 'Chat', message: [{ role: 'user', data: 'Before' }] }
    const database = { language: 'en', botPresets: [], modules: [], personas: [], loreBook: [], characters: [{
        chaId: 'one', type: 'character', name: 'One', desc: 'Before', chats: [chat],
    }] }
    repository.importLegacyDatabase(database, { mode: 'sync' })
    const store = createFileKv({ dataRoot: root })
    store.kvSet('database/database.bin', encodeRisuSaveLegacyBuffer(database))
    store.kvSet('database/canonical-projection-revision', Buffer.from(repository.getProjectionRevision()))
    fs.writeFileSync(path.join(root, '__password'), 'synthetic-shutdown-test')
    const reservation = net.createServer()
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
    const port = (reservation.address() as net.AddressInfo).port
    await new Promise<void>(resolve => reservation.close(() => resolve()))
    const child = spawn(process.execPath, [path.join(process.cwd(), 'server/node/server.cjs')], {
        cwd: root, env: { ...process.env, RISUBARD_DATA_ROOT: root, PORT: String(port), OPEN_BROWSER: '0' },
        windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let logs = ''
    child.stdout.on('data', value => { logs += value })
    child.stderr.on('data', value => { logs += value })
    const base = `http://127.0.0.1:${port}`
    try {
        await expect.poll(async () => {
            if (child.exitCode !== null) throw new Error(logs)
            try { return (await fetch(`${base}/api/test_auth`)).ok } catch { return false }
        }, { timeout: 10_000 }).toBe(true)
        const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'synthetic-shutdown-test' }) })
        const { token } = await login.json()
        const headers = { 'content-type': 'application/json', 'risu-auth': token, 'x-session-id': 'shutdown-test' }
        const read = await fetch(`${base}/api/read`, { headers: { ...headers, 'file-path': Buffer.from('database/database.bin').toString('hex') } })
        expect(read.ok, logs).toBe(true)
        await read.arrayBuffer()
        const updated = { ...chat, message: [...chat.message, { role: 'char', data: 'Acknowledged before shutdown' }] }
        const write = await fetch(`${base}/api/chat-content/one/0`, { method: 'POST', headers: { ...headers, 'x-chat-id': 'chat' }, body: JSON.stringify(updated) })
        expect(write.ok, await write.clone().text()).toBe(true)
        const resolver = require('./character-directories.cjs').createCharacterDirectoryResolver(root)
        const metadataFile = path.join(root, resolver.characterDirectory('one'), 'metadata.json')
        const external = JSON.stringify({ ...JSON.parse(fs.readFileSync(metadataFile, 'utf8')), desc: 'External edit to preserve' })
        fs.writeFileSync(metadataFile, external)
        const flush = await fetch(`${base}/api/db/flush?mode=canonical`, { method: 'POST', headers })
        expect(await flush.json()).toMatchObject({ paused: true, externalChangesPending: true })
        const tokenPath = path.join(os.tmpdir(), `risubard-shutdown-${port}.token`)
        const stopped = new Promise<number | null>(resolve => child.once('exit', resolve))
        const shutdown = await fetch(`${base}/api/local-shutdown`, { method: 'POST', headers: { 'x-risubard-shutdown-token': fs.readFileSync(tokenPath, 'utf8').trim() } })
        expect(shutdown.ok).toBe(true)
        expect(await stopped, logs).toBe(1)
        expect(fs.readFileSync(metadataFile, 'utf8')).toBe(external)
        const recoveryDirectory = path.join(root, 'trash/shutdown-recovery')
        const files = fs.readdirSync(recoveryDirectory).filter(name => name.endsWith('.bin'))
        expect(files).toHaveLength(1)
        const recovery = await decodeRisuSave(fs.readFileSync(path.join(recoveryDirectory, files[0])))
        expect(recovery.characters[0].chats[0]).toEqual(updated)
        expect(recovery.characters[0].desc).toBe('Before')
        expect(logs).toContain('shutdown-recovery/')
        expect(fs.existsSync(tokenPath)).toBe(false)
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill()
            await new Promise(resolve => child.once('exit', resolve))
        }
        if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir())) throw new Error('Unexpected test root')
        fs.rmSync(root, { recursive: true, force: true })
    }
}, 30_000)
