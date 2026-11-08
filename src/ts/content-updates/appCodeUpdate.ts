// App code update (client, content-updates module): the app server downloads a newer app code patch from the NAS in the
// background (server/node/content-updates/app-code-watch.cjs). When one is ready and the app is idle, this asks once per
// version and app start "새 버전 준비됨 · 지금 적용/나중에". On the Android app "지금 적용" saves (the same save the app does
// when Android sends it to the background), then asks the app to restart its embedded server: the loader installs the
// downloaded code and the app reconnects with no tap. Where that is not available (the PC package, an APK without
// app.restart), the downloaded code is installed at the next app start.
import { transferRequest } from '../playTransfer'
import { busy } from './contentUpdates'

export interface AppCodeStatus {
    enabled: boolean; current: string | null; ready: string | null; state: string; version?: string; error?: string
}

const CHECK_INTERVAL = 5 * 60_000
const START_DELAY = 20_000
const SAVE_WAIT = 2_000
const asked = new Set<string>()
let running = false
let started = false
let lastCheck = 0

export const fetchAppCodeStatus = async (check = false): Promise<AppCodeStatus> =>
    (await transferRequest('/content-updates/app-code', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ check }) })).json()

export const nativeRestartAvailable = (env: any = globalThis): boolean =>
    !!env?.RisuPlay && String(env.navigator?.userAgent ?? '').includes('RisuBardAndroid/')

/** Saves, then asks the Android app to restart its server. False when this app build cannot (no app.restart). */
export async function applyNow(env: any = globalThis, wait = SAVE_WAIT): Promise<boolean> {
    try { env.dispatchEvent?.(new Event('risubard-native-background')) } catch { /* the save also runs when the page unloads */ }
    await new Promise(resolve => setTimeout(resolve, wait))
    const { playNative } = await import('../transfer-sync/transferNative')
    try { await playNative('app.restart'); return true } catch { return false }
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
            `${status.current} → ${version}\n적용하면 앱이 잠깐 다시 시작돼요. 대화와 설정은 저장한 뒤 그대로 이어져요.\n나중에를 고르면 다음에 앱을 켤 때 적용돼요.`)
        // -1 is the dialog's own close: no answer yet, so it is asked again at the next check.
        if (choice === -1) { asked.delete(version); return status }
        if (choice !== 0) return status
        if (!await applyNow()) alert.alertNormal('이 앱 판에서는 바로 적용할 수 없어요. 앱을 완전히 닫았다가 다시 켜면 적용돼요.')
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
