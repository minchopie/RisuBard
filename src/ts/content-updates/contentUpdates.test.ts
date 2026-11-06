import { describe, expect, test, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { createHash } from 'node:crypto'

vi.mock('../storage/database.svelte', () => ({ getDatabase: vi.fn(), saveImage: vi.fn() }))
vi.mock('../globalApi.svelte', () => ({ checkCharOrder: vi.fn() }))
vi.mock('../characterCards', () => ({ importCharacterProcess: vi.fn() }))
vi.mock('../process/files/inlays', () => ({ reencodeImage: vi.fn() }))
vi.mock('../alert', () => ({ alertConfirmMulti: vi.fn(), alertError: vi.fn(), notifySuccess: vi.fn() }))
vi.mock('../playTransfer', async () => { const { writable } = await import('svelte/store'); return { transferRequest: vi.fn(), transferBusy: writable(false) } })
vi.mock('../platform', () => ({ isNodeServer: false }))
vi.mock('../stores.svelte', async () => { const { writable } = await import('svelte/store'); return { alertStore: writable({ type: 'none' }), loadedStore: writable(true) } })
vi.mock('../process/generationState', async () => { const { writable } = await import('svelte/store'); return { isAnyGenerating: writable(false) } })
vi.mock('../storage/importTransaction', () => ({ ImportCancelled: class ImportCancelled extends Error {} }))
vi.mock('../pngChunk', () => ({ PngChunk: { readGenerator: async function* () {} } }))
vi.mock('uuid', () => ({ v4: () => 'id' }))

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
            if (path === '/content-updates/fetch') return new Response(body.key === 'character:d' ? strToU8('tampered!!') : card)
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
})
