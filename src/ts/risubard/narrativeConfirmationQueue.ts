// One chat's wiki analyses run strictly one after another: each analysis
// reads the documents, calls the model and saves with a content hash, so two
// overlapping runs for the same chat make the later save fail on a stale hash.
const chains = new Map<string, Promise<void>>()

interface LockManagerLike {
    request<T>(name: string, callback: () => Promise<T>): Promise<T>
}

// Other tabs of this browser share the chat; the Web Locks API makes them wait
// too and releases on its own when a tab closes. Without it, as in an
// insecure LAN page, only this tab's chain applies.
function withSharedLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const locks = (globalThis.navigator as { locks?: LockManagerLike } | undefined)?.locks
    return typeof locks?.request === 'function'
        ? locks.request(`risubard-wiki-analysis:${key}`, task)
        : task()
}

export function enqueueNarrativeConfirmation<T>(
    key: string,
    task: () => Promise<T>,
): Promise<T> {
    const previous = chains.get(key) ?? Promise.resolve()
    const run = previous.then(() => withSharedLock(key, task))
    const settled: Promise<void> = run.then(() => undefined, () => undefined)
    chains.set(key, settled)
    void settled.then(() => {
        if (chains.get(key) === settled) chains.delete(key)
    })
    return run
}

/** Settles once the chat's queued and running analyses have finished, however they ended. */
export function narrativeConfirmationsSettled(key: string): Promise<void> {
    return chains.get(key) ?? Promise.resolve()
}

export function pendingNarrativeConfirmationKeys(): string[] {
    return [...chains.keys()]
}
