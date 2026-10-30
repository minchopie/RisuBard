import { readFileSync } from 'node:fs'
import { test, expect, vi } from 'vitest'

const source = readFileSync('server/node/server.cjs', 'utf8')
const begin = source.indexOf('async function flushPendingDbWithinQueue(')
const body = source.slice(begin, source.indexOf('function invalidateDbCache()', begin))

test('a failed flush remains retryable after its timer has been consumed', async () => {
    const persist = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValue(undefined)
    const clear = vi.fn()
    const create = new Function('persist', 'clearPersistFailure', `
        const DB_HEX_KEY = 'db', saveTimers = { db: 1 }, dbCache = { db: {} }, fullChatStore = new Map();
        let liveFilesPendingWrites = true;
        const reportImportProgress=()=>{}, externalChangesAwaitingReview=()=>false, adoptSettledExternalProjection=async()=>false;
        const directWriteTracker={ take:()=>null }, maybeCollectUnreferencedObjects=()=>{}, compatibilityCache={materialize:()=>{}};
        const persistDbCacheWithChats=async(...args)=>{await persist(...args);liveFilesPendingWrites=false};
        ${body}
        return {flush:flushPendingDbWithinQueue,saveTimers};
    `)
    const f = create(persist, clear)
    await expect(f.flush({ materialize: false })).rejects.toThrow('disk full')
    expect(f.saveTimers.db).toBeUndefined()
    expect(clear).not.toHaveBeenCalled()
    await f.flush({ materialize: false })
    expect(persist).toHaveBeenCalledTimes(2)
    expect(clear).toHaveBeenCalledOnce()
    await f.flush({ materialize: false })
    expect(persist).toHaveBeenCalledTimes(2)
})

test('an uncached chat save falls back to canonical data after deferred compatibility removal', async () => {
    const begin = source.indexOf('async function persistChatStoreWithoutCache(')
    const body = source.slice(begin, source.indexOf('async function persistDbCacheWithChats(', begin))
    const loader = source.slice(source.indexOf('async function loadPersistedFullDatabase('), source.indexOf('async function ensureChatStore('))
    const canonical = { characters: [{ chaId: 'one', chats: [{ id: 'chat', message: ['before'] }] }] }
    const changed = { characters: [{ chaId: 'one', chats: [{ id: 'chat', message: ['accepted'] }] }] }
    const persist = vi.fn(), write = vi.fn()
    const deps = {
        kvGet: () => null, userDataRepository: { exportLegacyDatabase: () => structuredClone(canonical) },
        migrateRemoteBlocksIfNeeded: async () => {}, canonicalProjectionReady: true,
        externalEditSession: { isActive: () => false }, prepareDatabaseWithPersistentChatIds: (value: unknown) => value,
        nodeCrypto: { randomUUID: () => 'test' }, activeCompatibilityPersists: 0,
        normalizeJSON: (value: unknown) => value, decodeRisuSave: vi.fn(),
        stripChatsFromDb: (value: unknown) => { expect(value).toEqual(canonical); return value },
        reassembleFullDb: () => changed, summarizeDatabaseShape: () => ({}),
        encodeRisuSaveLegacyBuffer: JSON.stringify, kvSet: write, persistCanonicalProjection: persist,
        saveObservation: { record() {} }, elapsedMs: () => 0,
        directWriteTracker: { observe() {} }, DB_HEX_KEY: 'db', compatibilityCache: { setVerified() {} },
    }
    const run = new Function('deps', `with (deps) { ${loader}; ${body}; return persistChatStoreWithoutCache; }`)(deps)
    await run('flush')
    expect(persist).toHaveBeenCalledWith(changed, expect.anything())
    expect(write).toHaveBeenCalledWith('database/database.bin', JSON.stringify(changed))
    expect(deps.decodeRisuSave).not.toHaveBeenCalled()
})
