import { describe, expect, test } from 'vitest'
import { luaChatEntry } from './luaChatEntry'

describe('luaChatEntry (Lua getFullChat)', () => {
    test('keeps role, data and time as before and adds the message id', () => {
        expect(luaChatEntry({ role: 'user', data: 'hello', time: 5, chatId: 'a1b2' })).toEqual({ role: 'user', data: 'hello', time: 5, id: 'a1b2' })
    })
    test('no id key for a message without one, time defaults to 0', () => {
        const entry = luaChatEntry({ role: 'char', data: 'hi' })
        expect(entry).toEqual({ role: 'char', data: 'hi', time: 0 })
        expect('id' in entry).toBe(false)
        expect('id' in luaChatEntry({ role: 'char', data: 'hi', chatId: '' })).toBe(false)
    })
    test('the JSON the Lua side decodes carries the id', () => {
        const json = JSON.stringify([{ role: 'user', data: 'x', chatId: 'id-1' }, { role: 'char', data: 'y' }].map(luaChatEntry))
        expect(JSON.parse(json)).toEqual([{ role: 'user', data: 'x', time: 0, id: 'id-1' }, { role: 'char', data: 'y', time: 0 }])
    })
})
