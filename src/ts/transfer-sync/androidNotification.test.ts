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
    const updates = calls.filter((c) => c.op === 'notify.generating').map((c) => c.args)
    // First update on load clears whatever an earlier page left in the app.
    expect(updates.map((u) => u.active)).toEqual([false, true, false])
    expect(updates.map((u) => u.seq)).toEqual([1, 2, 3])
    expect(new Set(updates.map((u) => u.page)).size).toBe(1)

    db.notification = false
    startGeneration('chat-a', 'gen-2')
    endGeneration('chat-a')
    await flush()
    expect(calls.filter((c) => c.op === 'notify.generating')).toHaveLength(3)
})

test('follows the setting and the permission while a reply is generating', async () => {
    const { installAndroidNotifications, startGeneration, endGeneration } = await load()
    const { RisuPlay, calls } = bridge({ 'notify.status': 'default', 'notify.permission': 'granted' })
    vi.useFakeTimers()
    try {
        db.notification = false
        const env: any = androidEnv(RisuPlay)
        installAndroidNotifications(env)
        await vi.advanceTimersByTimeAsync(0)
        startGeneration('chat-a', 'gen-1')
        await vi.advanceTimersByTimeAsync(0)
        db.notification = true
        await vi.advanceTimersByTimeAsync(1000)
        expect(calls.filter((c) => c.op === 'notify.generating').map((c) => c.args.active)).toEqual([false])
        await env.Notification.requestPermission()
        await vi.advanceTimersByTimeAsync(0)
        expect(calls.filter((c) => c.op === 'notify.generating').map((c) => c.args.active)).toEqual([false, true])
        db.notification = false
        await vi.advanceTimersByTimeAsync(1000)
        expect(calls.filter((c) => c.op === 'notify.generating').map((c) => c.args.active)).toEqual([false, true, false])
        endGeneration('chat-a')
        await vi.advanceTimersByTimeAsync(5000)
        expect(calls.filter((c) => c.op === 'notify.generating')).toHaveLength(3)
    } finally {
        vi.useRealTimers()
    }
})

test('a failed bridge answers the permission request as denied', async () => {
    const { installAndroidNotifications } = await load()
    let listener: (event: { data: string }) => void = () => {}
    const RisuPlay = {
        addEventListener: (_: string, callback: typeof listener) => { listener = callback },
        postMessage: (input: string) => { const { id } = JSON.parse(input); queueMicrotask(() => listener({ data: JSON.stringify({ id, error: 'bridge closed' }) })) },
    }
    vi.stubGlobal('RisuPlay', RisuPlay)
    const env: any = androidEnv(RisuPlay)
    installAndroidNotifications(env)
    expect(await env.Notification.requestPermission()).toBe('denied')
    expect(env.Notification.permission).toBe('denied')
})

test('resends after an undelivered update and re-reads the permission on return to the app', async () => {
    const { installAndroidNotifications, startGeneration, endGeneration } = await load()
    let listener: (event: { data: string }) => void = () => {}
    let status = 'granted', failNext = true
    const calls: { op: string, args: any }[] = []
    const RisuPlay = {
        addEventListener: (_: string, callback: typeof listener) => { listener = callback },
        postMessage: (input: string) => {
            const { id, op, args } = JSON.parse(input)
            calls.push({ op, args })
            const fail = op === 'notify.generating' && failNext
            if (fail) failNext = false
            queueMicrotask(() => listener({ data: JSON.stringify(fail ? { id, error: 'bridge busy' } : { id, value: op === 'notify.status' ? status : null }) }))
        },
    }
    vi.stubGlobal('RisuPlay', RisuPlay)
    const events: Record<string, () => void> = {}
    const env: any = { ...androidEnv(RisuPlay), addEventListener: (name: string, fn: () => void) => { events[name] = fn } }
    vi.useFakeTimers()
    try {
        installAndroidNotifications(env)
        await vi.advanceTimersByTimeAsync(0)
        startGeneration('chat-a', 'gen-1')
        await vi.advanceTimersByTimeAsync(0)
        // The first update (on load) failed and is sent again at the next check, before the generating one.
        await vi.advanceTimersByTimeAsync(1000)
        expect(calls.filter((c) => c.op === 'notify.generating').map((c) => c.args.active)).toEqual([false, false, true])
        status = 'default'
        events.focus()
        await vi.advanceTimersByTimeAsync(0)
        expect(env.Notification.permission).toBe('default')
        expect(calls.filter((c) => c.op === 'notify.generating').map((c) => c.args.active)).toEqual([false, false, true, false])
        endGeneration('chat-a')
        await vi.advanceTimersByTimeAsync(0)
        // The re-check timer is gone once nothing generates (playNative timers were cleared by the replies).
        expect(vi.getTimerCount()).toBe(0)
    } finally {
        vi.useRealTimers()
    }
})
