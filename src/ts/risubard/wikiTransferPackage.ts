import { isStoryArcChapterTitle, isStoryArcTitle } from './wikiWritingLanguage'
import { normalizeMemoryRetrievalMetadata, type MemoryRetrievalMetadata } from '../../../server/node/risubard-memory-metadata'

export const WIKI_PACKAGE_MAX_BYTES = 16 * 1024 * 1024
const types = ['character', 'location', 'scene', 'faction', 'creature', 'item', 'concept', 'other'] as const
export interface PortableWikiDocument {
    id: string
    type: typeof types[number]
    title: string
    aliases: string[]
    content: string
    contextMode: 'always' | 'auto' | 'never'
    retrievalMetadata?: MemoryRetrievalMetadata
}
export interface WikiPackage {
    format: 'risubard-wiki'
    version: 1
    documents: PortableWikiDocument[]
}
interface DocumentInput {
    id: string
    type: string
    title: string
    aliases?: readonly string[]
    content?: string
    contextMode?: string
    status?: string
    retrievalMetadata?: unknown
}

export function isPortableWikiDocument(document: Pick<DocumentInput, 'type' | 'title' | 'aliases' | 'content' | 'status'>): boolean {
    return types.some(type => type === document.type)
        && (document.status === undefined || document.status === 'active')
        && !isStoryArcTitle(document.title)
        && !isStoryArcChapterTitle(document.title)
        && !(document.aliases ?? []).some(isStoryArcTitle)
        && !/<!--\s*risubard-story-arc-checkpoint:/u.test(document.content ?? '')
}

function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('올바른 위키 파일이 아닙니다.')
    return value as Record<string, unknown>
}
function bounded(value: unknown, max: number): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error('위키 항목의 내용이나 길이가 올바르지 않습니다.')
    return value
}
const identity = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase()

export function validateWikiPackage(value: unknown): WikiPackage {
    const input = record(value)
    if (Object.keys(input).length !== 3 || input.format !== 'risubard-wiki' || input.version !== 1
        || !Array.isArray(input.documents) || input.documents.length < 1 || input.documents.length > 2000) {
        throw new Error('지원하지 않는 위키 파일이거나 선택한 항목이 없습니다.')
    }
    const documents = input.documents.map((raw): PortableWikiDocument => {
        const doc = record(raw)
        const allowed = ['id', 'type', 'title', 'aliases', 'content', 'contextMode', 'retrievalMetadata']
        if (Object.keys(doc).some(key => !allowed.includes(key)) || !types.some(type => type === doc.type)
            || !['always', 'auto', 'never'].includes(doc.contextMode as string)
            || !Array.isArray(doc.aliases) || doc.aliases.length > 32
            || (doc.type === 'scene' && doc.contextMode !== 'always')) throw new Error('위키 항목 형식이 올바르지 않습니다. 사건과 아크 플롯은 새 챗으로만 옮길 수 있습니다.')
        const title = bounded(doc.title, 160).trim()
        if (/[\r\n\[\]]/u.test(title)) throw new Error('위키 제목이 올바르지 않습니다.')
        const aliases = doc.aliases.map(alias => bounded(alias, 160).trim())
        if (aliases.some(alias => /[\r\n\[\]]/u.test(alias))) throw new Error('위키 별칭이 올바르지 않습니다.')
        const content = bounded(doc.content, 12_000)
        if (!/^#{1,2}\s+\S/m.test(content) || /^---\s*\r?\n/u.test(content)) throw new Error('위키 본문에는 제목이 필요하며 frontmatter를 포함할 수 없습니다.')
        const result: PortableWikiDocument = {
            id: bounded(doc.id, 1024), type: doc.type as PortableWikiDocument['type'], title,
            aliases: [...new Set(aliases)], content, contextMode: doc.contextMode as PortableWikiDocument['contextMode'],
            ...(doc.retrievalMetadata === undefined ? {} : { retrievalMetadata: normalizeMemoryRetrievalMetadata(doc.retrievalMetadata) }),
        }
        if (!isPortableWikiDocument(result)) throw new Error('사건과 아크 플롯은 이 위키로 새 챗 시작을 통해서만 옮길 수 있습니다.')
        return result
    })
    const pack: WikiPackage = { format: 'risubard-wiki', version: 1, documents }
    validateImportConflicts(pack, [])
    if (new TextEncoder().encode(JSON.stringify(pack)).length > WIKI_PACKAGE_MAX_BYTES) throw new Error('위키 파일은 16 MiB 이하여야 합니다.')
    return pack
}

/** Preflight the entire selection; never guess identity or silently overwrite canon. */
export function validateImportConflicts(pack: WikiPackage, existing: readonly Omit<DocumentInput, 'content'>[]): void {
    const ids = new Set(existing.map(doc => doc.id))
    const names = new Set(existing.flatMap(doc => [doc.title, ...(doc.aliases ?? [])]).map(identity))
    let hasScene = existing.some(doc => doc.type === 'scene')
    for (const doc of pack.documents) {
        const keys = [...new Set([doc.title, ...doc.aliases].map(identity))]
        const collision = keys.find(key => names.has(key))
        if (ids.has(doc.id) || collision || (doc.type === 'scene' && hasScene)) {
            throw new Error(`이미 존재하는 위키 항목과 충돌합니다: ${doc.title}${collision ? ` (${[doc.title, ...doc.aliases].find(name => identity(name) === collision)})` : ''}. 기존 항목은 변경하지 않았습니다.`)
        }
        ids.add(doc.id)
        keys.forEach(key => names.add(key))
        hasScene ||= doc.type === 'scene'
    }
}

export function createWikiPackage(documents: readonly DocumentInput[], selectedIds: readonly string[]): WikiPackage {
    const selected = new Set(selectedIds)
    const chosen = documents.filter(doc => selected.has(doc.id))
    if (chosen.length !== selected.size || chosen.some(doc => !isPortableWikiDocument(doc))) throw new Error('선택한 항목은 내보낼 수 없습니다.')
    return validateWikiPackage({ format: 'risubard-wiki', version: 1, documents: chosen.map(doc => ({
        id: doc.id, type: doc.type, title: doc.title, aliases: [...(doc.aliases ?? [])],
        content: doc.content, contextMode: doc.contextMode ?? 'auto',
        ...(doc.retrievalMetadata === undefined ? {} : { retrievalMetadata: doc.retrievalMetadata }),
    })) })
}
export function serializeWikiPackage(pack: WikiPackage): string {
    const validated = validateWikiPackage(pack)
    const formatted = JSON.stringify(validated, null, 2)
    // Whitespace must not turn our own valid package into an oversized import.
    return new TextEncoder().encode(formatted).length <= WIKI_PACKAGE_MAX_BYTES
        ? formatted : JSON.stringify(validated)
}
export function parseWikiPackage(text: string): WikiPackage {
    if (new TextEncoder().encode(text).length > WIKI_PACKAGE_MAX_BYTES) throw new Error('위키 파일은 16 MiB 이하여야 합니다.')
    return validateWikiPackage(JSON.parse(text.replace(/^\uFEFF/u, '')))
}
