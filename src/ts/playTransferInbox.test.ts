// The native inbox poll's per-entry handling: play sets are accepted and queued as before; a sync key share is accepted only on a
// terminal outcome, left unaccepted while `waiting` (apply in progress / key conflict / lost authority key) so the next poll retries,
// and a request answered by a grant is replied to over the registered channel automatically (best effort).
import { test, expect, vi } from 'vitest'
import { get } from 'svelte/store'
vi.mock('./globalApi.svelte', () => ({ forageStorage: { Init: async () => {}, realStorage: {} }, requestImmediateSave: vi.fn(), checkCharOrder: vi.fn() }))
vi.mock('./storage/database.svelte', () => ({ getDatabase: () => ({ characters: [] }), getCurrentCharacter: () => null, newChatModelDefaults: () => ({}), normalizeChat: (c: any) => c }))
vi.mock('./storage/chatStorage', () => ({ ensureChatHydrated: async (chats: any[], i: number) => chats[i] }))
vi.mock('./process/generationState', () => ({ doingChat: { subscribe: (fn: any) => { fn(false); return () => {} } }, isAnyGenerating: { subscribe: (fn: any) => { fn(false); return () => {} } } }))
vi.mock('./importSession', () => ({ importSession: { subscribe: (fn: any) => { fn({ phase: 'idle' }); return () => {} } } }))
vi.mock('./stores.svelte', () => ({ loadedStore: { subscribe: (fn: any) => { fn(true); return () => {} } }, alertStore: { subscribe: (fn: any) => { fn({ type: 'none' }); return () => {} } } }))
vi.mock('./alert', () => ({ alertSelect: vi.fn(), alertConfirm: vi.fn() }))
vi.mock('./risubard/memorySaveSlots', () => ({ applyMemorySavePromptSettings: vi.fn() }))
vi.mock('./transfer-sync/transferNative', () => ({ playNative: vi.fn(), playSetAvailable: () => true, sendNative: vi.fn() }))
import { handleNativeInboxEntry } from './playTransfer'
import { transferStatus } from './transferState'

function io(result: any) {
    const calls: string[] = []
    return { calls, post: vi.fn(async (path: string) => { calls.push(path); return result }), native: vi.fn(async (op: string) => { calls.push(op) }) as any, send: vi.fn(async (id: string, method: string, device: any) => { calls.push(`send:${id}:${method}:${device}`) }) as any }
}
test('a play set is imported and accepted exactly as before', async () => {
    const x = io({ id: 'rec', direction: 'receive', state: 'waiting' })
    expect(await handleNativeInboxEntry({ id: 'n1' }, x)).toBe('queued')
    expect(x.calls).toEqual(['/native-import', 'inbox.accept'])
})
test('a share that is still waiting (apply in progress, key conflict, lost authority key) is NOT accepted, so inbox.list offers it again next poll', async () => {
    for (const code of [undefined, 'KEY_CONFLICT', 'VAULT_MISSING']) {
        const x = io({ id: 'n2', share: true, state: 'waiting', code })
        expect(await handleNativeInboxEntry({ id: 'n2' }, x)).toBe('waiting')
        expect(x.calls).toEqual(['/native-import']); expect(x.native).not.toHaveBeenCalled()
    }
})
test('terminal share outcomes are accepted; a request answered by a grant is replied to automatically over the registered channel, never over USB adb; a failed reply is reported, not thrown', async () => {
    const applied = io({ id: 'n3', share: true, kind: 'grant', state: 'applied' })
    expect(await handleNativeInboxEntry({ id: 'n3' }, applied)).toBe('applied'); expect(applied.calls).toEqual(['/native-import', 'inbox.accept'])
    const failed = io({ id: 'n4', share: true, state: 'failed', error: 'untrusted' })
    expect(await handleNativeInboxEntry({ id: 'n4' }, failed)).toBe('failed'); expect(failed.calls).toEqual(['/native-import', 'inbox.accept'])
    const request = io({ id: 'n5', share: true, kind: 'request', state: 'applied', grant: 'grant-id', replyTo: 'registered-phone' })
    expect(await handleNativeInboxEntry({ id: 'n5' }, request)).toBe('replied'); expect(request.calls).toEqual(['/native-import', 'inbox.accept', 'send:grant-id:wifi:registered-phone'])
    const usb = io({ id: 'n6', share: true, kind: 'request', state: 'applied', grant: 'grant-id', replyTo: 'usb:adb' })
    expect(await handleNativeInboxEntry({ id: 'n6' }, usb)).toBe('applied'); expect(usb.send).not.toHaveBeenCalled()
    const broken = io({ id: 'n7', share: true, kind: 'request', state: 'applied', grant: 'grant-id', replyTo: 'registered-phone' }); broken.send.mockRejectedValue(new Error('peer offline'))
    expect(await handleNativeInboxEntry({ id: 'n7' }, broken)).toBe('replied'); expect(get(transferStatus)).toContain('다시 보낼 수 있어요')
})
