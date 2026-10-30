import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect, vi } from 'vitest'

const source = readFileSync(resolve(process.cwd(), 'server/node/server.cjs'), 'utf8')
const start = source.indexOf('let shuttingDown = false;')
const body = source.slice(start, source.indexOf('// SIGHUP:', start))

function fixture() {
    const events = { close: vi.fn() }, tunnel = vi.fn(), uploads = { close: vi.fn(async () => {}) }
    const flush = vi.fn(async () => {}), files = { close: vi.fn() }, observation = { flush: vi.fn(async () => {}) }
    const unlink = vi.fn(), process = { exit: vi.fn() }, logger = { warn: vi.fn(), error: vi.fn() }
    const shutdown = new Function('liveFileEvents', 'stopTunnel', 'chatContentUploads', 'flushPendingDbWithinQueue', 'liveCharacterFiles', 'saveObservation', 'unlinkSync', 'process', 'logger', 'console',
        `const localShutdownTokenPath='synthetic', liveFilesPendingWrites=false, embedded={enabled:true};
        const queueStorageOperation=operation=>Promise.resolve().then(operation);
        const recoverFailedCanonicalTransaction=()=>{};
        ${body}; return shutdownGracefully;`)(events, tunnel, uploads, flush, files, observation, unlink, process, logger, { log() {} })
    return { shutdown, events, tunnel, uploads, flush, files, observation, unlink, process }
}

test('cleanup exceptions cannot skip the data flush or strand an ownerless server', async () => {
    const f = fixture(), fail = () => { throw new Error('synthetic cleanup failure') }
    f.events.close.mockImplementation(fail); f.tunnel.mockImplementation(fail)
    f.uploads.close.mockRejectedValue(new Error('upload cleanup'))
    f.files.close.mockImplementation(fail); f.observation.flush.mockRejectedValue(new Error('observation cleanup'))
    await expect(f.shutdown('owner EOF')).resolves.toBeUndefined()
    expect(f.flush).toHaveBeenCalledOnce()
    expect(f.flush).toHaveBeenCalledWith({ materialize: false, deferCompatibility: true })
    expect(f.files.close).toHaveBeenCalledOnce()
    expect(f.observation.flush).toHaveBeenCalledOnce()
    expect(f.unlink).toHaveBeenCalledOnce()
    expect(f.process.exit).toHaveBeenCalledExactlyOnceWith(0)
})

test('a second signal cannot exit before the first pending flush, including its failure path', async () => {
    const f = fixture()
    let reject!: (error: Error) => void
    f.flush.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
    const first = f.shutdown('owner EOF')
    await vi.waitFor(() => expect(f.flush).toHaveBeenCalledOnce())
    await f.shutdown('SIGTERM')
    expect(f.process.exit).not.toHaveBeenCalled()
    reject(new Error('disk full')); await first
    expect(f.process.exit).toHaveBeenCalledExactlyOnceWith(1)
})
