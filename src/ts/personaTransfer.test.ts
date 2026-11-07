import { beforeEach, afterEach, test, expect, vi } from 'vitest'
import { writable } from 'svelte/store'
import { applyReceivedPersonas, planPersonas, personaPlanText, personaTargetMap, type ReceivedPersona } from './transfer-sync/personaTransfer'

const b64 = (text: string) => Buffer.from(text).toString('base64')
/** Blobs as the server sends them: one entry per distinct file. */
const blobs = (...texts: string[]) => Object.fromEntries(texts.map(t => [`blobs/${t}`, b64(t)]))
const io = () => {
    let n = 0
    return {
        saveImage: vi.fn(async (bytes: Uint8Array) => `assets/img-${Buffer.from(bytes).toString()}`),
        reencodeImage: vi.fn(async (bytes: Uint8Array) => bytes),
        saveAsset: vi.fn(async (bytes: Uint8Array, _id: string, name: string) => `assets/${name}-${Buffer.from(bytes).toString()}`),
        newId: () => `new-${++n}`,
    }
}
const baseDb = () => ({
    selectedPersona: 1, username: 'active name', personaPrompt: 'active old', userNote: 'active note', userIcon: 'assets/old-b',
    personas: [
        { id: 'a', name: 'A', personaPrompt: 'old a', note: 'keep note', icon: 'assets/old-a' },
        { id: 'b', name: 'B', personaPrompt: 'old b', note: 'old note', icon: 'assets/old-b' },
    ] as any[],
})

test('a unique same name updates in place (id kept, all four active fields follow the selected one); new names are added', async () => {
    const db = baseDb(), x = io()
    const rows: ReceivedPersona[] = [
        { name: 'B', personaPrompt: 'new b', note: 'new note', image: 'blobs/pic-b', largePortrait: true },
        { name: 'A', personaPrompt: 'new a', image: null },
        { name: 'C', personaPrompt: 'c', image: 'blobs/pic-c' },
        { name: 'C', personaPrompt: 'c2', image: null },
    ]
    const plan = await applyReceivedPersonas(db as any, rows, blobs('pic-b', 'pic-c'), x)
    expect(plan).toMatchObject({ targets: [1, 0, -1, -1], updated: ['B', 'A'], added: ['C', 'C'], ambiguous: ['C'] })
    expect(db.personas[1]).toEqual({ id: 'b', name: 'B', personaPrompt: 'new b', note: 'new note', icon: 'assets/img-pic-b', largePortrait: true })
    expect(db).toMatchObject({ username: 'B', personaPrompt: 'new b', userNote: 'new note', userIcon: 'assets/img-pic-b' })
    // No picture and no note in the file: this device's picture and note stay.
    expect(db.personas[0]).toEqual({ id: 'a', name: 'A', personaPrompt: 'new a', note: 'keep note', icon: 'assets/old-a' })
    expect(db.personas.slice(2)).toEqual([
        { id: 'new-1', name: 'C', personaPrompt: 'c', icon: 'assets/img-pic-c' },
        { id: 'new-2', name: 'C', personaPrompt: 'c2', icon: '' },
    ])
})

test('names that are not unique never overwrite: two received "A" for one local "A", or one received "X" for two local "X", are added', async () => {
    const db = baseDb(), x = io()
    db.personas.push({ id: 'x1', name: 'X', personaPrompt: 'x1', icon: '' }, { id: 'x2', name: 'X', personaPrompt: 'x2', icon: '' })
    const before = structuredClone(db.personas)
    const plan = await applyReceivedPersonas(db as any, [
        { name: 'A', personaPrompt: 'first' }, { name: 'A', personaPrompt: 'second' }, { name: 'X', personaPrompt: 'third' },
    ], {}, x)
    expect(plan).toMatchObject({ targets: [-1, -1, -1], updated: [], added: ['A', 'A', 'X'], ambiguous: ['A', 'X'] })
    expect(db.personas.slice(0, 4)).toEqual(before)
    expect(db.personas.slice(4).map(p => p.personaPrompt)).toEqual(['first', 'second', 'third'])
    expect(personaPlanText(plan)).toBe('페르소나 3개를 가져올까요?\n이름이 겹쳐서 덮어쓰지 않고 새로 추가: A, X')
})

test('applying the same file again updates what it added (stable ids) instead of adding it twice', async () => {
    for (const [local, rows] of [
        [[], [{ name: 'N', personaPrompt: 'n', transferId: 't-0' }]],
        [[], [{ name: 'A', personaPrompt: 'a1', transferId: 't-0' }, { name: 'A', personaPrompt: 'a2', transferId: 't-1' }]],
        [[{ id: 'x1', name: 'X', personaPrompt: 'x1', icon: '' }, { id: 'x2', name: 'X', personaPrompt: 'x2', icon: '' }], [{ name: 'X', personaPrompt: 'x3', transferId: 't-0' }]],
    ] as [any[], ReceivedPersona[]][]) {
        const db = { ...baseDb(), personas: structuredClone(local) }
        await applyReceivedPersonas(db as any, rows, {}, io())
        const once = structuredClone(db.personas)
        expect(once).toHaveLength(local.length + rows.length)
        expect(once.slice(local.length).map((p: any) => p.id)).toEqual(rows.map(r => r.transferId))
        const again = await applyReceivedPersonas(db as any, rows, {}, io())
        expect(again.added).toEqual([]); expect(db.personas).toEqual(once)
    }
})

test('a persona found by its stable id is reserved: a name match from another row never lands on it', async () => {
    // The file had A(t0) and B(t1); A was imported, then renamed to B here, and the old B was deleted.
    const db = { ...baseDb(), personas: [{ id: 't0', name: 'B', personaPrompt: 'was A', icon: '' }] as any[] }
    const plan = await applyReceivedPersonas(db as any, [{ name: 'A', personaPrompt: 'a', transferId: 't0' }, { name: 'B', personaPrompt: 'b', transferId: 't1' }], {}, io())
    expect(plan).toMatchObject({ targets: [0, -1], updated: ['A'], added: ['B'], ambiguous: [] })
    expect(db.personas.map(p => [p.id, p.name, p.personaPrompt])).toEqual([['t0', 'B', 'a'], ['t1', 'B', 'b']])
})

test('a row applied by name before is found again through its recorded local persona even after renames', async () => {
    // A and B were updated by name; here A was renamed to C and B to A. The recorded map keeps each row on its persona.
    const db = { ...baseDb(), personas: [{ id: 'local-a', name: 'C', personaPrompt: 'a0', icon: '' }, { id: 'local-b', name: 'A', personaPrompt: 'b0', icon: '' }] as any[] }
    const rows: ReceivedPersona[] = [{ name: 'A', personaPrompt: 'a1', transferId: 't0', localId: 'local-a' }, { name: 'B', personaPrompt: 'b1', transferId: 't1', localId: 'local-b' }]
    const plan = await applyReceivedPersonas(db as any, rows, {}, io())
    expect(plan).toMatchObject({ targets: [0, 1], updated: ['A', 'B'], added: [], ambiguous: [] })
    expect(db.personas.map(p => [p.id, p.name, p.personaPrompt])).toEqual([['local-a', 'C', 'a1'], ['local-b', 'A', 'b1']])
    // Without the record (first time), the map to send says which persona each row goes to; added rows get their stable id.
    const fresh = { ...baseDb() }
    const firstRows: ReceivedPersona[] = [{ name: 'A', personaPrompt: 'x', transferId: 't0' }, { name: 'Z', personaPrompt: 'z', transferId: 't1' }]
    expect(personaTargetMap(fresh, firstRows, planPersonas(fresh, firstRows))).toEqual({ t0: 'a', t1: 't1' })
})

test('targets are found again by id after the awaited picture saves; a target deleted meanwhile stops before any change', async () => {
    // Reordered while a picture was being saved: each row still reaches its own persona.
    const db = baseDb(), x = io()
    x.saveImage.mockImplementationOnce(async () => { db.personas.reverse(); db.selectedPersona = 0; return 'assets/pic' })
    await applyReceivedPersonas(db as any, [{ name: 'A', personaPrompt: 'new a', image: 'blobs/p' }, { name: 'B', personaPrompt: 'new b' }], blobs('p'), x)
    expect(db.personas.map(p => [p.id, p.personaPrompt, p.icon])).toEqual([['b', 'new b', 'assets/old-b'], ['a', 'new a', 'assets/pic']])
    // Deleted while a picture was being saved: nothing else changes.
    const db2 = baseDb(), y = io()
    y.saveImage.mockImplementationOnce(async () => { db2.personas.splice(1, 1); return 'assets/pic' })
    const before = structuredClone(db2.personas)
    await expect(applyReceivedPersonas(db2 as any, [{ name: 'A', personaPrompt: 'x', image: 'blobs/p' }, { name: 'B', personaPrompt: 'y' }], blobs('p'), y)).rejects.toThrow('목록이 바뀌었어요')
    expect(db2.personas).toEqual(before.slice(0, 1))
})

test('a stable id already used here is never given to a second persona', async () => {
    // A damaged record pointed row A(t0) at the persona whose id is row B's stable id t1.
    const db = { ...baseDb(), personas: [{ id: 't1', name: 'A', personaPrompt: 'old', icon: '' }] as any[] }
    const rows: ReceivedPersona[] = [{ name: 'A', personaPrompt: 'a', transferId: 't0', localId: 't1' }, { name: 'B', personaPrompt: 'b', transferId: 't1' }]
    await applyReceivedPersonas(db as any, rows, {}, io())
    expect(db.personas.map(p => p.id)).toEqual(['t1', 'new-1'])
    expect(new Set(db.personas.map(p => p.id)).size).toBe(2)
})

test('module files are stored first and the module points at the new keys; a storage failure or a missing blob changes no persona', async () => {
    const db = baseDb(), x = io()
    const module = { id: 'm', name: 'mod', description: '', assets: [['map', '', 'webp'], ['skip', '', 'png']] as [string, string, string][] }
    await applyReceivedPersonas(db as any, [{ name: 'D', personaPrompt: 'd', image: null, embeddedModule: module, moduleAssets: ['blobs/m1', null], moduleIcon: 'blobs/icon' }], blobs('m1', 'icon'), x)
    expect(db.personas[2].embeddedModule).toEqual({ id: 'm', name: 'mod', description: '', assets: [['map', 'assets/map.webp-m1', 'webp']], icon: 'assets/img-icon' })
    expect(module.assets).toHaveLength(2) // the received object is not changed

    const before = structuredClone(db), failing = io()
    failing.saveImage.mockRejectedValueOnce(new Error('disk full'))
    await expect(applyReceivedPersonas(db as any, [{ name: 'A', personaPrompt: 'x', image: null }, { name: 'E', personaPrompt: 'e', image: 'blobs/p' }], blobs('p'), failing)).rejects.toThrow('disk full')
    await expect(applyReceivedPersonas(db as any, [{ name: 'A', personaPrompt: 'x', image: null }, { name: 'E', personaPrompt: 'e', image: 'blobs/gone' }], {}, io())).rejects.toThrow('빠져')
    expect(db).toEqual(before)
})

test('the confirm text names what is replaced and what is added', () => {
    const plan = planPersonas(baseDb(), [{ name: 'A' }, { name: 'Z' }])
    expect(plan).toMatchObject({ targets: [0, -1], updated: ['A'], added: ['Z'], ambiguous: [] })
    expect(personaPlanText(plan)).toBe('페르소나 2개를 가져올까요?\n같은 이름이 있어 내용을 바꿈: A\n새로 추가: Z\n바꾸는 페르소나는 그대로 유지돼서, 연결된 대화·봇도 그대로 그 페르소나를 써요.')
    expect(personaPlanText({ targets: [-1], targetIds: [null], addIds: [null], updated: [], added: ['Z'], ambiguous: [] })).toBe('페르소나 1개를 가져올까요?\n새로 추가: Z')
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
const reload = vi.fn()
beforeEach(() => {
    f.db = { characters: [], ...baseDb() }
    f.request.mockReset(); f.save.mockReset(); f.save.mockResolvedValue(undefined); f.confirm.mockReset(); f.saveUserPersona.mockReset()
    transferBusy.set(false); reload.mockReset(); vi.stubGlobal('location', { reload })
})
afterEach(() => { vi.unstubAllGlobals() })
const server = (personas: ReceivedPersona[], files: Record<string, string> = {}) => f.request.mockImplementation(async (path: string) =>
    reply(path.endsWith('/inspect') ? { kind: 'persona', characters: [], personas: personas.map(p => ({ name: p.name })) }
        : path.endsWith('/personas') ? { personas, blobs: files } : path === '' ? [] : { state: 'applied' }))
const paths = () => f.request.mock.calls.map(call => call[0])

test('receiving a persona file asks first (names only), then reads pictures, saves, and marks it applied', async () => {
    server([{ name: 'B', personaPrompt: 'from tablet', image: 'blobs/pic' }], blobs('pic'))
    f.confirm.mockResolvedValue(true)
    await receiveTransfer('in')
    expect(f.confirm.mock.calls[0][0]).toContain('같은 이름이 있어 내용을 바꿈: B')
    expect(f.request.mock.invocationCallOrder[paths().indexOf('/in/personas')]).toBeGreaterThan(f.confirm.mock.invocationCallOrder[0])
    expect(f.db.personas[1]).toMatchObject({ id: 'b', personaPrompt: 'from tablet', icon: 'assets/pic' })
    expect(f.save.mock.invocationCallOrder[0]).toBeLessThan(f.request.mock.invocationCallOrder[paths().indexOf('/in/persona-applied')])
    expect(paths()).not.toContain('/in/prepare'); expect(reload).not.toHaveBeenCalled()
    // Which persona each row went to is recorded before the personas change (and before the save).
    const mapCall = paths().indexOf('/in/persona-map')
    expect(JSON.parse(f.request.mock.calls[mapCall][1].body)).toEqual({ map: {} }) // no transferId in this fixture row
    expect(f.request.mock.invocationCallOrder[mapCall]).toBeLessThan(f.save.mock.invocationCallOrder[0])
})

test('declining reads no pictures and keeps everything; a declined automatic (requested) apply is not asked again every poll', async () => {
    server([{ name: 'Z', personaPrompt: 'z', image: null }])
    f.confirm.mockResolvedValue(false)
    const before = structuredClone(f.db)
    await receiveTransfer('in', true)
    expect(f.db).toEqual(before); expect(f.save).not.toHaveBeenCalled(); expect(paths()).not.toContain('/in/personas')
    expect(f.request).toHaveBeenCalledWith('/in/apply-request', expect.objectContaining({ body: JSON.stringify({ requested: false }) }))
    f.request.mockClear()
    await receiveTransfer('in', false)
    expect(paths()).not.toContain('/in/apply-request')
})

test('a save or applied mark that does not confirm keeps the import (the app retries the save) and leaves the file to apply again without duplicates', async () => {
    server([{ name: 'B', personaPrompt: 'from tablet', image: null }, { name: 'New', personaPrompt: 'n', transferId: 't-0' }])
    f.confirm.mockResolvedValue(true); f.save.mockRejectedValue(new Error('canonical save failed'))
    await receiveTransfer('in')
    expect(f.db.personas.map((p: any) => [p.id, p.personaPrompt])).toEqual([['a', 'old a'], ['b', 'from tablet'], ['t-0', 'n']])
    expect(paths()).not.toContain('/in/persona-applied'); expect(reload).not.toHaveBeenCalled()

    // The save works but the applied mark does not reach the server: nothing is undone; applying again changes nothing more.
    f.save.mockReset(); f.save.mockResolvedValue(undefined)
    const rows = [{ name: 'B', personaPrompt: 'from tablet', image: null }, { name: 'New', personaPrompt: 'n', transferId: 't-0' }]
    f.request.mockImplementation(async (path: string) => path === '/in/persona-applied' ? new Response('{}', { status: 500 })
        : reply(path.endsWith('/inspect') ? { kind: 'persona', characters: [], personas: rows.map(r => ({ name: r.name, transferId: (r as any).transferId })) } : path.endsWith('/personas') ? { personas: rows, blobs: {} } : []))
    const before = JSON.parse(JSON.stringify(f.db.personas))
    await receiveTransfer('in')
    expect(JSON.parse(JSON.stringify(f.db.personas))).toEqual(before)
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
