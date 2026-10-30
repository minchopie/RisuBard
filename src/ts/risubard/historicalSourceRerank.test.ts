import { describe, expect, test } from 'vitest'
import type { HistoricalSourceMatch } from './historicalSourceRecall'
import { buildSourceRerankInput, buildSourceRerankPool, parseSourceRerank, SOURCE_RERANK_POOL_LIMIT } from './historicalSourceRerank'

const match = (id: string, occurredAt = 1): HistoricalSourceMatch => ({
    messageId: id, role: 'assistant', content: `text ${id}`, score: 1, occurredAt,
})

describe('historical source rerank', () => {
    test('pool keeps the first copy of each message and stays bounded', () => {
        const pool = buildSourceRerankPool([match('a'), match('b')], [match('b'), match('c')],
            Array.from({ length: 30 }, (_, index) => match(`x${index}`)))
        expect(pool.slice(0, 3).map((item) => item.messageId)).toEqual(['a', 'b', 'c'])
        expect(pool).toHaveLength(SOURCE_RERANK_POOL_LIMIT)
    })

    test('input numbers each excerpt with its chat order', () => {
        expect(buildSourceRerankInput('언제였지?', [match('a', 7)])).toContain('[0] (order 7, assistant)\ntext a')
    })

    test('parse maps ids to messages in model order, dropping unknown and repeated ids', () => {
        const pool = [match('a'), match('b'), match('c'), match('d'), match('e')]
        expect(parseSourceRerank('```json\n{"order": [2, "0", 2, 9, -1]}\n```', pool)).toEqual(['c', 'a'])
        expect(parseSourceRerank('{"order": [0, 1, 2, 3, 4]}', pool)).toEqual(['a', 'b', 'c', 'd'])
    })

    test('unreadable or empty answers keep nothing', () => {
        const pool = [match('a')]
        expect(parseSourceRerank('', pool)).toEqual([])
        expect(parseSourceRerank('{"order": "0"}', pool)).toEqual([])
        expect(parseSourceRerank('{"order": []}', pool)).toEqual([])
    })
})
