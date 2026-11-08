import { beforeEach, describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ busy: false, status: {} as any, choice: 0, native: vi.fn() }))
vi.mock('./contentUpdates', () => ({ busy: vi.fn(async () => state.busy) }))
vi.mock('../playTransfer', () => ({ transferRequest: vi.fn(async (_path: string, init: any) => ({ json: async () => ({ ...state.status, asked: JSON.parse(init.body) }) })) }))
vi.mock('../alert', () => ({ alertConfirmMulti: vi.fn(async () => state.choice), alertNormal: vi.fn() }))
vi.mock('../transfer-sync/transferNative', () => ({ playNative: state.native }))

let alert: any, transferRequest: any
const ready = { enabled: true, current: '0.9.92-ver1', ready: '0.9.92-ver2', state: 'ready' }

beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); state.native.mockReset()
    state.busy = false; state.status = ready; state.choice = 0
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

    test('Android: "지금 적용" saves (background flush event) and asks the app to restart its server', async () => {
        android()
        const events: string[] = []
        vi.stubGlobal('dispatchEvent', (e: Event) => { events.push(e.type); return true })
        const m = await load()
        state.native.mockResolvedValue(null)
        vi.useFakeTimers()
        const run = m.checkAppCodeUpdate(true)
        await vi.runAllTimersAsync()
        await run
        vi.useRealTimers()
        expect(vi.mocked(alert.alertConfirmMulti).mock.calls[0][1]).toEqual(['지금 적용', '나중에'])
        expect(events).toEqual(['risubard-native-background'])
        expect(state.native).toHaveBeenCalledWith('app.restart')
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
        expect(await m.applyNow({ dispatchEvent: () => true }, 0)).toBe(false)
    })

    test('PC / browser (no native restart): one notice per version, no restart', async () => {
        const m = await load()
        await m.checkAppCodeUpdate(true)
        await m.checkAppCodeUpdate(true)
        expect(alert.alertNormal).toHaveBeenCalledTimes(1)
        expect(vi.mocked(alert.alertNormal).mock.calls[0][0]).toContain('0.9.92-ver2')
        expect(alert.alertConfirmMulti).not.toHaveBeenCalled()
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
