import { describe, expect, test, vi } from 'vitest'
import { WikiEmbeddingIndex } from '../../src/ts/risubard/wikiEmbeddingIndex'
import { chunkWikiDocument } from '../../src/ts/risubard/wikiEmbeddingChunks'
import { loadNarrativeInquiry } from '../../src/ts/risubard/narrativeContext'
import { resolveHistoricalSourceMatchesById } from '../../src/ts/risubard/historicalSourceRecall'
import { inquireMarkdownDocuments } from './risubard-markdown-inquiry'
import type { MarkdownWikiDocument } from './risubard-markdown-wiki'

const document = (id: string, content: string, type: MarkdownWikiDocument['type'] = 'event'): MarkdownWikiDocument => ({
    id, content, type, title: id, status: 'active', aliases: [], links: [], sourceMessageIds: [`source-${id}`],
    contentHash: `hash-${id}`, contextMode: 'auto', relativePath: `notes/${id}.md`, updated: '2026-09-22',
})

// Deterministic vectors verify retrieval plumbing, not real model semantic quality.
async function indexDocuments(documents: MarkdownWikiDocument[]) {
    const index = new WikiEmbeddingIndex({ identity: 'deterministic-test',
        embed: async (texts, purpose) => texts.map(text => {
            if (purpose === 'query') return text.includes('bridge') || text.includes('betrayal') ? [1, 0] : [0.7, 0.7]
            return text.includes('enemy') || text.includes('bridge') ? [1, 0] : [0, 1]
        }),
    }, { read: async () => undefined, write: async () => {} })
    await index.refresh(async () => ({ revision: 'v1', chunks: documents.flatMap(chunkWikiDocument), nextOffset: null }))
    return index
}

describe('BardWiki semantic retrieval integration (deterministic vectors)', () => {
    test('returns actual evidence instead of a higher scoring bare title without extra embedding requests', async () => {
        const body = '츠구는 역에 가려던 길인지 물었고, 상대는 그렇다고 답하지 않았다.'
        const content = '## 기록\n\n### 대화\n\n' + body
        const embed = vi.fn(async (texts: string[], purpose: string) => texts.map(text =>
            purpose === 'query' || !text.includes(body) ? [1, 0] : [0.9, 0.1]))
        const index = new WikiEmbeddingIndex({ identity: 'evidence-test', embed }, {
            read: async () => undefined, write: async () => {},
        })
        await index.refresh(async () => ({ revision: 'v1', nextOffset: null,
            chunks: chunkWikiDocument({ id: 'record', title: '기록', contentHash: 'hash', content }),
        }))
        const result = await index.search('역에 가겠다고 했나?', '')
        expect(result.matches).toHaveLength(1)
        expect(content.slice(result.matches[0].start, result.matches[0].end)).toBe(body)
        expect(result.evidenceHints.record).toContain('그렇다고 답하지 않았다.')
        expect(embed.mock.calls).toEqual([
            [['기록\n### 대화\n\n' + body], 'document'],
            [['역에 가겠다고 했나?'], 'query'],
        ].map(([texts, purpose]) => [texts, purpose, expect.any(AbortSignal)]))
    })

    test('uses recent context for an implicit promise and retains lexical fallback without embeddings', async () => {
        const documents = [document('reunion', 'We promised to reunite at the bridge.'), document('payment', 'We promised to settle our debt at the store.')]
        const index = await indexDocuments(documents)
        const semantic = await index.search('Remember that promise?', 'We arrived at the bridge.')
        const result = inquireMarkdownDocuments({ documents, currentInput: 'Remember that promise?', semanticMatches: semantic.matches })
        expect(result.sources.some(source => source.content.includes('bridge'))).toBe(true)
        expect(semantic.matches[0].documentId).toBe('reunion')
        const lexical = inquireMarkdownDocuments({ documents, currentInput: 'reunion' })
        expect(lexical.sources.some(source => source.content.includes('bridge'))).toBe(true)
    })

    test('finds a paraphrased late passage and calls the original-source resolver within budget', async () => {
        const tail = 'The secret ledger was delivered to the enemy.'
        const documents = [document('archive', '## archive\n\n' + 'Weather notes. '.repeat(1600) + '\n\n' + tail)]
        const index = await indexDocuments(documents)
        const semantic = await index.search('betrayal', '')
        expect(semantic.matches[0].start).toBeGreaterThan(12000)
        const resolveSourceMatches = vi.fn((ids: readonly string[], requests: readonly { messageId: string; documentId?: string }[]) => resolveHistoricalSourceMatchesById({
            messageIds: ids, currentInput: 'archive betrayal', queryByMessageId: Object.fromEntries(requests.filter(request => request.documentId).map(request => [request.messageId, semantic.evidenceHints[request.documentId!]])), excludeRecentMessages: 1,
            messages: [{ role: 'char', chatId: 'source-archive', data: 'Archive discussed weather. ' + '평범한 날씨. '.repeat(2500) + tail + ' The courier wore a silver ring.' },
                { role: 'user', chatId: 'new-user', data: 'continue' }, { role: 'char', chatId: 'new-answer', data: 'Now.' }],
        }))
        const fetchImpl: typeof fetch = async (_url, init) => new Response(JSON.stringify(inquireMarkdownDocuments({
            ...JSON.parse(init!.body as string), documents,
        })), { status: 200, headers: { 'content-type': 'application/json' } })
        const result = await loadNarrativeInquiry({ characterId: 'char', chatId: 'chat', currentInput: 'betrayal',
            semanticMatches: semantic.matches, tokenBudget: { target: 1024, events: 512, perSource: 256, maximum: 1536 },
            fetchImpl, createAuth: async () => 'test', resolveSourceMatches,
        })
        expect(resolveSourceMatches).toHaveBeenCalledWith(['source-archive'], [{ messageId: 'source-archive', eventTitle: 'archive', documentId: 'archive' }])
        expect(result.sources.some(source => source.id.includes(':source:') && source.content.includes('silver ring'))).toBe(true)
        expect(result.sources.some(source => source.id.includes(':wiki:') && source.content.includes(tail))).toBe(true)
        expect(result.metrics.selectedTokens).toBeLessThanOrEqual(1536)
        const stale = inquireMarkdownDocuments({ documents: [{ ...documents[0], contentHash: 'edited' }], currentInput: 'betrayal', semanticMatches: semantic.matches })
        expect(stale.sources).toEqual([])
    })

    test('keeps current character state when the vector points to history', async () => {
        const documents = [document('Alice', '## Alice\n\n### Current State\nAlice lives in the southern village.\n\n### Story History\nAlice once lived with the enemy. ' + 'Past details. '.repeat(1800), 'character')]
        const index = await indexDocuments(documents)
        const semantic = await index.search('Where is Alice now?', 'betrayal')
        const result = inquireMarkdownDocuments({ documents, currentInput: 'Where is Alice now?', semanticMatches: semantic.matches,
            tokenBudget: { target: 512, events: 512, perSource: 256, maximum: 1024 } })
        expect(result.sources[0].content).toContain('southern village')
        expect(result.sources[0].content).not.toContain('once lived with the enemy')
    })
})
