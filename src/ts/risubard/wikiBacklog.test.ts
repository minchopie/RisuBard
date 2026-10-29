import { describe, expect, test } from 'vitest'
import { summarizeWikiBacklog, wikiBacklogMessages } from './wikiBacklog'

const reply = (index: number, extra: Record<string, unknown> = {}) => ({
    role: 'char', data: `reply ${index}`, chatId: `assistant-${index}`, ...extra,
})
const ask = (index: number) => ({ role: 'user', data: `ask ${index}`, chatId: `user-${index}` })

describe('wiki analysis backlog', () => {
    test('reports the oldest failed turn with its response number and reason', () => {
        const messages = [
            ask(1), reply(1, { risubardMemoryConfirmed: true }),
            ask(2), reply(2, { risubardWikiPending: { reason: '공급자 응답 오류', failedAt: '2026-10-26T00:00:00.000Z' } }),
            ask(3), reply(3, { risubardWikiPending: {} }),
            ask(4),
        ]

        expect(summarizeWikiBacklog(messages)).toEqual({
            count: 2,
            oldest: { messageId: 'assistant-2', index: 3, responseNumber: 2, reason: '공급자 응답 오류' },
        })
    })

    test('has nothing to show while a queued turn only waits, or after it is confirmed', () => {
        expect(summarizeWikiBacklog([ask(1), reply(1, { risubardWikiPending: {} })]).oldest?.reason).toBeUndefined()
        expect(summarizeWikiBacklog([ask(1), reply(1, { risubardMemoryConfirmed: true, risubardWikiPending: {} })]))
            .toEqual({ count: 0 })
        expect(summarizeWikiBacklog([ask(1), reply(1)])).toEqual({ count: 0 })
    })

    test('skips inactive, comment and OOC turns', () => {
        const messages = [
            ask(1), reply(1, { risubardWikiPending: {}, disabled: true }),
            ask(2), reply(2, { risubardWikiPending: {}, isComment: true }),
            ask(3), { ...reply(3, { risubardWikiPending: {} }), data: '<!-- OOC_turn -->\nnote' },
            ask(4), reply(4, { risubardWikiPending: {} }),
        ]

        expect(wikiBacklogMessages(messages).map((message) => message.chatId)).toEqual(['assistant-4'])
    })
})
