import { expect, test, vi } from 'vitest'
import { get } from 'svelte/store'
import { chatDisplayName, newChatName, ownsServer, parseChatDeviceLabels } from './chatDeviceLabel'

const labels = parseChatDeviceLabels({ origin: { a: 'pc', b: 'tablet', c: 'phone', bad: 'server', n: 'pc' }, branch: { c: 'tablet', x: 7 } })

test('labels keep only known device kinds', () => {
    expect(labels).toEqual({ origin: { a: 'pc', b: 'tablet', c: 'phone', n: 'pc' }, branch: { c: 'tablet' } })
    expect(parseChatDeviceLabels(null)).toEqual({ origin: {}, branch: {} })
})

test('a new chat is named after the device that makes it', () => {
    expect(newChatName(2, 'pc')).toBe('(pc) Chat 3')
    expect(newChatName(0, 'tablet')).toBe('(tablet) Chat 1')
    expect(newChatName(4, 'phone')).toBe('(phone) Chat 5')
    expect(newChatName(0)).toBe('(pc) Chat 1') // happy-dom is not the Android app
})

test('list marks: default names show the first recording device, sibling copies the continuing device; stored names never change', () => {
    const chat = { id: 'a', name: 'New Chat 2' }
    expect(chatDisplayName(chat, labels)).toBe('(pc) New Chat 2'); expect(chat.name).toBe('New Chat 2')
    expect(chatDisplayName({ id: 'b', name: 'Chat 1' }, labels)).toBe('(tablet) Chat 1')
    expect(chatDisplayName({ id: 'a', name: '내가 지은 이름' }, labels)).toBe('내가 지은 이름')
    expect(chatDisplayName({ id: 'n', name: '(pc) Chat 3' }, labels)).toBe('(pc) Chat 3')
    expect(chatDisplayName({ id: 'c', name: '(pc) Chat 3' }, labels)).toBe('(tablet) Chat 3')
    expect(chatDisplayName({ id: 'c', name: '여행' }, labels)).toBe('(tablet) 여행')
    expect(chatDisplayName({ id: 'zz', name: 'New Chat 9' }, labels)).toBe('New Chat 9')
    expect(chatDisplayName({ id: 'a', name: 'New Chat 3 (2)' }, labels)).toBe('(pc) New Chat 3 (2)')
    expect(chatDisplayName({ id: 'a', name: 'New Chat 3 (copy)' }, labels)).toBe('New Chat 3 (copy)')
    expect(chatDisplayName({ name: 'New Chat 1' }, labels)).toBe('New Chat 1')
    expect(chatDisplayName(null, labels)).toBe('')
})

test('only the app on its own server reports the device kind (never a tablet browser on the PC server)', () => {
    expect(ownsServer('Mozilla/5.0 (Linux; Android 14) wv RisuBardAndroid/0.9.92-ver1', '127.0.0.1')).toBe(true)
    expect(ownsServer('Mozilla/5.0 (Windows NT 10.0)', 'localhost')).toBe(true)
    expect(ownsServer('Mozilla/5.0 (Windows NT 10.0)', '127.0.0.1')).toBe(true)
    expect(ownsServer('Mozilla/5.0 (Linux; Android 14) Chrome/130', '192.168.0.10')).toBe(false)
    expect(ownsServer('Mozilla/5.0 (Windows NT 10.0)', 'my-pc.tailnet.ts.net')).toBe(false)
})

test('refresh reads the marks, tells the service this device once when it has no profile, and shows no marks when sync is off', async () => {
    vi.resetModules()
    const calls: string[] = []
    let self: string | null = null, fail = false
    vi.doMock('./nasSync', () => ({
        syncRequest: async (path: string) => { calls.push(path); if (fail) throw new Error('sync off'); return { json: async () => ({ origin: { a: 'pc' }, branch: { b: 'phone' }, self }) } },
        reportSyncProfile: async (profile: any) => { calls.push('profile:' + profile.kind); self = profile.kind },
    }))
    const m = await import('./chatDeviceLabel')
    await m.refreshChatDeviceLabels()
    expect(calls).toEqual(['/chat-labels', 'profile:pc', '/chat-labels'])
    expect(get(m.chatDeviceLabels)).toEqual({ origin: { a: 'pc' }, branch: { b: 'phone' } })
    await m.refreshChatDeviceLabels()
    expect(calls).toEqual(['/chat-labels', 'profile:pc', '/chat-labels', '/chat-labels'])
    // A browser that does not own the server never reports, even when the service has no profile.
    self = null; calls.length = 0
    vi.stubGlobal('location', { hostname: '192.168.0.10' })
    await m.refreshChatDeviceLabels()
    expect(calls).toEqual(['/chat-labels'])
    vi.unstubAllGlobals()
    fail = true; await m.refreshChatDeviceLabels()
    expect(get(m.chatDeviceLabels)).toEqual({ origin: {}, branch: {} })
    vi.doUnmock('./nasSync')
})
