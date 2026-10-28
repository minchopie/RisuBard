import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { expect, test, vi } from 'vitest'
import { waitForSendSync } from '../process/sendPreparation'
import { captureGenerationTarget, createGenerationScope } from '../process/generationTarget'

// Exercise the actual runtime response handler without mounting the application.
const source = readFileSync(resolve(process.cwd(), 'src/ts/globalApi.svelte.ts'), 'utf8')
const start = source.indexOf('    async function syncLiveFilesNow()')
const end = source.indexOf('    const refreshThisRuntime =', start)
const handler = ts.transpile(source.slice(start, end), { target: ts.ScriptTarget.ES2022 })

test('an error with a newer revision cannot consume the unseen snapshot revision', async () => {
    const response = { revision: 'new', etag: 'etag', error: 'External files are being saved; retry in a moment' }
    const syncLiveFiles = vi.fn(async () => response)
    const create = new Function('forageStorage', `
        let liveRevision = 'old', lastLiveError = '', gotChannel = false;
        const supportsPatchSync = true, saveRuntime = { isActive: () => true }, notifyError = () => {};
        const getDatabase = () => ({ externalChangeReview: false });
        ${handler}
        return { sync: syncLiveFilesNow, revision: () => liveRevision };
    `)
    const runtime = create({ syncLiveFiles })
    await expect(runtime.sync()).rejects.toThrow('External files are being saved')
    expect(runtime.revision()).toBe('old')
    await expect(runtime.sync()).rejects.toThrow('External files are being saved')
    expect(syncLiveFiles).toHaveBeenLastCalledWith('old')
})

test('send preflight failure is a visible false result before any generation starts', async () => {
    const sendSource = readFileSync(resolve(process.cwd(), 'src/ts/process/index.svelte.ts'), 'utf8')
    const sendStart = sendSource.indexOf('export async function sendChat(')
    const bodyMarker = '} = {}):Promise<boolean> {'
    const bodyStart = sendSource.indexOf(bodyMarker, sendStart) + bodyMarker.length
    const bodyEnd = sendSource.indexOf('    const parseGenerationText =', bodyStart)
    expect(sendStart).toBeGreaterThanOrEqual(0)
    expect(bodyStart).toBeGreaterThan(sendStart)
    expect(bodyEnd).toBeGreaterThan(bodyStart)
    const preflight = ts.transpile(`async function preflight(arg = {}) { ${sendSource.slice(bodyStart, bodyEnd)}; return true }`, { target: ts.ScriptTarget.ES2022 })
    const notifyError = vi.fn()
    const refreshLiveFiles = vi.fn(async () => { throw new Error('writer inactive') })
    const dependencies = {
        refreshLiveFiles, notifyError, waitForSendSync, captureGenerationTarget, createGenerationScope,
        DBState: { db: { characters: [{ chaId: 'bot', chatPage: 0, chats: [{ id: 'A' }] }] } },
        get: () => 0, selectedCharID: {}, language: {}, forageStorage: {}, transferBusy: {}, syncSaveHold: {},
    }
    const run = new Function(...Object.keys(dependencies), `${preflight}; return preflight`)(...Object.values(dependencies))
    await expect(run()).resolves.toBe(false)
    expect(refreshLiveFiles).toHaveBeenCalledOnce()
    expect(notifyError).toHaveBeenCalledWith(expect.stringContaining('writer inactive'))
})
