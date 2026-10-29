import { describe, expect, it } from 'vitest'
import { buildWikiFileTree, filterWikiDocumentsByType, getRecentlyUpdatedWikiDocumentIds, listWikiDocumentTypes, wikiDocumentTypeLabels, wikiFolderDisplayName } from './wikiFileTree'

describe('getRecentlyUpdatedWikiDocumentIds', () => {
    const page = (id: string, updated: string, type: 'character' | 'event' = 'character') => ({
        id, title: id, relativePath: `${id}.md`, type, updated,
    })

    it('marks all pages updated since the latest analysis event, even when writes finish separately', () => {
        expect([...getRecentlyUpdatedWikiDocumentIds([
            page('old', '2026-08-27T00:00:00Z'),
            page('event', '2026-08-27T01:00:00Z', 'event'),
            page('character', '2026-08-27T01:00:03Z'),
            page('scene', '2026-08-27T01:00:05Z'),
        ])]).toEqual(['event', 'character', 'scene'])
    })

    it('ignores retracted events and invalid timestamps, falling back to the latest saved pages', () => {
        expect([...getRecentlyUpdatedWikiDocumentIds([
            page('old', '2026-08-27T00:00:00Z'),
            page('first', '2026-08-27T01:00:00Z'),
            page('second', '2026-08-27T10:00:00+09:00'),
            page('invalid', 'now'),
            { ...page('undone', '2026-08-27T02:00:00Z', 'event'), status: 'retracted' },
        ])]).toEqual(['first', 'second'])
        expect(getRecentlyUpdatedWikiDocumentIds([]).size).toBe(0)
        expect(getRecentlyUpdatedWikiDocumentIds([page('invalid', '')]).size).toBe(0)
    })
})

describe('buildWikiFileTree', () => {
    it('keeps late repairs at their original chat position in the newest-first event folder', () => {
        const tree = buildWikiFileTree([
            { id: 'later', title: '다음 턴', type: 'event', relativePath: 'events/a.md',
                sourceMessageIds: ['a2'], created: '2026-01-02' },
            { id: 'repair', title: '과거 턴 재분석', type: 'event', relativePath: 'events/z.md',
                sourceMessageIds: ['a1'], created: '2026-09-30' },
            { id: 'unknown', title: '출처 없음', type: 'event', relativePath: 'events/b.md',
                sourceMessageIds: ['deleted'], created: '2026-10-01' },
        ], [{ chatId: 'a1', role: 'char' }, { chatId: 'a2', role: 'char' }])
        const events = tree.find(node => node.name === 'events')
        expect(events?.kind === 'folder' && events.children.map(node => node.kind === 'file' && node.documentId))
            .toEqual(['later', 'repair', 'unknown'])
    })

    it('shows the newest recorded event first regardless of hashed filename', () => {
        const tree = buildWikiFileTree([
            {
                id: 'event-new', title: '나중 사건',
                relativePath: 'events/turn-zzz.md', type: 'event',
                created: '2026-08-14T08:00:00.000Z',
            },
            {
                id: 'event-old', title: '이전 사건',
                relativePath: 'events/turn-aaa.md', type: 'event',
                created: '2026-08-14T07:00:00.000Z',
            },
        ])

        expect(tree.find((node) => node.name === 'events')).toEqual(
            expect.objectContaining({
                children: [
                    expect.objectContaining({ documentId: 'event-new' }),
                    expect.objectContaining({ documentId: 'event-old' }),
                ],
            })
        )
    })

    it('shows every standard wiki folder even when it has no documents', () => {
        const tree = buildWikiFileTree([])

        expect(tree.map((node) => node.name)).toEqual([
            'characters',
            'concepts',
            'events',
            'factions',
            'items',
            'locations',
            'notes',
        ])
        expect(tree.every((node) =>
            node.kind === 'folder' && node.children.length === 0
        )).toBe(true)
        expect(tree.find((node) => node.name === 'events')).toEqual(
            expect.objectContaining({ readOnly: false })
        )
    })

    it('groups editable event documents under the events folder', () => {
        const tree = buildWikiFileTree([
            { id: 'scene', title: '현재 장면', relativePath: 'current-scene.md', type: 'scene' },
            { id: 'character', title: '라비안', relativePath: 'characters/라비안.md', type: 'character' },
            { id: 'event', title: '전투', relativePath: 'events/turn-1.md', type: 'event' },
        ])

        expect(tree.map((node) => node.name)).toEqual([
            'current-scene.md',
            'characters',
            'concepts',
            'events',
            'factions',
            'items',
            'locations',
            'notes',
        ])
        expect(tree.find((node) => node.name === 'events')).toEqual(
            expect.objectContaining({
                kind: 'folder',
                readOnly: false,
                children: [expect.objectContaining({
                    documentId: 'event',
                    readOnly: false,
                })],
            })
        )
    })

    it('omits legacy retracted events from the file tree', () => {
        const tree = buildWikiFileTree([{
            id: 'event-retracted',
            title: '잘못된 첫 만남',
            relativePath: 'events/turn-retracted.md',
            type: 'event',
            status: 'retracted',
        }])

        expect(tree.find((node) => node.name === 'events')).toEqual(
            expect.objectContaining({
                kind: 'folder',
                readOnly: false,
                children: [],
            })
        )
    })
})

describe('wiki tree filters and sorting', () => {
    const docs = [
        { id: 'b', title: '베타', relativePath: 'characters/b.md', type: 'character' as const, updated: '2026-01-01T00:00:00Z' },
        { id: 'a', title: '알파', relativePath: 'characters/a.md', type: 'character' as const, updated: '2026-03-01T00:00:00Z' },
        { id: 'loc', title: '성문', relativePath: 'locations/gate.md', type: 'location' as const, updated: '2026-02-01T00:00:00Z' },
        { id: 'e1', title: '사건1', relativePath: 'events/e1.md', type: 'event' as const, created: '2026-01-01', updated: '2026-01-01T00:00:00Z' },
        { id: 'e2', title: '사건2', relativePath: 'events/e2.md', type: 'event' as const, created: '2026-01-02', updated: '2026-05-01T00:00:00Z' },
    ]
    const ids = (tree: ReturnType<typeof buildWikiFileTree>, folder: string) => {
        const node = tree.find((item) => item.name === folder)
        return node?.kind === 'folder' ? node.children.map((child) => child.kind === 'file' && child.documentId) : []
    }

    it('lists present document types in a stable order and filters by type', () => {
        expect(listWikiDocumentTypes(docs)).toEqual(['character', 'location', 'event'])
        expect(filterWikiDocumentsByType(docs, 'location').map((doc) => doc.id)).toEqual(['loc'])
        expect(filterWikiDocumentsByType(docs, null)).toHaveLength(5)
    })

    it('sorts folder children by name or by most recent update', () => {
        expect(ids(buildWikiFileTree(docs), 'characters')).toEqual(['a', 'b'])
        expect(ids(buildWikiFileTree(docs, undefined, { sort: 'updated' }), 'characters')).toEqual(['a', 'b'])
        const byName = [{ ...docs[0], relativePath: 'characters/a.md' }, { ...docs[1], relativePath: 'characters/b.md' }]
        expect(ids(buildWikiFileTree(byName), 'characters')).toEqual(['b', 'a'])
        expect(ids(buildWikiFileTree(byName, undefined, { sort: 'updated' }), 'characters')).toEqual(['a', 'b'])
        expect(ids(buildWikiFileTree(docs, undefined, { sort: 'updated' }), 'events')).toEqual(['e2', 'e1'])
    })

    it('maps folder keys to Korean display names without changing paths', () => {
        expect(['characters', 'concepts', 'events', 'factions', 'items', 'locations', 'notes', 'creatures', 'custom']
            .map(wikiFolderDisplayName))
            .toEqual(['인물', '개념', '사건', '세력', '사물', '장소', '메모', '종족과 생물', 'custom'])
        expect(buildWikiFileTree(docs).find((node) => node.name === 'characters')?.path).toBe('characters')
        expect(wikiDocumentTypeLabels.creature).toBe('종족과 생물')
    })
})
