import { describe, expect, it, vi } from 'vitest'

vi.mock('src/lang', () => ({ language: {} }))
vi.mock('src/ts/stores.svelte', () => ({ selIdState: { selId: 0 }, DBState: { db: { characters: [] } } }))
vi.mock('./database.svelte', () => ({ normalizeChat: (value: unknown) => value, getCurrentChat: () => null, getCurrentCharacter: () => null,
    getDatabase: () => ({ modules: [], enabledModules: [], personas: [], selectedPersona: 0, personaEnabledModules: {}, characters: [] }) }))
vi.mock('./risuSave', () => ({ decodeRisuSave: vi.fn(), encodeRisuSaveLegacy: vi.fn() }))
vi.mock('./chatContentPage', () => ({ assembleChatContentPages: vi.fn() }))

import { NodeStorage } from './nodeStorage'

describe('NodeStorage NAS sync write gate', () => {
    it('treats a 423 NAS_SYNC_BUSY as the local sync gate (no session loss) and sends the sync transaction header', async () => {
        const storage = new NodeStorage(), deactivated = vi.fn(), seen: Headers[] = []
        ;(storage as any).checkAuth = async () => {}
        storage.createAuth = async () => 'test-token'
        let code: string | undefined = 'NAS_SYNC_BUSY'
        vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { seen.push(init.headers as Headers); return Response.json({ error: 'sync apply must finish', code }, { status: 423 }) })
        window.addEventListener('risu-session-deactivated', deactivated)
        try {
            expect((await (storage as any).authFetch('/api/write')).status).toBe(423)
            expect(deactivated).not.toHaveBeenCalled()
            expect(seen.at(-1)!.get('x-nas-sync-id')).toBeNull()
            storage.syncTransaction = 'txn-1'
            await (storage as any).authFetch('/api/write')
            expect(seen.at(-1)!.get('x-nas-sync-id')).toBe('txn-1')
            expect(deactivated).not.toHaveBeenCalled()
            code = undefined
            await (storage as any).authFetch('/api/write')
            expect(deactivated).toHaveBeenCalledOnce() // a genuine takeover still deactivates
        } finally { window.removeEventListener('risu-session-deactivated', deactivated); vi.unstubAllGlobals() }
    })
    it('validates the relative sync route like transferRequest does', async () => {
        const storage = new NodeStorage()
        ;(storage as any).authFetch = vi.fn(async (url: string) => new Response(url))
        expect(await (await storage.syncRequest('/plan')).text()).toBe('/api/nas-sync/plan')
        await expect(storage.syncRequest('/../write')).rejects.toThrow(/Invalid sync route/)
        await expect(storage.syncRequest('plan?x=1')).rejects.toThrow(/Invalid sync route/)
    })
})
