import type { WikiEmbeddingCatalog, WikiEmbeddingChunk } from './wikiEmbeddingChunks'

export interface WikiSemanticMatch {
    documentId: string
    score: number
    contentHash?: string
    start?: number
    end?: number
}

export interface WikiVectorProvider {
    identity: string
    embed(texts: string[], purpose: 'document' | 'query', signal?: AbortSignal): Promise<number[][]>
}

export interface WikiVectorCache {
    read(key: string): Promise<number[] | undefined>
    /** Optional batched read; results align with `keys`. */
    readMany?(keys: readonly string[]): Promise<(number[] | undefined)[]>
    write(key: string, vector: number[]): Promise<void>
    /** Optional batched write, used for each embedding batch. */
    writeMany?(entries: readonly { key: string; vector: number[] }[]): Promise<void>
}

type IndexedChunk = { chunk: WikiEmbeddingChunk; vector: number[] }
const emptyResult = () => ({ matches: [] as WikiSemanticMatch[], evidenceQuery: '', evidenceHints: {} as Record<string, string> })

export function buildWikiEmbeddingQueries(current: string, recent: string): string[] {
    const query = current.trim().slice(0, 2048)
    if (!query) return []
    const context = recent.trim().slice(-Math.max(0, 4096 - query.length - 24))
    return context && context !== query
        ? [query, `${context}\nCurrent request: ${query}`]
        : [query]
}

function validVector(value: unknown): value is number[] {
    return Array.isArray(value) && value.length > 0
        && value.length <= 65_536 && value.every(Number.isFinite)
        && value.some(item => item !== 0)
}

function cosine(left: number[], right: number[]): number {
    if (left.length !== right.length) return -1
    let dot = 0, a = 0, b = 0
    for (let i = 0; i < left.length; i++) {
        dot += left[i] * right[i]
        a += left[i] ** 2
        b += right[i] ** 2
    }
    return dot / Math.sqrt(a * b)
}

export class WikiEmbeddingIndex {
    private entries: IndexedChunk[] = []
    private refreshPromise?: Promise<void>
    private controller = new AbortController()
    ready = false

    constructor(private provider: WikiVectorProvider, private cache: WikiVectorCache) {}

    dispose(): void { this.controller.abort() }

    refresh(
        loadPage: (offset: number, revision?: string) => Promise<WikiEmbeddingCatalog>,
        active: () => boolean = () => true,
    ): Promise<void> {
        if (this.refreshPromise) return this.refreshPromise
        this.refreshPromise = this.rebuild(loadPage, active).finally(() => {
            this.refreshPromise = undefined
        })
        return this.refreshPromise
    }

    private async readCached(keys: string[]): Promise<unknown[]> {
        if (this.cache.readMany) {
            try {
                const values = await this.cache.readMany(keys)
                if (values.length === keys.length) return values
            } catch { /* fall back to single reads */ }
        }
        return Promise.all(keys.map(async key => {
            try { return await this.cache.read(key) } catch { return undefined }
        }))
    }

    private async rebuild(
        loadPage: (offset: number, revision?: string) => Promise<WikiEmbeddingCatalog>,
        active: () => boolean,
    ): Promise<void> {
        const entries: IndexedChunk[] = []
        // The live index remains usable even when the disposable disk cache fails.
        const liveVectors = new Map(this.entries.map(({ chunk, vector }) => [
            JSON.stringify([chunk.documentId, chunk.text]), vector,
        ]))
        let offset = 0
        let revision: string | undefined
        let dimensions: number | undefined
        do {
            if (!active()) return
            const page = await loadPage(offset, revision)
            if (revision !== undefined && page.revision !== revision) throw new Error('Changed catalog')
            revision = page.revision
            const pageKeys = page.chunks.map(chunk => JSON.stringify([
                'wiki-vector-v1', this.provider.identity, chunk.documentId, chunk.text,
            ]))
            const pageVectors: (number[] | undefined)[] = page.chunks.map(chunk =>
                liveVectors.get(JSON.stringify([chunk.documentId, chunk.text])))
            const unread = pageVectors.flatMap((vector, index) => vector ? [] : [index])
            if (unread.length) {
                // One batched cache read per catalog page instead of one request per chunk.
                const cached = await this.readCached(unread.map(index => pageKeys[index]))
                unread.forEach((index, position) => {
                    const value = cached[position]
                    if (validVector(value)) pageVectors[index] = value
                })
            }
            for (let i = 0; i < page.chunks.length; i += 16) {
                if (!active()) return
                const chunks = page.chunks.slice(i, i + 16)
                const keys = pageKeys.slice(i, i + 16)
                const vectors = pageVectors.slice(i, i + 16)
                const missing = chunks.map((_, index) => index).filter(index => !vectors[index])
                if (missing.length) {
                    const generated = await this.provider.embed(missing.map(index => chunks[index].text), 'document', this.controller.signal)
                    if (generated.length !== missing.length || !generated.every(validVector)) {
                        throw new Error('Invalid embedding batch')
                    }
                    if (!active()) return
                    missing.forEach((index, position) => { vectors[index] = generated[position] })
                    const written = missing.map((index, position) => ({ key: keys[index], vector: generated[position] }))
                    // A disposable cache failure must not lose a usable in-memory index.
                    try {
                        if (this.cache.writeMany) await this.cache.writeMany(written)
                        else await Promise.all(written.map((entry) => this.cache.write(entry.key, entry.vector)))
                    } catch { /* rebuildable */ }
                }
                vectors.forEach((vector, index) => {
                    if (!validVector(vector)) throw new Error('Invalid embedding vector')
                    dimensions ??= vector.length
                    if (dimensions !== vector.length) throw new Error('Mixed embedding dimensions')
                    entries.push({ chunk: chunks[index], vector })
                })
            }
            if (page.nextOffset === null) break
            if (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset) throw new Error('Invalid catalog cursor')
            offset = page.nextOffset
        } while (active())
        if (!active()) return
        this.entries = entries
        this.ready = true
    }

    async search(current: string, recent: string, timeoutMs = 2000, options: { maximumDocuments?: number; maximumPassagesPerDocument?: number; allowedDocumentIds?: ReadonlySet<string> } = {}) {
        const entries = options.allowedDocumentIds ? this.entries.filter(entry => options.allowedDocumentIds!.has(entry.chunk.documentId)) : this.entries
        const queries = buildWikiEmbeddingQueries(current, recent)
        if (!this.ready || !entries.length || !queries.length) return emptyResult()
        let timer: ReturnType<typeof setTimeout> | undefined
        const controller = new AbortController()
        const abort = () => controller.abort()
        this.controller.signal.addEventListener('abort', abort, { once: true })
        try {
            const vectors = await Promise.race([
                this.provider.embed(queries, 'query', controller.signal),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(() => reject(new Error('Embedding query timeout')), timeoutMs)
                }),
            ])
            if (vectors.length !== queries.length || !vectors.every(validVector)
                || vectors.some(vector => vector.length !== entries[0].vector.length)) return emptyResult()
            const bestByDocument = new Map<string, IndexedChunk & { score: number; order: number }>()
            const passages: (IndexedChunk & { score: number; order: number })[] = []
            entries.forEach((entry, order) => {
                const direct = cosine(entry.vector, vectors[0])
                const contextual = vectors[1] ? cosine(entry.vector, vectors[1]) : direct
                const score = Math.max(0, Math.min(1, direct * 0.55 + contextual * 0.45))
                if (score < 0.4) return
                passages.push({ ...entry, score, order })
                const previous = bestByDocument.get(entry.chunk.documentId)
                if (!previous || score > previous.score
                    || (score === previous.score && entry.chunk.start < previous.chunk.start)) {
                    bestByDocument.set(entry.chunk.documentId, { ...entry, score, order })
                }
            })
            // Only the strongest passage can survive document deduplication; sort those winners.
            const ranked = [...bestByDocument.values()].sort((a, b) =>
                b.score - a.score || a.chunk.documentId.localeCompare(b.chunk.documentId)
                || a.chunk.start - b.chunk.start || a.order - b.order)
            // Do not fill the budget with weak matches or repeated chunks of one document.
            const threshold = Math.max(0.4, (ranked[0]?.score ?? 0) - 0.12)
            const selected = ranked.filter(item => item.score >= threshold).slice(0, Math.max(1, Math.min(32, options.maximumDocuments ?? 12)))
            const winners = new Map(selected.map(item => [item.chunk.documentId, [item]]))
            for (const item of passages.sort((a, b) => b.score - a.score || a.chunk.start - b.chunk.start)) {
                const existing = winners.get(item.chunk.documentId)
                if (selected.length >= 32 || !existing || existing.length >= Math.min(3, options.maximumPassagesPerDocument ?? 1)
                    || item.score < threshold || existing.some(other => item.chunk.start < other.chunk.end && item.chunk.end > other.chunk.start)) continue
                existing.push(item)
                selected.push(item)
            }
            return {
                matches: selected.map(({ chunk, score }) => ({
                    documentId: chunk.documentId, score, contentHash: chunk.contentHash,
                    start: chunk.start, end: chunk.end,
                })),
                evidenceQuery: selected.slice(0, 3).map(item => item.chunk.text).join('\n').slice(0, 3072),
                evidenceHints: Object.fromEntries([...winners].map(([id, items]) => [id, items.map(item => item.chunk.text).join('\n').slice(0, 3072)])),
            }
        } catch { return emptyResult() }
        finally {
            if (timer !== undefined) clearTimeout(timer)
            controller.abort()
            this.controller.signal.removeEventListener('abort', abort)
        }
    }
}

