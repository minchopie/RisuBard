import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const {
    CHAT_PREVIEW_TEXT_LIMIT,
    DEFAULT_CHAT_CONTENT_PAGE_SIZE,
    MAX_CHAT_CONTENT_PAGE_SIZE,
    createChatContentPage,
    createChatPreview,
    readLastJsonlRecord,
} = require('./chat-content-page.cjs')

describe('readLastJsonlRecord', () => {
    const write = (content: string | Buffer) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-preview-'))
        const file = path.join(dir, 'messages.jsonl')
        fs.writeFileSync(file, content)
        return file
    }

    it('returns the last record and ignores trailing line breaks', () => {
        expect(readLastJsonlRecord(write('{"data":"a"}\n{"data":"마지막"}\r\n\n'))).toEqual({ data: '마지막' })
        expect(readLastJsonlRecord(write('{"data":"only"}'))).toEqual({ data: 'only' })
    })

    it('grows the window for a last record longer than the first read', () => {
        const long = '가'.repeat(100_000)
        const file = write(`${JSON.stringify({ data: 'first' })}\n${JSON.stringify({ data: long })}\n`)
        expect(readLastJsonlRecord(file).data).toBe(long)
    })

    it('returns null for a missing or empty file', () => {
        expect(readLastJsonlRecord(path.join(os.tmpdir(), 'missing-chat-preview.jsonl'))).toBeNull()
        expect(readLastJsonlRecord(write('\n\n'))).toBeNull()
        expect(readLastJsonlRecord(write(''))).toBeNull()
    })
})

describe('createChatPreview', () => {
    it('keeps only the hover card fields and caps the message text', () => {
        const preview = createChatPreview(
            { id: 'c', bindedPersona: 'p', note: 'secret', localLore: [1] },
            { role: 'char', data: 'x'.repeat(CHAT_PREVIEW_TEXT_LIMIT + 5), time: 5, swipes: ['a'] },
        )
        expect(preview).toEqual({
            id: 'c', bindedPersona: 'p',
            lastMessage: { role: 'char', data: 'x'.repeat(CHAT_PREVIEW_TEXT_LIMIT), time: 5 },
        })
        expect(createChatPreview({ id: 'c' }, null)).toEqual({ id: 'c', bindedPersona: '', lastMessage: null })
    })
})

describe('createChatContentPage', () => {
    const chat = {
        id: 'chat-1',
        name: 'Long chat',
        note: 'kept as metadata',
        message: Array.from({ length: 25 }, (_, index) => ({ data: `m${index}` })),
    }

    it('returns metadata separately from an exact message slice', () => {
        const page = createChatContentPage(chat, 10, 10)
        expect(page.chat).toEqual({ id: 'chat-1', name: 'Long chat', note: 'kept as metadata' })
        expect(page.messages.map((message: { data: string }) => message.data)).toEqual(
            Array.from({ length: 10 }, (_, index) => `m${index + 10}`),
        )
        expect(page).toMatchObject({ offset: 10, limit: 10, total: 25 })
    })

    it('clamps invalid ranges and does not mutate the source chat', () => {
        const before = structuredClone(chat)
        expect(createChatContentPage(chat, -100, 1)).toMatchObject({
            offset: 0,
            limit: 10,
            total: 25,
        })
        expect(createChatContentPage(chat, 999, 9999)).toMatchObject({
            offset: 25,
            limit: MAX_CHAT_CONTENT_PAGE_SIZE,
            messages: [],
        })
        expect(chat).toEqual(before)
    })

    it('uses a bounded default and supports empty chats', () => {
        expect(createChatContentPage({ id: 'empty', message: [] }, undefined, undefined)).toEqual({
            chat: { id: 'empty' },
            messages: [],
            offset: 0,
            limit: DEFAULT_CHAT_CONTENT_PAGE_SIZE,
            total: 0,
        })
    })
})
