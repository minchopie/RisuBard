import { describe, expect, it } from 'vitest'
import type { Message } from '../storage/database.svelte'
import { mergeLuaFullChat } from './luaFullChat'
import { projectWikiRebootTurns } from '../risubard/wikiReboot'

const stored = (): Message[] => [
    { role: 'user', data: 'hello', chatId: 'u1', time: 1 },
    { role: 'char', data: 'reply <lb-stats/>', chatId: 'c1', time: 2, saying: 'bot',
        generationInfo: { model: 'm' } as Message['generationInfo'], risubardMemoryConfirmed: true },
    { role: 'user', data: 'again', chatId: 'u2', time: 3 },
    { role: 'char', data: 'second', chatId: 'c2', time: 4, saying: 'bot' },
]

describe('mergeLuaFullChat', () => {
    it('keeps identity and BardWiki state when a script rewrites message text in place', () => {
        const merged = mergeLuaFullChat(stored(), stored().map(({ role, data }) => ({
            role, data: data.replace(' <lb-stats/>', ''),
        })))
        expect(merged[1]).toMatchObject({
            role: 'char', data: 'reply', chatId: 'c1', time: 2, saying: 'bot',
            generationInfo: { model: 'm' }, risubardMemoryConfirmed: true,
        })
        expect(merged.map(message => message.chatId)).toEqual(['u1', 'c1', 'u2', 'c2'])
        expect(projectWikiRebootTurns(merged).map(turn => turn.assistantMessageId)).toEqual(['c1', 'c2'])
    })

    it('matches unchanged messages by text when a script removes or inserts messages', () => {
        const merged = mergeLuaFullChat(stored(), [
            { role: 'user', data: 'route intro' },
            { role: 'user', data: 'again' },
            { role: 'char', data: 'second' },
        ])
        expect(merged[0]).toEqual({ role: 'user', data: 'route intro' })
        expect(merged[1]).toMatchObject({ chatId: 'u2', time: 3 })
        expect(merged[2]).toMatchObject({ chatId: 'c2', saying: 'bot' })
    })

    it('never gives one message identity to two duplicated entries', () => {
        const merged = mergeLuaFullChat(stored(), [
            { role: 'char', data: 'second' },
            { role: 'char', data: 'second' },
        ])
        expect(merged.map(message => message.chatId)).toEqual(['c2', undefined])
    })

    it('does not carry identity across a role change at the same position', () => {
        const merged = mergeLuaFullChat(stored(), stored().map(({ data }) => ({ role: 'char', data })))
        expect(merged[0]).toEqual({ role: 'char', data: 'hello' })
        expect(merged[1].chatId).toBe('c1')
    })
})
