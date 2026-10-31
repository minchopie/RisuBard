export type LorebookMatchingMode = 'partial' | 'whitespace' | 'word-boundary'

const KOREAN_WORD_SUFFIXES = new Set([
    '은', '는', '이', '가', '을', '를', '의', '에', '에서',
    '에게', '한테', '께', '와', '과', '도', '만', '부터', '까지',
    '로', '으로', '랑', '이랑', '하고', '보다', '처럼', '만큼',
    '마다', '조차', '마저', '밖에', '뿐',
    '이라', '라', '이라고', '라고', '이라는', '라는', '이란', '란',
    '이야', '야', '이에요', '예요', '입니다', '이고', '이며', '이면',
])

export function resolveLorebookMatchingMode(
    mode: LorebookMatchingMode | undefined,
    legacyFullWordMatching: boolean | undefined,
): LorebookMatchingMode {
    if(mode === 'partial' || mode === 'whitespace' || mode === 'word-boundary'){
        return mode
    }
    return legacyFullWordMatching ? 'whitespace' : 'partial'
}

export function matchesLorebookKey(
    text: string,
    key: string,
    mode: LorebookMatchingMode,
    locale?: string,
): boolean {
    const normalizedText = text.toLocaleLowerCase(locale)
    const normalizedKey = key.trim().toLocaleLowerCase(locale)
    if(!normalizedKey){
        return false
    }

    if(mode === 'partial'){
        return normalizedText.replace(/ /g, '').includes(normalizedKey.replace(/ /g, ''))
    }
    if(mode === 'whitespace'){
        const textTerms = normalizedText.split(/\s+/u).filter(Boolean)
        const keyTerms = normalizedKey.split(/\s+/u).filter(Boolean)
        return textTerms.some((_, start) => keyTerms.every((term, offset) =>
            textTerms[start + offset] === term
        ))
    }

    const segments = Array.from(new Intl.Segmenter(locale, {
        granularity: 'word',
    }).segment(normalizedText))
    let matchIndex = normalizedText.indexOf(normalizedKey)

    while(matchIndex !== -1){
        const matchEnd = matchIndex + normalizedKey.length
        const startsOnWordBoundary = segments.some((segment) => {
            return segment.isWordLike && segment.index === matchIndex
        })
        const endsOnWordBoundary = segments.some((segment) => {
            return segment.isWordLike && segment.index + segment.segment.length === matchEnd
        })
        if(startsOnWordBoundary && endsOnWordBoundary){
            return true
        }
        const endingSegment = segments.find((segment) => {
            const segmentEnd = segment.index + segment.segment.length
            return segment.isWordLike && segment.index < matchEnd && segmentEnd > matchEnd
        })
        if(startsOnWordBoundary && endingSegment){
            const suffix = normalizedText.slice(
                matchEnd,
                endingSegment.index + endingSegment.segment.length,
            )
            if(KOREAN_WORD_SUFFIXES.has(suffix)){
                return true
            }
        }
        matchIndex = normalizedText.indexOf(normalizedKey, matchIndex + 1)
    }

    return false
}

// Regex lorebook keys are compiled once per source and flags instead of once per entry, message and sweep.
// A leading `(?!)|` or trailing `|(?!)` alternative can never match, so dropping it gives the same matches;
// some card key styles wrap every key that way, and the wrapper alone makes V8 scan several times slower.
const NEVER_HEAD = '(?!)|'
const NEVER_TAIL = '|(?!)'
const LOREBOOK_REGEX_CACHE_LIMIT = 4096
const lorebookRegexCache = new Map<string, RegExp | null>()

export function dropNeverMatchingRegexEdges(source: string): string {
    let result = source
    if(result.startsWith(NEVER_HEAD)){
        result = result.slice(NEVER_HEAD.length)
    }
    if(result.endsWith(NEVER_TAIL)){
        let backslashes = 0
        for(let i = result.length - NEVER_TAIL.length - 1; i >= 0 && result[i] === '\\'; i--){
            backslashes++
        }
        if(backslashes % 2 === 0){
            result = result.slice(0, -NEVER_TAIL.length)
        }
    }
    return result
}

/** Same result as `new RegExp(source, flags)` (null where that throws), reused across calls; lastIndex is reset. */
export function getLorebookKeyRegex(source: string, flags: string): RegExp | null {
    const cacheKey = JSON.stringify([flags, source])
    let regex = lorebookRegexCache.get(cacheKey)
    if(regex === undefined){
        try {
            regex = new RegExp(source, flags)
        } catch {
            regex = null
        }
        const trimmed = dropNeverMatchingRegexEdges(source)
        if(regex && trimmed !== source){
            try {
                regex = new RegExp(trimmed, flags)
            } catch {
                // keep the original pattern
            }
        }
        if(lorebookRegexCache.size >= LOREBOOK_REGEX_CACHE_LIMIT){
            lorebookRegexCache.clear()
        }
        lorebookRegexCache.set(cacheKey, regex)
    }
    if(regex){
        regex.lastIndex = 0
    }
    return regex
}
