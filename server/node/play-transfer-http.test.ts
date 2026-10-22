import { test, expect } from 'vitest'
import fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createUserDataRepository } = require('./user-data-repository.cjs')
const { encodeRisuSaveLegacyBuffer, decodeRisuSave } = require('./utils.cjs')

test.each([false, true])('real HTTP receive/save/restart uses canonical storage (new character=%s)', async (newCharacter) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'bard-transfer-http-'))
    const dataRoot = join(root, 'data')
    const database: any = { language: 'ko', botPresets: [], modules: [], personas: [], loreBook: [], characters: [
        { chaId: 'card', type: 'character', name: '합성 전송', chats: [{ id: 'chat', name: '보존', note: '', localLore: [], message: [{ role: 'char', data: '디스크 보존' }] }] },
    ] }
    createUserDataRepository({ dataRoot }).importLegacyDatabase(database, { mode: 'sync' })
    await fs.writeFile(join(dataRoot, '__password'), 'synthetic-transfer-test')
    let child: ReturnType<typeof spawn> | undefined, base = '', logs = ''
    const start = async () => {
        await fs.rm(join(dataRoot, '.android-server.json'), { force: true })
        child = spawn(process.execPath, [join(process.cwd(), 'server/node/server.cjs')], {
            cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, RISUBARD_DATA_ROOT: dataRoot, RISUBARD_EMBEDDED_ANDROID: '1', PORT: '0', OPEN_BROWSER: '0', RISU_UPDATE_CHECK: 'false' },
        })
        child.stdout!.on('data', b => { logs += b }); child.stderr!.on('data', b => { logs += b })
        for (let n = 0; n < 150; n++) {
            if (child.exitCode !== null) throw new Error(logs)
            try { const ready = JSON.parse(await fs.readFile(join(dataRoot, '.android-server.json'), 'utf8')); base = `http://127.0.0.1:${ready.port}`; return }
            catch { await new Promise(resolve => setTimeout(resolve, 100)) }
        }
        throw new Error('Server did not start: ' + logs)
    }
    const stop = async () => { if (child && child.exitCode === null) { const ended = new Promise(resolve => child!.once('exit', resolve)); child.kill(); await ended } }
    const login = async () => {
        const response = await fetch(base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'synthetic-transfer-test' }) })
        expect(response.ok, await response.clone().text()).toBe(true)
        return (await response.json()).token
    }
    try {
        await start()
        let token = await login()
        const headers = () => ({ 'risu-auth': token, 'x-session-id': 'transfer-test', 'content-type': 'application/json' })
        const post = async (path: string, body = {}) => new Promise<any>((yes, no) => {
            const bytes = Buffer.from(JSON.stringify(body)), middle = Math.ceil(bytes.length / 2)
            const req = request(base + path, { method: 'POST', headers: headers() }, response => {
                let output = ''; response.on('data', b => { output += b }); response.on('error', no)
                response.on('end', () => { try { expect(response.statusCode, output).toBe(200); yes(JSON.parse(output)) } catch (error) { no(error) } })
            })
            req.on('error', no); req.write(bytes.subarray(0, middle))
            setTimeout(() => req.end(bytes.subarray(middle)), 30)
        })
        await post('/api/session')
        const initial = await fetch(base + '/api/read', { headers: { ...headers(), 'file-path': Buffer.from('database/database.bin').toString('hex') } })
        expect(initial.ok, await initial.clone().text()).toBe(true)
        Object.assign(database, await decodeRisuSave(Buffer.from(await initial.arrayBuffer())))
        const exported = await post('/api/play-transfer/export', { characterId: 'card', chatIds: ['chat'], primaryChatId: 'chat' })
        const file = await fs.readFile(join(dataRoot, 'play-transfer', exported.id, 'export.risuplay'))
        const write = (id?: string) => fetch(base + '/api/write', { method: 'POST', headers: { ...headers(), 'content-type': 'application/octet-stream', 'file-path': Buffer.from('database/database.bin').toString('hex'), ...(id ? { 'x-play-transfer-id': id } : {}) }, body: encodeRisuSaveLegacyBuffer(database) })
        if (newCharacter) {
            database.characters[0].chaId = 'unrelated'; database.characters[0].name = '기존 다른 캐릭터'
            const changed = await write(); expect(changed.ok, await changed.clone().text()).toBe(true)
        }
        const incoming = await fetch(base + '/api/play-transfer/incoming', { method: 'POST', headers: { ...headers(), 'content-type': 'application/octet-stream' }, body: file })
        expect(incoming.ok, await incoming.clone().text()).toBe(true)
        const entry = await incoming.json(), plan = await post(`/api/play-transfer/${entry.id}/prepare`)
        if (!newCharacter) expect(plan.added[0].chat.id).not.toBe('chat')
        await post(`/api/play-transfer/${entry.id}/arm`, { transaction: plan.transaction, added: plan.added })
        expect(plan.newCharacters).toHaveLength(newCharacter ? 1 : 0)
        const blocked = await write()
        expect(blocked.status).toBe(423); expect((await blocked.json()).code).toBe('TRANSFER_BUSY')
        const removal = await fetch(base + '/api/remove', { headers: { ...headers(), 'file-path': Buffer.from('assets/unrelated').toString('hex') } })
        expect(removal.status).toBe(423); expect((await removal.json()).code).toBe('TRANSFER_BUSY')
        // The real client sends chat bodies separately; its DB encoder publishes only stubs.
        for (const row of plan.added) {
            const response = await fetch(base + `/api/chat-content/${row.characterId}/1`, {
                method: 'POST', headers: { ...headers(), 'content-type': 'application/octet-stream', 'x-chat-id': row.chat.id, 'x-play-transfer-id': plan.transaction }, body: encodeRisuSaveLegacyBuffer(row.chat),
            })
            expect(response.ok, await response.clone().text()).toBe(true)
        }
        database.characters.push(...plan.newCharacters)
        for (const row of plan.added) database.characters.find((c: any) => c.chaId === row.characterId).chats.push({ id: row.chat.id, name: row.chat.name, _stub: true })
        database.risuPlaySets = plan.registry
        const saved = await write(plan.transaction)
        expect(saved.ok, await saved.clone().text() + '\n' + (!saved.ok ? await fetch(base + '/api/external-changes', { headers: headers() }).then(r => r.text()) : '')).toBe(true)
        const flush = await fetch(base + '/api/db/flush?mode=canonical', { method: 'POST', headers: { ...headers(), 'x-play-transfer-id': plan.transaction } })
        expect(flush.ok, await flush.clone().text()).toBe(true)
        await stop(); await start(); token = await login()
        await post('/api/session')
        expect((await post(`/api/play-transfer/${entry.id}/finish`)).state).toBe('applied')
        expect((await write(plan.transaction)).status).toBe(423)
        const durable = createUserDataRepository({ dataRoot }).exportLegacyDatabase()
        expect(durable.characters[0].chats).toHaveLength(newCharacter ? 1 : 2)
        const received = durable.characters.find((c: any) => c.chaId === plan.added[0].characterId).chats.find((c: any) => c.id === plan.added[0].chat.id)
        expect(received.message[0].data).toBe('디스크 보존')
    } finally { await stop(); await fs.rm(root, { recursive: true, force: true }) }
}, 60000)
