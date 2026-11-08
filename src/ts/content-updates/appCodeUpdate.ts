// App code update (client, content-updates module): the app server downloads a newer app code patch from the NAS in the
// background (server/node/content-updates/app-code-watch.cjs). When one is ready and the app is idle, this asks once per
// version and app start "새 버전 준비됨 · 지금 적용/나중에". On the Android app "지금 적용" holds the screen with a wait
// dialog, saves to the server's file (waiting for it, failures stop the update), checks that nothing started meanwhile,
// then asks the app to restart its embedded server: the loader installs the downloaded code and the app reconnects with
// no tap. Where that is not available (the PC package, an APK without app.restart), the code is installed at the next start.
import { get } from 'svelte/store'
import { transferRequest } from '../playTransfer'
import { busy } from './contentUpdates'

export interface AppCodeStatus {
    enabled: boolean; current: string | null; ready: string | null; state: string; version?: string; error?: string
}
export type ApplyResult = 'restarting' | 'save-failed' | 'busy' | 'unsupported'

const CHECK_INTERVAL = 5 * 60_000
const START_DELAY = 20_000
const RESTART_GRACE = 15_000
const SAVE_LIMIT = 60_000
const APPLY_MESSAGE = '새 버전을 적용하고 있어요. 저장하는 중…'
// While applying, input is held at the window's capture phase (before the chat box, the send button and the global
// hotkeys on document), so no send or settings action can start between the save and the restart.
const HELD_INPUT = ['keydown', 'keypress', 'keyup', 'pointerdown', 'mousedown', 'click', 'touchstart', 'touchend'] as const
const asked = new Set<string>()
let running = false
let started = false
let lastCheck = 0

export const fetchAppCodeStatus = async (check = false): Promise<AppCodeStatus> =>
    (await transferRequest('/content-updates/app-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ check }) })).json()

export const nativeRestartAvailable = (env: any = globalThis): boolean =>
    !!env?.RisuPlay && String(env.navigator?.userAgent ?? '').includes('RisuBardAndroid/')

const defaults = {
    // The app's own durable save, flushed to the server's canonical file; rejects when it could not be written.
    save: async () => (await import('../globalApi.svelte')).requestImmediateSave({ flushServer: 'canonical', rejectOnFailure: true }),
    restart: async () => (await import('../transfer-sync/transferNative')).playNative('app.restart'),
    busy: (ignoreAlert: boolean) => busy(ignoreAlert),
    // The open dialog is still this update's own wait dialog (another dialog replacing it means something else started).
    ownDialog: async () => { const a: any = get((await import('../stores.svelte')).alertStore); return a?.type === 'wait' && a?.msg === APPLY_MESSAGE },
    saveLimit: SAVE_LIMIT,
}

/** Holds keyboard, pointer and touch input until the returned release is called. */
export function holdInput(env: any = globalThis): () => void {
    const stop = (event: Event) => { event.stopImmediatePropagation(); if (event.cancelable) event.preventDefault() }
    for (const type of HELD_INPUT) env.addEventListener?.(type, stop, { capture: true, passive: false })
    return () => { for (const type of HELD_INPUT) env.removeEventListener?.(type, stop, { capture: true }) }
}

/** Saves (with a time limit), then asks the Android app to restart its server. Call with the wait dialog shown and input held. */
export async function applyNow(deps: Partial<typeof defaults> = {}): Promise<ApplyResult> {
    const d = { ...defaults, ...deps }
    let limit: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'timeout'>(resolve => { limit = setTimeout(() => resolve('timeout'), d.saveLimit) })
    // A save that never settles ends this attempt; finishing later does not restart anything.
    const saved = await Promise.race([d.save().then(() => 'saved' as const), deadline]).catch(() => 'failed' as const)
    clearTimeout(limit)
    if (saved !== 'saved') return 'save-failed'
    // A NAS sync apply, transfer, reply or import that started meanwhile, or another dialog: leave the update for later.
    if (await d.busy(true) || !await d.ownDialog()) return 'busy'
    try { await d.restart(); return 'restarting' } catch { return 'unsupported' }
}

/** Asks about a downloaded app code update once per version. `force` ignores the interval. */
export async function checkAppCodeUpdate(force = false): Promise<AppCodeStatus | null> {
    if (running) return null
    if (!force && Date.now() - lastCheck < CHECK_INTERVAL) return null
    running = true
    try {
        if (await busy()) return null
        lastCheck = Date.now()
        const status = await fetchAppCodeStatus()
        const version = status?.ready
        if (!status?.enabled || !version || asked.has(version) || await busy()) return status
        asked.add(version)
        const alert = await import('../alert')
        if (!nativeRestartAvailable()) {
            alert.alertNormal(`새 버전(${version})을 받아 뒀어요. RisuBard를 다시 켜면 적용돼요.`)
            return status
        }
        const choice = await alert.alertConfirmMulti('새 버전이 준비됐어요. 지금 적용할까요?', ['지금 적용', '나중에'],
            `${status.current} → ${version}\n적용하면 저장을 마친 뒤 앱이 잠깐 다시 시작돼요. 저장이 안 되면 적용하지 않아요.\n나중에를 고르면 다음에 앱을 켤 때 적용돼요.`)
        // -1 is the dialog's own close: no answer yet, so it is asked again at the next check.
        if (choice === -1) { asked.delete(version); return status }
        if (choice !== 0) return status
        if (await busy(true)) { asked.delete(version); return status }
        const release = holdInput()
        alert.alertWait(APPLY_MESSAGE)
        const result = await applyNow()
        if (result === 'restarting') {
            // The app replaces the page right away; if this page is still here later, the restart did not happen.
            setTimeout(() => { release(); alert.alertClear(); asked.delete(version) }, RESTART_GRACE)
            return status
        }
        release()
        // Clear only this update's own dialog; one that replaced it belongs to whatever opened it.
        if (await defaults.ownDialog()) alert.alertClear()
        if (result === 'save-failed') { asked.delete(version); alert.alertError('저장을 마치지 못해서 새 버전을 적용하지 않았어요. 다음에 다시 물어볼게요.') }
        else if (result === 'busy') asked.delete(version)
        else alert.alertNormal('이 앱 판에서는 바로 적용할 수 없어요. 앱을 완전히 닫았다가 다시 켜면 적용돼요.')
        return status
    } catch (error) {
        // An old server without the route, or no NAS: stay quiet and try again later.
        console.warn('[AppCodeUpdate] check skipped:', error instanceof Error ? error.message : String(error))
        return null
    } finally {
        running = false
    }
}

export function startAppCodeUpdates() {
    if (started) return
    started = true
    setTimeout(() => { void checkAppCodeUpdate(true) }, START_DELAY)
    setInterval(() => { void checkAppCodeUpdate(true) }, CHECK_INTERVAL)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void checkAppCodeUpdate()
    })
}
