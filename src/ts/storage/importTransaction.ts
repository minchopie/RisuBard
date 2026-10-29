import { v4 } from 'uuid'

export type ImportOwner = { type: 'character' | 'module', id: string }
export type ImportJournal = { id: string, assets: string[], owners: ImportOwner[] }
export type ImportAsset = { key: string, value: Uint8Array }
interface Dependencies {
    write: (entries: ImportAsset[]) => Promise<unknown>
    journal: (record: ImportJournal | null) => void
    removeOwners: (owners: ImportOwner[]) => Promise<void>
    cleanup: (keys: string[], id: string) => Promise<unknown>
    prepareRollback?: (id: string) => Promise<unknown>
}

export class ImportCancelled extends Error {
    constructor() { super('Import cancelled'); this.name = 'ImportCancelled' }
}

export class ImportTransaction {
    private assets = new Set<string>()
    private owners: ImportOwner[] = []
    private pending = new Set<Promise<unknown>>()
    // In-memory changes to existing entities (a bot update), undone before owners are removed.
    private undo: (() => void)[] = []
    cancelled = false
    readonly id: string
    constructor(private existing: Set<string>, private deps: Dependencies, recovery?: ImportJournal) {
        this.id = recovery?.id ?? v4()
        if (recovery) { this.assets = new Set(recovery.assets); this.owners = recovery.owners }
    }
    check = () => { if (this.cancelled) throw new ImportCancelled() }
    cancel = () => { this.cancelled = true }
    private record() { this.deps.journal({ id: this.id, assets: [...this.assets], owners: [...this.owners] }) }
    register(type: ImportOwner['type'], id: string) {
        this.check()
        this.owners.push({ type, id })
        this.record()
    }
    async write(entries: ImportAsset[]) {
        this.check()
        // Content-addressed assets that existed before this import are never overwritten.
        const fresh = entries.filter(entry => !this.existing.has(entry.key))
        if (!fresh.length) return
        for (const entry of fresh) this.assets.add(entry.key)
        this.record() // Write-ahead: a lost response can still mean the server wrote the data.
        const writing = this.deps.write(fresh)
        this.pending.add(writing)
        try { await writing } finally { this.pending.delete(writing) }
    }
    onRollback(undo: () => void) {
        this.check()
        this.undo.push(undo)
    }
    async rollback() {
        this.cancel()
        await Promise.allSettled([...this.pending])
        for (const undo of this.undo.splice(0).reverse()) undo()
        if (!this.assets.size && !this.owners.length) { this.deps.journal(null); return }
        if (this.owners.length) await this.deps.prepareRollback?.(this.id)
        await this.deps.removeOwners(this.owners)
        await this.deps.cleanup([...this.assets], this.id)
        this.deps.journal(null)
    }
    commit() { this.check(); this.deps.journal(null) }
}
