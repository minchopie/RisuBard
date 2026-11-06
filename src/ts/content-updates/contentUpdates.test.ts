import { describe, expect, test, vi } from 'vitest'
import { zipSync, strToU8 } from 'fflate'

vi.mock('../storage/database.svelte', () => ({ getDatabase: vi.fn(), saveImage: vi.fn() }))
vi.mock('../globalApi.svelte', () => ({ checkCharOrder: vi.fn() }))
vi.mock('../characterCards', () => ({ importCharacterProcess: vi.fn() }))
vi.mock('../process/files/inlays', () => ({ reencodeImage: vi.fn() }))
vi.mock('../alert', () => ({ alertConfirmMulti: vi.fn(), alertError: vi.fn(), notifySuccess: vi.fn() }))
vi.mock('../transfer-sync/playTransfer', () => ({ transferRequest: vi.fn() }))
vi.mock('../platform', () => ({ isNodeServer: false }))
vi.mock('../stores.svelte', async () => { const { writable } = await import('svelte/store'); return { alertStore: writable({ type: 'none' }), loadedStore: writable(true) } })
vi.mock('../process/generationState', async () => { const { writable } = await import('svelte/store'); return { isAnyGenerating: writable(false) } })
vi.mock('../transfer-sync/transferState', async () => { const { writable } = await import('svelte/store'); return { transferBusy: writable(false) } })
vi.mock('../storage/importTransaction', () => ({ ImportCancelled: class ImportCancelled extends Error {} }))
vi.mock('../pngChunk', () => ({ PngChunk: { readGenerator: async function* () {} } }))

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
})
