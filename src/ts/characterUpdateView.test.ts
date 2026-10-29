import { describe, expect, test } from 'vitest'
import type { UpdateItem } from './characterUpdate'
import { editableText, editedValue, isEditable, loreFolderNames, updateGroupOf, updateSubgroupOf } from './characterUpdateView'

const item = (overrides: Partial<UpdateItem>): UpdateItem => ({
    id: 'x', field: 'desc', key: '', status: 'conflict', mine: undefined, theirs: undefined, base: undefined, baseKnown: false, choice: null, ...overrides,
})

describe('update review helpers', () => {
    test('text fields, lore bodies and regex output can be rewritten; other items cannot', () => {
        expect(isEditable(item({ mine: 'a', theirs: 'b' }))).toBe(true)
        const lore = item({ field: 'globalLore', key: 'k', mine: { comment: 'Town', content: 'mine' }, theirs: { comment: 'Town', content: 'new' } })
        expect(editableText(lore, 'mine')).toBe('mine')
        expect(editableText(lore, 'theirs')).toBe('new')
        expect(editedValue(lore, 'both')).toEqual({ comment: 'Town', content: 'both' })
        const regex = item({ field: 'customscript', key: 'k', mine: { comment: 'r', in: 'a', out: 'b', type: 'editoutput' } })
        expect(editedValue(regex, 'c')).toMatchObject({ in: 'a', out: 'c' })
        expect(isEditable(item({ field: 'emotionImages', key: 'k', mine: ['smile', 'assets/a.png'] }))).toBe(false)
    })

    test('an entry added by the author is edited from the new version', () => {
        const added = item({ field: 'globalLore', key: 'k', status: 'added', theirs: { comment: 'Port', content: 'harbor' } })
        expect(editableText(added, 'mine')).toBe('harbor')
    })

    test('groups lore entries by folder and assets by kind', () => {
        const folders = loreFolderNames([{ mode: 'folder', key: 'f1', comment: 'Characters' }])
        const labels = { emotionImages: 'Emotion image' }
        const inFolder = item({ field: 'globalLore', key: 'k', mine: { comment: 'Aria', folder: 'f1' } })
        expect(updateGroupOf(inFolder)).toBe('lore')
        expect(updateSubgroupOf(inFolder, folders, labels)).toEqual({ id: 'folder:f1', label: 'Characters' })
        expect(updateSubgroupOf(item({ field: 'globalLore', key: 'k', mine: { comment: 'Loose' } }), folders, labels).id).toBe('root')
        expect(updateSubgroupOf(item({ field: 'emotionImages', key: 'smile' }), folders, labels)).toEqual({ id: 'emotionImages', label: 'Emotion image' })
        expect(updateGroupOf(item({ field: 'backgroundHTML' }))).toBe('other')
    })
})
