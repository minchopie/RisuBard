import { normalizeWikiLinkKey } from './wikiLink'

export interface LinkRepairDocument {
    id: string
    title: string
    aliases?: readonly string[]
    status?: string
}

export interface RepairedWikiLink {
    from: string
    to: string
}

/** Smallest title similarity (bigram Dice) a missing link needs before it is rewritten. */
export const LINK_REPAIR_MIN_SIMILARITY = 0.7
/** The best title must beat the best title of any other document by this much, or the link is left alone. */
export const LINK_REPAIR_MIN_MARGIN = 0.08

const namesOf = (document: LinkRepairDocument): string[] =>
    [document.title, ...(Array.isArray(document.aliases) ? document.aliases : [])]
        .filter((name): name is string => typeof name === 'string' && name.length > 0)

const WIKI_LINK = /\[\[([^\]|#\n]+)((?:[|#][^\]\n]*)?)\]\]/gu

function bigrams(value: string): Map<string, number> {
    const chars = [...normalizeWikiLinkKey(value).replace(/[\s\p{P}]+/gu, '')]
    const result = new Map<string, number>()
    if (chars.length === 1) result.set(chars[0], 1)
    for (let index = 0; index + 1 < chars.length; index += 1) {
        const bigram = chars[index] + chars[index + 1]
        result.set(bigram, (result.get(bigram) ?? 0) + 1)
    }
    return result
}

function dice(left: Map<string, number>, right: Map<string, number>): number {
    let shared = 0
    let total = 0
    for (const count of left.values()) total += count
    for (const count of right.values()) total += count
    if (total === 0) return 0
    for (const [bigram, count] of left) shared += Math.min(count, right.get(bigram) ?? 0)
    return (2 * shared) / total
}

/**
 * Rewrites a `[[link]]` that no document owns to the closest existing title, so a writer that
 * misquotes a title by a word or two does not leave a dead link. Runs on every save without a
 * model call. Links that already resolve, and links with no clearly closest title, stay as written.
 */
export function repairBrokenWikiLinks(
    markdown: string,
    documents: readonly LinkRepairDocument[],
): { markdown: string; repaired: RepairedWikiLink[] } {
    // A save must never fail because of link upkeep: malformed input leaves the text as written.
    try {
        return repairLinks(markdown, documents)
    }
    catch {
        return { markdown, repaired: [] }
    }
}

function repairLinks(
    markdown: string,
    documents: readonly LinkRepairDocument[],
): { markdown: string; repaired: RepairedWikiLink[] } {
    const live = documents.filter((document) => typeof document?.title === 'string' && document.title
        && document.status !== 'retracted' && document.status !== 'superseded')
    const known = new Set<string>()
    for (const document of live) {
        known.add(document.id)
        for (const name of namesOf(document)) known.add(normalizeWikiLinkKey(name))
    }
    const candidates = live.map((document) => ({
        title: document.title,
        id: document.id,
        grams: namesOf(document).map(bigrams),
    }))
    const cache = new Map<string, string | undefined>()
    const repaired: RepairedWikiLink[] = []

    const closest = (target: string): string | undefined => {
        const grams = bigrams(target)
        if (grams.size === 0) return undefined
        const best = new Map<string, { score: number; title: string }>()
        for (const candidate of candidates) {
            const score = Math.max(...candidate.grams.map((other) => dice(grams, other)))
            const current = best.get(candidate.id)
            if (!current || score > current.score) best.set(candidate.id, { score, title: candidate.title })
        }
        const ranked = [...best.values()].sort((a, b) => b.score - a.score)
        const [first, second] = ranked
        if (!first || first.score < LINK_REPAIR_MIN_SIMILARITY) return undefined
        if (second && first.score - second.score < LINK_REPAIR_MIN_MARGIN) return undefined
        return first.title
    }

    const result = markdown.replace(WIKI_LINK, (match, target: string, suffix: string) => {
        const key = normalizeWikiLinkKey(target)
        if (!key || known.has(key) || known.has(target.trim())) return match
        if (!cache.has(key)) cache.set(key, closest(target))
        const title = cache.get(key)
        if (!title || /[\[\]|#\n]/u.test(title)) return match
        repaired.push({ from: target.trim(), to: title })
        return `[[${title}${suffix}]]`
    })
    return { markdown: result, repaired }
}
