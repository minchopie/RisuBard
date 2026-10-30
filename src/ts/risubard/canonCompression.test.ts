import { beforeEach, describe, expect, test, vi } from 'vitest'

const bodies = vi.hoisted(() => ({ documents: [] as Array<Record<string, unknown>> }))
vi.mock('./memoryWiki', () => ({
    loadWikiDocumentBodies: vi.fn(async (input: { documentIds: readonly string[] }) =>
        bodies.documents.filter((document) => input.documentIds.includes(document.id as string))),
}))

import { applyCanonCompression, canCompressCanonDocument, previewCanonCompression } from './canonCompression'

const knowledge = Array.from({ length: 12 }, (_, index) => `- 미드나이트가 규칙 ${index + 1}번을 알려 주었다. (#${index + 1})`)
const card = ['## 키스케', '', '### 지식과 비밀', '', ...knowledge].join('\n')

beforeEach(() => {
    bodies.documents = [{
        id: 'character.kisuke', type: 'character', title: '키스케', aliases: ['키스'], contentHash: 'h1',
        content: card, sourceMessageIds: ['m1'], status: 'active',
    }]
})

const scope = { characterId: 'c', chatId: 'chat', fetchImpl: fetch, createAuth: async () => 'auth', policy: '' }

describe('canon compression', () => {
    test('previews a compressed card without saving, and says why when nothing shrinks', async () => {
        const prompts: string[] = []
        const shrink = await previewCanonCompression({
            ...scope, targetIds: ['character.kisuke'], catalog: [],
            request: async (prompt) => {
                prompts.push(prompt.system)
                return JSON.stringify({
                    sections: [{ role: 'knowledge', units: ['- 미드나이트가 규칙 열두 가지를 알려 주었다. (#12)'.slice(2)] }],
                    dispositions: knowledge.map((_, old) => ({ role: 'knowledge', old, action: 'merged', newIndex: 0,
                        moveTo: null, movedText: null, documentId: null })),
                })
            },
        })
        expect(shrink).toHaveLength(1)
        expect(shrink[0]).toMatchObject({ documentId: 'character.kisuke', outcome: 'ready', contentHash: 'h1', aliases: ['키스'] })
        expect(shrink[0].charsAfter!).toBeLessThan(shrink[0].charsBefore)
        expect(shrink[0].markdown).toContain('규칙 열두 가지')
        expect(prompts[0]).toContain('compressed now')

        const keep = await previewCanonCompression({
            ...scope, targetIds: ['character.kisuke'], catalog: [],
            request: async () => JSON.stringify({
                sections: [{ role: 'knowledge', units: knowledge.map((unit) => unit.slice(2)) }],
                dispositions: knowledge.map((_, old) => ({ role: 'knowledge', old, action: 'kept', newIndex: old,
                    moveTo: null, movedText: null, documentId: null })),
            }),
        })
        expect(keep[0]).toMatchObject({ outcome: 'unchanged' })
        expect(keep[0].note).toContain('줄일 항목')
    })

    test('reports a failed page without stopping the run', async () => {
        const result = await previewCanonCompression({
            ...scope, targetIds: ['character.kisuke'], catalog: [],
            request: async () => { throw new Error('network') },
        })
        expect(result[0].outcome).toBe('error')
    })

    test('applies only ready previews, opens one undo point, and skips changed pages', async () => {
        const save = vi.fn(async (preview: { documentId: string }) => {
            if (preview.documentId === 'b') throw new Error('Wiki document changed since the draft was created')
        })
        const beforeApply = vi.fn(async () => undefined)
        const base = { title: 't', type: 'character' as const, aliases: [], contentHash: 'h', charsBefore: 10 }
        const result = await applyCanonCompression({
            previews: [
                { ...base, documentId: 'a', outcome: 'ready', note: '', markdown: '## a' },
                { ...base, documentId: 'b', title: 'B', outcome: 'ready', note: '', markdown: '## b' },
                { ...base, documentId: 'c', outcome: 'unchanged', note: '' },
            ],
            beforeApply, save,
        })
        expect(beforeApply).toHaveBeenCalledTimes(1)
        expect(save).toHaveBeenCalledTimes(2)
        expect(result.applied).toEqual(['a'])
        expect(result.failed).toEqual([{ title: 'B', reason: '미리보기 이후 문서가 바뀌어 적용하지 않았습니다.' }])
        const none = await applyCanonCompression({ previews: [], beforeApply, save })
        expect(none).toEqual({ applied: [], failed: [] })
        expect(beforeApply).toHaveBeenCalledTimes(1)
    })

    test('limits manual compression to live canon pages', () => {
        expect(canCompressCanonDocument({ type: 'character' })).toBe(true)
        expect(canCompressCanonDocument({ type: 'location', status: 'active' })).toBe(true)
        expect(canCompressCanonDocument({ type: 'event' })).toBe(false)
        expect(canCompressCanonDocument({ type: 'scene' })).toBe(false)
        expect(canCompressCanonDocument({ type: 'character', status: 'retracted' })).toBe(false)
    })
})
