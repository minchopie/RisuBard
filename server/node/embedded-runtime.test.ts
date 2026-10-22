import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
const { embeddedRuntime } = createRequire(import.meta.url)('./embedded-runtime.cjs')

describe('Android embedded server boundary', () => {
    it('preserves desktop binding and constrains only the embedded runtime', () => {
        expect(embeddedRuntime({}).host).toBeUndefined()
        expect(embeddedRuntime({ RISUBARD_EMBEDDED_ANDROID: '1' }).host).toBe('127.0.0.1')
    })
    it('publishes only the actual loopback address after binding', () => {
        const root = mkdtempSync(join(tmpdir(), 'bard-embedded-'))
        const runtime = embeddedRuntime({ RISUBARD_EMBEDDED_ANDROID: '1' })
        try {
            expect(() => runtime.ready({ address: () => ({ address: '0.0.0.0', port: 1 }) }, root)).toThrow('loopback')
            runtime.ready({ address: () => ({ address: '127.0.0.1', port: 12345 }) }, root)
            expect(JSON.parse(readFileSync(join(root, '.android-server.json'), 'utf8'))).toEqual({ pid: process.pid, port: 12345 })
        } finally { rmSync(root, { recursive: true, force: true }) }
    })
    it('closes the child when its Android owner pipe closes', async () => {
        const script = `require(${JSON.stringify(createRequire(import.meta.url).resolve('./embedded-runtime.cjs'))}).embeddedRuntime({RISUBARD_EMBEDDED_ANDROID:'1'}).watchOwner(() => process.exit(0)); console.log('ready'); setInterval(() => {}, 1000)`
        const child = spawn(process.execPath, ['-e', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        try {
            await once(child.stdout, 'data')
            const closed = once(child, 'exit')
            child.stdin.end()
            expect((await closed)[0]).toBe(0)
        } finally { if (child.exitCode === null) child.kill() }
    })
})
