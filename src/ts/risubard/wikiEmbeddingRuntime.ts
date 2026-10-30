import { WikiEmbeddingIndex, type WikiVectorCache, type WikiVectorProvider } from './wikiEmbeddingIndex'
import type { WikiEmbeddingCatalog } from './wikiEmbeddingChunks'

export interface WikiEmbeddingScope { characterId: string; chatId: string }
export type WikiEmbeddingStatus = 'disabled' | 'preparing' | 'ready' | 'unavailable'

export class WikiEmbeddingRuntime<Settings extends { enabled: boolean }> {
    private entry?: { key: string; scope: WikiEmbeddingScope; index: WikiEmbeddingIndex; running: boolean; pending: boolean }
    status: WikiEmbeddingStatus = 'disabled'

    constructor(private dependencies: {
        provider(settings: Settings): WikiVectorProvider
        cache: WikiVectorCache
        load(scope: WikiEmbeddingScope, offset: number, revision?: string): Promise<WikiEmbeddingCatalog>
        onStatus?(status: WikiEmbeddingStatus): void
    }) {}

    private setStatus(status: WikiEmbeddingStatus) {
        this.status = status
        this.dependencies.onStatus?.(status)
    }

    activate(scope: WikiEmbeddingScope, settings: Settings): void {
        if (!settings.enabled) { this.stop(); return }
        // Configuration equality stays in memory; credentials never become storage keys.
        const key = JSON.stringify([scope, settings])
        if (this.entry?.key === key) return
        this.entry?.index.dispose()
        this.entry = undefined
        try {
            this.entry = { key, scope: { ...scope }, index: new WikiEmbeddingIndex(
                this.dependencies.provider(settings), this.dependencies.cache,
            ), running: false, pending: false }
            this.refresh()
        } catch { this.setStatus('unavailable') }
    }

    stop(): void {
        this.entry?.index.dispose()
        this.entry = undefined
        this.setStatus('disabled')
    }

    refresh(): void {
        const entry = this.entry
        if (!entry) return
        if (entry.running) { entry.pending = true; return }
        entry.running = true
        this.setStatus('preparing')
        void (async () => {
            do {
                entry.pending = false
                try {
                    await entry.index.refresh(
                        (offset, revision) => this.dependencies.load(entry.scope, offset, revision),
                        () => this.entry === entry,
                    )
                    if (this.entry === entry) this.setStatus('ready')
                } catch {
                    if (this.entry === entry) this.setStatus('unavailable')
                }
            } while (entry.pending && this.entry === entry)
            entry.running = false
        })()
    }

    /** Waits for the query embedding up to the user's wiki lookup time; a remote model can take seconds. */
    async search(current: string, recent: string, timeoutMs = 2000) {
        const entry = this.entry
        const result = await entry?.index.search(current, recent, timeoutMs, { maximumDocuments: 12, maximumPassagesPerDocument: 3 })
        return entry && this.entry === entry && result
            ? result : { matches: [], evidenceQuery: '', evidenceHints: {} as Record<string, string> }
    }
}
