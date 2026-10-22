// The real send path's pre-send admission, built from the actual `sendChat` prefix (not a re-typed copy): with a NAS that never answers,
// the send proceeds immediately; the only refusal is an unresolved apply (hold kept), which is reported and never forced open.
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { writable, get } from 'svelte/store'
vi.mock('../transfer-sync/nasSync', () => ({ activityBlocksSync: () => false, applySync: vi.fn(), pullSync: vi.fn(), publishSync: vi.fn(), snapshotSync: vi.fn(), syncStatus: vi.fn(), reportSyncNetwork: vi.fn(), pendingRootsSync: vi.fn(), releaseSyncPlan: vi.fn(), activeChatSignature: () => '' }))
vi.mock('../transfer-sync/playTransfer', () => ({ transferUnavailable: () => false }))
vi.mock('../platform', () => ({ isNodeServer: true }))
vi.mock('../stores.svelte', () => ({ alertStore: writable({ type: 'none' }), selectedCharID: writable(0) }))
import { waitForSendSync } from './sendPreparation'
import { captureGenerationTarget, createGenerationScope } from './generationTarget'
import { preSendSync, createSyncCoordinator } from '../nasSyncCoordinator'
import { syncSaveHold } from '../transferState'

function prefix() {
    const source = readFileSync('src/ts/process/index.svelte.ts', 'utf8')
    const parsed = ts.createSourceFile('process.ts', source, ts.ScriptTarget.Latest, true)
    const send = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'sendChat') as ts.FunctionDeclaration
    const statements = send.body!.statements
    const end = statements.findIndex(node => node.getText(parsed).includes('preSendSync('))
    expect(end).toBeGreaterThan(0)
    return ts.transpileModule(`async function preflight(arg = {}) {
        ${statements.slice(0, end + 1).map(node => node.getText(parsed)).join('\n')}
        generationStarted = true; return true;
    }`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
}
function run(code: string, coordinator: any, signal?: AbortSignal) {
    const errors: string[] = [], flags = { generationStarted: false }
    const character = { chaId: 'character', chatPage: 0, chats: [{ id: 'first' }] }
    const dependencies = {
        DBState: { db: { characters: [character] } }, get, selectedCharID: writable(0), transferBusy: writable(false), syncSaveHold,
        refreshLiveFiles: async () => {}, waitForSendSync, captureGenerationTarget, createGenerationScope, chatProcessStage: { set() {} },
        preSendSync: (s?: AbortSignal) => preSendSync(s, coordinator), notifyError: (e: string) => errors.push(e), language: { chatSendPreparationFailed: 'prep failed', chatSendSelectionChanged: 'changed' },
    }
    const preflight = new Function(...Object.keys(dependencies), 'flags', `let generationStarted = false; ${code}; return async arg => { const r = await preflight(arg); flags.generationStarted = generationStarted; return r }`)(...Object.values(dependencies), flags)
    return { result: preflight({ signal }), errors, flags }
}
it('a NAS that never answers does not delay the send: admission resolves at once with no network call on the send path', async () => {
    vi.useFakeTimers()
    try {
        const hang = vi.fn(() => new Promise<never>(() => {})) // every NAS step hangs forever
        const c = createSyncCoordinator({ status: hang as any, snapshot: hang as any, publish: hang as any, pull: hang as any, apply: vi.fn() as any, pendingRoots: hang as any, supported: () => true })
        c.state.enabled = true
        const code = prefix(), { result, errors, flags } = run(code, c)
        let settled = false; void result.then(() => { settled = true })
        for (let i = 0; i < 50; i++) await Promise.resolve() // microtasks only: no timer advances
        expect(settled).toBe(true) // the send never waited for the NAS
        expect(await result).toBe(true); expect(flags.generationStarted).toBe(true); expect(errors).toEqual([])
        expect(hang).not.toHaveBeenCalled() // the send path triggers no NAS request of its own
    } finally { vi.useRealTimers() }
})
it('a cancelled send never passes the pre-send admission: no generation, no scripts, no error toast', async () => {
    const code = prefix(), pre = new AbortController(); pre.abort()
    const { result, errors, flags } = run(code, null, pre.signal)
    expect(await result).toBe(false); expect(flags.generationStarted).toBe(false); expect(errors).toEqual([])
})
it('an apply left unresolved (hold kept) stops the send with a notice and never forces the hold open; a released hold lets the send proceed', async () => {
    const code = prefix()
    syncSaveHold.set(true)
    const gated = run(code, null); expect(await gated.result).toBe(false); expect(gated.flags.generationStarted).toBe(false); expect(get(syncSaveHold)).toBe(true) // the top-of-sendChat gate, before any check
    syncSaveHold.set(false)
    const ok = run(code, null); expect(await ok.result).toBe(true); expect(ok.flags.generationStarted).toBe(true)
})
