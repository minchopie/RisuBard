// The native inbox poll (every 3 s) against the write gate: while a NAS sync apply or a manual transfer holds `transferBusy`/
// `syncSaveHold` the tick is skipped (and abandoned when the gate closes between awaited steps), a structured 423 gate answer
// (NAS_SYNC_BUSY / TRANSFER_BUSY) is never written into the status text, and a real error still is. Live PC .76: network.start /
// usb.start through native-rpc answered 423 during an apply every 3 s and overwrote the status with the gate message.
import { test, expect, vi, beforeEach, afterEach } from 'vitest'
import { get } from 'svelte/store'
const f = vi.hoisted(() => ({ transferRequest: vi.fn() }))
vi.mock('./globalApi.svelte', () => ({ forageStorage: { Init: async () => {}, realStorage: { transferRequest: (...a: any[]) => f.transferRequest(...a) } }, requestImmediateSave: vi.fn(), checkCharOrder: vi.fn() }))
vi.mock('./storage/database.svelte', () => ({ getDatabase: () => ({ characters: [] }), getCurrentCharacter: () => null, newChatModelDefaults: () => ({}), normalizeChat: (c: any) => c }))
vi.mock('./storage/chatStorage', () => ({ ensureChatHydrated: async (chats: any[], i: number) => chats[i] }))
vi.mock('./process/generationState', () => ({ doingChat: { subscribe: (fn: any) => { fn(false); return () => {} } }, isAnyGenerating: { subscribe: (fn: any) => { fn(false); return () => {} } } }))
vi.mock('./importSession', () => ({ importSession: { subscribe: (fn: any) => { fn({ phase: 'idle' }); return () => {} } } }))
vi.mock('./stores.svelte', () => ({ loadedStore: { subscribe: (fn: any) => { fn(true); return () => {} } }, alertStore: { subscribe: (fn: any) => { fn({ type: 'none' }); return () => {} } } }))
vi.mock('./alert', () => ({ alertSelect: vi.fn(), alertConfirm: vi.fn() }))
vi.mock('./risubard/memorySaveSlots', () => ({ applyMemorySavePromptSettings: vi.fn() }))
vi.mock('./transfer-sync/transferNative', () => ({ playNative: vi.fn(), playSetAvailable: () => true, sendNative: vi.fn() }))
import { startTransferInbox, transferRequest } from './playTransfer'
import { transferBusy, syncSaveHold, transferStatus } from './transferState'
import { playNative } from './transferNative'

const native = playNative as unknown as ReturnType<typeof vi.fn>
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const ops = () => native.mock.calls.map(c => c[0])
const tick = async () => { await vi.advanceTimersByTimeAsync(3_000); for (let i = 0; i < 20; i++) await Promise.resolve() }
beforeEach(() => { vi.useFakeTimers(); native.mockReset(); native.mockImplementation(async (op: string) => op === 'inbox.list' ? [] : undefined); f.transferRequest.mockReset(); f.transferRequest.mockImplementation(async () => json([])); transferBusy.set(false); syncSaveHold.set(false); transferStatus.set('') })
afterEach(() => { vi.useRealTimers() })

test('transferRequest keeps the server code/status of a structured 423 and the message of any other failure', async () => {
    f.transferRequest.mockResolvedValueOnce(json({ error: 'NAS sync apply must finish before saving', code: 'NAS_SYNC_BUSY', transaction: 'tx' }, 423))
    await expect(transferRequest('/native-rpc', { method: 'POST' })).rejects.toMatchObject({ message: 'NAS sync apply must finish before saving', code: 'NAS_SYNC_BUSY', status: 423, transaction: 'tx' })
    f.transferRequest.mockResolvedValueOnce(json({ error: 'disk full' }, 500))
    await expect(transferRequest('/x')).rejects.toMatchObject({ message: 'disk full', status: 500 })
    f.transferRequest.mockResolvedValueOnce(new Response('nope', { status: 502 }))
    await expect(transferRequest('/x')).rejects.toMatchObject({ message: '전송 요청 실패 (502)', status: 502 })
})

test('inbox poll: skipped while the gate is held at the start of a tick, abandoned when it closes between steps, silent on structured 423 gate codes, loud on real errors', async () => {
    // 1. Initial busy (an apply is armed): the whole native tick is skipped, nothing touches the native bridge.
    transferBusy.set(true)
    startTransferInbox(); await tick()
    expect(ops()).toEqual([]); expect(get(transferStatus)).toBe('')
    // 2. Save hold alone (pre-arm/recovery) also skips.
    transferBusy.set(false); syncSaveHold.set(true); await tick()
    expect(ops()).toEqual([]); expect(get(transferStatus)).toBe('')
    // 3. Gate open: the full tick runs in order and writes the queue state.
    syncSaveHold.set(false); await tick()
    expect(ops()).toEqual(['network.start', 'usb.start', 'inbox.list', 'state.write']); native.mockClear()
    // 4. Late busy: the gate closes while network.start is in flight → usb.start and the rest are not attempted this tick.
    native.mockImplementationOnce(async () => { transferBusy.set(true) }); await tick()
    expect(ops()).toEqual(['network.start']); expect(get(transferStatus)).toBe(''); native.mockClear()
    transferBusy.set(false)
    // 5. A structured 423 from the bridge/native-rpc (the gate raced us) is not an error for the status text.
    for (const code of ['NAS_SYNC_BUSY', 'TRANSFER_BUSY']) {
        native.mockImplementationOnce(async () => { throw Object.assign(new Error('NAS sync apply must finish before saving'), { code, status: 423 }) })
        await tick(); expect(get(transferStatus)).toBe(''); native.mockClear()
    }
    // 6. A real error is still reported exactly as before; a gate code without the 423 status is not a gate race either.
    native.mockImplementationOnce(async () => { throw new Error('USB bridge died') }); await tick()
    expect(get(transferStatus)).toBe('Error: USB bridge died'); native.mockClear()
    transferStatus.set(''); native.mockImplementationOnce(async () => { throw Object.assign(new Error('bridge: NAS_SYNC_BUSY text'), { code: 'NAS_SYNC_BUSY' }) }); await tick()
    expect(get(transferStatus)).toBe('Error: bridge: NAS_SYNC_BUSY text'); native.mockClear()
    // 6b. The gate closes while refreshTransfers() is in flight (between inbox.list and state.write): state.write is not attempted.
    transferStatus.set(''); f.transferRequest.mockImplementationOnce(async () => { syncSaveHold.set(true); return json([]) }); await tick()
    expect(ops()).toEqual(['network.start', 'usb.start', 'inbox.list']); expect(get(transferStatus)).toBe(''); native.mockClear(); syncSaveHold.set(false)
    // 7. Next tick with the gate open runs normally again.
    transferStatus.set(''); await tick(); expect(ops()).toEqual(['network.start', 'usb.start', 'inbox.list', 'state.write']); expect(get(transferStatus)).toBe('')
    // 8. An explicit remote receive uses the same importer even with no native trust, and completes without a second user click.
    const card = { chaId: 'new', name: 'remote', chats: [] }
    let state = 'waiting'
    const receiveRequest = async (path: string) => {
        if (!path) return json([{ id: 'remote', direction: 'receive', state, trusted: false, applyRequested: true }])
        if (path.endsWith('/inspect')) return json({ characters: [] })
        if (path.endsWith('/prepare')) return json({ transaction: 'tx', newCharacters: [card], added: [], registry: {} })
        if (path.endsWith('/finish')) state = 'applied'
        return json({})
    }
    f.transferRequest.mockImplementation(receiveRequest)
    await tick()
    expect(state).toBe('applied')
    expect(f.transferRequest.mock.calls.some(c => c[0] === '/remote/finish')).toBe(true)
    // 9. A durable explicit false suppresses even a trusted legacy entry until the user chooses its target.
    f.transferRequest.mockReset(); f.transferRequest.mockImplementation(async () => json([{ id: 'choice', direction: 'receive', state: 'waiting', trusted: true, applyRequested: false }]))
    await tick()
    expect(f.transferRequest.mock.calls.every(c => c[0] === '')).toBe(true)
    // 10. Remote reception remains available when only the unrelated native transport is broken.
    state = 'waiting'; f.transferRequest.mockReset(); f.transferRequest.mockImplementation(receiveRequest)
    native.mockImplementationOnce(async () => { throw new Error('native bridge unavailable') })
    await tick()
    expect(state).toBe('applied')
})
