import { test, expect } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtemp, rm, readFile, access } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { createHash } from 'node:crypto'
import { userInfo } from 'node:os'
const require = createRequire(import.meta.url)
const { createWindowsTransfers } = require('./transfer-windows.cjs')
const { createPlaySetService } = require('./play-set-service.cjs')
const { createFileKv } = require('./file-kv.cjs')
const { createRuntimeMemoryService } = require('./risubard-memory-runtime.cjs')

test.skipIf(process.platform !== 'win32' || !process.env.RISUBARD_TEST_TRANSFER_EXE)('actual Windows current-user broker imports a v2 archive, keeps identity and isolates its inbox', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bard-win-ß-한글-'))
    const helper = resolve(process.env.RISUBARD_TEST_TRANSFER_EXE!)
    let child: ReturnType<typeof spawn> | undefined
    let owner: ReturnType<typeof spawn> | undefined
    const stop = async () => { if (child && child.exitCode === null) { const ended = new Promise(resolve => child!.once('exit', resolve)); child.kill(); await ended } }
    const start = async () => {
        child = spawn(helper, ['--risubard-service', root, ...(owner ? ['--owner', String(owner.pid)] : [])], { windowsHide: true, stdio: 'ignore' })
        for (let n = 0; n < 100; n++) {
            if (child.exitCode !== null) throw new Error('Broker exited: ' + child.exitCode)
            try { await access(join(root, 'transfer-native/identity.dpapi')); await new Promise(resolve => setTimeout(resolve, 150)); return }
            catch { await new Promise(resolve => setTimeout(resolve, 100)) }
        }
        throw new Error('Broker did not start')
    }
    try {
        const service = createPlaySetService({ dataRoot: root, readDatabase: async () => ({ characters: [{ chaId: 'card', name: '합성', chats: [{ id: 'chat', name: '합성', message: [{ role: 'char', data: '합성 검사' }] }] }] }),
            memory: createRuntimeMemoryService(root), storage: createFileKv({ dataRoot: root }), readInlay: async () => null, installInlay: async () => {}, removeInlay: async () => {} })
        const entry = await service.exportSet({ characterId: 'card', chatIds: ['chat'], primaryChatId: 'chat' })
        await start()
        const broker = createWindowsTransfers(root, root, helper)
        expect(broker.available()).toBe(true)
        const identity = await broker.dispatch('identity')
        expect(identity.id).toMatch(/^[0-9a-f-]{36}$/)
        expect(await broker.dispatch('capabilities')).toEqual({ usbHost: true })
        const handle = await broker.dispatch('bard.export', { id: entry.id })
        expect(await readFile(join(root, 'transfer-native/archives', handle + '.risuplay'))).toEqual(await readFile(await service.file(entry.id)))
        expect(await broker.dispatch('inbox.list')).toEqual([])
        await broker.dispatch('state.write', { key: 'queue', value: [] })
        await expect(broker.dispatch('file.stage', { path: 'C:/unrelated' })).rejects.toThrow('Unsupported')
        const pipe = '\\\\.\\pipe\\RisuBard.PlaySet.' + createHash('sha256').update(resolve(root)).digest('hex').toUpperCase().slice(0, 16) + '.' + userInfo().username.replaceAll('\\', '_')
        const held = [] as ReturnType<typeof connect>[]
        try {
            for (let n = 0; n < 8; n++) {
                // A completed RPC may still be disposing its pipe before the next listener opens.
                for (let attempt = 0; ; attempt++) {
                    try {
                        held.push(await new Promise<ReturnType<typeof connect>>((yes, no) => { const socket = connect(pipe); socket.once('connect', () => yes(socket)); socket.once('error', no) }))
                        break
                    } catch (error) {
                        if (attempt >= 49 || !['ENOENT', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
                        await new Promise(resolve => setTimeout(resolve, 20))
                    }
                }
            }
            await new Promise(resolve => setTimeout(resolve, 600))
            expect(child!.exitCode, 'eight busy pipes must not kill the broker').toBeNull()
        } finally { for (const socket of held) socket.destroy() }
        await new Promise(resolve => setTimeout(resolve, 350))
        expect(await broker.dispatch('identity')).toEqual(identity)
        await stop(); await start()
        expect(await broker.dispatch('identity')).toEqual(identity)
        await stop()
        owner = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: 'ignore' })
        await start()
        expect(await broker.dispatch('identity')).toEqual(identity)
        owner.kill()
        for (let n = 0; n < 50 && child!.exitCode === null; n++) await new Promise(resolve => setTimeout(resolve, 100))
        expect(child!.exitCode).toBe(0)
    } finally { owner?.kill(); await stop(); await rm(root, { recursive: true, force: true }) }
}, 60000)
