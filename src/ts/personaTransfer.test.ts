import { beforeEach, test, expect, vi } from 'vitest'
import { writable } from 'svelte/store'
import { applyReceivedPersonas, planPersonas, personaPlanText, type ReceivedPersona } from './transfer-sync/personaTransfer'

const b64 = (text: string) => Buffer.from(text).toString('base64')
const io = () => {
    let n = 0
    return {
        saved: [] as string[],
        saveImage: vi.fn(async (bytes: Uint8Array) => `assets/img-${Buffer.from(bytes).toString()}`),
        reencodeImage: vi.fn(async (bytes: Uint8Array) => bytes),
        saveAsset: vi.fn(async (bytes: Uint8Array, _id: string, name: string) => `assets/${name}-${Buffer.from(bytes).toString()}`),
        newId: () => `new-${++n}`,
    }
}
const baseDb = () => ({
    selectedPersona: 1, personaPrompt: 'active old', userNote: 'active note', userIcon: 'assets/old-b',
    personas: [
        { id: 'a', name: 'A', personaPrompt: 'old a', note: 'keep note', icon: 'assets/old-a' },
        { id: 'b', name: 'B', personaPrompt: 'old b', note: 'old note', icon: 'assets/old-b' },
    ] as any[],
})

test('same name updates in place (id kept, active fields follow the selected one); new names are added with new ids', async () => {
    const db = baseDb(), x = io()
    const rows: ReceivedPersona[] = [
        { name: 'B', personaPrompt: 'new b', note: 'new note', image: b64('pic-b'), largePortrait: true },
        { name: 'A', personaPrompt: 'new a', image: null },
        { name: 'C', personaPrompt: 'c', image: b64('pic-c') },
        { name: 'C', personaPrompt: 'c2', image: null },
    ]
    const plan = await applyReceivedPersonas(db as any, rows, x)
    expect(plan).toEqual({ updated: ['B', 'A'], added: ['C', 'C'] })
    expect(db.personas[1]).toEqual({ id: 'b', name: 'B', personaPrompt: 'new b', note: 'new note', icon: 'assets/img-pic-b', largePortrait: true })
    expect(db).toMatchObject({ personaPrompt: 'new b', userNote: 'new note', userIcon: 'assets/img-pic-b' })
    // No picture and no note in the file: this device's picture and note stay.
    expect(db.personas[0]).toEqual({ id: 'a', name: 'A', personaPrompt: 'new a', note: 'keep note', icon: 'assets/old-a' })
    expect(db.personas.slice(2)).toEqual([
        { id: 'new-1', name: 'C', personaPrompt: 'c', icon: 'assets/img-pic-c' },
        { id: 'new-2', name: 'C', personaPrompt: 'c2', icon: '' },
    ])
})

test('module files are stored first and the module points at the new keys; a storage failure changes no persona', async () => {
    const db = baseDb(), x = io()
    const module = { id: 'm', name: 'mod', description: '', assets: [['map', '', 'webp'], ['skip', '', 'png']] as [string, string, string][] }
    await applyReceivedPersonas(db as any, [{ name: 'D', personaPrompt: 'd', image: null, embeddedModule: module, moduleAssets: [b64('m1'), null], moduleIcon: b64('icon') }], x)
    expect(db.personas[2].embeddedModule).toEqual({ id: 'm', name: 'mod', description: '', assets: [['map', 'assets/map.webp-m1', 'webp']], icon: 'assets/img-icon' })
    expect(module.assets).toHaveLength(2) // the received object is not changed

    const before = structuredClone(db), failing = io()
    failing.saveImage.mockRejectedValueOnce(new Error('disk full'))
    await expect(applyReceivedPersonas(db as any, [{ name: 'A', personaPrompt: 'x', image: null }, { name: 'E', personaPrompt: 'e', image: b64('p') }], failing)).rejects.toThrow('disk full')
    expect(db).toEqual(before)
})

test('the confirm text names what is replaced and what is added', () => {
    const plan = planPersonas(baseDb(), [{ name: 'A' }, { name: 'Z' }])
    expect(plan).toEqual({ updated: ['A'], added: ['Z'] })
    expect(personaPlanText(plan)).toBe('페르소나 2개를 가져올까요?\n같은 이름이 있어 내용을 바꿈: A\n새로 추가: Z\n바꾸는 페르소나는 그대로 유지돼서, 연결된 대화·봇도 그대로 그 페르소나를 써요.')
    expect(personaPlanText({ updated: [], added: ['Z'] })).toBe('페르소나 1개를 가져올까요?\n새로 추가: Z')
})

// ── Flow through playTransfer (server answers mocked) ──
const f = vi.hoisted(() => ({ db: {} as any, request: vi.fn(), save: vi.fn(), confirm: vi.fn(), saveUserPersona: vi.fn() }))
vi.mock('./globalApi.svelte', () => ({ forageStorage: { Init: async () => {}, realStorage: { transferRequest: (...args: any[]) => f.request(...args) } }, requestImmediateSave: (...args: any[]) => f.save(...args), checkCharOrder: () => {}, saveAsset: async () => 'assets/x' }))
vi.mock('./storage/database.svelte', () => ({ getDatabase: () => f.db, getCurrentCharacter: () => undefined, newChatModelDefaults: () => ({}), normalizeChat: (c: any) => c, saveImage: async (bytes: Uint8Array) => `assets/${Buffer.from(bytes).toString()}` }))
vi.mock('./process/files/inlays', () => ({ reencodeImage: async (bytes: Uint8Array) => bytes }))
vi.mock('./persona', () => ({ saveUserPersona: () => f.saveUserPersona() }))
vi.mock('./storage/chatStorage', () => ({ ensureChatHydrated: async () => undefined }))
vi.mock('./process/generationState', () => ({ doingChat: writable(false), isAnyGenerating: writable(false) }))
vi.mock('./importSession', () => ({ importSession: writable({ phase: 'idle' }) }))
vi.mock('./stores.svelte', () => ({ loadedStore: writable(true), alertStore: writable({ type: 'none' }) }))
vi.mock('./alert', () => ({ alertSelect: vi.fn(), alertConfirm: (...args: any[]) => f.confirm(...args) }))
vi.mock('./risubard/memorySaveSlots', () => ({ applyMemorySavePromptSettings: () => {} }))
import { receiveTransfer, exportPersonaTransfer, transferBusy } from './playTransfer'

const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
beforeEach(() => {
    f.db = { characters: [], ...baseDb() }
    f.request.mockReset(); f.save.mockReset(); f.save.mockResolvedValue(undefined); f.confirm.mockReset(); f.saveUserPersona.mockReset()
    transferBusy.set(false)
})
const server = (personas: unknown[]) => f.request.mockImplementation(async (path: string) =>
    reply(path.endsWith('/inspect') ? { kind: 'persona', characters: [] } : path.endsWith('/personas') ? { personas } : path === '' ? [] : { state: 'applied' }))

test('receiving a persona file asks first, saves, then marks it applied', async () => {
    server([{ name: 'B', personaPrompt: 'from tablet', image: b64('pic') }])
    f.confirm.mockResolvedValue(true)
    await receiveTransfer('in')
    expect(f.confirm.mock.calls[0][0]).toContain('같은 이름이 있어 내용을 바꿈: B')
    expect(f.db.personas[1]).toMatchObject({ id: 'b', personaPrompt: 'from tablet', icon: 'assets/pic' })
    const paths = f.request.mock.calls.map(call => call[0])
    expect(paths.indexOf('/in/persona-applied')).toBeGreaterThan(-1)
    expect(f.save.mock.invocationCallOrder[0]).toBeLessThan(f.request.mock.invocationCallOrder[paths.indexOf('/in/persona-applied')])
    expect(paths).not.toContain('/in/prepare')
})

test('declining keeps everything; an automatic (requested) apply that was declined is not asked again every poll', async () => {
    server([{ name: 'Z', personaPrompt: 'z', image: null }])
    f.confirm.mockResolvedValue(false)
    const before = structuredClone(f.db)
    await receiveTransfer('in', true)
    expect(f.db).toEqual(before); expect(f.save).not.toHaveBeenCalled()
    expect(f.request).toHaveBeenCalledWith('/in/apply-request', expect.objectContaining({ body: JSON.stringify({ requested: false }) }))
    f.request.mockClear()
    await receiveTransfer('in', false)
    expect(f.request.mock.calls.map(c => c[0])).not.toContain('/in/apply-request')
})

test('exporting writes the active persona back to its row and saves before the server reads the database', async () => {
    f.request.mockImplementation(async (path: string) => reply(path === '/persona-export' ? { id: 'out', kind: 'persona', excluded: [] } : []))
    expect(await exportPersonaTransfer(['a'])).toMatchObject({ id: 'out' })
    expect(f.saveUserPersona).toHaveBeenCalled()
    const exportCall = f.request.mock.calls.findIndex(c => c[0] === '/persona-export')
    expect(f.save.mock.invocationCallOrder[0]).toBeLessThan(f.request.mock.invocationCallOrder[exportCall])
    expect(JSON.parse(f.request.mock.calls[exportCall][1].body)).toEqual({ personaIds: ['a'] })
    await expect(exportPersonaTransfer([])).rejects.toThrow('골라')
})
