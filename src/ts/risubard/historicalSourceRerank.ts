import type { HistoricalSourceMatch } from './historicalSourceRecall'

/** Candidates shown to the reranking model; their excerpts are at most 1,200 characters each. */
export const SOURCE_RERANK_POOL_LIMIT = 16
/** Originals the reranking model may keep; the inquiry gives them room before pages. */
export const SOURCE_RERANK_PICK_LIMIT = 4

export const SOURCE_RERANK_SYSTEM_PROMPT = 'You choose chat excerpts for answering a question about the past of a roleplay. '
    + 'Rank only excerpts that explicitly state a fact the question asks for (a number, name, object, quote, reason, or which event came first). '
    + 'An excerpt on a similar topic that does not state the asked fact is useless; leave it out. '
    + 'If the question names two moments, rank an excerpt stating each moment at the top. '
    + `Reply JSON {"order": [ids]} with at most ${SOURCE_RERANK_PICK_LIMIT} ids, or {"order": []} when no excerpt states an asked fact.`

export const SOURCE_RERANK_SCHEMA = JSON.stringify({
    type: 'object',
    properties: { order: { type: 'array', items: { type: 'integer' }, maxItems: SOURCE_RERANK_PICK_LIMIT } },
    required: ['order'],
    additionalProperties: false,
})

/** Search results first, then the originals selected events asked for, without repeats. */
export function buildSourceRerankPool(...lists: readonly (readonly HistoricalSourceMatch[])[]): HistoricalSourceMatch[] {
    const seen = new Set<string>()
    return lists.flat().filter((match) => {
        if (seen.has(match.messageId)) return false
        seen.add(match.messageId)
        return true
    }).slice(0, SOURCE_RERANK_POOL_LIMIT)
}

export function buildSourceRerankInput(question: string, pool: readonly HistoricalSourceMatch[]): string {
    const listing = pool.map((match, index) =>
        `[${index}] (order ${match.occurredAt}, ${match.role})\n${match.content}`).join('\n\n')
    return `Question: ${question}\n\n${listing}\n\nReply only the JSON object.`
}

/** Message ids the model kept, in its order; anything unreadable keeps nothing. */
export function parseSourceRerank(text: string, pool: readonly HistoricalSourceMatch[]): string[] {
    let order: unknown
    try {
        order = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).order
    }
    catch {
        return []
    }
    if (!Array.isArray(order)) return []
    const ids: string[] = []
    for (const value of order) {
        const index = typeof value === 'string' ? Number(value) : value
        const match = Number.isSafeInteger(index) ? pool[index as number] : undefined
        if (match && !ids.includes(match.messageId)) ids.push(match.messageId)
        if (ids.length >= SOURCE_RERANK_PICK_LIMIT) break
    }
    return ids
}
