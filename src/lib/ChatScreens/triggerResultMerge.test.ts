import { describe, expect, test } from 'vitest'
import { mergeTriggerChat } from './triggerResultMerge'
import type { Chat } from 'src/ts/storage/database.svelte'

function chat(over: Partial<Chat> = {}): Chat {
    return {
        id: 'c1',
        name: 'chat',
        note: '',
        localLore: [],
        message: [{ role: 'user', data: 'hi' }, { role: 'char', data: 'hello' }],
        scriptstate: { $a: '1', $b: '2' },
        ...over,
    } as Chat
}

describe('mergeTriggerChat', () => {
    test('keeps the live messages when only variables changed', () => {
        const live = chat()
        const messages = live.message
        const first = live.message[0]
        const ok = mergeTriggerChat(live, chat({ scriptstate: { $a: '9', $c: '3' } }))
        expect(ok).toBe('merged')
        expect(live.message).toBe(messages)
        expect(live.message[0]).toBe(first)
        expect(live.scriptstate).toEqual({ $a: '9', $c: '3' })
    })

    test('writes other changed fields', () => {
        const live = chat()
        expect(mergeTriggerChat(live, chat({ note: 'new note' }))).toBe('merged')
        expect(live.note).toBe('new note')
    })

    test('reports a trigger that changed nothing', () => {
        expect(mergeTriggerChat(chat(), chat())).toBe('same')
    })

    test('refuses when a message changed, was added or the chat is another', () => {
        expect(mergeTriggerChat(chat(), chat({ message: [{ role: 'user', data: 'hi' }, { role: 'char', data: 'edited' }] } as Partial<Chat>))).toBe(false)
        expect(mergeTriggerChat(chat(), chat({ message: [{ role: 'user', data: 'hi' }] } as Partial<Chat>))).toBe(false)
        expect(mergeTriggerChat(chat(), chat({ id: 'c2' }))).toBe(false)
        expect(mergeTriggerChat(undefined, chat())).toBe(false)
    })
})
