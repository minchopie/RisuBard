import { get_encoding, type Tiktoken } from '@dqbd/tiktoken'
import { sha256Digest } from '../secureCrypto'

let tokenizer: Tiktoken | undefined
export function directWikiTokens(value: string): number {
    tokenizer ??= get_encoding('cl100k_base')
    return tokenizer.encode(value, [], []).length
}

export interface DirectWikiBlock {
    blockId: string
    contentHash: string
    heading: string
    markdown: string
    start: number
    end: number
}

async function hash(value: string): Promise<string> {
    const bytes = await sha256Digest(new TextEncoder().encode(value))
    return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

// IDs belong to the exact source snapshot, not a persisted second source of truth.
// Real headings delimit sections; even one long H3 may have many blocks.
// Only the document title is immutable. Section headings remain editable source.
export async function splitDirectWikiBlocks(source: string, maximumCharacters: number): Promise<DirectWikiBlock[]> {
    const ranges: Array<{ start: number; end: number; heading: string }> = []
    let position = 0
    let start = 0
    let heading = ''
    let titleFound = false
    let fence: { character: string; length: number } | undefined
    for (const line of source.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
        const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)/)
        if (marker) {
            if (!fence) fence = { character: marker[1][0], length: marker[1].length }
            else if (marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined
        } else if (!fence && /^ {0,3}#{1,6}[\t ]+\S/.test(line)) {
            if (start < position) ranges.push({ start, end: position, heading })
            heading = line.trim()
            const title = !titleFound && /^ {0,3}#{1,2}[\t ]+\S/.test(line)
            if (title) titleFound = true
            start = title ? position + line.length : position
        }
        position += line.length
    }
    if (start < source.length) ranges.push({ start, end: source.length, heading })
    const blocks: DirectWikiBlock[] = []
    for (const range of ranges) {
        for (let offset = range.start; offset < range.end;) {
            let end = Math.min(range.end, offset + maximumCharacters)
            if (end < range.end) {
                const newline = source.lastIndexOf('\n', end - 1)
                const space = source.lastIndexOf(' ', end - 1)
                const boundary = newline > offset + maximumCharacters / 2 ? newline : space
                if (boundary > offset + maximumCharacters / 2) end = boundary + 1
                // Never cut a wiki link or a UTF-16 surrogate pair in half.
                const open = source.lastIndexOf('[[', end - 1)
                const close = source.lastIndexOf(']]', end - 1)
                if (open >= offset && open > close) {
                    const linkEnd = source.indexOf(']]', end)
                    if (open > offset) end = open
                    else if (linkEnd >= 0) end = linkEnd + 2
                }
                if (/^[\uDC00-\uDFFF]$/.test(source[end])) end -= 1
            }
            const markdown = source.slice(offset, end)
            const contentHash = await hash(markdown)
            blocks.push({ blockId: `block-${offset}-${contentHash.slice(0, 16)}`, contentHash,
                heading: range.heading, markdown, start: offset, end })
            offset = end
        }
    }
    return blocks
}

export function applyDirectWikiBlocks(source: string, blocks: DirectWikiBlock[], replacements: Map<string, string | null>): string {
    let result = ''
    let offset = 0
    for (const block of blocks) {
        if (source.slice(block.start, block.end) !== block.markdown) throw new Error('구간 원문이 변경되었습니다. 다시 실행해 주세요.')
        if (!replacements.has(block.blockId)) throw new Error('처리하지 않은 위키 구간이 있습니다. 저장하지 않았습니다.')
        result += source.slice(offset, block.start) + (replacements.get(block.blockId) ?? block.markdown)
        offset = block.end
    }
    return result + source.slice(offset)
}

export const directWikiBlockSchema = JSON.stringify({
    type: 'object', additionalProperties: false,
    required: ['schemaVersion', 'documentId', 'contentHash', 'replacements'],
    properties: {
        schemaVersion: { const: 2 }, documentId: { type: 'string' }, contentHash: { type: 'string' },
        replacements: { type: 'array', items: {
            type: 'object', additionalProperties: false, required: ['blockId', 'contentHash', 'markdown'],
            properties: { blockId: { type: 'string' }, contentHash: { type: 'string' },
                markdown: { oneOf: [{ type: 'string' }, { type: 'null' }] } },
        } },
    },
})

export function parseDirectWikiReplacements(value: unknown, document: { id: string; contentHash: string }, blocks: DirectWikiBlock[]): Map<string, string | null> {
    const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
    const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).length === expected.length && expected.every((key) => key in value)
    if (!record(value) || !keys(value, ['schemaVersion', 'documentId', 'contentHash', 'replacements'])
        || value.schemaVersion !== 2 || value.documentId !== document.id || value.contentHash !== document.contentHash
        || !Array.isArray(value.replacements)) throw new Error('위키 구간 응답의 문서 ID 또는 원문 해시가 올바르지 않습니다.')
    const byId = new Map(blocks.map((block) => [block.blockId, block]))
    const replacements = new Map<string, string | null>()
    for (const replacement of value.replacements) {
        if (!record(replacement) || !keys(replacement, ['blockId', 'contentHash', 'markdown'])
            || typeof replacement.blockId !== 'string'
            || (replacement.markdown !== null && typeof replacement.markdown !== 'string')) throw new Error('위키 구간 응답 형식이 올바르지 않습니다.')
        const block = byId.get(replacement.blockId)
        if (!block || replacements.has(replacement.blockId)) throw new Error('위키 구간 ID가 알 수 없거나 중복되었습니다.')
        if (block.contentHash !== replacement.contentHash) throw new Error('위키 구간 원문 해시가 일치하지 않습니다.')
        replacements.set(block.blockId, replacement.markdown as string | null)
    }
    if (replacements.size !== blocks.length) throw new Error('위키 구간 응답에 누락된 구간이 있습니다.')
    return replacements
}
