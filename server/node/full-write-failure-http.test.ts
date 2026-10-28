import { expect, test } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'

const { createUserDataRepository } = require('./user-data-repository.cjs')
const { createFileKv } = require('./file-kv.cjs')
const { encodeRisuSaveLegacyBuffer, decodeRisuSave, calculateHash, normalizeJSON } = require('./utils.cjs')

test.each([...['kv','canonical','publish','publish-delayed'].flatMap(fault => (fault === 'publish-delayed' ? ['chat','flush','shutdown','external','restart-read','restart-chat','restart-patch'] : ['chat','flush','shutdown','restart-read','restart-chat','restart-patch']).map(action => ({fault,action}))), {fault:'direct-external',action:'external'}])('full database failure preserves attempted changes: $fault / $action', async ({fault,action}) => {
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
    const preload = path.join(root, 'fault.cjs')
    const faultMarker = path.join(root, 'fail-db-write')
    const modulePath = require.resolve(fault === 'kv' ? './file-kv.cjs' : fault.startsWith('publish') || fault==='direct-external' ? './file-store.cjs' : './canonical-projection-writer.cjs')
    const condition = 'fs.existsSync('+JSON.stringify(faultMarker)+')'
    fs.writeFileSync(preload, [
        "const fs=require('node:fs');const mod=require("+JSON.stringify(modulePath)+");",
        fault === 'direct-external'
            ? 'const path=require("node:path"),commit=mod.commitTransaction;mod.commitTransaction=(root,operations,options={})=>{if(!'+condition+')return commit(root,operations,options);try{return commit(root,operations,{...options,failAfterPublish:1})}catch(error){const dir=path.join(root,".journal");const name=fs.readdirSync(dir).find(name=>name.endsWith(".json"));const journal=JSON.parse(fs.readFileSync(path.join(dir,name),"utf8"));const entry=journal.entries.find(entry=>entry.staged&&fs.existsSync(entry.staged)&&fs.existsSync(path.join(root,entry.path)));if(!entry)throw new Error("Missing partial direct-write fixture");fs.appendFileSync(path.join(root,entry.path),"\\n");fs.writeFileSync(path.join(root,"direct-external-path"),entry.path);fs.unlinkSync('+JSON.stringify(faultMarker)+');throw error}};'
            : fault === 'kv'
            ? 'const create=mod.createFileKv;mod.createFileKv=(...args)=>{const store=create(...args);const write=store.kvSet;store.kvSet=(key,value)=>{if(key==="database/database.bin"&&'+condition+'){throw new Error("injected write failure")}return write(key,value)};return store};'
            : fault.startsWith('publish')
            ? 'const commit=mod.commitTransaction;mod.commitTransaction=(root,operations,options={})=>commit(root,operations,{...options,...('+condition+'?{failAfterPublish:1}:{})});'
            : 'const write=mod.writeCanonicalProjection;mod.writeCanonicalProjection=(...args)=>{if('+condition+'){throw new Error("injected canonical failure")}return write(...args)};',
        fault === 'publish-delayed' ? 'const recover=mod.recoverTransactions;mod.recoverTransactions=(...args)=>{if('+condition+')throw Object.assign(new Error("persistent disk error"),{code:"ENOSPC"});return recover(...args)};' : '',
    ].join('\n'))
    let child = spawn(process.execPath, ['--require', preload, path.join(process.cwd(), 'server/node/server.cjs')], {
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
        if(fault!=='direct-external') fs.writeFileSync(faultMarker, 'enabled')
        const incoming = structuredClone(database)
        incoming.characters[0].desc = 'Changed in full write'
        incoming.characters[0].chats[0].message.push({role:'char',data:'Attempted chat change'})
        incoming.characters.push({ ...structuredClone(incoming.characters[0]), chaId: 'two', name: 'New character' })
        const full = await fetch(base+'/api/write', { method:'POST',headers:{...headers, 'content-type':'application/octet-stream', 'file-path':Buffer.from('database/database.bin').toString('hex')},body:encodeRisuSaveLegacyBuffer(incoming) })
        expect(full.status,logs).toBe(fault==='direct-external'?200:500)
        if(fault==='direct-external') {
            Object.assign(incoming.characters[0].chats[0], {note:'Direct metadata change'})
            incoming.characters[0].chats[0].message.push({role:'char',data:'Accepted direct-lane change'})
            const saved=await fetch(base+'/api/chat-content/one/0',{method:'POST',headers:{...headers,'x-chat-id':'chat'},body:JSON.stringify(incoming.characters[0].chats[0])})
            expect(saved.ok,await saved.clone().text()).toBe(true)
            fs.writeFileSync(faultMarker,'enabled')
            const failed=await fetch(base+'/api/db/flush?mode=canonical',{method:'POST',headers})
            expect(failed.status,logs+'\n'+await failed.clone().text()).toBe(500)
            expect(fs.readdirSync(path.join(root,'.journal')).filter(name=>name.endsWith('.json'))).toHaveLength(1)
        }
        if (fault === 'publish-delayed') {
            expect(fs.readdirSync(path.join(root,'.journal')).filter(name=>name.endsWith('.json'))).toHaveLength(1)
        }
        let external: { path: string, bytes: Buffer } | undefined
        if (action === 'external') {
            const journalName = fs.readdirSync(path.join(root, '.journal')).find(name => name.endsWith('.json'))!
            const journal = JSON.parse(fs.readFileSync(path.join(root, '.journal', journalName), 'utf8'))
            const entry = journal.entries.find((value: { path: string, staged: string }) => value.path.endsWith('.json') && fs.existsSync(value.staged) && fs.existsSync(path.join(root, value.path)))
            expect(entry, JSON.stringify(journal.entries.map((value: { path: string }) => value.path))).toBeTruthy()
            if(fault==='direct-external') {
                const changed=fs.readFileSync(path.join(root,'direct-external-path'),'utf8')
                external={path:changed,bytes:fs.readFileSync(path.join(root,changed))}
            } else {
                const original = JSON.parse(fs.readFileSync(path.join(root, entry.path), 'utf8'))
                external = { path: entry.path, bytes: Buffer.from(JSON.stringify({ ...original, externalRecoveryProbe: 'external-only' })) }
                fs.writeFileSync(path.join(root, external.path), external.bytes)
                fs.unlinkSync(faultMarker)
            }
            for (const [route, method] of [['/api/external-changes', 'GET'], ['/api/db/flush?mode=canonical', 'POST']]) {
                const blocked = await fetch(base + route, { method, headers })
                expect(blocked.status).toBe(500)
                expect((await blocked.json()).error).toContain(external.path)
                expect(fs.readFileSync(path.join(root, external.path))).toEqual(external.bytes)
            }
        }
        if (action === 'shutdown' || action === 'external' || action.startsWith('restart-')) {
            const tokenPath = path.join(os.tmpdir(), 'risubard-shutdown-'+port+'.token')
            const stopped = new Promise<number | null>(resolve => child.once('exit', resolve))
            const shutdown = await fetch(base+'/api/local-shutdown',{method:'POST',headers:{'x-risubard-shutdown-token':fs.readFileSync(tokenPath,'utf8').trim()}})
            expect(shutdown.ok).toBe(true)
            expect(await stopped,logs).toBe(1)
            const directory = path.join(root,'trash/shutdown-recovery')
            const files = fs.readdirSync(directory).filter(name=>name.endsWith('.bin'))
            expect(files).toHaveLength(1)
            expect(await decodeRisuSave(fs.readFileSync(path.join(directory,files[0])))).toEqual(incoming)
            if (external || action.startsWith('restart-')) {
                if(fs.existsSync(faultMarker)) fs.unlinkSync(faultMarker)
                child = spawn(process.execPath, [path.join(process.cwd(), 'server/node/server.cjs')], {
                    cwd: root, env: {...process.env, RISUBARD_DATA_ROOT:root, PORT:String(port), OPEN_BROWSER:'0'},
                    windowsHide:true, stdio:['ignore','pipe','pipe'],
                })
                child.stdout.on('data', value=>{logs+=value});child.stderr.on('data', value=>{logs+=value})
                await expect.poll(async()=>{
                    if(child.exitCode!==null)throw new Error(logs)
                    try{return(await fetch(base+'/api/test_auth')).ok}catch{return false}
                },{timeout:10_000}).toBe(true)
                const relogin=await fetch(base+'/api/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'synthetic-shutdown-test'})})
                const nextHeaders={...headers,'risu-auth':(await relogin.json()).token}
                const expected=fault==='kv'||fault==='canonical'?database:incoming
                const readStartup=async()=>{
                    const res=await fetch(base+'/api/read',{headers:{...nextHeaders,'file-path':Buffer.from('database/database.bin').toString('hex')}})
                    expect(res.ok,logs).toBe(true)
                    return decodeRisuSave(Buffer.from(await res.arrayBuffer()))
                }
                const readChat=async()=>{
                    const res=await fetch(base+'/api/chat-content/one/0',{headers:{...nextHeaders,'x-chat-id':'chat'}})
                    expect(res.ok,await res.clone().text()).toBe(true)
                    return decodeRisuSave(Buffer.from(await res.arrayBuffer()))
                }
                if (action === 'restart-patch') {
                    const canonicalStartup = createUserDataRepository({dataRoot:root}).loadStartupDatabase()
                    const patched = await fetch(base+'/api/patch', {method:'POST',headers:{...nextHeaders,'file-path':Buffer.from('database/database.bin').toString('hex')},body:JSON.stringify({patch:[],expectedHash:calculateHash(normalizeJSON(canonicalStartup)).toString(16)})})
                    if (fault === 'publish-delayed') {
                        expect(patched.status,await patched.clone().text()).toBe(409)
                        expect((await patched.json()).code).toBe('EXTERNAL_CHANGES_PENDING')
                    } else expect(patched.status, await patched.clone().text()).toBe(200)
                }
                const startup=action==='restart-chat'||action==='restart-patch'?undefined:await readStartup()
                const stats=await fetch(base+'/api/db/stats/characters',{headers:nextHeaders})
                expect(stats.ok,await stats.clone().text()).toBe(true)
                expect(await readChat()).toEqual(expected.characters[0].chats[0])
                expect((startup??await readStartup()).characters[0].desc).toBe(expected.characters[0].desc)
                const flushed=await fetch(base+'/api/db/flush?mode=canonical',{method:'POST',headers:nextHeaders})
                expect(flushed.ok,await flushed.clone().text()).toBe(true)
                expect(createUserDataRepository({dataRoot:root}).exportLegacyDatabase()).toEqual(expected)
                expect(await decodeRisuSave(fs.readFileSync(path.join(directory,files[0])))).toEqual(incoming)
            }
            if (external) {
                const recovery = path.join(root, 'trash/transaction-recovery')
                const mappings = fs.readdirSync(recovery, { recursive: true }).map(String).filter(name => name.endsWith('mapping.json'))
                    .map(name => JSON.parse(fs.readFileSync(path.join(recovery, name), 'utf8')))
                const copy = mappings.find(value => value.source === external!.path)
                expect(copy).toBeTruthy()
                expect(fs.readFileSync(path.join(root, copy.destination))).toEqual(external.bytes)
                expect(fs.readdirSync(path.join(root, '.journal'))).toEqual([])
                expect(createUserDataRepository({ dataRoot: root }).exportLegacyDatabase()).toEqual(incoming)
            }
            return
        }
        fs.unlinkSync(faultMarker)
        const updated = action === 'chat' ? { ...chat, message: [...chat.message, { role: 'char', data: 'Accepted after failed full write' }] } : incoming.characters[0].chats[0]
        if (action === 'chat') {
            const write = await fetch(base+'/api/chat-content/one/0', {method:'POST',headers:{...headers,'x-chat-id':'chat'},body:JSON.stringify(updated)})
            expect(write.ok,await write.clone().text()).toBe(true)
        }
        const flush = await fetch(base+'/api/db/flush?mode=canonical',{method:'POST',headers})
        expect(flush.ok,await flush.clone().text()).toBe(true)
        const reopened = createUserDataRepository({dataRoot:root}).exportLegacyDatabase()
        expect(reopened.characters[0].desc).toBe('Changed in full write')
        expect(reopened.characters[0].chats[0]).toEqual(updated)
        expect(reopened.characters.find((c: {chaId:string})=>c.chaId==='two')).toEqual(incoming.characters[1])
    } finally {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill()
            await new Promise(resolve => child.once('exit', resolve))
        }
        if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir())) throw new Error('Unexpected test root')
        fs.rmSync(root, { recursive: true, force: true })
    }
}, 30_000)
