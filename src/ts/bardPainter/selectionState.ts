import { writable } from 'svelte/store'
import type { PainterAnchor } from './types'

// Lightweight selection capture does not load the painter runtime or call a model.
export interface PainterSelectionState {
    characterId: string
    chatId: string
    anchor?: PainterAnchor
    issue?: string
}
export const painterSelection = writable<PainterSelectionState | null>(null)

/** Transient placement mode; callbacks and DOM focus are never saved to user data. */
export interface PainterInsertionRequest {
    characterId: string
    chatId: string
    resultId: string
    messageId?: string
    preferredOffset?: number
    insert: (anchor: PainterAnchor) => Promise<boolean>
    /** Swap an image already in the message for this result; `occurrence` counts that id's tokens in the source. */
    replace?: (target: { messageId: string; inlayId: string; occurrence: number }) => Promise<boolean>
    error?: () => string
}
export const painterInsertionRequest = writable<PainterInsertionRequest | null>(null)
