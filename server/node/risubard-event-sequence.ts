import type { MarkdownWikiDocument } from './risubard-markdown-wiki'

/**
 * Story order of every active event. Events saved before numbering are ranked
 * by save time ahead of numbered ones, so the order needs no file rewrite.
 * The latest event carries the largest number.
 */
export function eventSequences(documents: readonly Pick<MarkdownWikiDocument, 'id' | 'type' | 'status' | 'sequence' | 'created' | 'updated'>[]): Map<string, number> {
    const events = documents.filter((document) => document.type === 'event' && document.status !== 'retracted')
    const legacy = events.filter((document) => document.sequence === undefined)
        .sort((left, right) => (left.created ?? left.updated).localeCompare(right.created ?? right.updated)
            || left.id.localeCompare(right.id))
    const sequences = new Map<string, number>(legacy.map((document, index) => [document.id, index + 1]))
    // Stored numbers were assigned above every legacy rank, so they keep their value.
    for (const document of events) {
        if (document.sequence !== undefined) sequences.set(document.id, document.sequence)
    }
    return sequences
}
