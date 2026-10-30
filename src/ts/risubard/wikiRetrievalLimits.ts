export interface WikiRetrievalLimits { candidates: number; directSeeds: number }

/** Local search breadth, independent from final document/token budgets. */
export function normalizeWikiRetrievalLimits(value?: Partial<WikiRetrievalLimits>): WikiRetrievalLimits {
    const candidates = Number.isSafeInteger(value?.candidates)
        ? Math.max(1, Math.min(256, value!.candidates!)) : 64
    const directSeeds = Number.isSafeInteger(value?.directSeeds)
        ? Math.max(1, Math.min(128, candidates, value!.directSeeds!)) : Math.min(32, candidates)
    return { candidates, directSeeds }
}

// The page lane holds about this many whole pages, so a scene with several named
// characters keeps each one's current card instead of one long history.
const PAGES_PER_LANE = 4
const MIN_PAGE_TOKENS = 512

/** Tokens one canon page may take in retrieval; canon upkeep keeps cards under it. */
export function wikiPageTokenCap(budget: { target: number; perSource: number }): number {
    return Math.min(budget.perSource, Math.max(MIN_PAGE_TOKENS, Math.floor(budget.target / PAGES_PER_LANE)))
}
