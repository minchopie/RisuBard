import { oocTurnIndices } from './oocTurns'
import { chunkWikiDocument, type WikiEmbeddingChunk } from './wikiEmbeddingChunks'
import { WikiEmbeddingIndex, type WikiVectorCache, type WikiVectorProvider } from './wikiEmbeddingIndex'
import { eligibleHistoricalSources, resolveHistoricalSourceMatchesById, type HistoricalSourceMatch, type HistoricalSourceMessage } from './historicalSourceRecall'

export interface HistoricalSearchOptions {
    ignoreOocTurns?: boolean
    excludeRecentMessages?: number
    maximumMatches: number
    /** How long to wait for the shared query embedding. */
    timeoutMs?: number
}

/** Query vectors are shared only in memory, never persisted with credentials. */
export function shareQueryEmbeddings(provider: WikiVectorProvider): WikiVectorProvider {
    const cache = new Map<string, { expires: number; vectors: number[][] }>()
    return { identity: provider.identity, async embed(texts, purpose, signal) {
        if (signal?.aborted) throw new Error('Embedding aborted')
        if (purpose !== 'query') return provider.embed(texts, purpose, signal)
        const key = JSON.stringify(texts)
        const found = cache.get(key)
        if (found && found.expires > Date.now()) return found.vectors
        const vectors = await provider.embed(texts, purpose, signal)
        if (!signal?.aborted) {
            if (cache.size >= 8) cache.delete(cache.keys().next().value!)
            cache.set(key, { expires: Date.now() + 30_000, vectors })
        }
        return vectors
    } }
}

export class HistoricalSourceEmbeddingIndex {
    private index: WikiEmbeddingIndex
    private snapshots = new Map<string, { data: string; role: unknown; chunks: WikiEmbeddingChunk[] }>()
    private generation = 0
    private disposed = false
    private pending: Promise<void> = Promise.resolve()

    constructor(provider: WikiVectorProvider, cache: WikiVectorCache) {
        this.index = new WikiEmbeddingIndex(provider, cache)
    }
    dispose(): void { this.disposed = true; this.generation++; this.index.dispose() }

    refresh(messages: readonly HistoricalSourceMessage[], ignoreOocTurns = true): Promise<void> {
        const generation = ++this.generation
        const excluded = oocTurnIndices(messages, ignoreOocTurns)
        const boundary = messages.findLastIndex(message => message.disabled === 'allBefore')
        const snapshots = new Map<string, { data: string; role: unknown; chunks: WikiEmbeddingChunk[] }>()
        messages.forEach((message, i) => {
            if (i <= boundary || excluded.has(i) || message.disabled || message.isComment
                || !['user', 'char'].includes(message.role as string) || typeof message.data !== 'string'
                || typeof message.chatId !== 'string' || !message.chatId.trim()) return
            const old = this.snapshots.get(message.chatId)
            snapshots.set(message.chatId, old?.data === message.data && old.role === message.role ? old : {
                data: message.data, role: message.role,
                chunks: chunkWikiDocument({id:message.chatId, title:message.role === 'user' ? 'User source' : 'Assistant source',
                    contentHash:String(generation), content:message.data}),
            })
        })
        const active = () => !this.disposed && generation === this.generation
        this.pending = this.pending.catch(() => {}).then(async () => {
            if (!active()) return
            if (snapshots.size === this.snapshots.size && [...snapshots].every(([id, value]) => {
                const old = this.snapshots.get(id)
                return old?.data === value.data && old.role === value.role
            })) return
            // Unchanged vectors are reused by the rebuildable cache.
            const chunks = [...snapshots.values()].flatMap(value => value.chunks)
            await this.index.refresh(async offset => ({revision:String(generation),chunks:chunks.slice(offset, offset + 256),
                nextOffset:offset + 256 < chunks.length ? offset + 256 : null}), active)
            if (active()) this.snapshots = snapshots
        })
        return this.pending
    }

    async search(current: string, recent: string, messages: readonly HistoricalSourceMessage[], options: HistoricalSearchOptions): Promise<HistoricalSourceMatch[]> {
        if (this.disposed || options.maximumMatches <= 0) return []
        const snapshots = this.snapshots
        const allowedDocumentIds = new Set(eligibleHistoricalSources(messages, options.ignoreOocTurns, options.excludeRecentMessages)
            .filter(({message}) => snapshots.get(message.chatId as string)?.data === message.data)
            .map(({message}) => message.chatId as string))
        const result = await this.index.search(current, recent, options.timeoutMs ?? 2000, {maximumDocuments:32, allowedDocumentIds})
        if (this.disposed || snapshots !== this.snapshots) return []
        const eligible = resolveHistoricalSourceMatchesById({ ...options, messages,
            messageIds:result.matches.map(match => match.documentId) })
        const currentById = new Map(messages.map(message => [message.chatId, message]))
        const matches = new Map(result.matches.map(match => [match.documentId, match]))
        return eligible.flatMap(source => {
            const old = snapshots.get(source.messageId)
            const now = currentById.get(source.messageId)
            const match = matches.get(source.messageId)
            if (!old || old.data !== now?.data || old.role !== now.role || match?.start === undefined || match.end === undefined) return []
            return [{ ...source, content:old.data.slice(match.start, match.end), score:match.score, retrieval:'semantic' as const }]
        }).slice(0, Math.min(32, options.maximumMatches))
    }
}

export function mergeHistoricalSourceMatches(lexical: readonly HistoricalSourceMatch[], semantic: readonly HistoricalSourceMatch[], maximum: number): HistoricalSourceMatch[] {
    // Rank fusion sets the order. A source both searches found keeps the lexical
    // excerpt and score: the excerpt is centred on the asked words, and the score is
    // what qualifies a strong lexical match without a routing event.
    const ranks = new Map<string, { source: HistoricalSourceMatch; score: number }>()
    for (const list of [lexical, semantic]) list.forEach((source, index) => {
        const old = ranks.get(source.messageId)
        ranks.set(source.messageId, {source:old?.source ?? source, score:(old?.score ?? 0) + 1 / (60 + index + 1)})
    })
    return [...ranks.values()].sort((a,b) => b.score - a.score).slice(0, Math.max(0, Math.min(32, maximum)))
        .map(({source}) => source)
}
