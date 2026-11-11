import { describe, expect, test, vi } from 'vitest'
import { get } from 'svelte/store'
import { zipSync, strToU8 } from 'fflate'
import { createHash } from 'node:crypto'

vi.mock('../storage/database.svelte', () => ({ getDatabase: vi.fn(), saveImage: vi.fn(async () => 'new-icon'), importPreset: vi.fn(), changeToPreset: vi.fn() }))
vi.mock('../globalApi.svelte', () => ({ checkCharOrder: vi.fn(), requestImmediateSave: vi.fn(async () => {}) }))
vi.mock('../plugins/plugins.svelte', () => ({ importPlugin: vi.fn(), loadPlugins: vi.fn(async () => {}) }))
vi.mock('../characterCards', () => ({ importCharacterProcess: vi.fn() }))
vi.mock('../process/files/inlays', () => ({ reencodeImage: vi.fn(async (b: Uint8Array) => b) }))
vi.mock('../alert', () => ({ alertConfirmMulti: vi.fn(), alertError: vi.fn(), notifySuccess: vi.fn() }))
vi.mock('../playTransfer', async () => { const { writable, get } = await import('svelte/store'); const transferBusy = writable(false); return { transferRequest: vi.fn(), transferBusy, transferStatus: writable(''), transferUnavailable: vi.fn(() => get(transferBusy)) } })
vi.mock('../platform', () => ({ isNodeServer: false }))
vi.mock('../stores.svelte', async () => { const { writable } = await import('svelte/store'); return { alertStore: writable({ type: 'none' }), loadedStore: writable(true) } })
vi.mock('../process/generationState', async () => { const { writable } = await import('svelte/store'); return { isAnyGenerating: writable(false) } })
vi.mock('../storage/importTransaction', () => ({ ImportCancelled: class ImportCancelled extends Error {} }))
vi.mock('../pngChunk', () => ({ PngChunk: { readGenerator: vi.fn(async function* () {}) } }))
vi.mock('uuid', () => ({ v4: () => 'id' }))
vi.mock('../importSession', async () => { const { writable } = await import('svelte/store'); return { importSession: writable({ phase: 'idle' }) } })
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
        expect(JSON.parse(overview[1].body)).toEqual({ kinds: ['character', 'persona', 'preset', 'plugin'] })
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
