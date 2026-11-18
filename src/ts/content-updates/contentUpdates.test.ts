import { describe, expect, test, vi } from 'vitest'
import { get } from 'svelte/store'
import { zipSync, strToU8 } from 'fflate'
import { createHash } from 'node:crypto'

vi.mock('../storage/database.svelte', () => ({ getDatabase: vi.fn(), saveImage: vi.fn(async () => 'new-icon'), importPreset: vi.fn(), changeToPreset: vi.fn() }))
vi.mock('../globalApi.svelte', () => ({ checkCharOrder: vi.fn(), requestImmediateSave: vi.fn(async () => {}) }))
vi.mock('../plugins/plugins.svelte', () => ({ importPlugin: vi.fn(), loadPlugins: vi.fn(async () => {}) }))
vi.mock('../characterCards', () => ({ importCharacterProcess: vi.fn() }))
vi.mock('../process/files/inlays', () => ({ reencodeImage: vi.fn(async (b: Uint8Array) => b) }))
vi.mock('../alert', () => ({ alertConfirmMulti: vi.fn(), alertError: vi.fn(), notifySuccess: vi.fn(), notifyInfo: vi.fn() }))
vi.mock('../playTransfer', async () => { const { writable, get } = await import('svelte/store'); const transferBusy = writable(false); return { transferRequest: vi.fn(), transferBusy, transferStatus: writable(''), transferUnavailable: vi.fn(() => get(transferBusy)) } })
vi.mock('../platform', () => ({ isNodeServer: false }))
vi.mock('../stores.svelte', async () => { const { writable } = await import('svelte/store'); return { alertStore: writable({ type: 'none' }), loadedStore: writable(true) } })
vi.mock('../process/generationState', async () => { const { writable } = await import('svelte/store'); return { isAnyGenerating: writable(false) } })
vi.mock('../storage/importTransaction', () => ({ ImportCancelled: class ImportCancelled extends Error {} }))
vi.mock('../pngChunk', () => ({ PngChunk: { readGenerator: vi.fn(async function* () {}) } }))
vi.mock('uuid', () => ({ v4: () => 'id' }))
vi.mock('../importSession', async () => { const { writable } = await import('svelte/store'); return { importSession: writable({ phase: 'idle' }), runImport: vi.fn() } })
vi.mock('../process/modules', () => ({ readModule: vi.fn() }))
vi.mock('../rpack/rpack_js', () => ({ decodeRPack: vi.fn(async (data: Uint8Array) => data) })) // identity: the tests write plain JSON
vi.mock('../nasSync', () => ({ reportSyncNetwork: vi.fn(async () => ({})) }))
vi.mock('../nasSyncCoordinator', async () => { const { writable } = await import('svelte/store'); return { coordinatorState: writable(null) } })

const mod = await import('./contentUpdates')

describe('content updates (client helpers)', () => {
    test('publish name drops the version and a trailing ver', () => {
        expect(mod.baseName('마물소녀도감 1.2.34-argon.4 ver')).toBe('마물소녀도감')
        expect(mod.baseName('마물소녀도감 1.2.32 ver')).toBe('마물소녀도감')
        expect(mod.baseName('Shecubus!')).toBe('Shecubus!')
        expect(mod.baseName('1.2.3')).toBe('1.2.3')
    })
    test('finds a version token in a name or persona note', () => {
        expect(mod.versionIn('함건희(용사지망) v1.0.30-aspirant.6 · v1.0.29-aspirant.5 + ...')).toBe('1.0.30-aspirant.6')
        expect(mod.versionIn('no version here')).toBe('')
    })
    test('reads name and version from a charx card.json', async () => {
        const charx = zipSync({ 'card.json': strToU8(JSON.stringify({ spec: 'chara_card_v3', data: { name: '마물소녀도감 1.2.34-argon.4 ver', character_version: '1.2.34-argon.4' } })), 'assets/x.png': new Uint8Array([1, 2, 3]) })
        expect(await mod.describeFile('MGE.charx', charx)).toEqual({ kind: 'character', title: '마물소녀도감 1.2.34-argon.4 ver', version: '1.2.34-argon.4' })
        await expect(mod.describeFile('x.charx', zipSync({ 'other.json': strToU8('{}') }))).rejects.toThrow(/card\.json/)
        await expect(mod.describeFile('x.exe', new Uint8Array([1]))).rejects.toThrow()
    })
    test('reads a json card and labels items', async () => {
        expect(await mod.describeFile('a.json', strToU8(JSON.stringify({ data: { name: 'Bot 2.0.1 ver' } })))).toEqual({ kind: 'character', title: 'Bot 2.0.1 ver', version: '2.0.1' })
        expect(mod.itemLabel({ title: 'Bot', version: '2.0.1' })).toBe('Bot (2.0.1)')
        expect(mod.itemLabel({ title: 'Bot 2.0.1 ver', version: '2.0.1' })).toBe('Bot 2.0.1 ver')
    })
    test('a .risup, .risupreset or .preset.json is described as a prompt preset', async () => {
        expect(await mod.describeFile('바드 프롬프트 젬 0.5.2 — Argon 단일 시스템 v1.0.0 r2.risup', new Uint8Array([1]))).toEqual({ kind: 'preset', title: '바드 프롬프트 젬 0.5.2 — Argon 단일 시스템 v1.0.0 r2', version: '0.5.2' })
        expect(await mod.describeFile('Gem_preset.risupreset', new Uint8Array([1]))).toEqual({ kind: 'preset', title: 'Gem', version: '' })
        expect(await mod.describeFile('x.preset.json', strToU8(JSON.stringify({ name: 'Gem 1.2', mainPrompt: 'm' })))).toEqual({ kind: 'preset', title: 'Gem 1.2', version: '1.2' })
        expect(await mod.describeFile('Gem_preset.json', strToU8(JSON.stringify({ name: 'Gem', promptTemplate: [] })))).toEqual({ kind: 'preset', title: 'Gem', version: '' }) // the app's own export name
        expect((await mod.describeFile('Bot.preset.json', strToU8(JSON.stringify({ spec: 'chara_card_v3', data: { name: 'Bot' } })))).kind).toBe('character') // content decides, not the name
        expect(mod.kindLabel('preset')).toBe('프롬프트 프리셋')
    })
    test('a prompt preset with the same name is updated in place (same id, this device\'s keys kept, the active one reloaded); a new name is added', async () => {
        const database = await import('../storage/database.svelte') as any
        const db: any = { botPresetsId: 1, botPresets: [{ id: 'p0', name: '다른 것' }, { id: 'p1', name: '바드 프롬프트 젬', mainPrompt: 'old', openAIKey: 'device-key', proxyKey: '' }] }
        database.getDatabase.mockReturnValue(db)
        let next: any = { name: '바드 프롬프트 젬', mainPrompt: 'new', openAIKey: '', proxyKey: 'file-proxy' }
        database.importPreset.mockImplementation(async () => { db.botPresets.push({ ...next, id: 'fresh' }) })
        const item = { key: 'preset:바드 프롬프트 젬', kind: 'preset', title: '바드 프롬프트 젬', fileName: 'gem.risup' } as any
        expect(await mod.applyItem(item, new Uint8Array([1]))).toBe('applied')
        expect(db.botPresets).toEqual([{ id: 'p0', name: '다른 것' }, { id: 'p1', name: '바드 프롬프트 젬', mainPrompt: 'new', openAIKey: 'device-key', proxyKey: 'file-proxy' }])
        expect(database.importPreset).toHaveBeenCalledWith({ name: 'gem.risup', data: new Uint8Array([1]) })
        expect(database.changeToPreset).toHaveBeenCalledWith(1, false)
        database.changeToPreset.mockClear(); next = { name: '새 프리셋 0.5.2', mainPrompt: 'x' }
        expect(await mod.applyItem(item, new Uint8Array([2]))).toBe('applied')
        expect(db.botPresets.map((p: any) => p.name)).toEqual(['다른 것', '바드 프롬프트 젬', '새 프리셋 0.5.2']); expect(database.changeToPreset).not.toHaveBeenCalled()
        // A preset added from a published item has the same id on every device (no NAS divergence), never the import's random one.
        expect(db.botPresets[2].id).toBe(await mod.publishedPresetId('preset:바드 프롬프트 젬', '새 프리셋 0.5.2')); expect(db.botPresets[2].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
        expect(await mod.publishedPresetId('preset:다른 배포', '새 프리셋 0.5.2')).not.toBe(db.botPresets[2].id)
        // An ST conversion takes the published file's name, so two ST presets never replace each other.
        next = { name: 'Imported ST Preset' }
        await mod.applyItem({ ...item, fileName: 'st one.json' }, new Uint8Array([4])); await mod.applyItem({ ...item, fileName: 'st two.json' }, new Uint8Array([5]))
        expect(db.botPresets.map((p: any) => p.name).slice(3)).toEqual(['st one', 'st two'])
        database.importPreset.mockImplementation(async () => {}) // unreadable file: nothing added
        await expect(mod.applyItem(item, new Uint8Array([3]))).rejects.toThrow(/프롬프트 프리셋/)
    })
    test('persona json must have a name and a prompt', () => {
        const b64 = (value: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
        expect(mod.readPersonaJson(b64({ name: '함건희', personaPrompt: 'p', note: 'n' }))).toEqual({ name: '함건희', personaPrompt: 'p', note: 'n' })
        expect(() => mod.readPersonaJson(b64({ name: '함건희' }))).toThrow()
    })

    test('asks each pending item once: no → declined, yes → imported → applied, cancelled import → declined, failure → not recorded', async () => {
        const { transferRequest } = await import('../playTransfer') as any
        const { alertConfirmMulti, alertError } = await import('../alert') as any
        const { importCharacterProcess } = await import('../characterCards') as any
        const card = strToU8('card bytes')
        const sha = createHash('sha256').update(card).digest('hex')
        const item = (key: string) => ({ key, kind: 'character', title: key, version: '1', file: `${sha}.charx`, fileName: 'a.charx', sha256: sha, bytes: card.length, publishedAt: new Date().toISOString(), publishedBy: 'pc', decision: '' })
        const decisions: any[] = []
        transferRequest.mockImplementation(async (path: string, init: any) => {
            const body = init?.body ? JSON.parse(init.body) : {}
            if (path === '/content-updates/overview') return new Response(JSON.stringify({ configured: true, items: [], pending: [item('character:a'), item('character:b'), item('character:c'), item('character:d')] }))
            if (path === '/content-updates/fetch') return new Response((body.key === 'character:d' ? strToU8('tampered!!') : card) as BodyInit)
            if (path === '/content-updates/decide') { decisions.push([body.key, body.decision]); return new Response('{}') }
            throw new Error('unexpected ' + path)
        })
        alertConfirmMulti.mockResolvedValueOnce(1).mockResolvedValueOnce(0).mockResolvedValueOnce(0).mockResolvedValueOnce(0)
        importCharacterProcess.mockResolvedValueOnce(2).mockResolvedValueOnce(null)
        await mod.checkContentUpdates(true)
        expect(decisions).toEqual([['character:a', 'declined'], ['character:b', 'applied'], ['character:c', 'declined']])
        expect(importCharacterProcess).toHaveBeenCalledTimes(2)
        expect(importCharacterProcess.mock.calls[0][0]).toMatchObject({ name: 'a.charx' })
        expect(alertError).toHaveBeenCalledTimes(1)
        // within the interval a non-forced check does nothing
        expect(await mod.checkContentUpdates()).toBeNull()
    })

    test('a persona with the same name is updated in place; when it is the selected one, the active fields follow', async () => {
        const { getDatabase } = await import('../storage/database.svelte') as any
        const { PngChunk } = await import('../pngChunk') as any
        const b64 = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify({ name: '함건희', personaPrompt: 'new prompt', note: 'new note' }))))
        PngChunk.readGenerator.mockImplementation(async function* () { yield { key: 'persona', value: b64 } })
        const db: any = { personas: [{ name: '다른 사람', id: 'x', personaPrompt: 'p', icon: 'i' }, { name: '함건희', id: 'keep', personaPrompt: 'old', note: 'old', icon: 'old-icon' }], selectedPersona: 1, personaPrompt: 'old', userNote: 'old', userIcon: 'old-icon', username: '함건희' }
        getDatabase.mockReturnValue(db)
        const item: any = { key: 'persona:함건희', kind: 'persona', title: '함건희', version: '', fileName: 'p.png' }
        expect(await mod.applyItem(item, new Uint8Array([1]))).toBe('applied')
        expect(db.personas[1]).toEqual({ name: '함건희', id: 'keep', personaPrompt: 'new prompt', note: 'new note', icon: 'new-icon' })
        expect([db.personaPrompt, db.userNote, db.userIcon, db.username]).toEqual(['new prompt', 'new note', 'new-icon', '함건희'])
        db.selectedPersona = 0; db.personaPrompt = 'p'
        await mod.applyItem(item, new Uint8Array([1]))
        expect(db.personaPrompt).toBe('p')
        db.personas = []
        await mod.applyItem(item, new Uint8Array([1]))
        expect(db.personas).toEqual([{ name: '함건희', icon: 'new-icon', personaPrompt: 'new prompt', note: 'new note', id: 'id' }])
    })

    test('an import that ended in rollback recovery is an error, not a "no"', async () => {
        const { importCharacterProcess } = await import('../characterCards') as any
        const { importSession } = await import('../importSession') as any
        importCharacterProcess.mockImplementationOnce(async () => { importSession.set({ phase: 'recovery' }); return null })
        await expect(mod.applyItem({ key: 'character:a', kind: 'character', fileName: 'a.charx' } as any, new Uint8Array([1]))).rejects.toThrow(/복구/)
        importSession.set({ phase: 'idle' })
        importCharacterProcess.mockResolvedValueOnce(null)
        expect(await mod.applyItem({ key: 'character:a', kind: 'character', fileName: 'a.charx' } as any, new Uint8Array([1]))).toBe('declined')
    })

    test('closing the dialog (-1) or a pending import recovery leaves the item unanswered', async () => {
        const { transferRequest } = await import('../playTransfer') as any
        const { alertConfirmMulti } = await import('../alert') as any
        const { importSession } = await import('../importSession') as any
        const pending = { key: 'character:z', kind: 'character', title: 'z', version: '1', file: 'f', fileName: 'z.charx', sha256: 's', bytes: 1, publishedAt: new Date().toISOString(), publishedBy: '', decision: '' }
        const calls: string[] = []
        transferRequest.mockImplementation(async (path: string) => {
            calls.push(path)
            if (path === '/content-updates/overview') return new Response(JSON.stringify({ configured: true, items: [], pending: [pending] }))
            return new Response('{}')
        })
        alertConfirmMulti.mockReset()
        importSession.set({ phase: 'recovery' })
        expect(await mod.checkContentUpdates(true)).toBeNull()
        expect(alertConfirmMulti).not.toHaveBeenCalled()
        importSession.set({ phase: 'idle' })
        alertConfirmMulti.mockResolvedValueOnce(-1)
        await mod.checkContentUpdates(true)
        expect(alertConfirmMulti).toHaveBeenCalledTimes(1)
        expect(calls).toEqual(['/content-updates/overview'])
    })
})

// 0.9.92-ver4: the Wi-Fi report goes to the server right before each NAS call, so the home address is used on the home Wi-Fi.
describe('content updates: fresh NAS route', () => {
    test('overview, fetch and publish report the network first; a failed report does not block the call', async () => {
        const { transferRequest } = await import('../playTransfer') as any
        const { reportSyncNetwork } = await import('../nasSync') as any
        const order: string[] = []
        reportSyncNetwork.mockReset().mockImplementation(async () => { order.push('report'); return {} })
        const card = strToU8('card bytes'), sha = createHash('sha256').update(card).digest('hex')
        transferRequest.mockReset().mockImplementation(async (path: string) => {
            order.push(path)
            if (path === '/content-updates/overview') return new Response(JSON.stringify({ configured: true, items: [], pending: [] }))
            if (path === '/content-updates/fetch') return new Response(card as BodyInit)
            if (path === '/content-updates/publish') return new Response('{}')
            throw new Error('unexpected ' + path)
        })
        await mod.fetchOverview()
        await mod.fetchContent({ key: 'character:a', sha256: sha, bytes: card.length } as any)
        await mod.publishContent({ key: 'character:a', kind: 'character', title: 'a', version: '1', fileName: 'a.charx', bytes: card })
        expect(order).toEqual(['report', '/content-updates/overview', 'report', '/content-updates/fetch', 'report', '/content-updates/publish'])
        // a report that never answers (native bridge silent) holds the call at most 3 s
        vi.useFakeTimers()
        try {
            reportSyncNetwork.mockImplementationOnce(() => new Promise(() => {}))
            order.length = 0
            const pending = mod.fetchOverview()
            await vi.advanceTimersByTimeAsync(2_900)
            expect(order).toEqual([])
            await vi.advanceTimersByTimeAsync(200)
            await expect(pending).resolves.toMatchObject({ configured: true })
            expect(order).toEqual(['/content-updates/overview'])
        } finally { vi.useRealTimers() }
        reportSyncNetwork.mockRejectedValueOnce(new Error('no native bridge'))
        await expect(mod.fetchOverview()).resolves.toMatchObject({ configured: true })
    })

    test('overview proceeds at 3 s even when abort rejects the network report', async () => {
        const { transferRequest } = await import('../playTransfer') as any
        const { reportSyncNetwork } = await import('../nasSync') as any
        const abort = vi.fn()
        const overview = { configured: true, items: [], pending: [] }
        transferRequest.mockReset().mockImplementation(async () => Response.json(overview))
        reportSyncNetwork.mockImplementationOnce((signal: AbortSignal) => new Promise((_, reject) => {
            signal.addEventListener('abort', () => {
                abort()
                reject(new DOMException('Network report aborted', 'AbortError'))
            }, { once: true })
        }))
        vi.useFakeTimers()
        try {
            const pending = mod.fetchOverview()
            await vi.advanceTimersByTimeAsync(2_999)
            expect(transferRequest).not.toHaveBeenCalled()
            expect(abort).not.toHaveBeenCalled()
            await vi.advanceTimersByTimeAsync(1)
            await expect(pending).resolves.toEqual(overview)
            expect(abort).toHaveBeenCalledOnce()
            expect(transferRequest).toHaveBeenCalledExactlyOnceWith('/content-updates/overview', expect.anything())
        } finally { vi.useRealTimers() }
    })

    test('overview waits for a network report that finishes before 3 s', async () => {
        const { transferRequest } = await import('../playTransfer') as any
        const { reportSyncNetwork } = await import('../nasSync') as any
        const overview = { configured: true, items: [], pending: [] }
        transferRequest.mockReset().mockImplementation(async () => Response.json(overview))
        reportSyncNetwork.mockImplementationOnce(() => new Promise(resolve => setTimeout(resolve, 1_500)))
        vi.useFakeTimers()
        try {
            const pending = mod.fetchOverview()
            await vi.advanceTimersByTimeAsync(1_499)
            expect(transferRequest).not.toHaveBeenCalled()
            await vi.advanceTimersByTimeAsync(1)
            await expect(pending).resolves.toEqual(overview)
            expect(transferRequest).toHaveBeenCalledExactlyOnceWith('/content-updates/overview', expect.anything())
        } finally { vi.useRealTimers() }
    })
})

// 0.9.92-ver5: the start check runs when the main screen is up and, while the app is busy, again every 3 s until it asks.
describe('content updates: start check', () => {
    test('busy at start (another dialog): no skip — asked as soon as the app is free; not before 1.5 s', async () => {
        const { transferRequest } = await import('../playTransfer') as any
        const { alertConfirmMulti } = await import('../alert') as any
        const { alertStore } = await import('../stores.svelte') as any
        const { reportSyncNetwork } = await import('../nasSync') as any
        reportSyncNetwork.mockReset().mockResolvedValue({})
        const card = strToU8('card bytes'), sha = createHash('sha256').update(card).digest('hex')
        const item = { key: 'persona:a', kind: 'persona', title: 'a', version: '1', file: `${sha}.png`, fileName: 'a.png', sha256: sha, bytes: card.length, publishedAt: new Date().toISOString(), publishedBy: 'pc', decision: '' }
        const calls: string[] = []
        transferRequest.mockReset().mockImplementation(async (path: string) => {
            calls.push(path)
            if (path === '/content-updates/overview') return new Response(JSON.stringify({ configured: true, items: [item], pending: [item] }))
            if (path === '/content-updates/decide') return new Response('{}')
            throw new Error('unexpected ' + path)
        })
        alertConfirmMulti.mockReset().mockResolvedValue(1) // "아니오": recorded as declined
        vi.useFakeTimers()
        try {
            alertStore.set({ type: 'wait' }) // e.g. the startup NAS sync dialog
            mod.startContentUpdates(true)
            await vi.advanceTimersByTimeAsync(1_400)
            expect(calls).toEqual([])
            await vi.advanceTimersByTimeAsync(10_000) // busy: retried every 3 s, nothing asked
            expect(alertConfirmMulti).not.toHaveBeenCalled()
            expect(calls).toEqual([])
            alertStore.set({ type: 'none' })
            await vi.advanceTimersByTimeAsync(3_100)
            expect(calls).toEqual(['/content-updates/overview', '/content-updates/decide'])
            expect(alertConfirmMulti).toHaveBeenCalledTimes(1)
            await vi.advanceTimersByTimeAsync(30_000) // asked once: no more start checks
            expect(alertConfirmMulti).toHaveBeenCalledTimes(1)
        } finally { vi.useRealTimers(); alertStore.set({ type: 'none' }) }
    })
})

describe('content updates: start check retries (per call)', () => {
    const setup = async () => {
        const { transferRequest } = await import('../playTransfer') as any
        const { alertConfirmMulti } = await import('../alert') as any
        const { alertStore } = await import('../stores.svelte') as any
        const { coordinatorState } = await import('../nasSyncCoordinator') as any
        const card = strToU8('card bytes'), sha = createHash('sha256').update(card).digest('hex')
        const item = (key: string) => ({ key, kind: 'persona', title: key, version: '1', file: `${sha}.png`, fileName: 'a.png', sha256: sha, bytes: card.length, publishedAt: new Date().toISOString(), publishedBy: 'pc', decision: '' })
        const calls: string[] = [], answered = new Set<string>()
        let overviewHook = async () => {}
        transferRequest.mockReset().mockImplementation(async (path: string, init: any) => {
            calls.push(path)
            if (path === '/content-updates/overview') { await overviewHook(); const pending = ['persona:a', 'persona:b'].filter(k => !answered.has(k)).map(item); return new Response(JSON.stringify({ configured: true, items: pending, pending })) }
            if (path === '/content-updates/decide') { answered.add(JSON.parse(init.body).key); return new Response('{}') }
            throw new Error('unexpected ' + path)
        })
        alertConfirmMulti.mockReset()
        return { calls, alertConfirmMulti, alertStore, coordinatorState, setOverviewHook: (h: () => Promise<void>) => { overviewHook = h } }
    }
    test('the app becomes busy while the list is fetched: asked again once it is free', async () => {
        vi.resetModules()
        const m = await import('./contentUpdates')
        const s = await setup()
        s.alertConfirmMulti.mockResolvedValue(1)
        vi.useFakeTimers()
        try {
            let first = true
            s.setOverviewHook(async () => { if (first) { first = false; s.alertStore.set({ type: 'wait' }) } }) // e.g. the app code dialog opens meanwhile
            m.startContentUpdates(true)
            await vi.advanceTimersByTimeAsync(1_600)
            expect(s.alertConfirmMulti).not.toHaveBeenCalled()
            s.alertStore.set({ type: 'none' })
            await vi.advanceTimersByTimeAsync(3_100)
            expect(s.alertConfirmMulti).toHaveBeenCalledTimes(2) // both items asked
            await vi.advanceTimersByTimeAsync(30_000)
            expect(s.alertConfirmMulti).toHaveBeenCalledTimes(2)
        } finally { vi.useRealTimers(); s.alertStore.set({ type: 'none' }) }
    })
    test('a question closed without an answer is not re-asked by the start retry; a running NAS sync cycle is waited for', async () => {
        vi.resetModules()
        const m = await import('./contentUpdates')
        const s = await setup()
        s.alertConfirmMulti.mockResolvedValue(-1)
        vi.useFakeTimers()
        try {
            s.coordinatorState.set({ running: true })
            m.startContentUpdates(true)
            await vi.advanceTimersByTimeAsync(7_600)
            expect(s.calls).toEqual([]) // waiting for the sync cycle, no request
            s.coordinatorState.set({ running: false })
            await vi.advanceTimersByTimeAsync(3_100)
            expect(s.alertConfirmMulti).toHaveBeenCalledTimes(1)
            await vi.advanceTimersByTimeAsync(30_000)
            expect(s.alertConfirmMulti).toHaveBeenCalledTimes(1)
        } finally { vi.useRealTimers(); s.coordinatorState.set(null) }
    })
})

// 0.9.92-ver6: the server's write gate (423 NAS_SYNC_BUSY while a NAS sync step runs) is waited out, not reported as a failure.
describe('content updates: NAS sync busy answer', () => {
    const busy423 = () => Object.assign(new Error('NAS sync apply must finish before saving'), { status: 423, code: 'NAS_SYNC_BUSY' })
    test('fetch, decide and publish are sent again until the sync step ends; other errors fail at once', async () => {
        const { transferRequest } = await import('../playTransfer') as any
        const { reportSyncNetwork } = await import('../nasSync') as any
        reportSyncNetwork.mockReset().mockResolvedValue({})
        const card = strToU8('card bytes'), sha = createHash('sha256').update(card).digest('hex')
        const seen: string[] = []
        let refusals = 0
        transferRequest.mockReset().mockImplementation(async (path: string) => {
            // only this test's requests: the start check / app code watch of an earlier test may still be polling the same mock
            if (!['/content-updates/fetch', '/content-updates/decide', '/content-updates/publish'].includes(path)) return new Response('{}')
            seen.push(path)
            if (refusals > 0) { refusals--; throw busy423() }
            if (path === '/content-updates/fetch') return new Response(card as BodyInit)
            return new Response('{}')
        })
        vi.useFakeTimers()
        try {
            refusals = 3
            const fetched = mod.fetchContent({ key: 'character:a', sha256: sha, bytes: card.length } as any)
            await vi.advanceTimersByTimeAsync(3_000)
            await expect(fetched).resolves.toEqual(card)
            expect(seen.filter(p => p === '/content-updates/fetch')).toHaveLength(4)
            expect(get(mod.contentUpdateStatus)).toBe('')
            refusals = 1; seen.length = 0
            const decided = mod.recordDecision({ key: 'character:a', sha256: sha }, 'applied')
            await vi.advanceTimersByTimeAsync(1_000)
            await decided
            expect(seen).toEqual(['/content-updates/decide', '/content-updates/decide'])
            refusals = 2; seen.length = 0
            const published = mod.publishContent({ key: 'character:a', kind: 'character', title: 'a', version: '1', fileName: 'a.charx', bytes: card })
            await vi.advanceTimersByTimeAsync(2_000)
            await published
            expect(seen).toEqual(['/content-updates/publish', '/content-updates/publish', '/content-updates/publish'])
            transferRequest.mockImplementationOnce(async () => { throw Object.assign(new Error('HTTP 500'), { status: 500 }) })
            await expect(mod.recordDecision({ key: 'character:a', sha256: sha }, 'applied')).rejects.toThrow('HTTP 500')
        } finally { vi.useRealTimers() }
    })
    test('an armed sync apply (transaction) is waited for 15 s, then reported as pending with its transaction', async () => {
        const { transferRequest } = await import('../playTransfer') as any
        transferRequest.mockReset().mockImplementation(async () => { throw Object.assign(busy423(), { transaction: 'tx-1' }) })
        vi.useFakeTimers()
        try {
            const decided = mod.recordDecision({ key: 'character:a', sha256: 'x' }, 'applied')
            const outcome = expect(decided).rejects.toMatchObject({ code: 'NAS_SYNC_BUSY', transaction: 'tx-1', message: expect.stringMatching(/적용 결과를 확인/) })
            await vi.advanceTimersByTimeAsync(16_000)
            await outcome
            expect(transferRequest.mock.calls.filter(([path]: any) => path === '/content-updates/decide').length).toBeLessThanOrEqual(17) // only this request: a start check of an earlier test may still be polling
        } finally { vi.useRealTimers() }
    })
    test('a sync step longer than a minute: a clear error, nothing left in the status line', async () => {
        const { transferRequest } = await import('../playTransfer') as any
        transferRequest.mockReset().mockImplementation(async () => { throw busy423() })
        vi.useFakeTimers()
        try {
            const decided = mod.recordDecision({ key: 'character:a', sha256: 'x' }, 'applied')
            const outcome = expect(decided).rejects.toThrow(/1분 넘게/)
            await vi.advanceTimersByTimeAsync(61_000)
            await outcome
            expect(get(mod.contentUpdateStatus)).toBe('')
        } finally { vi.useRealTimers() }
    })
})

// 0.9.92-ver6: a version this device already has is recorded as applied without asking.
describe('content updates: already installed', () => {
    test('same card version or same persona version → recorded, not asked; other versions and presets are asked', async () => {
        const { getDatabase } = await import('../storage/database.svelte') as any
        getDatabase.mockReturnValue({
            characters: [{ name: '마물소녀도감 1.2.35-argon.16 ver', characterVersion: '1.2.35-argon.16' }, { name: 'Shecubus!', characterVersion: '' }],
            personas: [{ name: '함건희(보어)', note: '함건희(보어) v1.0.33-vore.9 · …', personaPrompt: 'prompt 35' }],
        })
        expect(await mod.alreadyInstalled({ kind: 'character', title: '마물소녀도감 1.2.35-argon.16 ver', version: '1.2.35-argon.16' })).toBe(true)
        expect(await mod.alreadyInstalled({ kind: 'character', title: '마물소녀도감 1.2.35-argon.17 ver', version: '1.2.35-argon.17' })).toBe(false)
        // a persona is compared by its content (the real v1.0.35 PNG notes still carry v1.0.33)
        const { PngChunk } = await import('../pngChunk') as any
        const { transferRequest: tr } = await import('../playTransfer') as any
        const personaPng = (prompt: string) => { const bytes = strToU8('png ' + prompt); return { bytes, sha: createHash('sha256').update(bytes).digest('hex'), json: btoa(unescape(encodeURIComponent(JSON.stringify({ name: '함건희(보어)', personaPrompt: prompt, note: '함건희(보어) v1.0.33-vore.9 · …' })))) } }
        const same = personaPng('prompt 35'), changed = personaPng('prompt 36')
        let serving = same
        tr.mockReset().mockImplementation(async (path: string) => { if (path === '/content-updates/fetch') return new Response(serving.bytes as BodyInit); throw new Error('unexpected ' + path) })
        PngChunk.readGenerator.mockImplementation(async function* () { yield { key: 'persona', value: serving.json } })
        const personaItem = (p: any) => ({ kind: 'persona', key: 'persona:함건희(보어)', title: '함건희(보어)', version: 'v1.0.35-vore.10', sha256: p.sha, bytes: p.bytes.length, file: p.sha + '.png' })
        expect(await mod.alreadyInstalled(personaItem(same) as any)).toBe(true)
        serving = changed
        expect(await mod.alreadyInstalled(personaItem(changed) as any)).toBe(false) // same name and note, new prompt: asked
        // deleted while the comparison download ran: the current list decides
        serving = same
        const db = getDatabase()
        tr.mockImplementationOnce(async () => { db.personas = []; return new Response(same.bytes as BodyInit) })
        expect(await mod.alreadyInstalled(personaItem(same) as any)).toBe(false)
        db.personas = [{ name: '함건희(보어)', note: '함건희(보어) v1.0.33-vore.9 · …', personaPrompt: 'prompt 35' }]
        PngChunk.readGenerator.mockImplementation(async function* () {})
        expect(await mod.alreadyInstalled({ kind: 'persona', title: '함건희(보어·꿈각성)', version: 'v1.0.34-awakening.3' })).toBe(false) // no persona of that name: no download
        expect(await mod.alreadyInstalled({ kind: 'preset', title: '바드 프롬프트 젬', version: '0.5.2-r2' })).toBe(false)
        expect(await mod.alreadyInstalled({ kind: 'character', title: 'Shecubus!', version: '' })).toBe(false)

        const { transferRequest } = await import('../playTransfer') as any
        const { alertConfirmMulti } = await import('../alert') as any
        const { reportSyncNetwork } = await import('../nasSync') as any
        reportSyncNetwork.mockReset().mockResolvedValue({})
        const sha = 'a'.repeat(64)
        const item = (kind: string, key: string, title: string, version: string) => ({ key, kind, title, version, file: sha + '.x', fileName: 'x', sha256: sha, bytes: 1, publishedAt: new Date().toISOString(), publishedBy: 'pc', decision: '' })
        const decisions: any[] = []
        transferRequest.mockReset().mockImplementation(async (path: string, init: any) => {
            if (path === '/content-updates/overview') return new Response(JSON.stringify({ configured: true, items: [], pending: [
                item('character', 'character:마물소녀도감', '마물소녀도감 1.2.35-argon.16 ver', '1.2.35-argon.16'),
                item('persona', 'persona:함건희(보어·꿈각성)', '함건희(보어·꿈각성)', 'v1.0.34-awakening.3')] }))
            if (path === '/content-updates/decide') { const b = JSON.parse(init.body); decisions.push([b.key, b.decision]); return new Response('{}') }
            throw new Error('unexpected ' + path)
        })
        alertConfirmMulti.mockReset().mockResolvedValue(1)
        await mod.checkContentUpdates(true)
        expect(decisions).toEqual([['character:마물소녀도감', 'applied'], ['persona:함건희(보어·꿈각성)', 'declined']])
        expect(alertConfirmMulti).toHaveBeenCalledTimes(1)
    })
})

// 0.9.92-ver11: a plugin (.js) is published, asked about and imported with the app's own importPlugin.
describe('content updates: plugins', () => {
    const script = '//@name argon\r\n//@display-name Argon\r\n//@version 1.0.3\r\n//@api 3.0\r\n//@arg model string\r\n//@arg added int\r\nRisuai.log("argon 1.0.3")\r\n'
    const fileBytes = strToU8('﻿' + script) // a BOM, as a file saved by some editors: removed as upstream importPlugin does
    const sha = createHash('sha256').update(fileBytes).digest('hex')
    const pending = { key: 'plugin:argon', kind: 'plugin', title: 'argon', version: '1.0.3', file: `${sha}.js`, fileName: 'argon_1.0.3.js', sha256: sha, bytes: fileBytes.length, publishedAt: new Date().toISOString(), publishedBy: 'pc', decision: '' }
    const setup = async (plugins: any[]) => {
        const { getDatabase } = await import('../storage/database.svelte') as any
        const { transferRequest, transferBusy } = await import('../playTransfer') as any
        const { alertConfirmMulti, alertError } = await import('../alert') as any
        const { importPlugin, loadPlugins } = await import('../plugins/plugins.svelte') as any
        const { requestImmediateSave } = await import('../globalApi.svelte') as any
        const { reportSyncNetwork } = await import('../nasSync') as any
        reportSyncNetwork.mockReset().mockResolvedValue({})
        const db: any = { characters: [], personas: [], plugins }
        getDatabase.mockReturnValue(db)
        const calls: string[] = [], decisions: string[] = []
        let onFetch = () => {}
        transferRequest.mockReset().mockImplementation(async (path: string, init: any) => {
            calls.push(path)
            if (path === '/content-updates/overview') return new Response(JSON.stringify({ configured: true, items: [pending], pending: [pending] }))
            if (path === '/content-updates/fetch') { onFetch(); return new Response(fileBytes as BodyInit) }
            if (path === '/content-updates/decide') { decisions.push(JSON.parse(init.body).decision); return new Response('{}') }
            return new Response('{}')
        })
        // As upstream importPlugin: a same-name plugin is replaced by a fresh entry (enabled, default argument values); a new one is added.
        let heldDuringImport: boolean | undefined
        importPlugin.mockReset().mockImplementation(async (code: string) => {
            heldDuringImport = get(transferBusy) as boolean
            const fresh = { name: 'argon', script: code, arguments: { model: 'string', added: 'int' }, realArg: { model: '', added: 0 }, version: '3.0', enabled: true }
            const index = db.plugins.findIndex((p: any) => p.name === 'argon')
            if (index >= 0) db.plugins[index] = fresh; else db.plugins.push(fresh)
            return true
        })
        loadPlugins.mockClear(); requestImmediateSave.mockClear()
        alertConfirmMulti.mockReset().mockResolvedValue(0); alertError.mockReset()
        return { db, calls, decisions, importPlugin, loadPlugins, requestImmediateSave, alertConfirmMulti, alertError, held: () => heldDuringImport, setOnFetch: (f: () => void) => { onFetch = f } }
    }

    test('a .js file is described as a plugin from its //@name and //@version lines', async () => {
        expect(await mod.describeFile('argon_1.0.3.js', fileBytes)).toEqual({ kind: 'plugin', title: 'argon', version: '1.0.3' })
        expect(await mod.describeFile('x.js', strToU8('//@name x\nconsole.log(1)'))).toEqual({ kind: 'plugin', title: 'x', version: '' })
        await expect(mod.describeFile('x.js', strToU8('console.log(1)'))).rejects.toThrow(/@name/)
        expect(mod.kindLabel('plugin')).toBe('플러그인')
    })

    test('publishing sends the plugin kind; the overview request lists the kinds this client imports', async () => {
        const { transferRequest } = await import('../playTransfer') as any
        const seen: any[] = []
        transferRequest.mockReset().mockImplementation(async (path: string, init: any) => {
            seen.push([path, init])
            if (path === '/content-updates/overview') return new Response(JSON.stringify({ configured: true, items: [], pending: [] }))
            return new Response('{}')
        })
        await mod.publishContent({ key: 'plugin:argon', kind: 'plugin', title: 'argon', version: '1.0.3', fileName: 'argon_1.0.3.js', bytes: fileBytes })
        const publish = seen.find(([path]) => path === '/content-updates/publish')
        expect(JSON.parse(decodeURIComponent(publish[1].headers['x-content-meta']))).toEqual({ key: 'plugin:argon', kind: 'plugin', title: 'argon', version: '1.0.3', fileName: 'argon_1.0.3.js' })
        expect(publish[1].body).toBe(fileBytes)
        await mod.fetchOverview()
        const overview = seen.find(([path]) => path === '/content-updates/overview')
        expect(JSON.parse(overview[1].body)).toEqual({ kinds: ['character', 'persona', 'preset', 'plugin', 'module'] })
    })

    test('yes → the app\'s importPlugin gets the script text as a hand import (no update flag); a same-name plugin keeps this device\'s argument values and on/off state', async () => {
        const s = await setup([{ name: 'argon', script: 'old', arguments: { model: 'string', gone: 'string' }, realArg: { model: 'my-model', gone: 'g' }, version: '3.0', enabled: false, customLink: [] }])
        const { transferBusy } = await import('../playTransfer') as any
        await mod.checkContentUpdates(true)
        expect(s.alertConfirmMulti).toHaveBeenCalledTimes(1)
        expect(s.alertConfirmMulti.mock.calls[0][0]).toBe('새 플러그인이 올라왔어요. 지금 가져올까요?')
        expect(s.alertConfirmMulti.mock.calls[0][2]).toMatch(/설정값과 켜짐\/꺼짐 상태는 그대로/)
        expect(s.importPlugin).toHaveBeenCalledTimes(1)
        expect(s.importPlugin.mock.calls[0]).toEqual([script]) // the text without the BOM, and no { isUpdate }: upstream's own "update?" dialog is shown
        expect(s.held()).toBe(true) // the import owns the busy state, like a persona or preset import
        expect(get(transferBusy)).toBe(false)
        expect(s.db.plugins).toEqual([{ name: 'argon', script, arguments: { model: 'string', added: 'int' }, realArg: { model: 'my-model', added: 0 }, version: '3.0', enabled: false, customLink: [] }])
        expect(s.loadPlugins).toHaveBeenCalledTimes(1) // loaded again with the restored on/off state
        expect(s.requestImmediateSave).toHaveBeenCalledTimes(1)
        expect(s.decisions).toEqual(['applied'])
        expect(s.alertError).not.toHaveBeenCalled()
    })

    test('a new plugin is added as the app\'s import adds it; "no" in the app\'s own dialog is recorded as declined', async () => {
        const s = await setup([])
        await mod.checkContentUpdates(true)
        expect(s.db.plugins).toEqual([{ name: 'argon', script, arguments: { model: 'string', added: 'int' }, realArg: { model: '', added: 0 }, version: '3.0', enabled: true }])
        expect(s.loadPlugins).not.toHaveBeenCalled() // importPlugin loads the plugins itself
        expect(s.decisions).toEqual(['applied'])
        const t = await setup([{ name: 'argon', script: 'old', arguments: {}, realArg: {}, enabled: true }])
        t.importPlugin.mockResolvedValueOnce(undefined) // the user answered no to "update the existing plugin?"
        await mod.checkContentUpdates(true)
        expect(t.db.plugins[0].script).toBe('old')
        expect(t.decisions).toEqual(['declined'])
    })

    test('the app\'s import put the plugin in the list but its own save failed (it answers nothing): the settings are still restored, and it is loaded and saved here', async () => {
        const s = await setup([{ name: 'argon', script: 'old', arguments: { model: 'string' }, realArg: { model: 'my-model' }, version: '3.0', enabled: false }])
        const replace = s.importPlugin.getMockImplementation()
        s.importPlugin.mockImplementation(async (code: string) => { await replace(code); return undefined })
        await mod.checkContentUpdates(true)
        expect(s.db.plugins).toEqual([{ name: 'argon', script, arguments: { model: 'string', added: 'int' }, realArg: { model: 'my-model', added: 0 }, version: '3.0', enabled: false }])
        expect(s.loadPlugins).toHaveBeenCalledTimes(1)
        expect(s.requestImmediateSave).toHaveBeenCalledTimes(1)
        expect(s.decisions).toEqual(['applied'])
        const t = await setup([]) // a new plugin whose save failed inside the app's import: loaded and saved here
        const add = t.importPlugin.getMockImplementation()
        t.importPlugin.mockImplementation(async (code: string) => { await add(code); return undefined })
        await mod.checkContentUpdates(true)
        expect(t.db.plugins).toHaveLength(1)
        expect(t.requestImmediateSave).toHaveBeenCalledTimes(1)
        expect(t.decisions).toEqual(['applied'])
        // the same script was already installed (its comparison download had failed, so it was asked): the settings are restored as well
        const u = await setup([{ name: 'argon', script, arguments: { model: 'string', added: 'int' }, realArg: { model: 'my-model', added: 3 }, version: '3.0', enabled: false }])
        const again = u.importPlugin.getMockImplementation()
        u.importPlugin.mockImplementation(async (code: string) => { await again(code); return undefined })
        expect(await mod.applyItem(pending as any, fileBytes)).toBe('applied')
        expect(u.db.plugins).toEqual([{ name: 'argon', script, arguments: { model: 'string', added: 'int' }, realArg: { model: 'my-model', added: 3 }, version: '3.0', enabled: false }])
        expect(u.requestImmediateSave).toHaveBeenCalledTimes(1)
    })

    test('the same script already installed → recorded as applied without asking; a different script is asked', async () => {
        const s = await setup([{ name: 'argon', script, arguments: {}, realArg: {}, enabled: true }])
        await mod.checkContentUpdates(true)
        expect(s.alertConfirmMulti).not.toHaveBeenCalled()
        expect(s.importPlugin).not.toHaveBeenCalled()
        expect(s.decisions).toEqual(['applied'])
        expect(await mod.alreadyInstalled({ ...pending, kind: 'plugin' } as any)).toBe(true)
        s.db.plugins = [{ name: 'argon', script: script.replace('1.0.3")', '1.0.2")'), arguments: {}, realArg: {}, enabled: true }]
        expect(await mod.alreadyInstalled({ ...pending, kind: 'plugin' } as any)).toBe(false)
        s.db.plugins = [{ name: 'other', script, arguments: {}, realArg: {}, enabled: true }]
        const fetches = s.calls.filter(p => p === '/content-updates/fetch').length
        expect(await mod.alreadyInstalled({ ...pending, kind: 'plugin' } as any)).toBe(false)
        expect(s.calls.filter(p => p === '/content-updates/fetch').length).toBe(fetches) // no plugin of that name: no download
    })

    test('another dialog opened during the plugin comparison download: no question over it', async () => {
        const s = await setup([{ name: 'argon', script: 'old', arguments: {}, realArg: {}, enabled: true }])
        const { alertStore } = await import('../stores.svelte') as any
        s.setOnFetch(() => alertStore.set({ type: 'confirm' }))
        try {
            await mod.checkContentUpdates(true)
            expect(s.alertConfirmMulti).not.toHaveBeenCalled()
            expect(s.importPlugin).not.toHaveBeenCalled()
            expect(s.decisions).toEqual([])
        } finally { alertStore.set({ type: 'none' }) }
    })
})

describe('content updates: comparison download then busy', () => {
    test('another dialog opened during the persona comparison download: no question over it', async () => {
        const { getDatabase } = await import('../storage/database.svelte') as any
        const { transferRequest } = await import('../playTransfer') as any
        const { alertConfirmMulti } = await import('../alert') as any
        const { alertStore } = await import('../stores.svelte') as any
        const { PngChunk } = await import('../pngChunk') as any
        getDatabase.mockReturnValue({ characters: [], personas: [{ name: '함건희(보어)', note: 'n', personaPrompt: 'old' }] })
        const bytes = strToU8('png new'), sha = createHash('sha256').update(bytes).digest('hex')
        const json = btoa(unescape(encodeURIComponent(JSON.stringify({ name: '함건희(보어)', personaPrompt: 'new', note: 'n' }))))
        PngChunk.readGenerator.mockImplementation(async function* () { yield { key: 'persona', value: json } })
        const item = { key: 'persona:함건희(보어)', kind: 'persona', title: '함건희(보어)', version: '1', file: sha + '.png', fileName: 'p.png', sha256: sha, bytes: bytes.length, publishedAt: new Date().toISOString(), publishedBy: 'pc', decision: '' }
        const decisions: string[] = []
        transferRequest.mockReset().mockImplementation(async (path: string, init: any) => {
            if (path === '/content-updates/overview') return new Response(JSON.stringify({ configured: true, items: [item], pending: [item] }))
            if (path === '/content-updates/fetch') { alertStore.set({ type: 'confirm' }); return new Response(bytes as BodyInit) }
            if (path === '/content-updates/decide') { decisions.push(JSON.parse(init.body).decision); return new Response('{}') }
            throw new Error('unexpected ' + path)
        })
        alertConfirmMulti.mockReset().mockResolvedValue(1)
        try {
            await mod.checkContentUpdates(true)
            expect(alertConfirmMulti).not.toHaveBeenCalled()
            expect(decisions).toEqual([])
        } finally { alertStore.set({ type: 'none' }); PngChunk.readGenerator.mockImplementation(async function* () {}) }
    })
})

// 0.9.92-ver7 (tablet: 「함건희(…) (v1.0.35-carrier.8)」를 가져오지 못했어요 … setItem Error): a NAS sync cycle around the import.
describe('content updates: NAS sync cycle around the import', () => {
    const setup = async () => {
        const { getDatabase, saveImage } = await import('../storage/database.svelte') as any
        const { transferRequest } = await import('../playTransfer') as any
        const { alertConfirmMulti, alertError } = await import('../alert') as any
        const { PngChunk } = await import('../pngChunk') as any
        const { coordinatorState } = await import('../nasSyncCoordinator') as any
        getDatabase.mockReturnValue({ characters: [], personas: [] })
        const bytes = strToU8('png carrier'), sha = createHash('sha256').update(bytes).digest('hex')
        const json = btoa(unescape(encodeURIComponent(JSON.stringify({ name: '함건희(carrier)', personaPrompt: 'p', note: 'n' }))))
        PngChunk.readGenerator.mockImplementation(async function* () { yield { key: 'persona', value: json } })
        const item = { key: 'persona:함건희(carrier)', kind: 'persona', title: '함건희(carrier)', version: '1', file: sha + '.png', fileName: 'p.png', sha256: sha, bytes: bytes.length, publishedAt: new Date().toISOString(), publishedBy: 'pc', decision: '' }
        const decisions: string[] = []
        let onFetch = () => {}
        transferRequest.mockReset().mockImplementation(async (path: string, init: any) => {
            if (path === '/content-updates/overview') return new Response(JSON.stringify({ configured: true, items: [item], pending: [item] }))
            if (path === '/content-updates/fetch') { onFetch(); return new Response(bytes as BodyInit) }
            if (path === '/content-updates/decide') { decisions.push(JSON.parse(init.body).decision); return new Response('{}') }
            throw new Error('unexpected ' + path)
        })
        alertConfirmMulti.mockReset().mockResolvedValue(0)
        alertError.mockReset(); saveImage.mockClear()
        return { saveImage, alertError, coordinatorState, decisions, setOnFetch: (f: () => void) => { onFetch = f }, cleanup: () => { coordinatorState.set(null); PngChunk.readGenerator.mockImplementation(async function* () {}) } }
    }
    test('a persona import owns the busy state while it writes (a sync apply cannot arm under it) and releases it afterwards', async () => {
        const s = await setup()
        const { transferBusy } = await import('../playTransfer') as any
        let heldAtSave: boolean | undefined
        s.saveImage.mockImplementationOnce(async () => { heldAtSave = get(transferBusy) as boolean; return 'icon' })
        try {
            await mod.checkContentUpdates(true)
            expect(heldAtSave).toBe(true)
            expect(get(transferBusy)).toBe(false)
            expect(s.decisions).toEqual(['applied'])
        } finally { s.cleanup() }
    })
    test('something else took the app (a sync apply armed) right after the download: nothing is written, the item stays unanswered; a failed save releases the busy state', async () => {
        const s = await setup()
        const { transferUnavailable, transferBusy } = await import('../playTransfer') as any
        transferUnavailable.mockReturnValueOnce(true)
        try {
            await mod.checkContentUpdates(true)
            expect(s.saveImage).not.toHaveBeenCalled()
            expect(s.decisions).toEqual([])
            expect(s.alertError).not.toHaveBeenCalled()
            s.saveImage.mockImplementationOnce(async () => { throw 'setItem Error' })
            await mod.checkContentUpdates(true)
            expect(s.alertError).toHaveBeenCalledTimes(1)
            expect(get(transferBusy)).toBe(false)
            expect(s.decisions).toEqual([])
        } finally { s.cleanup() }
    })
})

// 0.9.96-ver4: a module (.risum) as a fifth kind.
describe('content updates: modules', () => {
    const fileBytes = strToU8('risum file bytes 7.2-mge.1')
    const sha = createHash('sha256').update(fileBytes).digest('hex')
    const pending = { key: 'module:삶은계란', kind: 'module', title: '라이프 모듈 v.7.2-mge.1', version: '7.2-mge.1', file: `${sha}.risum`, fileName: '라이프 모듈 v.7.2-mge.1.risum', sha256: sha, bytes: fileBytes.length, publishedAt: new Date().toISOString(), publishedBy: 'pc', decision: '' }
    const risum = (module: unknown) => {
        const json = strToU8(JSON.stringify({ type: 'risuModule', module }))
        const out = new Uint8Array(6 + json.length + 1)
        out[0] = 111; out[1] = 0; new DataView(out.buffer).setUint32(2, json.length, true); out.set(json, 6); out[6 + json.length] = 0
        return out
    }
    /** Which modules upstream getModules turns on for one character/chat/persona (ids or namespaces in any list). */
    const active = (db: any, character: any, chat: any, personaId?: string) => {
        const ids = new Set<string>([...(db.enabledModules ?? []), ...((personaId && db.personaEnabledModules?.[personaId]) ?? []), ...(chat?.modules ?? []), ...(character?.modules ?? []),
            ...String(db.moduleIntergration ?? '').split(',').map((x: string) => x.trim()).filter(Boolean)])
        return db.modules.filter((m: any) => ids.has(m.id) || (m.namespace && ids.has(m.namespace))).map((m: any) => m.id)
    }
    const setup = async (db: any, opts: { failSave?: (call: any) => boolean } = {}) => {
        const { getDatabase } = await import('../storage/database.svelte') as any
        const { transferRequest, transferBusy } = await import('../playTransfer') as any
        const { alertConfirmMulti, alertError, notifySuccess } = await import('../alert') as any
        const { requestImmediateSave } = await import('../globalApi.svelte') as any
        const { runImport, importSession } = await import('../importSession') as any
        const { readModule } = await import('../process/modules') as any
        importSession.set({ phase: 'idle' })
        getDatabase.mockReturnValue(db)
        const decisions: string[] = [], calls: string[] = [], saves: any[] = []
        transferRequest.mockReset().mockImplementation(async (path: string, init: any) => {
            calls.push(path)
            if (path === '/content-updates/overview') return new Response(JSON.stringify({ configured: true, items: [pending], pending: [pending] }))
            if (path === '/content-updates/fetch') return new Response(fileBytes as BodyInit)
            if (path === '/content-updates/decide') { decisions.push(JSON.parse(init.body).decision); return new Response('{}') }
            return new Response('{}')
        })
        // Every save is checked: no saved state may turn on two modules of the namespace for any character/chat/persona.
        requestImmediateSave.mockReset().mockImplementation(async (options: any) => {
            const both: string[] = []
            for (const character of db.characters ?? []) for (const chat of [...(character.chats ?? []), null]) for (const persona of [undefined, ...Object.keys(db.personaEnabledModules ?? {})]) {
                const on = active(db, character, chat, persona).filter((id: string) => db.modules.find((m: any) => m.id === id)?.namespace === '삶은계란')
                if (on.length > 1) both.push(`${character.chaId}/${chat?.id}/${persona}: ${on}`)
            }
            saves.push({ options, both, held: get(transferBusy) })
            if (opts.failSave?.(options)) throw new Error('save failed')
        })
        const transaction = { check: vi.fn(), register: vi.fn() }
        runImport.mockReset().mockImplementation(async (work: any) => {
            try { const result = await work(transaction); await requestImmediateSave({ flushServer: 'canonical', rejectOnFailure: true }); return result }
            catch (error) { db.modules = db.modules.filter((m: any) => !transaction.register.mock.calls.some((c: any) => c[1] === m.id)); throw error } // rollback: the registered module out
        })
        readModule.mockReset().mockImplementation(async () => ({ name: '라이프 모듈 v.7.2-mge.1', namespace: '삶은계란', lowLevelAccess: true, id: 'random-v4', trigger: Array(12).fill({}), assets: [['a', 'assets/h1.png', 'png']] }))
        alertConfirmMulti.mockReset().mockResolvedValue(0); alertError.mockReset(); notifySuccess.mockReset()
        return { db, decisions, calls, saves, transaction, runImport, readModule, alertConfirmMulti, alertError, notifySuccess, requestImmediateSave }
    }
    const deviceDb = () => ({
        modules: [{ id: 'life-611', name: '라이프 모듈 v.6.11', namespace: '삶은계란' }, { id: 'other', name: 'Other', namespace: 'Nureong' }],
        enabledModules: ['other', 'life-611'], personaEnabledModules: { p1: ['life-611'], p2: ['other'] },
        characters: [
            { chaId: 'c1', modules: ['life-611'], chats: [{ id: 'h1', modules: ['life-611', 'other'], message: [] }, { id: 'ph', modules: ['life-611'], _placeholder: true, message: [] }, { id: 'none', message: [] }] },
            { chaId: 'c2', modules: ['other'], chats: [{ id: 'x', modules: ['other'], message: [] }] },
        ],
        moduleIntergration: 'Nureong, 삶은계란', botPresetsId: 0,
        botPresets: [{ id: 'b0', moduleIntergration: 'Nureong, 삶은계란' }, { id: 'b1', moduleIntergration: '-Nureong' }, { id: 'b2' }],
        moduleModelBindings: { 'life-611': 'preset-a' },
    })

    test('a .risum is described from its module record (namespace = default publish name); other bytes are refused', async () => {
        expect(await mod.describeFile('라이프 모듈 v.7.2-mge.1.risum', risum({ name: '라이프 모듈 v.7.2-mge.1', namespace: '삶은계란', id: 'f78' })))
            .toEqual({ kind: 'module', title: '라이프 모듈 v.7.2-mge.1', version: '7.2-mge.1', series: '삶은계란' })
        expect(await mod.describeFile('m.risum', risum({ name: 'Plain' }))).toEqual({ kind: 'module', title: 'Plain', version: '' })
        await expect(mod.describeFile('m.risum', strToU8('not a module'))).rejects.toThrow(/모듈/)
        await expect(mod.describeFile('m.risum', risum({ namespace: 'x' }))).rejects.toThrow(/이름/)
        const cut = risum({ name: 'x' }); await expect(mod.describeFile('m.risum', cut.subarray(0, 10))).rejects.toThrow(/잘렸/)
        expect(mod.kindLabel('module')).toBe('모듈')
    })

    test('the module id is decided by the file: the same on every device, uuid-shaped, another file another id', async () => {
        const id = await mod.publishedModuleId(sha)
        expect(id).toBe(await mod.publishedModuleId(sha))
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
        expect(await mod.publishedModuleId('0'.repeat(64))).not.toBe(id)
    })

    test('yes → imported under the file id and turned on everywhere the earlier one was on, in the same save; the earlier one stays, off', async () => {
        const start: any = deviceDb()
        start.characters.push({ chaId: 'c3', modules: ['삶은계란'], chats: [{ id: 'p3', modules: ['삶은계란'], _placeholder: true, message: [] }] }) // a character not open, on by namespace
        const s = await setup(start)
        await mod.checkContentUpdates(true)
        const id = await mod.publishedModuleId(sha)
        expect(s.alertConfirmMulti.mock.calls[0][0]).toBe('새 모듈이 올라왔어요. 지금 가져올까요?')
        expect(s.alertConfirmMulti.mock.calls[0][2]).toMatch(/꺼진 채 목록에 남겨요/)
        expect(s.readModule).toHaveBeenCalledTimes(1)
        expect(Buffer.isBuffer(s.readModule.mock.calls[0][0])).toBe(true)
        expect(s.transaction.register).toHaveBeenCalledWith('module', id)
        const db = s.db
        expect(db.modules.map((m: any) => m.id)).toEqual(['life-611', 'other', id]) // the earlier module is kept
        expect(db.modules[2]).toMatchObject({ id, name: '라이프 모듈 v.7.2-mge.1', namespace: '삶은계란' })
        expect(db.enabledModules).toEqual(['other', id])
        expect(db.personaEnabledModules).toEqual({ p1: [id], p2: ['other'] })
        expect(db.characters[0].modules).toEqual([id])
        expect(db.characters[0].chats.map((c: any) => c.modules)).toEqual([[id, 'other'], [id], undefined])
        expect(db.characters[1]).toEqual(deviceDb().characters[1])
        expect([db.characters[2].modules, db.characters[2].chats[0].modules]).toEqual([[id], [id]])
        // A namespace in module integration turns on every module of it: replaced too, so the earlier one is off there as well.
        expect(db.moduleIntergration).toBe(`Nureong,${id}`)
        expect(db.botPresets.map((p: any) => p.moduleIntergration)).toEqual([`Nureong,${id}`, '-Nureong', undefined])
        expect(db.moduleModelBindings).toEqual({ 'life-611': 'preset-a', [id]: 'preset-a' })
        // The import's own save (the namespace entry written out as the earlier id, the new module off), then one switch save with the
        // changed characters and the loaded chats (a placeholder's list lives in the stub), under the busy hold.
        // (a character whose list was pinned is named in that first save: an immediate save diffs only the characters it is given).
        expect(s.saves.map((x: any) => x.options)).toEqual([
            { characters: ['c3'], chats: [], flushServer: true, rejectOnFailure: true },
            { flushServer: 'canonical', rejectOnFailure: true },
            { characters: ['c1', 'c3'], chats: [['c1', 'h1']], flushServer: true, rejectOnFailure: true }])
        expect(s.saves.map((x: any) => x.held)).toEqual([false, false, true])
        expect(s.saves.every((x: any) => x.both.length === 0)).toBe(true)
        for (const character of db.characters) for (const chat of character.chats) for (const persona of ['p1', 'p2', undefined])
            expect(active(db, character, chat, persona).filter((m: string) => m === 'life-611')).toEqual([])
        expect(active(db, db.characters[0], db.characters[0].chats[0], 'p1')).toContain(id)
        expect(s.decisions).toEqual(['applied'])
        expect(s.notifySuccess.mock.calls.at(-1)[0]).toMatch(/옛 모듈 대신 켰어요/)
        expect(s.alertError).not.toHaveBeenCalled()
    })

    test('no earlier module turned on anywhere: added only, nothing switched; a module of another namespace is never touched', async () => {
        const db: any = { modules: [{ id: 'life-611', name: 'L', namespace: '삶은계란' }, { id: 'other', name: 'O', namespace: 'Nureong' }], enabledModules: ['other'], personaEnabledModules: {},
            characters: [{ chaId: 'c1', modules: ['other'], chats: [{ id: 'h', modules: ['Nureong'], message: [] }] }], moduleIntergration: '', botPresets: [], moduleModelBindings: {} }
        const s = await setup(db)
        expect(await mod.applyItem(pending as any, fileBytes)).toBe('applied')
        const id = await mod.publishedModuleId(sha)
        expect(db.modules.map((m: any) => m.id)).toEqual(['life-611', 'other', id])
        expect([db.enabledModules, db.characters[0].modules, db.characters[0].chats[0].modules]).toEqual([['other'], ['other'], ['Nureong']])
        expect(db.moduleModelBindings).toEqual({})
        expect(s.saves.map((x: any) => x.options)).toEqual([{ flushServer: 'canonical', rejectOnFailure: true }]) // only the import's save
        expect(s.notifySuccess.mock.calls.at(-1)[0]).toMatch(/켜지는 않았어요/)
    })

    test('a module without a namespace follows an earlier module of the same name', () => {
        const db: any = { modules: [{ id: 'a', name: 'M' }, { id: 'b', name: 'N' }, { id: 'new', name: 'M' }], enabledModules: ['a', 'b'], characters: [] }
        const change = mod.switchModuleOn(db, db.modules[2])
        expect(change.changed).toBe(true)
        expect(db.enabledModules).toEqual(['new', 'b'])
        change.undo()
        expect(db.enabledModules).toEqual(['a', 'b'])
        expect(mod.switchModuleOn(db, db.modules[2], true).changed).toBe(true)
        expect(db.enabledModules).toEqual(['a', 'b']) // dry run changes nothing
    })

    test('the new id is listed once: a list that held both the earlier and the new id keeps one', () => {
        const db: any = { modules: [{ id: 'old', name: 'L', namespace: 'ns' }, { id: 'new', name: 'L2', namespace: 'ns' }], enabledModules: ['new', 'x', 'old', 'ns'], characters: [] }
        mod.switchModuleOn(db, db.modules[1])
        expect(db.enabledModules).toEqual(['new', 'x'])
    })

    test('NAS sync brought the module and its switched places first: recorded as applied without asking or downloading', async () => {
        const id = await mod.publishedModuleId(sha)
        const db: any = { ...deviceDb() }
        db.modules = [...db.modules, { id, name: '라이프 모듈 v.7.2-mge.1', namespace: '삶은계란' }]
        db.enabledModules = ['other', id]; db.personaEnabledModules = { p1: [id] }; db.moduleIntergration = 'Nureong'; db.botPresets = []
        db.characters = [{ chaId: 'c1', modules: [id], chats: [{ id: 'h1', modules: [id], message: [] }] }]
        const s = await setup(db)
        await mod.checkContentUpdates(true)
        expect(s.alertConfirmMulti).not.toHaveBeenCalled()
        expect(s.calls).not.toContain('/content-updates/fetch')
        expect(s.readModule).not.toHaveBeenCalled()
        expect(s.decisions).toEqual(['applied'])
        const before = JSON.stringify(db)
        await mod.checkContentUpdates(true, pending.key, true)
        expect(s.alertConfirmMulti).toHaveBeenCalledTimes(1)
        expect(s.calls).toContain('/content-updates/fetch')
        expect(s.readModule).not.toHaveBeenCalled()
        expect(JSON.stringify(db)).toBe(before)
        expect(db.modules.filter((m: any) => m.id === id)).toHaveLength(1)
    })

    test('the module is here (synced, or an earlier try could not switch) but the earlier one is still on: asked; yes switches without importing again, under the busy hold', async () => {
        const id = await mod.publishedModuleId(sha)
        const db: any = deviceDb()
        db.modules.push({ id, name: '라이프 모듈 v.7.2-mge.1', namespace: '삶은계란' })
        const s = await setup(db)
        expect(await mod.alreadyInstalled(pending as any)).toBe(false)
        await mod.checkContentUpdates(true)
        expect(s.alertConfirmMulti).toHaveBeenCalledTimes(1)
        expect(s.runImport).not.toHaveBeenCalled()
        expect(s.readModule).not.toHaveBeenCalled()
        expect(db.modules.filter((m: any) => m.id === id)).toHaveLength(1)
        expect(db.enabledModules).toEqual(['other', id])
        expect(s.saves).toHaveLength(1)
        expect(s.saves[0].held).toBe(true)
        expect(s.saves[0].both).toEqual([])
        const { transferBusy } = await import('../playTransfer') as any
        expect(get(transferBusy)).toBe(false)
        expect(s.decisions).toEqual(['applied'])
        expect(await mod.alreadyInstalled(pending as any)).toBe(true)
    })

    test('the switch save fails: the earlier module\'s places are put back, nothing recorded, the error shown; asked again later', async () => {
        const id = await mod.publishedModuleId(sha)
        const db: any = deviceDb()
        db.modules.push({ id, name: '라이프 모듈 v.7.2-mge.1', namespace: '삶은계란' })
        const s = await setup(db, { failSave: options => options.rejectOnFailure === true })
        const before = JSON.parse(JSON.stringify(db))
        await mod.checkContentUpdates(true)
        expect(JSON.parse(JSON.stringify(db))).toEqual(before)
        expect(s.saves.at(-1).options).toMatchObject({ flushServer: true }) // the put-back state is saved (best effort)
        expect(s.decisions).toEqual([])
        expect(s.alertError).toHaveBeenCalledTimes(1)
        const { transferBusy } = await import('../playTransfer') as any
        expect(get(transferBusy)).toBe(false)
    })

    test('the import\'s own save fails: its rollback takes only the new module out; the earlier module stays on everywhere (never none, never both)', async () => {
        const db: any = deviceDb()
        const s = await setup(db, { failSave: options => options.flushServer === 'canonical' })
        await expect(mod.applyItem(pending as any, fileBytes)).rejects.toThrow(/save failed/)
        const before = deviceDb()
        expect(db.modules).toEqual(before.modules)
        // Only the namespace entry is written out as the id it turned on (the same module on); everything else as before.
        expect(db.moduleIntergration).toBe('Nureong,life-611')
        expect(db.botPresets.map((p: any) => p.moduleIntergration)).toEqual(['Nureong,life-611', '-Nureong', undefined])
        expect({ ...db, moduleIntergration: before.moduleIntergration, botPresets: before.botPresets }).toEqual(before)
        expect(s.saves.every((x: any) => x.both.length === 0)).toBe(true)
        for (const character of db.characters) for (const chat of character.chats) expect(active(db, character, chat, 'p1')).toContain('life-611')
        expect(active(db, db.characters[1], db.characters[1].chats[0])).toEqual(['life-611', 'other']) // on through integration as before
    })

    test('the import is cancelled (no answer) → declined, the earlier module still on; a rollback left in recovery → an error', async () => {
        const db: any = deviceDb()
        const s = await setup(db)
        const id = await mod.publishedModuleId(sha)
        // As runImport after the user's cancel: the work ran, its rollback took the registered module out, no answer.
        s.runImport.mockImplementationOnce(async (work: any) => { await work(s.transaction); db.modules = db.modules.filter((m: any) => m.id !== id); return null })
        expect(await mod.applyItem(pending as any, fileBytes)).toBe('declined')
        expect(db.modules).toEqual(deviceDb().modules)
        expect(db.enabledModules).toEqual(['other', 'life-611'])
        const { importSession } = await import('../importSession') as any
        s.runImport.mockImplementationOnce(async () => { importSession.set({ phase: 'recovery' }); return null })
        await expect(mod.applyItem(pending as any, fileBytes)).rejects.toThrow(/복구/)
        importSession.set({ phase: 'idle' })
    })

    test('undo puts the lists back on the app\'s reactive (Svelte state) database too', async () => {
        const { proxy } = await import('svelte/internal/client') as any
        const db: any = proxy({ modules: [{ id: 'old', name: 'L', namespace: 'ns' }, { id: 'new', name: 'L2', namespace: 'ns' }], enabledModules: ['old'], personaEnabledModules: { p: ['old'] },
            characters: [{ chaId: 'c', modules: ['old'], chats: [{ id: 'h', modules: ['ns'], message: [] }] }], moduleIntergration: 'ns', botPresets: [{ moduleIntergration: 'old' }], moduleModelBindings: { old: 'x' } })
        const before = JSON.parse(JSON.stringify(db))
        const change = mod.switchModuleOn(db, db.modules[1])
        expect(change.changed).toBe(true)
        expect(db.enabledModules).toEqual(['new'])
        expect(db.moduleModelBindings).toEqual({ old: 'x', new: 'x' })
        change.undo()
        expect(JSON.parse(JSON.stringify(db))).toEqual(before)
    })

    test('a namespace entry is written out as the earlier ids before the new module is added (same modules on); nothing without a namespace entry', () => {
        const db: any = { modules: [{ id: 'a', name: 'L', namespace: 'ns' }, { id: 'b', name: 'L', namespace: 'ns' }, { id: 'z', name: 'Z', namespace: 'other' }], enabledModules: ['ns', 'a', 'z'],
            characters: [{ chaId: 'c', modules: ['z'], chats: [] }], moduleIntergration: 'x, ns', botPresets: [{ moduleIntergration: 'ns' }, { moduleIntergration: 'other' }] }
        const added = { id: 'new', name: 'L2', namespace: 'ns' }
        expect(mod.pinNamespace(db, added, true).changed).toBe(true)
        expect(db.enabledModules).toEqual(['ns', 'a', 'z'])
        const change = mod.pinNamespace(db, added)
        expect(db.enabledModules).toEqual(['a', 'b', 'z'])
        expect(db.moduleIntergration).toBe('x,a,b')
        expect(db.botPresets.map((p: any) => p.moduleIntergration)).toEqual(['a,b', 'other'])
        expect(change.characters).toEqual([])
        expect(mod.pinNamespace(db, added).changed).toBe(false)
        // No earlier module: the namespace entry turns on nothing now and would turn on the new one, so it goes; so does a stray new id.
        const empty: any = { modules: [], enabledModules: ['ns', 'new', 'q'] }
        expect(mod.pinNamespace(empty, added).changed).toBe(true)
        expect(empty.enabledModules).toEqual(['q'])
    })

    test('the namespace is matched exactly as upstream matches it (no trimming)', () => {
        const db: any = { modules: [{ id: 'old', name: 'L', namespace: ' ns ' }, { id: 'trim', name: 'T', namespace: 'ns' }, { id: 'new', name: 'L2', namespace: ' ns ' }],
            enabledModules: [' ns '], characters: [{ chaId: 'c', modules: ['old', 'trim'], chats: [] }] }
        mod.switchModuleOn(db, db.modules[2])
        expect(db.enabledModules).toEqual(['new'])
        expect(db.characters[0].modules).toEqual(['new', 'trim']) // 'ns' is another namespace for upstream
        expect(mod.switchModuleOn(db, db.modules[2], true).changed).toBe(false)
    })

    test('an entry that the new module would also match (an earlier id that is the namespace text) stops the apply before anything changes', async () => {
        const db: any = deviceDb()
        db.modules[0] = { id: '삶은계란', name: '라이프 모듈 v.6.11', namespace: '삶은계란' }
        db.enabledModules = ['삶은계란']; db.personaEnabledModules = {}; db.characters = []; db.moduleIntergration = ''; db.botPresets = []
        const s = await setup(db)
        const before = JSON.parse(JSON.stringify(db))
        await mod.checkContentUpdates(true)
        expect(s.alertError.mock.calls[0][0]).toMatch(/보장할 수 없어요/)
        expect(s.decisions).toEqual([])
        expect(JSON.parse(JSON.stringify(db))).toEqual(before)
        expect(s.saves).toEqual([])
    })

    test('a persona\'s embedded module id that the new module\'s namespace would match, or a switch that would turn another module off: unsafe, nothing changed', () => {
        const db: any = { modules: [{ id: 'old', name: 'L', namespace: 'ns' }], enabledModules: [], characters: [], personas: [{ name: 'P', embeddedModule: { id: 'ns', namespace: 'different' } }] }
        const added = { id: 'new', name: 'L2', namespace: 'ns' }
        expect(mod.pinNamespace(db, added).unsafe).toBe(true)
        db.modules.push(added)
        expect(mod.switchModuleOn(db, added, true).unsafe).toBe(true) // the embedded id keeps the earlier one on
        const other: any = { modules: [{ id: 'old', name: 'L', namespace: 'ns' }, { id: 'other', name: 'O', namespace: 'old' }, added], enabledModules: ['old'], characters: [] }
        const change = mod.switchModuleOn(other, added)
        expect(change.unsafe).toBe(true) // 'old' also turns on the module of namespace 'old'
        expect(other.enabledModules).toEqual(['old'])
        // the normal case stays safe: ids in lists, the namespace in integration, another module in the same lists
        const normal: any = { modules: [{ id: 'old', name: 'L', namespace: 'ns' }, { id: 'z', name: 'Z', namespace: 'zz' }, added], enabledModules: ['z', 'old'], moduleIntergration: 'zz,ns', characters: [] }
        const ok = mod.switchModuleOn(normal, added)
        expect(ok.unsafe).toBeUndefined()
        expect([normal.enabledModules, normal.moduleIntergration]).toEqual([['z', 'new'], 'zz,new'])
    })

    test('no earlier module, only the namespace text listed: the new module is added turned off (the entry goes), and said so', async () => {
        const db: any = { modules: [], enabledModules: ['삶은계란'], personaEnabledModules: {}, characters: [], moduleIntergration: '', botPresets: [{ moduleIntergration: '삶은계란' }], moduleModelBindings: {} }
        const s = await setup(db)
        expect(await mod.applyItem(pending as any, fileBytes)).toBe('applied')
        expect(db.modules).toHaveLength(1)
        expect(db.enabledModules).toEqual([])
        expect(db.botPresets[0].moduleIntergration).toBe('')
        expect(active(db, null, null)).toEqual([])
        expect(s.notifySuccess.mock.calls.at(-1)[0]).toMatch(/켜지는 않았어요/)
        expect(await mod.alreadyInstalled(pending as any)).toBe(true)
    })

    test('a persona\'s embedded module of the same series stops the apply before anything changes, and the item is not counted as installed', async () => {
        const db: any = deviceDb()
        db.personas = [{ name: '함건희', id: 'p1', embeddedModule: { id: 'life-611', name: '라이프 모듈 v.6.11', namespace: '삶은계란' } }]
        const s = await setup(db)
        const before = JSON.parse(JSON.stringify(db))
        await mod.checkContentUpdates(true)
        expect(s.alertError).toHaveBeenCalledTimes(1)
        expect(s.alertError.mock.calls[0][0]).toMatch(/페르소나 「함건희」/)
        expect(s.decisions).toEqual([])
        expect(JSON.parse(JSON.stringify(db))).toEqual(before)
        const id = await mod.publishedModuleId(sha)
        db.modules.push({ id, name: 'N', namespace: '삶은계란' }); db.enabledModules = [id]; db.personaEnabledModules = {}; db.characters = []; db.moduleIntergration = ''; db.botPresets = []
        expect(await mod.alreadyInstalled(pending as any)).toBe(false)
        db.personas = []
        expect(await mod.alreadyInstalled(pending as any)).toBe(true)
    })

    test('NAS sync brought the same module while the file was being read: not added twice, switched in its place', async () => {
        const db: any = deviceDb()
        const s = await setup(db)
        const id = await mod.publishedModuleId(sha)
        s.readModule.mockImplementationOnce(async () => { db.modules.push({ id, name: '라이프 모듈 v.7.2-mge.1', namespace: '삶은계란' }); return { name: '라이프 모듈 v.7.2-mge.1', namespace: '삶은계란', id: 'random' } })
        expect(await mod.applyItem(pending as any, fileBytes)).toBe('applied')
        expect(db.modules.filter((m: any) => m.namespace === '삶은계란').map((m: any) => m.id)).toEqual(['life-611', id])
        expect(s.transaction.register).not.toHaveBeenCalled()
        expect(db.enabledModules).toEqual(['other', id])
    })

    test('an unreadable module file is an error, nothing added or switched', async () => {
        const db: any = deviceDb()
        const s = await setup(db)
        const before = JSON.parse(JSON.stringify(db))
        s.readModule.mockResolvedValueOnce(undefined)
        await expect(mod.applyItem(pending as any, fileBytes)).rejects.toThrow(/모듈을 읽지/)
        expect(JSON.parse(JSON.stringify(db))).toEqual(before)
    })
})

// 0.9.96-ver5: a check from a settings button says why it stopped; the pressed item is asked first; a persona that cannot be written is
// not asked; the download shows its size and time; the list read gives up after 2 minutes; a dropped NAS connection says how to retry.
describe('content updates: reasons and progress (0.9.96-ver5)', () => {
    const entry = (key: string, kind = 'character', bytes = 3_000_000) => ({ key, kind, title: key.split(':')[1], version: '1', file: 'f', fileName: 'x.charx', sha256: 's', bytes, publishedAt: new Date().toISOString(), publishedBy: '', decision: '' })
    const serve = async (pending: any[], fetchImpl?: () => Promise<Response>) => {
        const { transferRequest } = await import('../playTransfer') as any
        const { reportSyncNetwork } = await import('../nasSync') as any
        reportSyncNetwork.mockReset().mockResolvedValue({})
        const decisions: any[] = []
        transferRequest.mockReset().mockImplementation(async (path: string, init: any) => {
            if (path === '/content-updates/overview') return new Response(JSON.stringify({ configured: true, items: [], pending }))
            if (path === '/content-updates/decide') { decisions.push(JSON.parse(init.body)); return new Response('{}') }
            if (path === '/content-updates/fetch' && fetchImpl) return fetchImpl()
            return new Response('{}')
        })
        return decisions
    }
    test('a pending import recovery is named in the panel when the button was pressed', async () => {
        const { importSession } = await import('../importSession') as any
        const { alertConfirmMulti } = await import('../alert') as any
        await serve([entry('character:a')])
        alertConfirmMulti.mockReset()
        importSession.set({ phase: 'recovery' })
        try {
            expect(await mod.checkContentUpdates(true)).toBeNull()
            expect(get(mod.contentUpdateStatus)).toMatch(/가져오기의 복구가 남아 있어요/)
            expect(alertConfirmMulti).not.toHaveBeenCalled()
        } finally { importSession.set({ phase: 'idle' }); mod.contentUpdateStatus.set('') }
    })
    test('the pressed item is asked first', async () => {
        const { alertConfirmMulti } = await import('../alert') as any
        await serve([entry('character:a'), entry('character:b')])
        alertConfirmMulti.mockReset().mockResolvedValue(-1)
        await mod.checkContentUpdates(true, 'character:b')
        expect(alertConfirmMulti).toHaveBeenCalledTimes(1)
        expect(alertConfirmMulti.mock.calls[0][2]).toMatch(/^b \(1\)/)
    })
    test('only explicit re-download asks about an installed item; no and close retain the existing decision semantics', async () => {
        const { alertConfirmMulti } = await import('../alert') as any
        const { getDatabase } = await import('../storage/database.svelte') as any
        getDatabase.mockReturnValue({ characters: [{ name: 'a', characterVersion: '1' }, { name: 'b', characterVersion: '1' }] })
        const a = entry('character:a'), b = entry('character:b')
        for (const redownload of [false, true]) {
            const decisions = await serve([b, a])
            alertConfirmMulti.mockReset().mockResolvedValue(1)
            await mod.checkContentUpdates(true, a.key, redownload)
            expect(alertConfirmMulti).toHaveBeenCalledTimes(redownload ? 1 : 0)
            expect(decisions.map(d => [d.key, d.decision])).toEqual([[a.key, redownload ? 'declined' : 'applied'], [b.key, 'applied']])
        }
        const decisions = await serve([a])
        alertConfirmMulti.mockReset().mockResolvedValue(-1)
        await mod.recordDecision(a as any, 'reset')
        await mod.checkContentUpdates(true, a.key, true)
        expect(alertConfirmMulti).toHaveBeenCalledTimes(1)
        expect(decisions.map(d => d.decision)).toEqual(['reset'])
        alertConfirmMulti.mockClear()
        // The normal automatic path still detects installed content after the interval.
        const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 24 * 60 * 60 * 1000)
        try { await mod.checkContentUpdates() } finally { now.mockRestore() }
        expect(alertConfirmMulti).not.toHaveBeenCalled()
        expect(decisions.at(-1).decision).toBe('applied')
    })
    test('an installed character explicitly re-downloaded is fetched and passed to the existing card import', async () => {
        const { alertConfirmMulti } = await import('../alert') as any
        const { getDatabase } = await import('../storage/database.svelte') as any
        const { importCharacterProcess } = await import('../characterCards') as any
        const bytes = strToU8('same card bytes')
        const a = { ...entry('character:a', 'character', bytes.length), sha256: createHash('sha256').update(bytes).digest('hex') }
        getDatabase.mockReturnValue({ characters: [{ name: 'a', characterVersion: '1' }] })
        const fetchFile = vi.fn(async () => new Response(bytes as BodyInit))
        const decisions = await serve([a], fetchFile)
        alertConfirmMulti.mockReset().mockResolvedValue(0)
        importCharacterProcess.mockReset().mockResolvedValue(undefined)
        await mod.checkContentUpdates(true, a.key, true)
        expect(alertConfirmMulti).toHaveBeenCalledTimes(1)
        expect(fetchFile).toHaveBeenCalledTimes(1)
        expect(importCharacterProcess).toHaveBeenCalledWith({ name: a.fileName, data: bytes })
        expect(decisions.at(-1).decision).toBe('applied')
    })
    test('a persona that cannot be written now (a BardWiki reboot left on a chat) is not asked; the panel names the chat', async () => {
        const { alertConfirmMulti } = await import('../alert') as any
        const { transferUnavailable } = await import('../playTransfer') as any
        const { getDatabase } = await import('../storage/database.svelte') as any
        getDatabase.mockReturnValue({ personas: [], characters: [{ name: '마물소녀도감', chats: [{ name: '여행 1', risuBardWikiReboot: { status: 'paused' } }] }] })
        await serve([entry('persona:함건희', 'persona')])
        alertConfirmMulti.mockReset()
        transferUnavailable.mockReturnValue(true)
        try {
            await mod.checkContentUpdates(true)
            expect(alertConfirmMulti).not.toHaveBeenCalled()
            expect(get(mod.contentUpdateStatus)).toMatch(/「마물소녀도감」의 「여행 1」 채팅에 위키 리부트 작업이 멈춘 채로/)
        } finally { transferUnavailable.mockReset().mockImplementation(() => false); mod.contentUpdateStatus.set('') }
    })
    test('while a file downloads the panel shows its size and the time so far, and a toast says it started', async () => {
        const { alertConfirmMulti, notifyInfo, alertError } = await import('../alert') as any
        let release: (r: Response) => void = () => {}
        await serve([entry('character:big', 'character', 85_000_000)], () => new Promise<Response>(resolve => { release = resolve }))
        alertConfirmMulti.mockReset().mockResolvedValueOnce(0)
        notifyInfo.mockReset(); alertError.mockReset()
        const running = mod.checkContentUpdates(true)
        await vi.waitFor(() => expect(get(mod.contentUpdateStatus)).toMatch(/^big \(1\) \(85\.0 MB\) NAS에서 받는 중… 0초 지남$/))
        expect(notifyInfo).toHaveBeenCalledWith(expect.stringMatching(/85\.0 MB\)를 받기 시작했어요/))
        // a second press meanwhile keeps the progress text
        await mod.checkContentUpdates(true)
        expect(get(mod.contentUpdateStatus)).toMatch(/NAS에서 받는 중/)
        release(new Response('x'))
        await running
        expect(get(mod.contentUpdateStatus)).toMatch(/^「big \(1\)」를 가져오지 못했어요: 받은 파일이 배포본과 달라요/) // the reason stays in the panel
        expect(alertError).toHaveBeenCalledTimes(1) // the 1-byte answer is not the published file
    })
    test('a dropped NAS connection says the item can be fetched again from the panel', async () => {
        const { alertConfirmMulti, alertError } = await import('../alert') as any
        await serve([entry('character:a')], async () => { throw new Error('socket hang up') })
        alertConfirmMulti.mockReset().mockResolvedValueOnce(0); alertError.mockReset()
        await mod.checkContentUpdates(true)
        expect(alertError).toHaveBeenCalledWith(expect.stringMatching(/socket hang up[\s\S]*「지금 물어보기」를 누르면 다시 받아요/))
        const { notifyInfo } = await import('../alert') as any
        expect(notifyInfo).toHaveBeenLastCalledWith(expect.stringMatching(/^「a \(1\)」를 가져오지 못했어요: socket hang up NAS와의 연결이 끊겼어요/)) // toast too
        expect(get(mod.contentUpdateStatus)).toMatch(/^「a \(1\)」를 가져오지 못했어요: socket hang up/) // and the panel
    })
    test('a list read with no answer gives up after 2 minutes, says so, and the next press runs', async () => {
        const { transferRequest } = await import('../playTransfer') as any
        const { reportSyncNetwork } = await import('../nasSync') as any
        reportSyncNetwork.mockReset().mockResolvedValue({})
        transferRequest.mockReset().mockImplementation(() => new Promise(() => {}))
        vi.useFakeTimers()
        try {
            const first = mod.checkContentUpdates(true)
            await vi.advanceTimersByTimeAsync(121_000)
            expect(await first).toBeNull()
            expect(get(mod.contentUpdateStatus)).toMatch(/배포 목록을 읽지 못했어요: NAS에서 배포 목록을 2분 안에/)
            const second = mod.checkContentUpdates(true)
            await vi.advanceTimersByTimeAsync(1)
            expect(get(mod.contentUpdateStatus)).toBe('') // started again (not "still running")
            await vi.advanceTimersByTimeAsync(121_000)
            await second
        } finally { vi.useRealTimers(); mod.contentUpdateStatus.set('') }
    })
})

// 0.9.96-ver5 (Codex B round 1): an overview request given up after 2 minutes never writes the status line when it answers late.
describe('content updates: a late overview answer (0.9.96-ver5)', () => {
    test('a list read given up after 2 minutes that answers late leaves the next check\'s download text alone', async () => {
        const { transferRequest } = await import('../playTransfer') as any
        const { reportSyncNetwork } = await import('../nasSync') as any
        const { alertConfirmMulti } = await import('../alert') as any
        reportSyncNetwork.mockReset().mockResolvedValue({})
        const item = { key: 'character:late', kind: 'character', title: 'late', version: '1', file: 'f', fileName: 'x.charx', sha256: 's', bytes: 2_000_000, publishedAt: new Date().toISOString(), publishedBy: '', decision: '' }
        let overviews = 0, lateAnswer: (r: Response) => void = () => {}, lateFail: (e: any) => void = () => {}
        transferRequest.mockReset().mockImplementation((path: string) => {
            if (path === '/content-updates/overview') {
                if (++overviews === 1) return new Promise<Response>((resolve, reject) => { lateAnswer = resolve; lateFail = reject })
                return Promise.resolve(new Response(JSON.stringify({ configured: true, items: [], pending: [item] })))
            }
            if (path === '/content-updates/fetch') return new Promise(() => {}) // still downloading
            return Promise.resolve(new Response('{}'))
        })
        alertConfirmMulti.mockReset().mockResolvedValue(0)
        vi.useFakeTimers()
        try {
            const first = mod.checkContentUpdates(true)
            await vi.advanceTimersByTimeAsync(121_000)
            expect(await first).toBeNull()
            void mod.checkContentUpdates(true) // asks, then downloads (never finishes in this test)
            await vi.advanceTimersByTimeAsync(10)
            expect(get(mod.contentUpdateStatus)).toMatch(/NAS에서 받는 중/)
            lateAnswer(new Response(JSON.stringify({ configured: true, items: [], pending: [] })))
            await vi.advanceTimersByTimeAsync(10)
            expect(get(mod.contentUpdateStatus)).toMatch(/NAS에서 받는 중/)
            void lateFail
        } finally { vi.useRealTimers(); mod.contentUpdateStatus.set('') }
    })
    test('a list read that waited on a NAS sync step and then hit the 2-minute limit takes its waiting text down', async () => {
        const { transferRequest } = await import('../playTransfer') as any
        const { reportSyncNetwork } = await import('../nasSync') as any
        reportSyncNetwork.mockReset().mockResolvedValue({})
        let calls = 0
        transferRequest.mockReset().mockImplementation((path: string) => {
            if (path !== '/content-updates/overview') return Promise.resolve(new Response('{}'))
            if (++calls === 1) return Promise.reject(Object.assign(new Error('busy'), { status: 423, code: 'NAS_SYNC_BUSY' }))
            return new Promise(() => {}) // the second try never answers
        })
        vi.useFakeTimers()
        try {
            mod.contentUpdateStatus.set('')
            const overview = mod.fetchOverview()
            const settled = expect(overview).rejects.toThrow(/2분 안에/)
            await vi.advanceTimersByTimeAsync(500)
            expect(get(mod.contentUpdateStatus)).toBe('NAS 동기화가 끝나면 이어서 받아요…')
            await vi.advanceTimersByTimeAsync(121_000)
            await settled
            expect(get(mod.contentUpdateStatus)).toBe('')
        } finally { vi.useRealTimers(); mod.contentUpdateStatus.set('') }
    })
})
