import { expect, test, vi } from 'vitest'
import { get } from 'svelte/store'
import { chatDisplayName, newChatName, parseChatDeviceLabels } from './chatDeviceLabel'

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
    expect(chatDisplayName({ name: 'New Chat 1' }, labels)).toBe('New Chat 1')
    expect(chatDisplayName(null, labels)).toBe('')
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
    fail = true; await m.refreshChatDeviceLabels()
    expect(get(m.chatDeviceLabels)).toEqual({ origin: {}, branch: {} })
    vi.doUnmock('./nasSync')
})
