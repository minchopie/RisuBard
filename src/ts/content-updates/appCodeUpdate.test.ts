import { beforeEach, describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ busy: false, busyAfterSave: false, saved: false, status: {} as any, choice: 0, native: vi.fn(), save: vi.fn(), order: [] as string[] }))
vi.mock('./contentUpdates', () => ({ busy: vi.fn(async (ignoreAlert = false) => state.busy || (ignoreAlert && state.saved && state.busyAfterSave)) }))
vi.mock('../playTransfer', () => ({ transferRequest: vi.fn(async (_path: string, init: any) => ({ json: async () => ({ ...state.status, asked: JSON.parse(init.body) }) })) }))
const alertState = await vi.hoisted(async () => { const { writable } = await import('svelte/store'); return { store: writable<any>({ type: 'none', msg: '' }) } })
vi.mock('../stores.svelte', () => ({ alertStore: alertState.store }))
vi.mock('../alert', () => ({
    alertConfirmMulti: vi.fn(async () => state.choice), alertNormal: vi.fn(), alertError: vi.fn(),
    alertWait: vi.fn((msg: string) => { state.order.push('wait'); alertState.store.set({ type: 'wait', msg }) }),
    alertClear: vi.fn(() => { state.order.push('clear'); alertState.store.set({ type: 'none', msg: '' }) }),
}))
vi.mock('../transfer-sync/transferNative', () => ({ playNative: state.native }))
vi.mock('../globalApi.svelte', () => ({ requestImmediateSave: state.save }))

let alert: any, transferRequest: any
const ready = { enabled: true, current: '0.9.92-ver1', ready: '0.9.92-ver2', state: 'ready' }

beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); state.native.mockReset(); state.save.mockReset(); alertState.store.set({ type: 'none', msg: '' })
    state.busy = false; state.busyAfterSave = false; state.saved = false; state.status = ready; state.choice = 0; state.order = []
    state.save.mockImplementation(async () => { state.order.push('save'); state.saved = true })
    state.native.mockImplementation(async () => { state.order.push('restart'); return null })
    vi.unstubAllGlobals()
})
const load = async () => { const m = await import('./appCodeUpdate'); alert = await import('../alert'); transferRequest = (await import('../playTransfer')).transferRequest; return m }
const android = () => { vi.stubGlobal('RisuPlay', {}); vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 RisuBardAndroid/0.9.92' }) }

describe('app code update (client)', () => {
    test('asks for status only (the server downloads on its own schedule)', async () => {
        const m = await load()
        state.status = { enabled: true, current: '0.9.92-ver1', ready: null, state: 'current' }
        await m.checkAppCodeUpdate(true)
        expect(vi.mocked(transferRequest).mock.calls[0][0]).toBe('/content-updates/app-code')
        expect(JSON.parse(vi.mocked(transferRequest).mock.calls[0][1]!.body as string)).toEqual({ check: false })
        expect(alert.alertConfirmMulti).not.toHaveBeenCalled()
    })

    test('Android "지금 적용": wait dialog, durable save to the server file, then the native restart', async () => {
        android()
        const m = await load()
        await m.checkAppCodeUpdate(true)
        expect(vi.mocked(alert.alertConfirmMulti).mock.calls[0][1]).toEqual(['지금 적용', '나중에'])
        expect(state.save).toHaveBeenCalledWith({ flushServer: 'canonical', rejectOnFailure: true })
        expect(state.native).toHaveBeenCalledWith('app.restart')
        expect(state.order).toEqual(['wait', 'save', 'restart'])
    })

    test('a failed save stops the update (no restart) and asks again later', async () => {
        android()
        const m = await load()
        state.save.mockRejectedValue(new Error('disk full'))
        await m.checkAppCodeUpdate(true)
        expect(state.native).not.toHaveBeenCalled()
        expect(alert.alertError).toHaveBeenCalled()
        expect(alert.alertClear).toHaveBeenCalled()
        await m.checkAppCodeUpdate(true)
        expect(alert.alertConfirmMulti).toHaveBeenCalledTimes(2)
    })

    test('work that started while saving (sync apply, transfer, reply, import): no restart, asked again later', async () => {
        android()
        const m = await load()
        state.busyAfterSave = true
        await m.checkAppCodeUpdate(true)
        expect(state.save).toHaveBeenCalled()
        expect(state.native).not.toHaveBeenCalled()
        expect(alert.alertClear).toHaveBeenCalled()
    })

    test('a save that never settles ends the attempt after the limit (no restart, even if it finishes later)', async () => {
        const m = await load()
        let finish: () => void = () => {}
        const restart = vi.fn(async () => null)
        const result = await m.applyNow({ save: () => new Promise<void>(r => { finish = r }), restart, busy: async () => false, ownDialog: async () => true, saveLimit: 20 })
        expect(result).toBe('save-failed')
        finish(); await new Promise(r => setTimeout(r, 10))
        expect(restart).not.toHaveBeenCalled()
    })

    test('another dialog that replaced the wait dialog while saving: no restart, that dialog is left open', async () => {
        android()
        const m = await load()
        state.save.mockImplementation(async () => { state.saved = true; alertState.store.set({ type: 'input', msg: 'other' }) })
        await m.checkAppCodeUpdate(true)
        expect(state.native).not.toHaveBeenCalled()
        expect(alert.alertClear).not.toHaveBeenCalled()
    })

    test('input is held while applying (capture phase, before the chat box and the hotkeys) and released after', async () => {
        const m = await load()
        const target = new EventTarget(), seen: string[] = []
        target.addEventListener('keydown', () => seen.push('hotkey'))
        const release = m.holdInput(target)
        target.dispatchEvent(new Event('keydown', { cancelable: true }))
        release()
        target.dispatchEvent(new Event('keydown', { cancelable: true }))
        expect(seen).toEqual(['hotkey'])
    })

    test('if the page is still there after the restart request, the wait dialog is cleared', async () => {
        android()
        const m = await load()
        vi.useFakeTimers()
        try {
            await m.checkAppCodeUpdate(true)
            expect(alert.alertClear).not.toHaveBeenCalled()
            await vi.advanceTimersByTimeAsync(15_000)
            expect(alert.alertClear).toHaveBeenCalled()
        } finally { vi.useRealTimers() }
    })

    test('"나중에" is not asked again for the same version this run; closing the dialog asks again', async () => {
        android()
        const m = await load()
        state.choice = -1
        await m.checkAppCodeUpdate(true)
        state.choice = 1
        await m.checkAppCodeUpdate(true)
        await m.checkAppCodeUpdate(true)
        expect(alert.alertConfirmMulti).toHaveBeenCalledTimes(2)
        expect(state.native).not.toHaveBeenCalled()
        expect(state.save).not.toHaveBeenCalled()
    })

    test('busy (reply, transfer, open dialog, import): nothing is asked', async () => {
        android()
        const m = await load()
        state.busy = true
        await m.checkAppCodeUpdate(true)
        expect(transferRequest).not.toHaveBeenCalled()
        expect(alert.alertConfirmMulti).not.toHaveBeenCalled()
    })

    test('an APK without app.restart: says it applies at the next start', async () => {
        android()
        const m = await load()
        state.native.mockRejectedValue(new Error('unknown op'))
        await m.checkAppCodeUpdate(true)
        expect(alert.alertClear).toHaveBeenCalled()
        expect(vi.mocked(alert.alertNormal).mock.calls[0][0]).toContain('다시 켜면')
    })

    test('PC / browser (no native restart): one notice per version, no save or restart', async () => {
        const m = await load()
        await m.checkAppCodeUpdate(true)
        await m.checkAppCodeUpdate(true)
        expect(alert.alertNormal).toHaveBeenCalledTimes(1)
        expect(vi.mocked(alert.alertNormal).mock.calls[0][0]).toContain('0.9.92-ver2')
        expect(alert.alertConfirmMulti).not.toHaveBeenCalled()
        expect(state.save).not.toHaveBeenCalled()
        expect(state.native).not.toHaveBeenCalled()
    })

    test('an old server without the route or a disabled loader: quiet', async () => {
        const m = await load()
        state.status = { enabled: false, current: null, ready: null, state: 'off' }
        expect(await m.checkAppCodeUpdate(true)).toMatchObject({ enabled: false })
        vi.mocked(transferRequest).mockRejectedValueOnce(new Error('404'))
        expect(await m.checkAppCodeUpdate(true)).toBeNull()
        expect(alert.alertNormal).not.toHaveBeenCalled()
    })
})
