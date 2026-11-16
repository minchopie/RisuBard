// App code update (client, content-updates module): the app server downloads a newer app code patch from the NAS in the
// background (server/node/content-updates/app-code-watch.cjs). When one is ready and the app is idle, this asks once per
// version and app start "새 버전 준비됨 · 지금 적용/나중에". On the Android app "지금 적용" holds input and shows a wait
// dialog, writes the unsent message draft and saves to the server's file (waiting for both, a failed or unfinished save
// stops the update), checks that nothing started meanwhile, then asks the app to restart its embedded server: the loader
// installs the downloaded code and the app reconnects with no tap. Where that is not available (the PC package, an APK
// without app.restart), the code is installed at the next start.
import { get } from 'svelte/store'
import { transferRequest } from '../playTransfer'
import { busy } from './contentUpdates'
import { isNodeServer } from '../platform'
import { ownsServer } from '../transfer-sync/chatDeviceLabel'

export interface AppCodeStatus {
    enabled: boolean; current: string | null; ready: string | null; state: string; version?: string; error?: string
}
export type ApplyResult = 'restarting' | 'save-failed' | 'busy' | 'unsupported'

const CHECK_INTERVAL = 5 * 60_000
const START_DELAY = 20_000
const RESTART_GRACE = 15_000
const SAVE_LIMIT = 60_000
const DRAFT_SETTLE = 1_000 // longer than the composer's 800 ms draft debounce
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

/** The chat composer shows a send in preparation or in progress (upstream DefaultChatScreen: preparingInput, sendingChat
 *  or doingChat — local to the screen, before a generation is registered). The send button carries the label as
 *  aria-label (preparing) or title (the cancel button while sending), and the screen-reader status text always. */
export async function composerBusy(doc: any = globalThis.document): Promise<boolean> {
    if (!doc?.querySelector) return false
    const { language } = await import('../../lang') as any
    const labels = [language?.chatSendPreparing, language?.chatSendBusy].filter((label): label is string => typeof label === 'string' && label.length > 0)
    if (labels.some(label => doc.querySelector(`[aria-label="${CSS.escape(label)}"],[title="${CSS.escape(label)}"]`))) return true
    return Array.from(doc.querySelectorAll?.('[role="status"]') ?? []).some((el: any) => labels.includes(String(el.textContent ?? '').trim()))
}

const defaults = {
    // The unsent draft (upstream DefaultChatScreen + chatDraft.ts): the composer already wrote it when it lost focus to
    // the dialogs (onblur), a text set without focus is written by its 800 ms debounce (input is held, so nothing new),
    // and loading any draft waits for the draft write queue. No synthetic event: the composer's own writes only (a
    // draft still loading is never written). The queue keeps its upstream best-effort rule (failures not reported).
    flushDraft: async () => {
        await new Promise(resolve => setTimeout(resolve, DRAFT_SETTLE))
        await (await import('../storage/chatDraft')).loadChatDraft('app-code-update', 'flush')
    },
    // The app's own durable save, flushed to the server's canonical file; rejects when it could not be written.
    save: async () => (await import('../globalApi.svelte')).requestImmediateSave({ flushServer: 'canonical', rejectOnFailure: true }),
    restart: async () => (await import('../transfer-sync/transferNative')).playNative('app.restart'),
    busy: async (ignoreAlert: boolean) => await busy(ignoreAlert) || await composerBusy(),
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

/** Writes the draft and saves (within a time limit), then asks the Android app to restart its server.
 *  Call with the wait dialog shown and input held. */
export async function applyNow(deps: Partial<typeof defaults> = {}): Promise<ApplyResult> {
    const d = { ...defaults, ...deps }
    let limit: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'timeout'>(resolve => { limit = setTimeout(() => resolve('timeout'), d.saveLimit) })
    // A save that never settles ends this attempt; finishing later does not restart anything.
    const work = (async () => { await d.flushDraft(); await d.save(); return 'saved' as const })()
    const saved = await Promise.race([work, deadline]).catch(() => 'failed' as const)
    clearTimeout(limit)
    if (saved !== 'saved') return 'save-failed'
    // A NAS sync apply, transfer, reply (or one being prepared) or import that started meanwhile, or another dialog:
    // leave the update for later.
    if (await d.busy(true) || !await d.ownDialog()) return 'busy'
    try { await d.restart(); return 'restarting' } catch { return 'unsupported' }
}

/** Asks about a downloaded app code update once per version. `force` ignores the interval. */
export async function checkAppCodeUpdate(force = false): Promise<AppCodeStatus | null> {
    if (running) return null
    if (!force && Date.now() - lastCheck < CHECK_INTERVAL) return null
    running = true
    let release: (() => void) | null = null
    let version: string | null = null
    try {
        if (await defaults.busy(false)) return null
        lastCheck = Date.now()
        const status = await fetchAppCodeStatus()
        version = status?.ready ?? null
        if (!status?.enabled || !version || asked.has(version) || await defaults.busy(false)) return status
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
        if (await defaults.busy(true)) { asked.delete(version); return status }
        release = holdInput()
        alert.alertWait(APPLY_MESSAGE)
        const result = await applyNow()
        if (result === 'restarting') {
            // The app replaces the page right away; if this page is still here later, the restart did not happen.
            const held = release, again = version
            release = null // handed to the grace timer
            setTimeout(() => {
                held()
                void defaults.ownDialog().then(own => { if (own) alert.alertClear() }).catch(() => {})
                asked.delete(again)
            }, RESTART_GRACE)
            return status
        }
        if (result === 'save-failed') { asked.delete(version); alert.alertError('저장을 마치지 못해서 새 버전을 적용하지 않았어요. 다음에 다시 물어볼게요.') }
        else if (result === 'busy') asked.delete(version)
        else alert.alertNormal('이 앱 판에서는 바로 적용할 수 없어요. 앱을 완전히 닫았다가 다시 켜면 적용돼요.')
        return status
    } catch (error) {
        if (release && version) asked.delete(version)
        // An old server without the route, or no NAS: stay quiet and try again later.
        console.warn('[AppCodeUpdate] check skipped:', error instanceof Error ? error.message : String(error))
        return null
    } finally {
        // Every path that did not hand the held input to the restart grace timer releases it here, and clears this
        // update's own wait dialog (a dialog that replaced it belongs to whatever opened it).
        if (release) {
            release()
            try { if (await defaults.ownDialog()) (await import('../alert')).alertClear() } catch { /* nothing to clear */ }
        }
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

// ── 0.9.96-ver7: settings 「서버 끄기」 (PC) ──
// The PC server keeps running without a window after its tab is closed, and an app code patch from the NAS is installed only when
// the server starts again. This switch reuses the "지금 적용" steps above (held input, wait dialog, unsent draft, durable save to the
// server's file, busy re-check) and, in place of the Android restart, asks the server for the graceful exit the start-menu stop uses
// (POST /api/server-shutdown in server.cjs: refused while a write gate is held or a reply runs on the server, then shutdownGracefully).
// The PC has no restart path of its own (RisuBard.exe or the package updater starts the server), so there is no restart switch.
// Not shown on Android (the app owns its embedded server) nor in another device's browser that uses this PC's server.
const SHUTDOWN_MESSAGE = '서버를 끄기 전에 저장하는 중…'
export const SERVER_STOPPING_TEXT = '서버를 끄고 있어요. 저장을 마무리하는 중…'
export const SERVER_STOPPED_TEXT = '서버가 꺼졌습니다. 다시 켜려면 RisuBard를 실행하세요.'
export const SERVER_STILL_RUNNING_TEXT = '서버가 1분 안에 꺼지지 않았어요. 저장 마무리가 길어지는 중일 수 있어요. 잠시 뒤 이 탭을 새로 고쳐 확인해 주세요.'

/** The PC's own screen on its Node server (localhost), not the Android app. */
export function serverShutdownAvailable(nodeServer: boolean = isNodeServer, userAgent: string = String(globalThis.navigator?.userAgent ?? ''), hostname: string = String(globalThis.location?.hostname ?? '')): boolean {
    return nodeServer && !/RisuBardAndroid/i.test(userAgent) && ownsServer(userAgent, hostname)
}

/** Covers the page with the message: the app cannot be used once its server is gone. */
export function showServerStopped(text: string, doc: any = globalThis.document) {
    let cover = doc.getElementById('risubard-server-stopped')
    if (!cover) {
        cover = doc.createElement('div')
        cover.id = 'risubard-server-stopped'
        cover.setAttribute('role', 'status')
        cover.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:2rem;text-align:center;font-size:1.25rem;line-height:1.6;background:var(--color-bgcolor,#1e1e2e);color:var(--color-textcolor,#f8f8f2)'
        doc.body.append(cover)
    }
    cover.textContent = text
}

/** The server still answers. A slow answer (the exit flushing saves) counts as still running; only a refused connection is gone. */
export async function serverStillAnswers(fetcher: typeof fetch = globalThis.fetch): Promise<boolean> {
    try { await fetcher('/', { cache: 'no-store', signal: AbortSignal.timeout(2_000) }); return true }
    catch (error: any) { return error?.name === 'TimeoutError' || error?.name === 'AbortError' }
}

const shutdownDefaults = {
    reason: async (): Promise<string> => {
        const updates = await import('./contentUpdates')
        return await updates.busyReason() || (await composerBusy() ? '채팅을 보내는 중이에요.' : '')
            || (await updates.syncCycleRunning() ? 'NAS 동기화가 진행 중이에요. 끝난 뒤 다시 눌러 주세요.' : '')
            || (updates.contentCheckRunning() ? '캐릭터·페르소나 배포 확인(목록 읽기·받기·가져오기)이 진행 중이에요. 끝난 뒤 다시 눌러 주세요.' : '')
    },
    confirm: async (): Promise<boolean> => (await import('../alert')).alertConfirm('서버를 끌까요?\n\n저장을 마친 뒤 이 PC의 RisuBard 서버를 꺼요. 꺼지면 이 탭은 쓸 수 없어요. 다시 쓰려면 RisuBard를 실행하세요. NAS에서 받아 둔 새 앱 코드가 있으면 그때 적용돼요.'),
    busy: async (ignoreAlert: boolean): Promise<boolean> => {
        const updates = await import('./contentUpdates')
        return await defaults.busy(ignoreAlert) || await updates.syncCycleRunning() || updates.contentCheckRunning()
    },
    ownDialog: async (): Promise<boolean> => { const a: any = get((await import('../stores.svelte')).alertStore); return a?.type === 'wait' && a?.msg === SHUTDOWN_MESSAGE },
    /** Holds automatic NAS sync (in memory) so no cycle starts while the server exits; returns how to undo it, or null when a cycle
     *  is running right now (then nothing is paused). */
    pauseSync: async (): Promise<(() => void) | null> => {
        const coordinator: any = (await import('../nasSyncCoordinator')).syncCoordinator()
        if (coordinator.state?.running) return null
        if (coordinator.state?.paused) return () => {}
        coordinator.pause(true)
        return () => coordinator.pause(false)
    },
    request: async (): Promise<void> => {
        const { forageStorage } = await import('../globalApi.svelte')
        const response = await fetch('/api/server-shutdown', { method: 'POST', headers: { 'risu-auth': await forageStorage.createAuth() } })
        if (!response.ok) throw new Error((await response.json().catch(() => null))?.error || `서버가 끄기 요청을 받지 않았어요 (${response.status}).`)
    },
    alive: (): Promise<boolean> => serverStillAnswers(),
    show: (text: string) => showServerStopped(text),
    hold: (): (() => void) => holdInput(),
    apply: {} as Partial<typeof defaults>,
    pollMs: 1_000,
    stopWait: 60_000,
}

/** 「서버 끄기」. '' when cancelled; otherwise what happened, for the settings panel. Once the server took the request the page is
 *  covered and input stays held (nothing here can be saved any more). */
export async function shutdownServer(deps: Partial<typeof shutdownDefaults> = {}): Promise<string> {
    const d = { ...shutdownDefaults, ...deps }
    const before = await d.reason()
    if (before) return `지금은 서버를 끌 수 없어요: ${before}`
    if (!await d.confirm()) return ''
    // The question was open for a while.
    const after = await d.reason()
    if (after) return `지금은 서버를 끌 수 없어요: ${after}`
    const alert = await import('../alert')
    let refused = ''
    let release: (() => void) | null = d.hold()
    try {
        alert.alertWait(SHUTDOWN_MESSAGE)
        const result = await applyNow({ ...d.apply, busy: d.busy, ownDialog: d.ownDialog, restart: async () => {
            const resume = await d.pauseSync()
            if (!resume) { refused = 'NAS 동기화가 막 시작됐어요. 끝난 뒤 다시 눌러 주세요.'; throw new Error(refused) }
            try { await d.request() } catch (error) { resume(); refused = error instanceof Error ? error.message : String(error); throw error }
        } })
        if (result === 'restarting') {
            release = null
            if (await d.ownDialog()) alert.alertClear()
            d.show(SERVER_STOPPING_TEXT)
            const until = Date.now() + d.stopWait
            while (Date.now() < until) {
                if (!await d.alive()) { d.show(SERVER_STOPPED_TEXT); return SERVER_STOPPED_TEXT }
                await new Promise(resolve => setTimeout(resolve, d.pollMs))
            }
            d.show(SERVER_STILL_RUNNING_TEXT)
            return SERVER_STILL_RUNNING_TEXT
        }
        if (result === 'save-failed') return '저장을 마치지 못해서 서버를 끄지 않았어요. 잠시 뒤 다시 눌러 주세요.'
        if (result === 'busy') return '그사이 다른 작업(답변·전송·NAS 동기화·가져오기 또는 다른 알림 창)이 시작돼서 서버를 끄지 않았어요. 끝난 뒤 다시 눌러 주세요.'
        return `서버를 끄지 못했어요: ${refused}`
    } finally {
        if (release) {
            release()
            try { if (await d.ownDialog()) alert.alertClear() } catch { /* nothing to clear */ }
        }
    }
}