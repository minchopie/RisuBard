import { afterEach, describe, expect, test } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fork, spawnSync, type ChildProcess } from 'node:child_process'

const roots: string[] = []
const lockModule = resolve('server/node/data-root-lock.cjs')

function tempRoot() {
    const root = mkdtempSync(join(tmpdir(), 'risubard-data-root-lock-'))
    roots.push(root)
    return root
}

function waitForMessage(child: ChildProcess, type: string) {
    return new Promise<Record<string, unknown>>((resolveMessage, reject) => {
        const onMessage = (message: unknown) => {
            if ((message as { type?: string })?.type !== type) return
            cleanup()
            resolveMessage(message as Record<string, unknown>)
        }
        const onExit = (code: number | null) => {
            cleanup()
            reject(new Error(`lock holder exited before ${type} (code ${code})`))
        }
        const cleanup = () => {
            child.off('message', onMessage)
            child.off('exit', onExit)
        }
        child.on('message', onMessage)
        child.on('exit', onExit)
    })
}

afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('data-root process lock', () => {
    test.each(['0', '1'])('handles a stale PID reused by another UID in embedded mode %s', (embedded) => {
        const root = tempRoot()
        const result = spawnSync(process.execPath, ['-e', `
            const assert = require('node:assert/strict')
            const fs = require('node:fs')
            const path = require('node:path')
            const lockPath = path.join(process.env.DATA_ROOT, '.risubard-server.lock')
            fs.mkdirSync(lockPath)
            fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid + 1 }))
            process.kill = () => { throw Object.assign(new Error('other UID'), { code: 'EPERM' }) }
            const { acquireDataRootLock } = require(process.env.LOCK_MODULE)
            if (process.env.RISUBARD_EMBEDDED_ANDROID === '1') acquireDataRootLock(process.env.DATA_ROOT).release()
            else assert.throws(() => acquireDataRootLock(process.env.DATA_ROOT), { code: 'DATA_ROOT_IN_USE' })
        `], {
            env: { ...process.env, LOCK_MODULE: lockModule, DATA_ROOT: root, RISUBARD_EMBEDDED_ANDROID: embedded },
            encoding: 'utf8', timeout: 3000,
        })
        expect(result.status, result.stderr).toBe(0)
    })

    test.each(['SIGINT', 'SIGTERM'])('releases the lock on %s without a shutdown handler', (signal) => {
        const root = tempRoot()
        const result = spawnSync(process.execPath, ['-e', `
            require(process.env.LOCK_MODULE).acquireDataRootLock(process.env.DATA_ROOT)
            // Windows cannot deliver POSIX signals; exercise the same Node event.
            if (process.platform === 'win32') process.emit(process.env.STOP_SIGNAL)
            else process.kill(process.pid, process.env.STOP_SIGNAL)
            setInterval(() => {}, 1000)
        `], {
            env: { ...process.env, LOCK_MODULE: lockModule, DATA_ROOT: root, STOP_SIGNAL: signal },
            encoding: 'utf8',
            timeout: 3000,
        })
        expect(result.error).toBeUndefined()
        expect(existsSync(join(root, '.risubard-server.lock'))).toBe(false)
        if (process.platform !== 'win32') expect(result.signal).toBe(signal)
    })

    test.each(['SIGINT', 'SIGTERM'])('keeps the lock during asynchronous %s shutdown', (signal) => {
        const root = tempRoot()
        const result = spawnSync(process.execPath, ['-e', `
            const assert = require('node:assert/strict')
            const fs = require('node:fs')
            const { acquireDataRootLock } = require(process.env.LOCK_MODULE)
            const lock = acquireDataRootLock(process.env.DATA_ROOT)
            let calls = 0
            process.on(process.env.STOP_SIGNAL, async () => {
                assert.equal(++calls, 1)
                assert.ok(fs.existsSync(lock.lockPath))
                await new Promise(resolve => setTimeout(resolve, 50))
                assert.ok(fs.existsSync(lock.lockPath))
                assert.throws(() => acquireDataRootLock(process.env.DATA_ROOT), { code: 'DATA_ROOT_IN_USE' })
                process.exit(0)
            })
            process.emit(process.env.STOP_SIGNAL)
        `], {
            env: { ...process.env, LOCK_MODULE: lockModule, DATA_ROOT: root, STOP_SIGNAL: signal },
            encoding: 'utf8',
            timeout: 3000,
        })
        expect(result.error).toBeUndefined()
        expect(result.status, result.stderr).toBe(0)
        expect(existsSync(join(root, '.risubard-server.lock'))).toBe(false)
    })

    test('rejects a second live process before it can initialize the shared data root', async () => {
        const root = tempRoot()
        const holderPath = join(root, 'holder.cjs')
        const contenderPath = join(root, 'contender.cjs')
        writeFileSync(holderPath, `
            const { acquireDataRootLock } = require(process.env.LOCK_MODULE)
            acquireDataRootLock(process.env.DATA_ROOT)
            process.send({ type: 'locked' })
            setInterval(() => {}, 1000)
        `)
        writeFileSync(contenderPath, `
            const { acquireDataRootLock } = require(process.env.LOCK_MODULE)
            acquireDataRootLock(process.env.DATA_ROOT)
            require('node:fs').writeFileSync(process.env.SENTINEL, 'initialized')
        `)
        const env = { ...process.env, LOCK_MODULE: lockModule, DATA_ROOT: root }
        const holder = fork(holderPath, [], {
            env,
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        })

        await waitForMessage(holder, 'locked')
        const sentinel = join(root, 'contender-initialized')
        const contender = spawnSync(process.execPath, [contenderPath], {
            env: { ...env, SENTINEL: sentinel },
            encoding: 'utf8',
        })

        expect(contender.status).toBe(1)
        expect(contender.stderr).toContain('DATA_ROOT_IN_USE')
        expect(existsSync(sentinel)).toBe(false)
        holder.kill('SIGTERM')
        await new Promise<void>(resolveExit => holder.once('exit', () => resolveExit()))
        if (process.platform !== 'win32') {
            expect(existsSync(join(root, '.risubard-server.lock'))).toBe(false)
        }
    })

    test('reclaims a lock left by a dead process', () => {
        const root = tempRoot()
        const lockPath = join(root, '.risubard-server.lock')
        const ownerPath = join(lockPath, 'owner.json')
        const script = `
            const fs = require('node:fs')
            const path = require('node:path')
            const { acquireDataRootLock } = require(process.env.LOCK_MODULE)
            fs.mkdirSync(process.env.LOCK_PATH, { recursive: true })
            fs.writeFileSync(process.env.OWNER_PATH, JSON.stringify({ pid: 2147483647 }))
            const lock = acquireDataRootLock(process.env.DATA_ROOT)
            lock.release()
        `

        const result = spawnSync(process.execPath, ['-e', script], {
            env: {
                ...process.env,
                LOCK_MODULE: lockModule,
                DATA_ROOT: root,
                LOCK_PATH: lockPath,
                OWNER_PATH: ownerPath,
            },
            encoding: 'utf8',
        })

        expect(result.status, result.stderr).toBe(0)
        expect(existsSync(lockPath)).toBe(false)
    })

    test('reclaims a lock left by a previous process with the same PID', () => {
        const root = tempRoot()
        const lockPath = join(root, '.risubard-server.lock')
        const script = `
            const fs = require('node:fs')
            const path = require('node:path')
            const { acquireDataRootLock } = require(process.env.LOCK_MODULE)
            fs.mkdirSync(process.env.LOCK_PATH, { recursive: true })
            fs.writeFileSync(
                path.join(process.env.LOCK_PATH, 'owner.json'),
                JSON.stringify({ pid: process.pid, token: 'previous-container' }),
            )
            const lock = acquireDataRootLock(process.env.DATA_ROOT)
            lock.release()
        `

        const result = spawnSync(process.execPath, ['-e', script], {
            env: { ...process.env, LOCK_MODULE: lockModule, DATA_ROOT: root, LOCK_PATH: lockPath },
            encoding: 'utf8',
        })

        expect(result.status, result.stderr).toBe(0)
        expect(existsSync(lockPath)).toBe(false)
    })

    test('server acquires the data-root lock before loading the database facade', () => {
        const source = readFileSync(resolve('server/node/server.cjs'), 'utf8')
        const acquisition = source.indexOf('acquireDataRootLock(processDataRoot);')
        expect(acquisition).toBeGreaterThan(-1)
        expect(acquisition).toBeLessThan(source.indexOf("require('./db.cjs')"))
    })
})
