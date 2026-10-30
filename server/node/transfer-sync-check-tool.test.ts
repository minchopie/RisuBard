// Self-test of the upstream check tool (scripts/transfer-sync/check-upstream.mjs). Tests 1–4: the pure parts — hunk parsing,
// anchor selection, reviewed exclusions (additions only — a matching removal is a hard failure), renumbering, and that a required
// hook missing from the kept hunks is reported, never filtered away silently. Tests 5–6: the real `patch` command end to end —
// generated patch applied to a pristine base must equal the reviewed module integration (host-bridges lines that git merges into
// module hunks by proximity are excluded by the manifest's reviewed rules; required hooks and the longpath inlay normalizations stay).
import { test, expect } from 'vitest'
import { pathToFileURL } from 'node:url'
import { join, dirname } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const repoRoot = join(__dirname, '../..')
const toolPath = join(repoRoot, 'scripts/transfer-sync/check-upstream.mjs')
const tool = () => import(pathToFileURL(toolPath).href)
const realManifest = () => JSON.parse(readFileSync(join(repoRoot, 'docs/transfer-sync/manifest.json'), 'utf8'))
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
/** Runs the real CLI of the tool copied into `repo` (it locates manifest/repo from its own path), returns exit status + output. */
const runPatch = (repo: string, out: string, report: string) => {
    const r = spawnSync(process.execPath, [join(repo, 'scripts/transfer-sync/check-upstream.mjs'), 'patch', '--out', out, '--report', report], { cwd: repo, encoding: 'utf8' })
    return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}
/** Fresh pristine checkout of `sha` from the local object store of `repo` (same line-ending convention every time: no autocrlf). */
const pristine = (repo: string, sha: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'transfer-sync-pristine-'))
    git(dir, 'init', '-q'); git(dir, 'config', 'core.autocrlf', 'false'); git(dir, 'fetch', '-q', '--depth', '1', repo, sha); git(dir, 'checkout', '-q', '--detach', 'FETCH_HEAD')
    return dir
}
const apply = (dir: string, patch: string) => { const r = spawnSync('git', ['apply', '--whitespace=nowarn', patch], { cwd: dir, encoding: 'utf8' }); expect(r.status, r.stderr).toBe(0) }
const LEAK_MARKERS = ['app-update/bootstrap', 'readColdChat', 'APP_SERVER_FETCH', 'characters?: string[]', 'saveFailureNotified', 'options?.characters', 'localAIRequest']

const diff = [
    'diff --git a/x.js b/x.js', '--- a/x.js', '+++ b/x.js',
    '@@ -1,3 +1,5 @@', ' a', '+const localAI = 1', '+const nasSync = create()', ' b', ' c',
    '@@ -10,2 +12,3 @@', ' d', '+unrelatedFeature()', ' e',
    '@@ -20,3 +23,2 @@', ' f', '-const old = nasSync.x', ' g',
].join('\n')

test('parse → select → render: anchors keep module hunks, exclusions drop proximity additions, renumbering stays consistent', async () => {
    const { parseDiff, selectHunks, renderHunks } = await tool()
    const [file] = parseDiff(diff)
    expect(file.hunks).toHaveLength(3)
    const { kept, dropped } = selectHunks(file.hunks, { anchors: ['nasSync'], excludeAdded: ['localAI'] }, 'x.js')
    expect(kept).toHaveLength(2); expect(dropped).toHaveLength(1); expect(dropped[0].lines).toContain('+unrelatedFeature()')
    expect(kept[0].lines).toEqual([' a', '+const nasSync = create()', ' b', ' c']) // localAI addition removed
    const rendered = renderHunks(kept)
    expect(rendered[0]).toBe('@@ -1,3 +1,4 @@')   // 3 old lines, +1 kept addition
    expect(rendered.indexOf('@@ -20,3 +21,2 @@')).toBeGreaterThan(0) // second kept hunk shifted by the +1 of the first
    expect(file.hunks[0].lines).toContain('+const localAI = 1') // input not mutated
})

test('block exclusions remove a whole added method, rewrites fix mixed lines exactly, and context is re-trimmed so the hunk no longer depends on lines it does not change', async () => {
    const { parseDiff, selectHunks, renderHunks } = await tool()
    const text = [
        'diff --git a/y.ts b/y.ts', '--- a/y.ts', '+++ b/y.ts',
        '@@ -5,6 +5,14 @@', ' k1', ' k2', ' k3',
        '+    async otherFeature(path) {', '+        if (!ok(path)) throw new Error()', '+        return this.go(path)', '+    }', '+',
        '+    async transferRequest(path) {', '+        return this.authFetch(path)', '+    }',
        '+function queue(op, recover = true) {', ' k4', ' k5', ' k6',
    ].join('\n')
    const [file] = parseDiff(text)
    const spec = { anchors: ['transferRequest', 'queue\\('], excludeAddedBlocks: [{ from: '^\\s{4}async otherFeature\\(', to: '^\\s{4}\\}$' }], rewriteAdded: [['function queue(op, recover = true) {', 'function queue(op) {']] }
    const { kept } = selectHunks(file.hunks, spec, 'y.ts', 1)
    expect(kept).toHaveLength(1)
    expect(kept[0].lines).toEqual([' k3', '+', '+    async transferRequest(path) {', '+        return this.authFetch(path)', '+    }', '+function queue(op) {', ' k4'])
    expect(kept[0].oldStart).toBe(7); expect(kept[0].oldCount).toBe(2) // leading k1,k2 and trailing k5,k6 trimmed to one context line each
    expect(renderHunks(kept)[0]).toBe('@@ -7,2 +7,7 @@')
    // git's output ends with a newline: that is not a context line of the last hunk, so the re-trim must give the same result.
    const [withNewline] = parseDiff(text + '\n')
    expect(withNewline.hunks[0].lines).toEqual(file.hunks[0].lines)
    expect(renderHunks(selectHunks(withNewline.hunks, spec, 'y.ts', 1).kept)[0]).toBe('@@ -7,2 +7,7 @@')
    // A block that never closes, a block whose start matches a removal, and a rewrite that does not apply are all hard failures.
    expect(() => selectHunks(file.hunks, { ...spec, excludeAddedBlocks: [{ from: '^\\s{4}async otherFeature\\(', to: 'never-matches' }] }, 'y.ts', 1)).toThrow(/never closed|runs past/)
    expect(() => selectHunks(file.hunks, { ...spec, rewriteAdded: [['function queue(op, recover = true) {', 'function queue(op, recover = true) {']] }, 'y.ts', 1)).toThrow(/rewrite did not apply/)
})

test('an exclusion that would drop a REMOVAL is refused (host behaviour must never change silently)', async () => {
    const { parseDiff, selectHunks } = await tool()
    const [file] = parseDiff(diff)
    expect(() => selectHunks(file.hunks, { anchors: ['nasSync'], excludeAdded: ['old'] }, 'x.js')).toThrow(/removed line/)
})

test('a required hook that no kept hunk adds is reported as missing (no silent filtering)', async () => {
    const { parseDiff, selectHunks } = await tool()
    const [file] = parseDiff(diff)
    const { kept } = selectHunks(file.hunks, { anchors: ['nasSync'] }, 'x.js')
    const keptAdded = kept.flatMap(h => h.lines.filter(l => l.startsWith('+')).map(l => l.slice(1))).join('\n')
    const hooks = ['nasSync = create', 'unrelatedFeature\\(']
    expect(hooks.filter(h => !new RegExp(h).test(keptAdded))).toEqual(['unrelatedFeature\\('])
})

// ── 5. Deterministic end-to-end fixture (runs everywhere, no network, no pinned base needed) ─────────────────────────────────
// A throw-away git repo whose base commit holds three mini host files, and whose worktree is the "current layered" state: the module
// hooks PLUS, at the exact proximity git merges them in the real tree, the other features' lines that leaked in the 2026-10-28
// regeneration — app-update bootstrap start line / readColdChat factory option / mixed `listening` line (server.cjs), the
// APP_SERVER_FETCH try/catch that REPLACES the original fetch call between the header hook and the 423 gate hook (nodeStorage.ts),
// the `characters` dirty-list option + its loop and the save-failure latch (globalApi.svelte.ts), plus the local-AI route method and
// an unrelated removal-bearing hunk. The real CLI runs with the real manifest's reviewed rules for these files; the output applied to
// the pristine base must equal the pure module text. Why a fixture: the pinned upstream base object is not in an arbitrary CI
// checkout (and never in the shallow `verify` temp checkout where this file also runs); test 6 covers the actual tree when it is.
const LF = (...lines: string[]) => lines.join('\n') + '\n'
const fixtures = {
    'server/node/server.cjs': {
        base: LF(
            "const express = require('express');",
            "const { validatePackage, stageWindowsUpdate, restoreEntries } = require('./portable-update.cjs');",
            'const app = express();',
            "const http = require('http');",
            "const https = require('https');",
            "const path = require('path');",
            "const fs = require('fs/promises');",
            "const { spawn } = require('child_process');",
            "const nodeCrypto = require('node:crypto');",
            "const logger = require('./logger.cjs');",
            'const processDataRoot = resolveDataRoot();',
            'acquireDataRootLock(processDataRoot);',
            'function unrelatedA() { return 1; }',
            'function unrelatedB() { return 2; }',
            'function unrelatedD() { return 4; }',
            'function unrelatedE() { return 5; }',
            'function unrelatedF() { return 6; }',
            'const narrativeMemoryService = createRuntimeMemoryService(savePath);',
            'registerRisuBardMemoryRoutes(app, {',
            '    auth: checkAuth,',
            '});',
            'function unrelatedC() { return 3; }',
            'async function startServer() {',
            '    {',
            '        server.requestTimeout = 0;',
            "        // Written only once bound, so a server that lost the port race keeps the owner's token intact.",
            "        server.once('listening', () => writeFileSync(localShutdownTokenPath, localShutdownToken, { mode: 0o600 }));",
            '    }',
            '}',
        ),
        current: LF(
            "if (require('./app-update/bootstrap.cjs').start(__filename)) return;",
            "const express = require('express');",
            "const { validatePackage, stageWindowsUpdate, restoreEntries } = require('./portable-update.cjs');",
            'const app = express();',
            "const embedded = require('./embedded-runtime.cjs').embeddedRuntime();",
            "const http = require('http');",
            "const https = require('https');",
            "const path = require('path');",
            "const fs = require('fs/promises');",
            "const { spawn } = require('child_process');",
            "const nodeCrypto = require('node:crypto');",
            "const logger = require('./logger.cjs');",
            'const processDataRoot = resolveDataRoot();',
            "if (!require('./app-update/bootstrap.cjs').ownsDataRoot(processDataRoot)) acquireDataRootLock(processDataRoot);",
            'function unrelatedA() { return 1; }',
            'function unrelatedB() { return 2; }',
            'function unrelatedD() { return 4; }',
            'function unrelatedE() { return 5; }',
            'function unrelatedF() { return 6; }',
            'const narrativeMemoryService = createRuntimeMemoryService(savePath);',
            "const nasSync = require('./nas-sync-service.cjs').createNasSyncService({",
            '    dataRoot: savePath,',
            '    readColdChat: key => readColdStorageJsonEntry(key)?.coldData ?? null,',
            '    readDatabase: () => queueStorageOperation(() => loadPersistedFullDatabase()),',
            '    memory: narrativeMemoryService,',
            "    readInlay: async id => ({ data: await require('node:fs').openAsBlob(path.toNamespacedPath(file), { type: getMimeFromExt(metadata.ext) }) }),",
            '});',
            'nasSync.registerRoutes(app, { auth: checkAuth, activeSession: checkActiveSession });',
            'registerRisuBardMemoryRoutes(app, {',
            '    auth: checkAuth,',
            '});',
            'function unrelatedC() { return 3; }',
            'async function startServer() {',
            '    {',
            '        server.requestTimeout = 0;',
            "        server.once('listening', () => { require('./app-update/bootstrap.cjs').ready(); embedded.ready(server, savePath); });",
            "        // Written only once bound, so a server that lost the port race keeps the owner's token intact.",
            "        server.once('listening', () => writeFileSync(localShutdownTokenPath, localShutdownToken, { mode: 0o600 }));",
            '    }',
            '}',
        ),
        expected: LF(
            "const express = require('express');",
            "const { validatePackage, stageWindowsUpdate, restoreEntries } = require('./portable-update.cjs');",
            'const app = express();',
            "const embedded = require('./embedded-runtime.cjs').embeddedRuntime();",
            "const http = require('http');",
            "const https = require('https');",
            "const path = require('path');",
            "const fs = require('fs/promises');",
            "const { spawn } = require('child_process');",
            "const nodeCrypto = require('node:crypto');",
            "const logger = require('./logger.cjs');",
            'const processDataRoot = resolveDataRoot();',
            'acquireDataRootLock(processDataRoot);',
            'function unrelatedA() { return 1; }',
            'function unrelatedB() { return 2; }',
            'function unrelatedD() { return 4; }',
            'function unrelatedE() { return 5; }',
            'function unrelatedF() { return 6; }',
            'const narrativeMemoryService = createRuntimeMemoryService(savePath);',
            "const nasSync = require('./nas-sync-service.cjs').createNasSyncService({",
            '    dataRoot: savePath,',
            '    readDatabase: () => queueStorageOperation(() => loadPersistedFullDatabase()),',
            '    memory: narrativeMemoryService,',
            "    readInlay: async id => ({ data: await require('node:fs').openAsBlob(path.toNamespacedPath(file), { type: getMimeFromExt(metadata.ext) }) }),",
            '});',
            'nasSync.registerRoutes(app, { auth: checkAuth, activeSession: checkActiveSession });',
            'registerRisuBardMemoryRoutes(app, {',
            '    auth: checkAuth,',
            '});',
            'function unrelatedC() { return 3; }',
            'async function startServer() {',
            '    {',
            '        server.requestTimeout = 0;',
            "        server.once('listening', () => embedded.ready(server, savePath));",
            "        // Written only once bound, so a server that lost the port race keeps the owner's token intact.",
            "        server.once('listening', () => writeFileSync(localShutdownTokenPath, localShutdownToken, { mode: 0o600 }));",
            '    }',
            '}',
        ),
        hooks: ['createNasSyncService\\(', 'embedded\\.ready\\(server, savePath\\)', 'embedded-runtime', 'openAsBlob\\(path\\.toNamespacedPath\\(file\\)'],
    },
    'src/ts/storage/nodeStorage.ts': {
        base: LF(
            "import { isUserActive } from './userActivity'",
            '',
            'export class NodeStorage{',
            "    static sessionId = 'session'",
            '    private importProgressId: string | null = null',
            '    private liveSnapshotRequired = false',
            '    pendingSaveRequests = 0',
            '',
            '    private async authFetch(input: string, init: RequestInit): Promise<Response> {',
            '        const headers = new Headers(init.headers)',
            '        init.signal?.throwIfAborted()',
            "        headers.set('x-session-id', NodeStorage.sessionId)",
            "        if (this.importProgressId) headers.set('x-import-id', this.importProgressId)",
            "        if (isUserActive()) headers.set('x-user-active', '1')",
            '',
            '        const response = await fetch(input, {',
            '            ...init,',
            '            headers',
            '        })',
            '        init.signal?.throwIfAborted()',
            '',
            '        if (response.status === 423) {',
            "            window.dispatchEvent(new CustomEvent('risu-session-deactivated'))",
            '        }',
            '',
            '        return response',
            '    }',
            '',
            '    async setItem(key:string, value:Uint8Array, etag?:string): Promise<string | null> {',
            '        return null',
            '    }',
            '}',
        ),
        current: LF(
            "import { isUserActive } from './userActivity'",
            '',
            'export class NodeStorage{',
            "    static sessionId = 'session'",
            '    private importProgressId: string | null = null',
            '    private liveSnapshotRequired = false',
            '    pendingSaveRequests = 0',
            '    transferTransaction: string | undefined',
            "    /** Active NAS sync apply transaction; its id travels with every save so the server's sync write gate admits only that save. */",
            '    syncTransaction: string | undefined',
            '',
            '    private async authFetch(input: string, init: RequestInit): Promise<Response> {',
            '        const headers = new Headers(init.headers)',
            '        init.signal?.throwIfAborted()',
            "        headers.set('x-session-id', NodeStorage.sessionId)",
            "        if (this.transferTransaction) headers.set('x-play-transfer-id', this.transferTransaction)",
            "        if (this.syncTransaction) headers.set('x-nas-sync-id', this.syncTransaction)",
            "        if (this.importProgressId) headers.set('x-import-id', this.importProgressId)",
            "        if (isUserActive()) headers.set('x-user-active', '1')",
            '',
            '        let response: Response',
            '        try {',
            '            response = await fetch(input, {',
            '                ...init,',
            '                headers',
            '            })',
            '        } catch (error) {',
            '            if (!init.signal?.aborted && error instanceof TypeError) {',
            "                throw Object.assign(new TypeError('앱 서버에 연결하지 못했습니다', { cause: error }), { code: 'APP_SERVER_FETCH' })",
            '            }',
            '            throw error',
            '        }',
            '        init.signal?.throwIfAborted()',
            '',
            '        if (response.status === 423) {',
            '            const failure = await response.clone().json().catch(() => ({}))',
            '            // Local transfer/sync write gates answer 423 too; only a real session takeover deactivates this tab.',
            "            if (!['TRANSFER_BUSY', 'NAS_SYNC_BUSY'].includes(failure.code)) window.dispatchEvent(new CustomEvent('risu-session-deactivated'))",
            '        }',
            '',
            '        return response',
            '    }',
            '',
            '    async localAIRequest(path: string, init: RequestInit = {}): Promise<Response> {',
            "        if (!['', '/model'].includes(path)) throw new Error('Invalid local AI route')",
            "        return this.authFetch('/api/local-ai' + path, init)",
            '    }',
            '',
            '    async transferRequest(path: string, init: RequestInit = {}): Promise<Response> {',
            "        if (!/^\\/(?:[a-z0-9-]+\\/?)*$/i.test(path) && path !== '') throw new Error('Invalid transfer route')",
            "        return this.authFetch('/api/play-transfer' + path, init)",
            '    }',
            '',
            '    async setItem(key:string, value:Uint8Array, etag?:string): Promise<string | null> {',
            '        return null',
            '    }',
            '}',
        ),
        expected: LF(
            "import { isUserActive } from './userActivity'",
            '',
            'export class NodeStorage{',
            "    static sessionId = 'session'",
            '    private importProgressId: string | null = null',
            '    private liveSnapshotRequired = false',
            '    pendingSaveRequests = 0',
            '    transferTransaction: string | undefined',
            "    /** Active NAS sync apply transaction; its id travels with every save so the server's sync write gate admits only that save. */",
            '    syncTransaction: string | undefined',
            '',
            '    private async authFetch(input: string, init: RequestInit): Promise<Response> {',
            '        const headers = new Headers(init.headers)',
            '        init.signal?.throwIfAborted()',
            "        headers.set('x-session-id', NodeStorage.sessionId)",
            "        if (this.transferTransaction) headers.set('x-play-transfer-id', this.transferTransaction)",
            "        if (this.syncTransaction) headers.set('x-nas-sync-id', this.syncTransaction)",
            "        if (this.importProgressId) headers.set('x-import-id', this.importProgressId)",
            "        if (isUserActive()) headers.set('x-user-active', '1')",
            '',
            '        const response = await fetch(input, {',
            '            ...init,',
            '            headers',
            '        })',
            '        init.signal?.throwIfAborted()',
            '',
            '        if (response.status === 423) {',
            '            const failure = await response.clone().json().catch(() => ({}))',
            '            // Local transfer/sync write gates answer 423 too; only a real session takeover deactivates this tab.',
            "            if (!['TRANSFER_BUSY', 'NAS_SYNC_BUSY'].includes(failure.code)) window.dispatchEvent(new CustomEvent('risu-session-deactivated'))",
            '        }',
            '',
            '        return response',
            '    }',
            '',
            '',
            '    async transferRequest(path: string, init: RequestInit = {}): Promise<Response> {',
            "        if (!/^\\/(?:[a-z0-9-]+\\/?)*$/i.test(path) && path !== '') throw new Error('Invalid transfer route')",
            "        return this.authFetch('/api/play-transfer' + path, init)",
            '    }',
            '',
            '    async setItem(key:string, value:Uint8Array, etag?:string): Promise<string | null> {',
            '        return null',
            '    }',
            '}',
        ),
        hooks: null as string[] | null, // the real file's hooks (transferRequest, syncTransaction, transferTransaction) are all in the fixture
    },
    'src/ts/globalApi.svelte.ts': {
        base: LF(
            'export let requiresFullEncoderReload = $state({})',
            '',
            'let requestImmediateSaveImpl: ((options?: {',
            '    forceFullWrite?: boolean',
            "    flushServer?: boolean | 'canonical' | 'canonical-background'",
            '    flushSignal?: AbortSignal',
            '    rejectOnFailure?: boolean',
            '}) => Promise<void> | void) = () => {}',
            'let patchSyncBaseline: Database | null = null',
            '',
            'export async function saveDb() {',
            '    let forceFullWriteOnRetry = false',
            '    // Immediate saves diff only tracked characters; the next background save',
            '    // runs the full untracked-character sweep so missed edits still persist.',
            '    let savetrys = 0',
            '    async function flush(options?: { syncOwned?: boolean }) {',
            '        const result = await saveRuntime.flush()',
            "        if (result === 'saved') {",
            '            forceFullWriteOnRetry = false',
            '            savetrys = 0',
            '            // Node clients use the server lock. A failed/passive save',
            '            // must not kick another tab through a second authority.',
            '        }',
            '    }',
            '    requestImmediateSaveImpl = async (options) => {',
            '        if (!saveRuntime.isActive()) {',
            '            throw new Error(language.sessionSavePausedTitle)',
            '        }',
            '        changed = true',
            '        await tick()',
            '    }',
            '}',
        ),
        current: LF(
            'export let requiresFullEncoderReload = $state({})',
            '',
            'let requestImmediateSaveImpl: ((options?: {',
            '    chats?: [string, string][]',
            '    characters?: string[]',
            '    forceFullWrite?: boolean',
            "    flushServer?: boolean | 'canonical' | 'canonical-background'",
            '    flushSignal?: AbortSignal',
            '    rejectOnFailure?: boolean',
            '    syncOwned?: boolean',
            '}) => Promise<void> | void) = () => {}',
            'let patchSyncBaseline: Database | null = null',
            '',
            'export async function saveDb() {',
            '    let forceFullWriteOnRetry = false',
            '    let saveFailureNotified = false',
            '    // Immediate saves diff only tracked characters; the next background save',
            '    // runs the full untracked-character sweep so missed edits still persist.',
            '    let savetrys = 0',
            '    async function flush(options?: { syncOwned?: boolean }) {',
            '        const result = await saveRuntime.flush()',
            "        if (result === 'saved') {",
            '            forceFullWriteOnRetry = false',
            '            savetrys = 0',
            '            saveFailureNotified = false',
            '            // A user save settled: the NAS sync coordinator (if enabled) snapshots after its debounce.',
            '            if (!options?.syncOwned) canonicalSaveSettled.set(Date.now())',
            '            // Node clients use the server lock. A failed/passive save',
            '            // must not kick another tab through a second authority.',
            '        }',
            '    }',
            '    requestImmediateSaveImpl = async (options) => {',
            '        if (!saveRuntime.isActive()) {',
            '            throw new Error(language.sessionSavePausedTitle)',
            '        }',
            "        if (get(syncSaveHold) && !options?.syncOwned) throw new Error('NAS 동기화 적용이 끝날 때까지 저장이 잠겨 있어요.')",
            '        for (const id of options?.characters ?? []) {',
            '            if (!changeTracker.character.includes(id)) changeTracker.character.push(id)',
            '        }',
            '        // Imports can append chats without selecting their character in the UI.',
            '        for (const [id, chatId] of options?.chats ?? []) {',
            '            if (!changeTracker.character.includes(id)) changeTracker.character.push(id)',
            '            if (!changeTracker.chat.some(pair => pair[0] === id && pair[1] === chatId)) changeTracker.chat.push([id, chatId])',
            '        }',
            '        changed = true',
            '        await tick()',
            '    }',
            '}',
        ),
        expected: LF(
            'export let requiresFullEncoderReload = $state({})',
            '',
            'let requestImmediateSaveImpl: ((options?: {',
            '    chats?: [string, string][]',
            '    forceFullWrite?: boolean',
            "    flushServer?: boolean | 'canonical' | 'canonical-background'",
            '    flushSignal?: AbortSignal',
            '    rejectOnFailure?: boolean',
            '    syncOwned?: boolean',
            '}) => Promise<void> | void) = () => {}',
            'let patchSyncBaseline: Database | null = null',
            '',
            'export async function saveDb() {',
            '    let forceFullWriteOnRetry = false',
            '    // Immediate saves diff only tracked characters; the next background save',
            '    // runs the full untracked-character sweep so missed edits still persist.',
            '    let savetrys = 0',
            '    async function flush(options?: { syncOwned?: boolean }) {',
            '        const result = await saveRuntime.flush()',
            "        if (result === 'saved') {",
            '            forceFullWriteOnRetry = false',
            '            savetrys = 0',
            '            // A user save settled: the NAS sync coordinator (if enabled) snapshots after its debounce.',
            '            if (!options?.syncOwned) canonicalSaveSettled.set(Date.now())',
            '            // Node clients use the server lock. A failed/passive save',
            '            // must not kick another tab through a second authority.',
            '        }',
            '    }',
            '    requestImmediateSaveImpl = async (options) => {',
            '        if (!saveRuntime.isActive()) {',
            '            throw new Error(language.sessionSavePausedTitle)',
            '        }',
            "        if (get(syncSaveHold) && !options?.syncOwned) throw new Error('NAS 동기화 적용이 끝날 때까지 저장이 잠겨 있어요.')",
            '        // Imports can append chats without selecting their character in the UI.',
            '        for (const [id, chatId] of options?.chats ?? []) {',
            '            if (!changeTracker.character.includes(id)) changeTracker.character.push(id)',
            '            if (!changeTracker.chat.some(pair => pair[0] === id && pair[1] === chatId)) changeTracker.chat.push([id, chatId])',
            '        }',
            '        changed = true',
            '        await tick()',
            '    }',
            '}',
        ),
        hooks: ['syncOwned', 'canonicalSaveSettled', 'syncSaveHold'],
    },
}
/** Fixture repo: base commit = `base` texts; worktree = `current` texts; the real tool copied in; a manifest built from `specs`. */
function fixtureRepo(specs: Record<string, unknown>) {
    const repo = mkdtempSync(join(tmpdir(), 'transfer-sync-fixture-'))
    git(repo, 'init', '-q'); git(repo, 'config', 'core.autocrlf', 'false')
    const write = (file: string, text: string) => { mkdirSync(dirname(join(repo, file)), { recursive: true }); writeFileSync(join(repo, file), text) }
    for (const [file, f] of Object.entries(fixtures)) write(file, f.base)
    git(repo, 'add', '-A'); git(repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base')
    const sha = git(repo, 'rev-parse', 'HEAD').trim()
    for (const [file, f] of Object.entries(fixtures)) write(file, f.current)
    cpSync(toolPath, join(repo, 'scripts/transfer-sync/check-upstream.mjs'))
    write('docs/transfer-sync/manifest.json', JSON.stringify({ upstream: { base: { tag: 'fixture', sha } }, integration: { patch: 'docs/transfer-sync/integration.patch', files: specs, context: 2 } }))
    return { repo, sha, restore: () => git(repo, 'checkout', '-q', '--', '.'), read: (file: string) => readFileSync(join(repo, file), 'utf8'), rm: () => rmSync(repo, { recursive: true, force: true }) }
}

test('patch command on a layered fixture tree: the manifest rules keep every module hook and drop the neighbouring host-bridges lines; applied source equals the pure module text', async () => {
    const real = realManifest().integration.files
    // The real reviewed rules for these three files (exclusions, blocks, rewrites, per-file context, anchors); only the hooks list is
    // the fixture's own where the real hooks reach lines the mini file does not carry.
    const specs: Record<string, any> = Object.fromEntries(Object.entries(fixtures).map(([file, f]) => [file, { ...real[file], ...(f.hooks ? { hooks: f.hooks } : {}) }]))
    const fx = fixtureRepo(specs)
    try {
        const out = join(fx.repo, 'generated.patch'), report = join(fx.repo, 'report.json')
        const r = runPatch(fx.repo, out, report)
        const rep = JSON.parse(readFileSync(report, 'utf8')) // written before the self-check verdict, so a failure can be explained
        expect(r.status, r.out + '\n' + (rep.baseApplyError ?? '') + '\n' + readFileSync(out, 'utf8')).toBe(0)
        expect(rep.ok).toBe(true); expect(rep.appliesToBase).toBe(true)
        for (const file of Object.keys(fixtures)) expect(rep.files[file].hooksMissing, file).toEqual([])
        // The removal-bearing ownsDataRoot hunk and the saveFailureNotified declaration hunk are dropped whole (reported), not errors.
        expect(rep.files['server/node/server.cjs'].dropped.map((d: { first: string }) => d.first)).toContain('acquireDataRootLock(processDataRoot);')
        expect(rep.files['src/ts/globalApi.svelte.ts'].dropped.map((d: { first: string }) => d.first)).toContain('    let saveFailureNotified = false')
        // Applied to the pristine base, every file is exactly the pure module text: hooks kept, host-bridges lines absent, the
        // original fetch call untouched (no removal was ever filtered), longpath inlay normalization kept.
        fx.restore(); apply(fx.repo, out)
        for (const [file, f] of Object.entries(fixtures)) expect(fx.read(file), file).toBe(f.expected)
        // Negative control (non-vacuous): the same tree with anchors+hooks only (no reviewed exclusions, default context) succeeds
        // on hooks yet leaks every one of those lines — the rules above are what keeps the boundary.
        const bare = fixtureRepo(Object.fromEntries(Object.entries(specs).map(([file, s]) => [file, { anchors: s.anchors, hooks: s.hooks }])))
        try {
            const bareOut = join(bare.repo, 'generated.patch'), bareRep = join(bare.repo, 'report.json')
            expect(runPatch(bare.repo, bareOut, bareRep).status).toBe(0)
            bare.restore(); apply(bare.repo, bareOut)
            const applied = Object.keys(fixtures).map(file => bare.read(file)).join('\n')
            for (const marker of LEAK_MARKERS) expect(applied, marker).toContain(marker)
            expect(applied).not.toContain('        const response = await fetch(input, {')
        } finally { bare.rm() }
        // A required hook edited out of the tree is a hard failure of the command (no silent filtering), never a thinner patch.
        fx.restore()
        for (const [file, f] of Object.entries(fixtures)) writeFileSync(join(fx.repo, file), file.endsWith('nodeStorage.ts') ? f.current.replace(/    async transferRequest[\s\S]*?\n    \}\n/, '') : f.current)
        const broken = runPatch(fx.repo, join(fx.repo, 'broken.patch'), join(fx.repo, 'broken.json'))
        expect(broken.status).not.toBe(0)
        expect(broken.out).toMatch(/would omit required host hooks: src\/ts\/storage\/nodeStorage\.ts → transferRequest/)
    } finally { fx.rm() }
}, 120_000)

// ── 6. Actual current tree against the pinned base (full equivalence evidence; needs the base commit in the local object store) ──
const realBase: string = realManifest().upstream.base.sha
const baseAvailable = spawnSync('git', ['cat-file', '-e', `${realBase}^{commit}`], { cwd: repoRoot }).status === 0
test.skipIf(!baseAvailable)(`patch command on the CURRENT tree reproduces the reviewed integration: applied to pristine base ${realBase.slice(0, 7)} every hooked host file equals the golden-applied one (skipped when that commit is not in the local object store, e.g. a shallow upstream checkout)`, async () => {
    const manifest = realManifest(), files: string[] = Object.keys(manifest.integration.files)
    const work = mkdtempSync(join(tmpdir(), 'transfer-sync-actual-'))
    let golden: string | null = null, generated: string | null = null
    try {
        const out = join(work, 'generated.patch'), report = join(work, 'report.json')
        const r = spawnSync(process.execPath, [toolPath, 'patch', '--out', out, '--report', report], { cwd: repoRoot, encoding: 'utf8' })
        expect(r.status, (r.stdout ?? '') + (r.stderr ?? '')).toBe(0)
        const rep = JSON.parse(readFileSync(report, 'utf8'))
        expect(rep.ok).toBe(true); expect(rep.appliesToBase).toBe(true)
        golden = pristine(repoRoot, realBase); generated = pristine(repoRoot, realBase)
        const baseText = Object.fromEntries(files.map(f => [f, readFileSync(join(golden!, f), 'utf8')]))
        apply(golden, join(repoRoot, manifest.integration.patch)); apply(generated, out)
        for (const f of files) {
            const a = readFileSync(join(golden, f), 'utf8'), b = readFileSync(join(generated, f), 'utf8')
            expect(b, f).toBe(a)
            expect(b, `${f} must be changed by the patch (a drop-all patch is not equivalence)`).not.toBe(baseText[f])
            for (const h of manifest.integration.files[f].hooks) expect(b, `${f}: hook ${h}`).toMatch(new RegExp(h))
            for (const marker of LEAK_MARKERS) if (!a.includes(marker)) expect(b, `${f}: leaked ${marker}`).not.toContain(marker)
        }
        // Latest reviewed longpath normalization: both inlay readers open the file through path.toNamespacedPath.
        expect(readFileSync(join(generated, 'server/node/server.cjs'), 'utf8').match(/openAsBlob\(path\.toNamespacedPath\(file\)/g)).toHaveLength(2)
    } finally { rmSync(work, { recursive: true, force: true }); for (const d of [golden, generated]) if (d) rmSync(d, { recursive: true, force: true }) }
}, 180_000)
