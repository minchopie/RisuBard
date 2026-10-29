import { describe, expect, test } from 'vitest'
import { chatIdRange, chatSection, gatherSelectionAfterDrag, shiftSelectedChats, type ListChat } from './chatListOrder'

const chat = (id: string, folderId: string | null = null): ListChat => ({ id, folderId })
const ids = (chats: ListChat[]) => chats.map(c => c.id).join(',')
const folders = new Set(['f'])

describe('chatSection', () => {
    test('treats orphaned folder ids as unfiled', () => {
        expect(chatSection(chat('a', 'f'), folders)).toBe('f')
        expect(chatSection(chat('a', 'gone'), folders)).toBeNull()
        expect(chatSection({ id: 'a' }, folders)).toBeNull()
    })
})

describe('shiftSelectedChats', () => {
    test('moves a selected block up by one inside its section', () => {
        const list = [chat('a'), chat('b'), chat('c'), chat('d')]
        expect(ids(shiftSelectedChats(list, new Set(['b', 'c']), -1, folders))).toBe('b,c,a,d')
        expect(ids(shiftSelectedChats(list, new Set(['b', 'c']), 1, folders))).toBe('a,d,b,c')
    })

    test('stops at the section edge and leaves other sections in their slots', () => {
        const list = [chat('x', 'f'), chat('a'), chat('y', 'f'), chat('b')]
        const up = shiftSelectedChats(list, new Set(['y', 'a']), -1, folders)
        // y swaps with x in the folder slots; a is already first among unfiled chats.
        expect(ids(up)).toBe('y,a,x,b')
        const down = shiftSelectedChats(list, new Set(['b']), 1, folders)
        expect(ids(down)).toBe('x,a,y,b')
    })

    test('keeps non-adjacent selections apart', () => {
        const list = [chat('a'), chat('s1'), chat('b'), chat('s2')]
        expect(ids(shiftSelectedChats(list, new Set(['s1', 's2']), -1, folders))).toBe('s1,a,s2,b')
    })
})

describe('gatherSelectionAfterDrag', () => {
    test('brings the selection to the drop point in previous order and folder', () => {
        const a = chat('a'), b = chat('b'), c = chat('c', 'f'), d = chat('d')
        const previous = [a, b, c, d]
        // b was dragged into the folder, behind c.
        b.folderId = 'f'
        const afterDrop = [a, c, b, d]
        const result = gatherSelectionAfterDrag(afterDrop, previous, 'b', new Set(['a', 'b', 'd']))
        expect(ids(result)).toBe('c,a,b,d')
        expect([a.folderId, b.folderId, d.folderId]).toEqual(['f', 'f', 'f'])
        expect(c.folderId).toBe('f')
    })

    test('does nothing when the dragged chat is not part of a multi selection', () => {
        const list = [chat('a'), chat('b')]
        expect(ids(gatherSelectionAfterDrag(list, list, 'a', new Set(['b'])))).toBe('a,b')
        expect(ids(gatherSelectionAfterDrag(list, list, 'a', new Set(['a'])))).toBe('a,b')
    })
})

describe('chatIdRange', () => {
    test('selects inclusively in either direction', () => {
        expect(chatIdRange(['a', 'b', 'c', 'd'], 'c', 'a')).toEqual(['a', 'b', 'c'])
        expect(chatIdRange(['a', 'b', 'c'], 'a', 'c')).toEqual(['a', 'b', 'c'])
        expect(chatIdRange(['a', 'b'], 'gone', 'b')).toEqual(['b'])
    })
})
