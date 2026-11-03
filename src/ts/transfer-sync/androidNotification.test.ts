import { afterEach, expect, test, vi } from 'vitest'

const db = { notification: true }
vi.mock('../storage/database.svelte', () => ({ getDatabase: () => db }))

// Fresh module instances per test: each install subscribes to the shared generation store.
async function load() {
    vi.resetModules()
    const generation = await import('../process/generationState')
    const { installAndroidNotifications } = await import('./androidNotification')
    return { ...generation, installAndroidNotifications }
}

afterEach(() => { vi.unstubAllGlobals(); db.notification = true })

function bridge(answers: Record<string, unknown>) {
    const calls: { op: string, args: any }[] = []
    let listener: (event: { data: string }) => void = () => {}
    const RisuPlay = {
        addEventListener: (_: string, callback: typeof listener) => { listener = callback },
        postMessage: (input: string) => {
            const { id, op, args } = JSON.parse(input)
            calls.push({ op, args })
            queueMicrotask(() => listener({ data: JSON.stringify({ id, value: op in answers ? answers[op] : null }) }))
        },
    }
    vi.stubGlobal('RisuPlay', RisuPlay)
    return { RisuPlay, calls }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const androidEnv = (RisuPlay: unknown, extra: Record<string, unknown> = {}) => ({
    RisuPlay,
    navigator: { userAgent: 'Mozilla/5.0 RisuBardAndroid/0.9.106', permissions: { query: vi.fn(async (d: any) => ({ state: 'prompt', name: d.name })) } },
    ...extra,
})

test('leaves browsers, the desktop app and a WebView with its own Notification alone', async () => {
    const { installAndroidNotifications } = await load()
    const { RisuPlay } = bridge({})
    expect(installAndroidNotifications({ navigator: { userAgent: 'Mozilla/5.0 RisuBardAndroid/1' } })).toBe(false)
    expect(installAndroidNotifications({ RisuPlay, navigator: { userAgent: 'Mozilla/5.0 Chrome' } })).toBe(false)
    const own = function Notification() {}
    const env: any = androidEnv(RisuPlay, { Notification: own })
    expect(installAndroidNotifications(env)).toBe(false)
    expect(env.Notification).toBe(own)
})

test('upstream permission and notification calls reach the native bridge', async () => {
    const { installAndroidNotifications } = await load()
    const { RisuPlay, calls } = bridge({ 'notify.status': 'default', 'notify.permission': 'granted' })
    const env: any = androidEnv(RisuPlay)
    const passthrough = env.navigator.permissions.query
    expect(installAndroidNotifications(env)).toBe(true)
    await flush()
    expect(env.Notification.permission).toBe('default')
    // NotificationToggle: Permissions API first; anything but granted reads as 'denied' so it requests.
    expect((await env.navigator.permissions.query({ name: 'notifications' })).state).toBe('denied')
    expect(await env.navigator.permissions.query({ name: 'geolocation' })).toEqual({ state: 'prompt', name: 'geolocation' })
    expect(passthrough).toHaveBeenCalledTimes(1)
    const callback = vi.fn()
    expect(await env.Notification.requestPermission(callback)).toBe('granted')
    expect(callback).toHaveBeenCalledWith('granted')
    expect(env.Notification.permission).toBe('granted')
    // process/index.svelte.ts: new Notification('Risuai', { body: result }) then sets onclick.
    const shown = new env.Notification('Risuai', { body: '응답 본문' })
    shown.onclick = () => {}
    await flush()
    expect(calls.filter((c) => c.op === 'notify.show')).toEqual([{ op: 'notify.show', args: { title: 'Risuai', body: '응답 본문' } }])
})

test('a refused or failed permission request answers denied', async () => {
    const { installAndroidNotifications } = await load()
    const { RisuPlay } = bridge({ 'notify.status': 'default', 'notify.permission': 'denied' })
    const env: any = androidEnv(RisuPlay)
    installAndroidNotifications(env)
    expect(await env.Notification.requestPermission()).toBe('denied')
    expect(env.Notification.permission).toBe('denied')
})

test('reports generation to the app only while the notification setting is on and granted', async () => {
    const { installAndroidNotifications, startGeneration, endGeneration } = await load()
    const { RisuPlay, calls } = bridge({ 'notify.status': 'granted' })
    installAndroidNotifications(androidEnv(RisuPlay))
    await flush()
    startGeneration('chat-a', 'gen-1')
    endGeneration('chat-a')
    await flush()
    expect(calls.filter((c) => c.op === 'notify.generating').map((c) => c.args.active)).toEqual([true, false])

    db.notification = false
    startGeneration('chat-a', 'gen-2')
    endGeneration('chat-a')
    await flush()
    expect(calls.filter((c) => c.op === 'notify.generating')).toHaveLength(2)
})
