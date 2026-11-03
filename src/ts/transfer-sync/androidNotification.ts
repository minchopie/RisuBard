// RisuBard Android: the system WebView has no Web Notification API, so upstream's
// response-complete notification (Settings > Sound & Notification) failed with
// "Notification is not defined". This installs a small stand-in backed by the app's
// native bridge so the upstream code paths run unchanged:
//   Notification.permission / Notification.requestPermission() -> Android notification permission
//   new Notification(title, { body })                          -> an Android notification
// While the setting is on and a response is generating, the app is told so; if it goes to
// the background meanwhile, it keeps running until the reply is done (Android would
// otherwise freeze it and the notification would only come on return).
// Browsers and the desktop app keep their own Notification and are untouched.
import { isAnyGenerating } from '../process/generationState'
import { getDatabase } from '../storage/database.svelte'
import { playNative } from './transferNative'

type Permission = 'default' | 'granted' | 'denied'
const normalize = (value: unknown): Permission => value === 'granted' || value === 'denied' ? value : 'default'

export function installAndroidNotifications(env: any = globalThis): boolean {
    if (!env?.RisuPlay || !String(env.navigator?.userAgent ?? '').includes('RisuBardAndroid/')) return false
    if (typeof env.Notification !== 'undefined') return false
    let permission: Permission = 'default'
    const refresh = async (): Promise<Permission> => {
        try { permission = normalize(await playNative('notify.status')) } catch { /* keep the last known state */ }
        return permission
    }

    class AndroidNotification {
        static get permission(): Permission { return permission }
        static async requestPermission(callback?: (result: Permission) => void): Promise<Permission> {
            let result: Permission = 'denied'
            try { result = normalize(await playNative('notify.permission')) } catch { /* answered as denied */ }
            permission = result
            callback?.(result)
            return result
        }
        readonly title: string
        readonly body: string
        onclick: ((event: unknown) => unknown) | null = null
        onshow: ((event: unknown) => unknown) | null = null
        onerror: ((event: unknown) => unknown) | null = null
        onclose: ((event: unknown) => unknown) | null = null
        constructor(title: string, options: { body?: unknown } = {}) {
            this.title = String(title)
            this.body = options?.body === undefined || options?.body === null ? '' : String(options.body)
            void playNative('notify.show', { title: this.title, body: this.body }).catch(() => {})
        }
        close() {}
        addEventListener() {}
        removeEventListener() {}
    }
    env.Notification = AndroidNotification

    // The settings toggle asks the Permissions API first and only requests on 'denied'.
    const permissions = env.navigator?.permissions
    if (permissions && typeof permissions.query === 'function') {
        const query = permissions.query.bind(permissions)
        try {
            permissions.query = (descriptor: { name?: string }) => descriptor?.name === 'notifications'
                ? refresh().then((state) => ({ name: 'notifications', state: state === 'granted' ? 'granted' : 'denied', onchange: null }))
                : query(descriptor)
        } catch { /* read-only: the toggle then requests every time, which stays correct */ }
    }

    let keepAlive = false
    isAnyGenerating.subscribe((generating) => {
        let want = false
        try { want = generating && getDatabase().notification === true && permission === 'granted' } catch { want = false }
        if (want === keepAlive) return
        keepAlive = want
        void playNative('notify.generating', { active: want }).catch(() => {})
    })
    void refresh()
    return true
}
