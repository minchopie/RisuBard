import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ reason: '', syncing: false, checking: false, busy: false, busyAfterSave: false, saved: false, status: {} as any, choice: 0, native: vi.fn(), save: vi.fn(), order: [] as string[] }))
vi.mock('./contentUpdates', () => ({ busy: vi.fn(async (ignoreAlert = false) => state.busy || (ignoreAlert && state.saved && state.busyAfterSave)), busyReason: vi.fn(async () => state.reason), syncCycleRunning: vi.fn(async () => state.syncing), contentCheckRunning: vi.fn(() => state.checking) }))
vi.mock('../playTransfer', () => ({ transferRequest: vi.fn(async (_path: string, init: any) => ({ json: async () => ({ ...state.status, asked: JSON.parse(init.body) }) })) }))
const alertState = await vi.hoisted(async () => { const { writable } = await import('svelte/store'); return { store: writable<any>({ type: 'none', msg: '' }) } })
vi.mock('../stores.svelte', () => ({ alertStore: alertState.store }))
vi.mock('../alert', () => ({
    alertConfirmMulti: vi.fn(async () => state.choice), alertConfirm: vi.fn(async () => state.choice === 0), alertNormal: vi.fn(), alertError: vi.fn(),
    alertWait: vi.fn((msg: string) => { state.order.push('wait'); alertState.store.set({ type: 'wait', msg }) }),
    alertClear: vi.fn(() => { state.order.push('clear'); alertState.store.set({ type: 'none', msg: '' }) }),
}))
vi.mock('../transfer-sync/transferNative', () => ({ playNative: state.native }))
vi.mock('../globalApi.svelte', () => ({ requestImmediateSave: state.save }))
vi.mock('../storage/chatDraft', () => ({ loadChatDraft: vi.fn(async () => { state.order.push('draft'); return null }) }))
vi.mock('../../lang', () => ({ language: { chatSendPreparing: 'Preparing to send', chatSendBusy: 'Sending' } }))

let alert: any, transferRequest: any
const ready = { enabled: true, current: '0.9.92-ver1', ready: '0.9.92-ver2', state: 'ready' }

beforeEach(() => {
    vi.resetModules(); vi.clearAllMocks(); state.native.mockReset(); state.save.mockReset(); alertState.store.set({ type: 'none', msg: '' })
    state.reason = ''; state.syncing = false; state.checking = false; state.busy = false; state.busyAfterSave = false; state.saved = false; state.status = ready; state.choice = 0; state.order = []
    state.save.mockImplementation(async () => { state.order.push('save'); state.saved = true })
    state.native.mockImplementation(async () => { state.order.push('restart'); return null })
    vi.unstubAllGlobals()
    vi.useFakeTimers()
})
// Run every pending restart grace timer, so held input from one test never leaks into the next.
afterEach(async () => { await vi.runAllTimersAsync(); vi.useRealTimers() })
const load = async () => { const m = await import('./appCodeUpdate'); alert = await import('../alert'); transferRequest = (await import('../playTransfer')).transferRequest; return m }
// Runs a check while advancing past the draft settle wait (fake timers).
const run = async (m: any) => { const p = m.checkAppCodeUpdate(true); await vi.advanceTimersByTimeAsync(2_000); return p }
const android = () => { vi.stubGlobal('RisuPlay', {}); vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 RisuBardAndroid/0.9.92' }) }

describe('app code update (client)', () => {
    test('asks for status only (the server downloads on its own schedule)', async () => {
        const m = await load()
        state.status = { enabled: true, current: '0.9.92-ver1', ready: null, state: 'current' }
        await run(m)
        expect(vi.mocked(transferRequest).mock.calls[0][0]).toBe('/content-updates/app-code')
        expect(JSON.parse(vi.mocked(transferRequest).mock.calls[0][1]!.body as string)).toEqual({ check: false })
        expect(alert.alertConfirmMulti).not.toHaveBeenCalled()
    })

    test('Android "지금 적용": wait dialog, durable save to the server file, then the native restart', async () => {
        android()
        let pagehides = 0
        window.addEventListener('pagehide', () => { pagehides++ })
        const m = await load()
        await run(m)
        expect(vi.mocked(alert.alertConfirmMulti).mock.calls[0][1]).toEqual(['지금 적용', '나중에'])
        expect(state.save).toHaveBeenCalledWith({ flushServer: 'canonical', rejectOnFailure: true })
        expect(state.native).toHaveBeenCalledWith('app.restart')
        expect(state.order).toEqual(['wait', 'draft', 'save', 'restart'])
        // No synthetic pagehide (it would make a composer still loading its draft write an empty one).
        expect(pagehides).toBe(0)
    })

    test('a failed save stops the update (no restart) and asks again later', async () => {
        android()
        const m = await load()
        state.save.mockRejectedValue(new Error('disk full'))
        await run(m)
        expect(state.native).not.toHaveBeenCalled()
        expect(alert.alertError).toHaveBeenCalled()
        expect(alert.alertClear).toHaveBeenCalled()
        await run(m)
        expect(alert.alertConfirmMulti).toHaveBeenCalledTimes(2)
    })

    test('work that started while saving (sync apply, transfer, reply, import): no restart, asked again later', async () => {
        android()
        const m = await load()
        state.busyAfterSave = true
        await run(m)
        expect(state.save).toHaveBeenCalled()
        expect(state.native).not.toHaveBeenCalled()
        expect(alert.alertClear).toHaveBeenCalled()
    })

    test('a save that never settles ends the attempt after the limit (no restart, even if it finishes later)', async () => {
        const m = await load()
        let finish: () => void = () => {}
        const restart = vi.fn(async () => null)
        const pending = m.applyNow({ flushDraft: async () => {}, save: () => new Promise<void>(r => { finish = r }), restart, busy: async () => false, ownDialog: async () => true, saveLimit: 20 })
        await vi.advanceTimersByTimeAsync(20)
        expect(await pending).toBe('save-failed')
        finish(); await vi.advanceTimersByTimeAsync(10)
        expect(restart).not.toHaveBeenCalled()
    })

    test('another dialog that replaced the wait dialog while saving: no restart, that dialog is left open', async () => {
        android()
        const m = await load()
        state.save.mockImplementation(async () => { state.saved = true; alertState.store.set({ type: 'input', msg: 'other' }) })
        await run(m)
        expect(state.native).not.toHaveBeenCalled()
        expect(alert.alertClear).not.toHaveBeenCalled()
    })

    test('a send being prepared in the composer (button in its preparing/busy state) counts as busy', async () => {
        const m = await load()
        document.body.innerHTML = '<button aria-label="Preparing to send"></button>'
        expect(await m.composerBusy(document)).toBe(true)
        // While sending (before the generation is registered) the button is the cancel button: label only in title/status.
        document.body.innerHTML = '<button aria-label="Cancel" title="Preparing to send"></button>'
        expect(await m.composerBusy(document)).toBe(true)
        document.body.innerHTML = '<button aria-label="Cancel"><span class="sr-only" role="status"> Sending </span></button>'
        expect(await m.composerBusy(document)).toBe(true)
        document.body.innerHTML = '<button aria-label="Send"></button>'
        expect(await m.composerBusy(document)).toBe(false)
        document.body.innerHTML = ''
    })

    test('a send prepared while saving: no restart, asked again later', async () => {
        android()
        const m = await load()
        state.save.mockImplementation(async () => { state.saved = true; document.body.innerHTML = '<button aria-label="Preparing to send"></button>' })
        await run(m)
        document.body.innerHTML = ''
        expect(state.native).not.toHaveBeenCalled()
        let current: any; alertState.store.subscribe((v: any) => { current = v })()
        expect(current.type).toBe('none')
    })

    test('an exception after input is held releases it and clears the own wait dialog', async () => {
        android()
        const m = await load()
        state.save.mockImplementation(async () => { state.saved = true })
        vi.mocked(alert.alertConfirmMulti).mockImplementationOnce(async () => 0)
        const { alertWait } = await import('../alert')
        vi.mocked(alertWait).mockImplementationOnce((msg: string) => { alertState.store.set({ type: 'wait', msg }); throw new Error('dialog failed') })
        await run(m)
        const key = new KeyboardEvent('keydown', { cancelable: true, bubbles: true })
        document.body.dispatchEvent(key)
        expect(key.defaultPrevented).toBe(false)
        expect(state.native).not.toHaveBeenCalled()
        let current: any; alertState.store.subscribe((v: any) => { current = v })()
        expect(current.type).toBe('none')
    })

    test('the restart grace timer releases input but leaves a dialog that replaced the wait dialog', async () => {
        android()
        const m = await load()
        await run(m)
        alertState.store.set({ type: 'input', msg: 'other' })
        await vi.advanceTimersByTimeAsync(15_000)
        let current: any; alertState.store.subscribe((v: any) => { current = v })()
        expect(current.type).toBe('input')
        const key = new KeyboardEvent('keydown', { cancelable: true, bubbles: true })
        document.body.dispatchEvent(key)
        expect(key.defaultPrevented).toBe(false)
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
        await run(m)
        expect(alert.alertClear).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(15_000)
        expect(alert.alertClear).toHaveBeenCalled()
    })

    test('"나중에" is not asked again for the same version this run; closing the dialog asks again', async () => {
        android()
        const m = await load()
        state.choice = -1
        await run(m)
        state.choice = 1
        await run(m)
        await run(m)
        expect(alert.alertConfirmMulti).toHaveBeenCalledTimes(2)
        expect(state.native).not.toHaveBeenCalled()
        expect(state.save).not.toHaveBeenCalled()
    })

    test('busy (reply, transfer, open dialog, import): nothing is asked', async () => {
        android()
        const m = await load()
        state.busy = true
        await run(m)
        expect(transferRequest).not.toHaveBeenCalled()
        expect(alert.alertConfirmMulti).not.toHaveBeenCalled()
    })

    test('an APK without app.restart: says it applies at the next start', async () => {
        android()
        const m = await load()
        state.native.mockRejectedValue(new Error('unknown op'))
        await run(m)
        expect(alert.alertClear).toHaveBeenCalled()
        expect(vi.mocked(alert.alertNormal).mock.calls[0][0]).toContain('다시 켜면')
    })

    test('PC / browser (no native restart): one notice per version, no save or restart', async () => {
        const m = await load()
        await run(m)
        await run(m)
        expect(alert.alertNormal).toHaveBeenCalledTimes(1)
        expect(vi.mocked(alert.alertNormal).mock.calls[0][0]).toContain('0.9.92-ver2')
        expect(alert.alertConfirmMulti).not.toHaveBeenCalled()
        expect(state.save).not.toHaveBeenCalled()
        expect(state.native).not.toHaveBeenCalled()
    })

    test('an old server without the route or a disabled loader: quiet', async () => {
        const m = await load()
        state.status = { enabled: false, current: null, ready: null, state: 'off' }
        expect(await run(m)).toMatchObject({ enabled: false })
        vi.mocked(transferRequest).mockRejectedValueOnce(new Error('404'))
        expect(await run(m)).toBeNull()
        expect(alert.alertNormal).not.toHaveBeenCalled()
    })
})

describe('server shutdown switch (0.9.96-ver7, PC)', () => {
    // Each step records its turn; input holding is injected so no listener outlives a test.
    const deps = (over: any = {}) => {
        const held = { on: false }, shown: string[] = []
        const resume = vi.fn(() => { state.order.push('resume') })
        const d = {
            hold: () => { held.on = true; return () => { held.on = false } },
            pauseSync: vi.fn(async () => { state.order.push('pause'); return resume }),
            request: vi.fn(async () => { state.order.push('request') }),
            alive: vi.fn(async () => false),
            show: (text: string) => { shown.push(text) },
            apply: { flushDraft: async () => { state.order.push('draft') }, saveLimit: 1_000 },
            pollMs: 10, stopWait: 100,
            ...over,
        }
        return { d, held, shown, resume }
    }
    const go = async (m: any, d: any) => { const p = m.shutdownServer(d); await vi.advanceTimersByTimeAsync(500); return p }

    test('shown only on the PC\'s own screen on a Node server (not Android, not another device\'s browser)', async () => {
        const m = await load()
        expect(m.serverShutdownAvailable(true, 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', 'localhost')).toBe(true)
        expect(m.serverShutdownAvailable(true, 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', '127.0.0.1')).toBe(true)
        expect(m.serverShutdownAvailable(true, 'Mozilla/5.0 (Linux; Android 14) RisuBardAndroid/0.9.96', 'localhost')).toBe(false)
        expect(m.serverShutdownAvailable(true, 'Mozilla/5.0 (Linux; Android 14) Chrome/130', '192.168.0.10')).toBe(false)
        expect(m.serverShutdownAvailable(false, 'Mozilla/5.0 (Windows NT 10.0) Chrome/130', 'localhost')).toBe(false)
    })

    test('confirmed: draft and durable save first, sync paused, then the server is asked; the page says it stopped', async () => {
        const m = await load()
        const { d, held, shown } = deps({ alive: vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false) })
        expect(await go(m, d)).toBe(m.SERVER_STOPPED_TEXT)
        expect(state.order).toEqual(['wait', 'draft', 'save', 'pause', 'request', 'clear'])
        expect(state.save).toHaveBeenCalledWith({ flushServer: 'canonical', rejectOnFailure: true })
        expect(shown).toEqual([m.SERVER_STOPPING_TEXT, m.SERVER_STOPPED_TEXT])
        // The app cannot save any more: input stays held under the cover.
        expect(held.on).toBe(true)
        expect(state.native).not.toHaveBeenCalled()
    })

    test('busy before asking (reply, transfer, import, dialog, sending, NAS sync): says why, asks nothing', async () => {
        const m = await load()
        state.reason = '답변을 만드는 중이에요.'
        const { d } = deps()
        expect(await go(m, d)).toContain('답변을 만드는 중이에요.')
        expect(alert.alertConfirm).not.toHaveBeenCalled()
        expect(d.request).not.toHaveBeenCalled()
        state.reason = ''; state.syncing = true
        expect(await go(m, deps().d)).toContain('NAS 동기화')
        state.syncing = false; state.checking = true
        const check = deps()
        expect(await go(m, check.d)).toContain('배포 확인')
        expect(check.d.request).not.toHaveBeenCalled()
    })

    test('"아니오": nothing happens', async () => {
        const m = await load()
        state.choice = 1
        const { d, held } = deps()
        expect(await go(m, d)).toBe('')
        expect(state.save).not.toHaveBeenCalled()
        expect(d.request).not.toHaveBeenCalled()
        expect(held.on).toBe(false)
    })

    test('the server refuses (work running there): sync resumed, input released, wait dialog cleared, reason shown', async () => {
        const m = await load()
        const { d, held, resume, shown } = deps({ request: vi.fn(async () => { throw new Error('답변을 만드는 중이에요.') }) })
        expect(await go(m, d)).toBe('서버를 끄지 못했어요: 답변을 만드는 중이에요.')
        expect(resume).toHaveBeenCalled()
        expect(held.on).toBe(false)
        expect(shown).toEqual([])
        let current: any; alertState.store.subscribe((v: any) => { current = v })()
        expect(current.type).toBe('none')
    })

    test('a failed save: the server is not asked', async () => {
        const m = await load()
        state.save.mockRejectedValue(new Error('disk full'))
        const { d, held } = deps()
        expect(await go(m, d)).toContain('저장을 마치지 못해서')
        expect(d.pauseSync).not.toHaveBeenCalled()
        expect(d.request).not.toHaveBeenCalled()
        expect(held.on).toBe(false)
    })

    test('work that started while saving, or a sync cycle that just started: the server is not asked', async () => {
        const m = await load()
        state.busyAfterSave = true
        const first = deps()
        expect(await go(m, first.d)).toContain('그사이 다른 작업')
        expect(first.d.request).not.toHaveBeenCalled()
        state.busyAfterSave = false
        state.save.mockImplementation(async () => { state.order.push('save'); state.saved = true; state.checking = true })
        const during = deps()
        expect(await go(m, during.d)).toContain('그사이 다른 작업')
        expect(during.d.request).not.toHaveBeenCalled()
        state.checking = false
        state.save.mockImplementation(async () => { state.order.push('save'); state.saved = true })
        state.busyAfterSave = false
        const second = deps({ pauseSync: vi.fn(async () => null) })
        expect(await go(m, second.d)).toContain('NAS 동기화가 막 시작됐어요')
        expect(second.d.request).not.toHaveBeenCalled()
    })

    test('a server that has not exited within the wait: says so (the cover stays)', async () => {
        const m = await load()
        const { d, shown } = deps({ alive: vi.fn(async () => true) })
        expect(await go(m, d)).toBe(m.SERVER_STILL_RUNNING_TEXT)
        expect(shown.at(-1)).toBe(m.SERVER_STILL_RUNNING_TEXT)
    })

    test('the cover is one element; a slow answer counts as still running, a refused connection as stopped', async () => {
        const m = await load()
        m.showServerStopped('a'); m.showServerStopped('b')
        const covers = document.querySelectorAll('#risubard-server-stopped')
        expect(covers.length).toBe(1)
        expect(covers[0].textContent).toBe('b')
        covers[0].remove()
        expect(await m.serverStillAnswers((async () => ({ ok: true })) as any)).toBe(true)
        expect(await m.serverStillAnswers((async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }) }) as any)).toBe(true)
        expect(await m.serverStillAnswers((async () => { throw new TypeError('Failed to fetch') }) as any)).toBe(false)
    })
})