import { derived, writable } from 'svelte/store'

export const wikiGenerationOperations = writable<Set<string>>(new Set())
export const isWikiGenerating = derived(
    wikiGenerationOperations,
    (operations) => operations.size > 0
)

const wikiGenerationControllers = new Map<string, AbortController>()

export function beginWikiGeneration(operationId: string): AbortSignal {
    const existing = wikiGenerationControllers.get(operationId)
    if (existing) return existing.signal
    const controller = new AbortController()
    if (!operationId) {
        controller.abort()
        return controller.signal
    }
    wikiGenerationControllers.set(operationId, controller)
    wikiGenerationOperations.update((operations) => {
        if (operations.has(operationId)) return operations
        const next = new Set(operations)
        next.add(operationId)
        return next
    })
    return controller.signal
}

export function endWikiGeneration(operationId: string): void {
    wikiGenerationControllers.delete(operationId)
    wikiGenerationOperations.update((operations) => {
        if (!operations.has(operationId)) return operations
        const next = new Set(operations)
        next.delete(operationId)
        return next
    })
}

// Queued analyses that have not started yet hold no controller; they compare
// this counter to the value they captured when queued and skip after a cancel.
let cancellationEpoch = 0

export function wikiCancellationEpoch(): number {
    return cancellationEpoch
}

export function cancelWikiGeneration(): void {
    cancellationEpoch += 1
    for (const controller of wikiGenerationControllers.values()) {
        controller.abort()
    }
}

export function resetWikiGenerationState(): void {
    cancelWikiGeneration()
    wikiGenerationControllers.clear()
    wikiGenerationOperations.set(new Set())
}
