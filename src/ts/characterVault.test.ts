import { describe, expect, test } from 'vitest'
import type { Database, character, folder } from './storage/database.svelte'
import {
    applyCharacterVaultClones,
    buildCharacterVaultSections,
    clearCharacterVaultNew,
    createCharacterVaultFolder,
    createCharacterVaultClones,
    deleteCharacterVaultFolder,
    getCharacterVaultQuickAccess,
    isCharacterVaultNew,
    moveCharacterVaultSidebarCharacter,
    moveCharactersToVaultFolder,
    pinCharacterVaultQuickAccess,
    reorderCharacterVaultSidebarShortcuts,
    setCharacterVaultQuickAccess,
    sortCharacterVaultCharacters,
    trashCharacterVaultCharacters,
    toggleCharacterVaultQuickAccess,
} from './characterVault'

function makeDb(): Database {
    return {
        characters: [
            { chaId: 'a', name: 'Alice' },
            { chaId: 'b', name: 'Bryn' },
            { chaId: 'c', name: 'Cato' },
        ],
        characterOrder: [
            'a',
            {
                id: 'folder-1',
                name: 'Cast',
                color: 'blue',
                data: ['b'],
            },
            'c',
        ],
    } as Database
}

function getFolder(db: Database, id: string): folder {
    const result = db.characterOrder.find((entry): entry is folder =>
        typeof entry !== 'string' && entry.id === id
    )
    if (!result) throw new Error(`Folder ${id} not found`)
    return result
}

describe('Character Vault state', () => {
    test('uses canonical top-level order as the legacy quick inventory', () => {
        expect(getCharacterVaultQuickAccess(makeDb())).toEqual([
            { kind: 'character', id: 'a' },
            { kind: 'folder', id: 'folder-1' },
            { kind: 'character', id: 'c' },
        ])
    })

    test('prunes stale and duplicate explicit quick shortcuts', () => {
        const db = makeDb()
        db.characterVault = {
            quickAccess: [
                { kind: 'character', id: 'a' },
                { kind: 'character', id: 'missing' },
                { kind: 'character', id: 'a' },
                { kind: 'folder', id: 'folder-1' },
            ],
        }

        expect(getCharacterVaultQuickAccess(db)).toEqual([
            { kind: 'character', id: 'a' },
            { kind: 'folder', id: 'folder-1' },
        ])
    })

    test('excludes trashed characters from legacy and explicit quick access', () => {
        const db = makeDb()
        db.characters[0].trashTime = Date.now()
        db.characterVault = {
            quickAccess: [
                { kind: 'character', id: 'a' },
                { kind: 'character', id: 'c' },
            ],
        }

        expect(getCharacterVaultQuickAccess(db)).toEqual([
            { kind: 'character', id: 'c' },
        ])
    })

    test('persists an explicit quick inventory and toggles entries', () => {
        const db = makeDb()
        setCharacterVaultQuickAccess(db, [{ kind: 'character', id: 'a' }])
        toggleCharacterVaultQuickAccess(db, { kind: 'folder', id: 'folder-1' })
        toggleCharacterVaultQuickAccess(db, { kind: 'character', id: 'a' })

        expect(db.characterVault?.quickAccess).toEqual([
            { kind: 'folder', id: 'folder-1' },
        ])
    })

    test('pins a newly imported character last and marks it new until accessed', () => {
        const db = makeDb()
        setCharacterVaultQuickAccess(db, [
            { kind: 'folder', id: 'folder-1' },
            { kind: 'character', id: 'a' },
        ])

        pinCharacterVaultQuickAccess(db, 'c')
        pinCharacterVaultQuickAccess(db, 'c')

        expect(db.characterVault?.quickAccess).toEqual([
            { kind: 'folder', id: 'folder-1' },
            { kind: 'character', id: 'a' },
            { kind: 'character', id: 'c' },
        ])
        expect(isCharacterVaultNew(db, 'c')).toBe(true)

        clearCharacterVaultNew(db, 'c')
        expect(isCharacterVaultNew(db, 'c')).toBe(false)
    })

    test('reorders root quick inventory shortcuts without changing vault membership', () => {
        const db = makeDb()
        const originalOrder = structuredClone(db.characterOrder)
        setCharacterVaultQuickAccess(db, [
            { kind: 'character', id: 'a' },
            { kind: 'folder', id: 'folder-1' },
            { kind: 'character', id: 'c' },
        ])

        reorderCharacterVaultSidebarShortcuts(
            db,
            { kind: 'character', id: 'a' },
            3
        )

        expect(db.characterVault?.quickAccess).toEqual([
            { kind: 'folder', id: 'folder-1' },
            { kind: 'character', id: 'c' },
            { kind: 'character', id: 'a' },
        ])
        expect(db.characterOrder).toEqual(originalOrder)
    })

    test('moves a pinned root character into a sidebar folder without a duplicate shortcut', () => {
        const db = makeDb()
        setCharacterVaultQuickAccess(db, [
            { kind: 'character', id: 'a' },
            { kind: 'folder', id: 'folder-1' },
            { kind: 'character', id: 'c' },
        ])

        moveCharacterVaultSidebarCharacter(db, 'a', 'folder-1', 0)

        expect(getFolder(db, 'folder-1').data).toEqual(['a', 'b'])
        expect(db.characterVault?.quickAccess).toEqual([
            { kind: 'folder', id: 'folder-1' },
            { kind: 'character', id: 'c' },
        ])
    })

    test('moves a sidebar folder character out as a pinned root shortcut', () => {
        const db = makeDb()
        setCharacterVaultQuickAccess(db, [
            { kind: 'character', id: 'a' },
            { kind: 'folder', id: 'folder-1' },
            { kind: 'character', id: 'c' },
        ])

        moveCharacterVaultSidebarCharacter(db, 'b', null, 1)

        expect(getFolder(db, 'folder-1').data).toEqual([])
        expect(db.characterVault?.quickAccess).toEqual([
            { kind: 'character', id: 'a' },
            { kind: 'character', id: 'b' },
            { kind: 'folder', id: 'folder-1' },
            { kind: 'character', id: 'c' },
        ])
    })

    test('reorders characters inside a pinned sidebar folder', () => {
        const db = makeDb()
        getFolder(db, 'folder-1').data = ['a', 'b', 'c']
        db.characterOrder = [getFolder(db, 'folder-1')]

        moveCharacterVaultSidebarCharacter(db, 'a', 'folder-1', 3)

        expect(getFolder(db, 'folder-1').data).toEqual(['b', 'c', 'a'])
    })

    test('moves selected characters into one folder without duplicates', () => {
        const db = makeDb()
        moveCharactersToVaultFolder(db, ['a', 'b'], 'folder-1')

        expect(getFolder(db, 'folder-1').data).toEqual(['b', 'a'])
        expect(db.characterOrder).toEqual([
            expect.objectContaining({ id: 'folder-1' }),
            'c',
        ])
    })

    test('deduplicates damaged legacy membership without dropping its folder', () => {
        const db = makeDb()
        db.characterOrder.splice(1, 0, {
            id: 'legacy-duplicate',
            name: 'Legacy',
            color: 'default',
            data: ['a'],
        })

        moveCharactersToVaultFolder(db, ['a'], 'folder-1')

        expect(getFolder(db, 'folder-1').data).toEqual(['b', 'a'])
        expect(getFolder(db, 'legacy-duplicate').data).toEqual([])
    })

    test('moves selected characters out as unfiled entries', () => {
        const db = makeDb()
        moveCharactersToVaultFolder(db, ['b'], null)

        expect(db.characterOrder).toEqual([
            'a',
            expect.objectContaining({ id: 'folder-1', data: [] }),
            'b',
            'c',
        ])
    })

    test('deleting a folder preserves its characters as unfiled entries', () => {
        const db = makeDb()
        setCharacterVaultQuickAccess(db, [
            { kind: 'folder', id: 'folder-1' },
        ])
        deleteCharacterVaultFolder(db, 'folder-1')

        expect(db.characterOrder).toEqual(['a', 'b', 'c'])
        expect(db.characterVault?.quickAccess).toEqual([])
    })

    test('deleting a folder does not duplicate already unfiled characters', () => {
        const db = makeDb()
        getFolder(db, 'folder-1').data.unshift('a')

        deleteCharacterVaultFolder(db, 'folder-1')

        expect(db.characterOrder).toEqual(['a', 'b', 'c'])
    })

    test('creates and preserves an empty named folder', () => {
        const db = makeDb()
        const created = createCharacterVaultFolder(
            db, '  Supporting Cast  ', 'folder-empty'
        )

        expect(created).toEqual({
            id: 'folder-empty',
            name: 'Supporting Cast',
            color: 'default',
            data: [],
        })

        moveCharactersToVaultFolder(db, ['a'], 'folder-1')
        expect(getFolder(db, 'folder-empty').data).toEqual([])
    })

    test('permanently removes selected characters and preserves emptied folders', () => {
        const db = makeDb()
        setCharacterVaultQuickAccess(db, [
            { kind: 'character', id: 'a' },
            { kind: 'folder', id: 'folder-1' },
        ])

        expect(trashCharacterVaultCharacters(db, ['a', 'b'])).toBe(2)
        expect(db.characters.find((character) => character.chaId === 'a')).toBeUndefined()
        expect(db.characters.find((character) => character.chaId === 'b')).toBeUndefined()
        expect(db.characterOrder).toEqual([
            expect.objectContaining({ id: 'folder-1', data: [] }),
            'c',
        ])
        expect(db.characterVault?.quickAccess).toEqual([
            { kind: 'folder', id: 'folder-1' },
        ])
    })

    test.each([
        ['name', 'asc', ['b', 'c', 'a']],
        ['name', 'desc', ['a', 'c', 'b']],
        ['lastInteraction', 'asc', ['b', 'a', 'c']],
        ['lastInteraction', 'desc', ['c', 'a', 'b']],
        ['creationDate', 'asc', ['c', 'a', 'b']],
        ['creationDate', 'desc', ['b', 'a', 'c']],
    ] as const)('sorts characters by %s %s', (sortBy, direction, expected) => {
        const characters = [
            { chaId: 'a', name: 'Zulu', lastInteraction: 20, creation_date: 10 },
            { chaId: 'b', name: 'Alpha', lastInteraction: 10, creation_date: 30 },
            { chaId: 'c', name: 'Middle', lastInteraction: 30, creation_date: 5 },
        ]

        expect(sortCharacterVaultCharacters(characters, sortBy, direction)
            .map((character) => character.chaId)).toEqual(expected)
    })

    describe('buildCharacterVaultSections', () => {
        const folderOf = (id: string, data: string[]): folder => ({
            id, name: id, data, color: '', folder: true, imgFile: '', img: '',
        } as folder)
        const item = (chaId: string) => ({ chaId })
        const summary = (sections: ReturnType<typeof buildCharacterVaultSections<{ chaId: string }>>) =>
            sections.map((section) => [
                section.folder?.id ?? 'unfiled',
                section.items.map((entry) => entry.chaId),
            ])

        test('keeps sidebar order with unfiled runs between folders', () => {
            const order = ['a', 'b', folderOf('f1', ['c', 'd']), 'e', folderOf('f2', ['f'])]
            const items = ['f', 'e', 'd', 'c', 'b', 'a'].map(item)

            expect(summary(buildCharacterVaultSections(order, items, true))).toEqual([
                ['unfiled', ['a', 'b']],
                ['f1', ['c', 'd']],
                ['unfiled', ['e']],
                ['f2', ['f']],
            ])
        })

        test('shows empty folders only when asked and drops empty unfiled runs', () => {
            const order = [folderOf('empty', []), 'x', folderOf('f1', ['a'])]
            const items = [item('a')]

            expect(summary(buildCharacterVaultSections(order, items, true)))
                .toEqual([['empty', []], ['f1', ['a']]])
            expect(summary(buildCharacterVaultSections(order, items, false)))
                .toEqual([['f1', ['a']]])
        })

        test('skips repeats and appends items missing from the order', () => {
            const order = ['a', folderOf('f1', ['a', 'b'])]
            const items = ['a', 'b', 'orphan'].map(item)

            expect(summary(buildCharacterVaultSections(order, items, false))).toEqual([
                ['unfiled', ['a']],
                ['f1', ['b']],
                ['unfiled', ['orphan']],
            ])
        })
    })

    test('plans chat-inclusive clones with unique character and chat IDs', () => {
        const db = makeDb()
        db.characters[0] = {
            ...db.characters[0],
            chats: [{
                id: 'chat-a', name: 'Long chat', note: '', localLore: [],
                message: [{ role: 'char', data: 'hello', chatId: 'message-1' }],
            }],
            chatFolders: [],
            chatPage: 0,
        } as typeof db.characters[number]
        db.characters.push({ chaId: 'taken', name: 'Alice-2' } as typeof db.characters[number])
        const ids = ['clone-a', 'chat-copy']

        const [plan] = createCharacterVaultClones(db, ['a'], {
            withChats: true,
            createId: () => ids.shift()!,
            now: 500,
        })

        expect(plan.clone).toMatchObject({
            chaId: 'clone-a', name: 'Alice-3', creation_date: 500,
            chats: [{ id: 'chat-copy', name: 'Long chat' }],
        })
        expect(plan.clone.chats[0].message[0].chatId).toBe('message-1')
        expect(plan.chatForks).toEqual([{
            sourceChatId: 'chat-a', destinationChatId: 'chat-copy',
        }])
        expect(db.characters.map((character) => character.chaId))
            .not.toContain('clone-a')
    })

    test('treats case variants of clone names as occupied', () => {
        const db = makeDb()
        db.characters.push({ chaId: 'duplicate', name: 'alice-2' } as character)

        const [plan] = createCharacterVaultClones(db, ['a'], {
            withChats: false,
            createId: () => 'clone-a',
        })

        expect(plan.clone.name).toBe('Alice-3')
    })

    test('creates one empty chat when cloning without chats', () => {
        const db = makeDb()
        db.characters[0] = {
            ...db.characters[0],
            chats: [{
                id: 'chat-a', name: 'Long chat', note: 'private', localLore: [],
                message: [{ role: 'char', data: 'hello', chatId: 'message-1' }],
            }],
            chatFolders: [{ id: 'folder', folded: false }],
            chatPage: 0,
        } as typeof db.characters[number]
        const ids = ['clone-a', 'empty-chat']

        const [plan] = createCharacterVaultClones(db, ['a'], {
            withChats: false,
            createId: () => ids.shift()!,
            now: 500,
        })

        expect(plan.clone.chats).toEqual([expect.objectContaining({
            id: 'empty-chat', name: 'Chat 1', message: [], localLore: [],
        })])
        expect(plan.clone.chatFolders).toEqual([])
        expect(plan.clone.chatPage).toBe(0)
        expect(plan.chatForks).toEqual([])
    })

    test('inserts clones beside their sources in the same vault location', () => {
        const db = makeDb()
        const ids = ['clone-a', 'empty-a', 'clone-b', 'empty-b']
        const plans = createCharacterVaultClones(db, ['a', 'b'], {
            withChats: false,
            createId: () => ids.shift()!,
            now: 500,
        })

        applyCharacterVaultClones(db, plans)

        expect(db.characters.slice(-2).map((character) => character.chaId))
            .toEqual(['clone-a', 'clone-b'])
        expect(db.characterOrder).toEqual([
            'a', 'clone-a',
            expect.objectContaining({ id: 'folder-1', data: ['b', 'clone-b'] }),
            'c',
        ])
    })
})
