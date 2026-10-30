import { expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'

const { createUserDataRepository } = require('./user-data-repository.cjs')
const { createFileKv } = require('./file-kv.cjs')
const { encodeRisuSaveLegacyBuffer, decodeRisuSave } = require('./utils.cjs')

test.each([
    {patchFirst:false}, {patchFirst:true},
    {patchFirst:false, externalDecision:'accept'}, {patchFirst:false, externalDecision:'keep'},
    {patchFirst:false, patchAfter:true},
    {patchFirst:false, externalDecision:'accept', coldStart:true}, {patchFirst:false, externalDecision:'keep', coldStart:true},
    {patchFirst:false, concurrentStats:true},
    {patchFirst:false, externalBeforeRead:true},
])('a chat write preserves all chats without a loaded cache: $patchFirst / $patchAfter / $externalDecision / $coldStart / $concurrentStats / $externalBeforeRead', async ({patchFirst,patchAfter,externalDecision,coldStart,concurrentStats,externalBeforeRead}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bard-shutdown-recovery-'))
    const repository = createUserDataRepository({ dataRoot: root })
    const chat = { id: 'chat', name: 'Chat', message: [{ role: 'user', data: 'Before' }] }
    const database = { language: 'en', botPresets: [], modules: [], personas: [], loreBook: [], characters: [{
        chaId: 'one', type: 'character', name: 'One', desc: 'Before', chats: [chat, { id: 'other', name: 'Other', message: [{ role: 'user', data: 'Preserve unrelated chat' }] }],
    }] }
    if (!concurrentStats) repository.importLegacyDatabase(database, { mode: 'sync' })
    const store = createFileKv({ dataRoot: root })
    // A prior canonical-only flush deliberately removed the compatibility DB.
    if (!concurrentStats) store.kvSet('database/canonical-projection-revision', Buffer.from(repository.getProjectionRevision()))
    if (concurrentStats || externalBeforeRead) {
        // Exercise the asynchronous legacy decoder; canonical hydration is now synchronous.
        store.kvSet('database/database.bin', encodeRisuSaveLegacyBuffer(database))
    }
    fs.writeFileSync(path.join(root, '__password'), 'synthetic-shutdown-test')
    const reservation = net.createServer()
    await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
    const port = (reservation.address() as net.AddressInfo).port
    await new Promise<void>(resolve => reservation.close(() => resolve()))
    const missingCache = path.join(root,'missing-compatibility')
    const preload = path.join(root,'missing-cache.cjs')
    fs.writeFileSync(preload, 'const fs=require("node:fs");const mod=require('+JSON.stringify(require.resolve('./file-kv.cjs'))+');const create=mod.createFileKv;mod.createFileKv=(...args)=>{const store=create(...args);const get=store.kvGet;store.kvGet=key=>key==="database/database.bin"&&fs.existsSync('+JSON.stringify(missingCache)+')?null:get(key);return store};')
    const delayStart = path.join(root, 'delay-first-decode'), delayEntered = path.join(root, 'decode-entered'), delayRelease = path.join(root, 'release-decode')
    if (concurrentStats) fs.appendFileSync(preload, '\nconst utils=require('+JSON.stringify(require.resolve('./utils.cjs'))+');const decode=utils.decodeRisuSave;let delayed=false;utils.decodeRisuSave=async(...args)=>{if(!delayed&&fs.existsSync('+JSON.stringify(delayStart)+')){delayed=true;fs.writeFileSync('+JSON.stringify(delayEntered)+',"entered");while(!fs.existsSync('+JSON.stringify(delayRelease)+'))await new Promise(resolve=>setTimeout(resolve,10));}return decode(...args)};')
    const child = spawn(process.execPath, ['--require',preload,path.join(process.cwd(), 'server/node/server.cjs')], {
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
        if (externalBeforeRead) {
            const resolver = require('./character-directories.cjs').createCharacterDirectoryResolver(root)
            const file = path.join(root,resolver.characterDirectory('one'),'metadata.json')
            const external = JSON.stringify({...JSON.parse(fs.readFileSync(file,'utf8')),desc:'External hand edit before first read'})
            fs.writeFileSync(file, external)
            for (const route of ['/api/chat-content/one/0','/api/db/stats/characters']) {
                const response = await fetch(base+route,{headers:{...headers,'x-chat-id':'chat'}})
                expect(response.ok,await response.clone().text()).toBe(true)
                if (route.includes('chat-content')) expect(await decodeRisuSave(Buffer.from(await response.arrayBuffer()))).toEqual(chat)
                expect(fs.readFileSync(file,'utf8')).toBe(external)
            }
            const blocked = await fetch(base+'/api/chat-content/one/0',{method:'POST',headers:{...headers,'x-chat-id':'chat'},body:JSON.stringify(chat)})
            expect(blocked.status,await blocked.clone().text()).toBe(409)
            expect(fs.readFileSync(file,'utf8')).toBe(external)
            return
        }
        if (externalDecision && !coldStart) {
            const full = await fetch(base+'/api/write', {method:'POST',headers:{...headers,'content-type':'application/octet-stream','file-path':Buffer.from('database/database.bin').toString('hex')},body:encodeRisuSaveLegacyBuffer(database)})
            expect(full.ok,await full.clone().text()).toBe(true)
        }
        if (patchFirst) {
            fs.writeFileSync(missingCache,'simulate deferred compatibility cache absence')
            const patched = await fetch(base+'/api/patch',{method:'POST',headers:{...headers,'file-path':Buffer.from('database/database.bin').toString('hex')},body:JSON.stringify({patch:[],expectedHash:'incorrect'})})
            expect(patched.status,await patched.clone().text()).toBe(409)
        }
        const updated = { ...chat, message: [...chat.message, { role: 'char', data: 'Acknowledged without read' }] }
        let statistics: Promise<Response> | undefined
        if (concurrentStats) {
            fs.writeFileSync(delayStart, 'enabled')
            statistics = fetch(base+'/api/db/stats/characters', { headers })
            void statistics.catch(() => {}) // Awaited below; also handle teardown after an earlier assertion fails.
            await expect.poll(() => fs.existsSync(delayEntered), { timeout: 5000 }).toBe(true)
        }
        const write = await fetch(base+'/api/chat-content/one/0', { method:'POST',headers:{...headers,'x-chat-id':'chat'},body:JSON.stringify(updated) })
        expect(write.ok, await write.clone().text()).toBe(true)
        if (statistics) {
            fs.writeFileSync(delayRelease, 'released')
            const result = await statistics
            expect(result.ok, await result.clone().text()).toBe(true)
        }
        if (patchAfter) {
            const patched=await fetch(base+'/api/patch',{method:'POST',headers:{...headers,'file-path':Buffer.from('database/database.bin').toString('hex')},body:JSON.stringify({patch:[],expectedHash:'incorrect'})})
            expect(patched.status,await patched.clone().text()).toBe(409)
        }
        if (externalDecision) {
            const resolver=require('./character-directories.cjs').createCharacterDirectoryResolver(root)
            const file=path.join(root,resolver.characterDirectory('one'),'metadata.json')
            fs.writeFileSync(file,JSON.stringify({...JSON.parse(fs.readFileSync(file,'utf8')),desc:'External edit'}))
            const review=await (await fetch(base+'/api/external-changes',{headers})).json()
            expect(review.pending).not.toBeNull()
            const resolved=await fetch(base+'/api/external-changes/resolve',{method:'POST',headers,body:JSON.stringify({decision:externalDecision,revision:review.pending.revision})})
            expect(resolved.ok,await resolved.clone().text()).toBe(true)
        }
        const flush = await fetch(base+'/api/db/flush?mode=canonical', { method:'POST',headers })
        expect(await flush.json()).toMatchObject({success:true})
        const reopened = createUserDataRepository({dataRoot:root}).exportLegacyDatabase()
        expect(reopened.characters[0].chats[0]).toEqual(updated)
        expect(reopened.characters[0].chats[1]).toEqual(database.characters[0].chats[1])
        if(externalDecision) expect(reopened.characters[0].desc).toBe(externalDecision==='accept'?'External edit':'Before')
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill()
            await new Promise(resolve => child.once('exit', resolve))
        }
        if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir())) throw new Error('Unexpected test root')
        fs.rmSync(root, { recursive: true, force: true })
    }
}, 30_000)
