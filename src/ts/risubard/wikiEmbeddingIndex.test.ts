import { describe, expect, it, vi } from 'vitest'
import { WikiEmbeddingIndex, buildWikiEmbeddingQueries } from './wikiEmbeddingIndex'
import { chunkWikiDocument } from './wikiEmbeddingChunks'

const chunk = (documentId: string, text: string, contentHash = 'hash') => ({
    documentId, text, contentHash, start: 0, end: text.length,
})
const page = (chunks = [chunk('betrayal', '비밀을 적에게 넘겼다.')]) =>
    async () => ({ revision: 'r1', chunks, nextOffset: null })
const cache = () => {
    const values = new Map<string, number[]>()
    return { read: async (key: string) => values.get(key), write: async (key: string, value: number[]) => { values.set(key, value) } }
}

describe('optional wiki embedding index', () => {
    it('optionally retains independent passages for one document', async () => {
        const index = new WikiEmbeddingIndex({ identity:'passages',embed:async texts=>texts.map(()=>[1,0]) },cache())
        await index.refresh(page([
            {...chunk('a','first evidence'),start:0,end:14},
            {...chunk('a','second evidence'),start:100,end:115},
            {...chunk('b','other evidence'),start:0,end:14},
        ]))
        const result = await index.search('question','',2000,{ maximumDocuments:32,maximumPassagesPerDocument:3 })
        expect(result.matches.filter(match=>match.documentId==='a').map(match=>match.start).sort((x,y)=>x-y)).toEqual([0,100])
    })
    it('reads cached vectors with one batched call per catalog page', async () => {
        const chunks = Array.from({ length: 40 }, (_, i) => chunk(`doc-${i}`, `passage ${i}`))
        const stored = new Map(chunks.slice(0, 30).map(item => [
            JSON.stringify(['wiki-vector-v1', 'batched', item.documentId, item.text]), [1, 0],
        ]))
        const read = vi.fn(async (key: string) => stored.get(key))
        const readMany = vi.fn(async (keys: readonly string[]) => keys.map(key => stored.get(key)))
        const embed = vi.fn(async (texts: string[]) => texts.map(() => [0, 1]))
        const index = new WikiEmbeddingIndex({ identity: 'batched', embed },
            { read, readMany, write: async () => undefined })
        await index.refresh(page(chunks))
        expect(readMany).toHaveBeenCalledTimes(1)
        expect(read).not.toHaveBeenCalled()
        const writeMany = vi.fn(async (_entries: readonly { key: string; vector: number[] }[]) => undefined)
        const write = vi.fn(async () => undefined)
        const writer = new WikiEmbeddingIndex({ identity: 'batched-write',
            embed: async (texts: string[]) => texts.map(() => [0, 1]) },
            { read: async () => undefined, write, writeMany })
        await writer.refresh(page(chunks.slice(0, 20)))
        expect(writeMany.mock.calls.map(([entries]) => entries.length)).toEqual([16, 4])
        expect(write).not.toHaveBeenCalled()
        expect(embed.mock.calls.flatMap(([texts]) => texts)).toEqual(
            chunks.slice(30).map(item => item.text))
        expect(index.ready).toBe(true)
    })
    it('reuses pre-existing body embeddings after heading-only chunks are removed', async () => {
        const content = '## 기록\n\n### 약속\n\n역에 가겠다는 약속은 하지 않았다.'
        const storage = cache()
        const bodyText = '기록\n### 약속\n\n역에 가겠다는 약속은 하지 않았다.'
        await storage.write(JSON.stringify(['wiki-vector-v1', 'cached', 'record', bodyText]), [1, 0])
        const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))
        const index = new WikiEmbeddingIndex({ identity: 'cached', embed }, storage)
        await index.refresh(page(chunkWikiDocument({ id: 'record', title: '기록', contentHash: 'hash', content })))
        expect((await index.search('약속은?', '')).evidenceHints.record).toBe(bodyText)
        expect(embed.mock.calls).toEqual([[['약속은?'], 'query', expect.any(AbortSignal)]])
    })

    it('selects the strongest passage per document across pages with stable ties and the original cap', async () => {
        const chunks = Array.from({ length: 15 }, (_, i) => `doc-${String(i).padStart(2, '0')}`)
            .reverse().flatMap(documentId => [
                { ...chunk(documentId, 'late strongest'), start: 30, end: 44 },
                { ...chunk(documentId, 'early strongest'), start: 10, end: 25 },
                { ...chunk(documentId, 'weaker'), start: 0, end: 6 },
            ])
        chunks.push(chunk('unrelated', 'negative'))
        const index = new WikiEmbeddingIndex({ identity: 'scaled', embed: async (texts, purpose) => texts.map(text =>
            purpose === 'query' ? text.includes('Current request:') ? [0, 5] : [20, 0]
                : text === 'negative' ? [-5, -5] : text === 'weaker' ? [3, 4] : [8, 6]),
        }, cache())
        await index.refresh(async offset => ({ revision: 'r1', chunks: chunks.slice(offset, offset + 16),
            nextOffset: offset + 16 < chunks.length ? offset + 16 : null,
        }))
        for (const recent of ['', 'recent scene']) {
            const result = await index.search('question', recent)
            expect(result.matches.map(match => match.documentId)).toEqual([
                'doc-00', 'doc-01', 'doc-02', 'doc-03', 'doc-04', 'doc-05',
                'doc-06', 'doc-07', 'doc-08', 'doc-09', 'doc-10', 'doc-11',
            ])
            for (const match of result.matches) {
                expect(match.start).toBe(10)
                expect(match.score).toBeCloseTo(recent ? 0.71 : 0.8, 12)
            }
            expect(result.evidenceQuery).toBe('early strongest\nearly strongest\nearly strongest')
            expect(Object.values(result.evidenceHints)).toEqual(Array(12).fill('early strongest'))
        }
    })

    it('keeps both the absolute cutoff and the strongest-document relative cutoff', async () => {
        const vector = (score: number) => [score, Math.sqrt(1 - score ** 2)]
        const values: Record<string, number[]> = {
            strongest: vector(0.9), close: vector(0.8), distant: vector(0.7),
            aboveFloor: vector(0.41), belowFloor: vector(0.39),
        }
        const index = new WikiEmbeddingIndex({ identity: 'cutoff', embed: async (texts, purpose) =>
            texts.map(text => purpose === 'query' ? [1, 0] : values[text]),
        }, cache())
        await index.refresh(page(['strongest', 'close', 'distant'].map(id => chunk(id, id))))
        expect((await index.search('query', '')).matches.map(match => match.documentId))
            .toEqual(['strongest', 'close'])
        await index.refresh(page(['aboveFloor', 'belowFloor'].map(id => chunk(id, id))))
        expect((await index.search('query', '')).matches.map(match => match.documentId))
            .toEqual(['aboveFloor'])
        await index.refresh(page([chunk('belowFloor', 'belowFloor')]))
        expect((await index.search('query', '')).matches).toEqual([])
    })

    it('preserves source offsets and winning passage order when distinct IDs collate equally', async () => {
        const index = new WikiEmbeddingIndex({ identity: 'unicode', embed: async (texts, purpose) =>
            texts.map(text => purpose === 'query' || text !== 'weaker' ? [1, 0] : [4, 3]),
        }, cache())
        await index.refresh(page([
            { ...chunk('é', 'later'), start: 20, end: 25 },
            { ...chunk('e\u0301', 'earlier'), start: 0, end: 7 },
        ]))
        expect((await index.search('query', '')).matches.map(match => match.documentId))
            .toEqual(['e\u0301', 'é'])
        await index.refresh(page([
            { ...chunk('é', 'weaker'), start: 0, end: 6 },
            { ...chunk('e\u0301', 'first winner'), start: 10, end: 22 },
            { ...chunk('é', 'second winner'), start: 10, end: 23 },
        ]))
        expect((await index.search('query', '')).evidenceQuery).toBe('first winner\nsecond winner')
    })

    it('finds a paraphrased event without a shared keyword and returns its verified range', async () => {
        const embed = vi.fn(async (texts: string[], purpose: string) => texts.map(() => purpose === 'query' ? [0.98, 0.02] : [1, 0]))
        const index = new WikiEmbeddingIndex({ identity: 'local', embed }, cache())
        await index.refresh(page())
        const result = await index.search('배신당한 일', '')
        expect(result.matches[0]).toMatchObject({ documentId: 'betrayal', contentHash: 'hash', start: 0, end: 12 })
        expect(result.evidenceQuery).toContain('비밀을 적에게 넘겼다.')
    })

    it('uses recent context to distinguish two promises behind an implicit reference', async () => {
        const embed = async (texts: string[], purpose: string) => texts.map(text => purpose === 'document'
            ? text.includes('다리') ? [1, 0] : [0, 1]
            : text.includes('다리') ? [1, 0] : [0.7, 0.7])
        const index = new WikiEmbeddingIndex({ identity: 'local', embed }, cache())
        await index.refresh(page([chunk('bridge', '다리에서 재회하기로 맹세했다.'), chunk('shop', '상점에서 빚을 갚기로 했다.')]))
        expect((await index.search('그때 약속 기억해?', '우리는 무너진 다리에 도착했다.')).matches.map(x => x.documentId)).toEqual(['bridge'])
    })

    it('reuses unchanged vectors, embeds edits, and drops deleted documents', async () => {
        const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))
        const index = new WikiEmbeddingIndex({ identity: 'model-a', embed }, cache())
        await index.refresh(page([chunk('a', 'first'), chunk('b', 'second')]))
        await index.refresh(page([chunk('a', 'first')]))
        expect(embed).toHaveBeenCalledTimes(1)
        await index.refresh(page([chunk('a', 'edited', 'hash2')]))
        expect(embed).toHaveBeenCalledTimes(2)
        expect((await index.search('query', '')).matches).toEqual([expect.objectContaining({ documentId: 'a', contentHash: 'hash2' })])
    })

    it('never mixes vector spaces across provider identities', async () => {
        const storage = cache()
        const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))
        await new WikiEmbeddingIndex({ identity: 'model-a', embed }, storage).refresh(page())
        await new WikiEmbeddingIndex({ identity: 'model-b', embed }, storage).refresh(page())
        expect(embed).toHaveBeenCalledTimes(2)
    })

    it('reuses live document vectors when the disposable disk cache is unavailable', async () => {
        const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))
        const index = new WikiEmbeddingIndex({ identity: 'model-a', embed }, {
            read: async () => undefined,
            write: async () => { throw new Error('disk unavailable') },
        })
        await index.refresh(page([chunk('a', 'unchanged'), chunk('b', 'old')]))
        await index.refresh(page([chunk('a', 'unchanged', 'new-document-hash'), chunk('b', 'edited')]))
        expect(embed.mock.calls.map(([texts]) => texts)).toEqual([['unchanged', 'old'], ['edited']])
        await index.refresh(page([chunk('a', 'unchanged', 'new-document-hash')]))
        expect(embed).toHaveBeenCalledTimes(2)
        expect((await index.search('query', '')).matches).toEqual([
            expect.objectContaining({ documentId: 'a', contentHash: 'new-document-hash' }),
        ])
    })

    it('returns empty while unprepared and on provider failure or timeout', async () => {
        const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))
        const index = new WikiEmbeddingIndex({ identity: 'local', embed }, cache())
        expect((await index.search('query', '')).matches).toEqual([])
        expect(embed).not.toHaveBeenCalled()
        await index.refresh(page())
        embed.mockRejectedValueOnce(new Error('offline'))
        expect((await index.search('query', '')).matches).toEqual([])
        embed.mockImplementationOnce(() => new Promise(() => {}))
        expect((await index.search('query', '', 5)).matches).toEqual([])
    })

    it('rejects malformed vector batches and never publishes a partial revision', async () => {
        const index = new WikiEmbeddingIndex({ identity: 'local', embed: async () => [[NaN]] }, cache())
        await expect(index.refresh(page())).rejects.toThrow()
        expect(index.ready).toBe(false)
    })

    it('aborts obsolete background work before publishing', async () => {
        const index = new WikiEmbeddingIndex({ identity: 'local', embed: async texts => texts.map(() => [1, 0]) }, cache())
        await index.refresh(page(), () => false)
        expect(index.ready).toBe(false)
    })

    it('bounds contextual queries and retains the current request', () => {
        const queries = buildWikiEmbeddingQueries('지금 질문', '오래된 문맥'.repeat(3000))
        expect(queries).toHaveLength(2)
        expect(queries.every(text => text.length <= 4096)).toBe(true)
        expect(queries[1]).toContain('지금 질문')
    })
})
