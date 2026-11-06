import { describe, expect, test, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { createHash } from 'node:crypto'

vi.mock('../storage/database.svelte', () => ({ getDatabase: vi.fn(), saveImage: vi.fn(async () => 'new-icon') }))
vi.mock('../globalApi.svelte', () => ({ checkCharOrder: vi.fn() }))
vi.mock('../characterCards', () => ({ importCharacterProcess: vi.fn() }))
vi.mock('../process/files/inlays', () => ({ reencodeImage: vi.fn(async (b: Uint8Array) => b) }))
vi.mock('../alert', () => ({ alertConfirmMulti: vi.fn(), alertError: vi.fn(), notifySuccess: vi.fn() }))
vi.mock('../playTransfer', async () => { const { writable } = await import('svelte/store'); return { transferRequest: vi.fn(), transferBusy: writable(false) } })
vi.mock('../platform', () => ({ isNodeServer: false }))
vi.mock('../stores.svelte', async () => { const { writable } = await import('svelte/store'); return { alertStore: writable({ type: 'none' }), loadedStore: writable(true) } })
vi.mock('../process/generationState', async () => { const { writable } = await import('svelte/store'); return { isAnyGenerating: writable(false) } })
vi.mock('../storage/importTransaction', () => ({ ImportCancelled: class ImportCancelled extends Error {} }))
vi.mock('../pngChunk', () => ({ PngChunk: { readGenerator: vi.fn(async function* () {}) } }))
vi.mock('uuid', () => ({ v4: () => 'id' }))
vi.mock('../importSession', async () => { const { writable } = await import('svelte/store'); return { importSession: writable({ phase: 'idle' }) } })

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
