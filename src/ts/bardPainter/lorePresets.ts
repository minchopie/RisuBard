import type { PainterIdentity, PainterOutfit, PainterStyle } from './types'

/**
 * BardPainter presets written as lorebook entries. An entry is a preset when, after CBS
 * evaluation, it contains a `[bardpainter character: id]` or `[bardpainter outfit: id]`
 * header; CBS that empties the header (a disabled variant) leaves the preset inactive.
 * Entries should carry `@@dont_activate` and no keys so chat prompts never include them.
 *
 *   @@dont_activate
 *   [bardpainter character: izuku]
 *   name: Izuku Midoriya
 *   aliases: Deku, 미도리야
 *   note: U.A. 1-A
 *   default outfit: uniform
 *   [appearance]
 *   boy, midoriya izuku, green hair
 *   [outfit: uniform | school uniform]
 *   u.a. school uniform, <painter.ua_tie>
 *
 * Prompt text is NovelAI syntax and is used verbatim. `<painter.id>` inserts a shared outfit's clothing.
 *
 * A style entry (`[bardpainter style: id]`) holds `name`, `default: true`, `steps`, `scale`,
 * `cfg rescale` and `sampler` lines and `[artist]`, `[rendering]`, `[negative]` sections.
 */

export const PAINTER_LORE_IDENTITY_PREFIX = 'lore:'
export const PAINTER_LORE_OUTFIT_PREFIX = 'lore-outfit:'
export const PAINTER_LORE_STYLE_PREFIX = 'lore-style:'

export interface PainterLoreLibrary {
    identities: PainterIdentity[]
    /** Character outfits (subjectId set) and shared outfits (subjectId ''). */
    outfits: PainterOutfit[]
    styles: PainterStyle[]
    /** The style marked `default: true`; chats use it until the user picks another. */
    defaultStyleId?: string
    /** Problems shown to the user; the affected text is skipped, not guessed. */
    warnings: string[]
}

type LoreEntryLike = { id?: string; comment?: string; content: string; mode?: string; enabled?: boolean }
export interface PainterLoreSource { scope: string; entries: LoreEntryLike[] }

interface ParsedCharacter {
    kind: 'character'; id: string; name: string; aliases: string[]; note: string; defaultOutfit: string
    appearance: string; outfits: Array<{ id: string; name: string; clothing: string }>
}
interface ParsedOutfit { kind: 'outfit'; id: string; name: string; clothing: string }
interface ParsedStyle extends Omit<PainterStyle, 'id'> { kind: 'style'; id: string; isDefault: boolean }
export type ParsedPainterLore = ParsedCharacter | ParsedOutfit | ParsedStyle

export const PAINTER_LORE_HEADER = /^\[\s*bardpainter\s+(character|outfit|style)\s*:\s*([^\]]+?)\s*\]\s*$/i
export const PAINTER_LORE_SECTION = /^\[\s*(appearance|clothing|artist|rendering|negative|outfit\s*:\s*([^|\]]+?)\s*(?:\|\s*([^\]]*?)\s*)?)\s*\]\s*$/i
const META = /^([a-z][a-z ]*?)\s*:\s*(.*)$/i
const VALID_ID = /^[\w.-]+$/

const list = (value: string) => [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))]

/** Parse one CBS-evaluated entry. Returns undefined for ordinary lore or an inactive variant. */
export function parsePainterLoreEntry(text: string): ParsedPainterLore | undefined {
    const lines = text.replace(/\r\n?/g, '\n').split('\n').filter(line => !line.trimStart().startsWith('@@'))
    const start = lines.findIndex(line => PAINTER_LORE_HEADER.test(line.trim()))
    if (start < 0) return undefined
    const [, kind, rawId] = lines[start].trim().match(PAINTER_LORE_HEADER)!
    const id = rawId.trim()
    if (!VALID_ID.test(id)) throw new Error(`바드페인터 프리셋 ID「${id}」에는 영문, 숫자, _, -, . 만 쓸 수 있습니다.`)
    const meta = new Map<string, string>()
    const sections: Array<{ name: string; id?: string; label?: string; text: string[] }> = []
    for (const line of lines.slice(start + 1)) {
        const trimmed = line.trim()
        // A second header ends this preset; one entry holds one preset.
        if (PAINTER_LORE_HEADER.test(trimmed)) break
        const section = trimmed.match(PAINTER_LORE_SECTION)
        if (section) {
            const name = section[1].toLowerCase().startsWith('outfit') ? 'outfit' : section[1].toLowerCase()
            sections.push({ name, id: section[2]?.trim(), label: section[3]?.trim(), text: [] })
            continue
        }
        if (sections.length) { sections[sections.length - 1].text.push(line); continue }
        const pair = trimmed.match(META)
        if (pair) meta.set(pair[1].trim().toLowerCase(), pair[2].trim())
    }
    const body = (section?: { text: string[] }) => section ? section.text.join('\n').trim() : ''
    const name = meta.get('name') || id
    if (kind.toLowerCase() === 'style') {
        const number = (key: string, fallback: number) => {
            const value = meta.get(key)
            if (value === undefined || value === '') return fallback
            const parsed = Number(value)
            if (!Number.isFinite(parsed)) throw new Error(`「${name}」의 ${key} 값「${value}」이 숫자가 아닙니다.`)
            return parsed
        }
        return {
            kind: 'style', id, name, isDefault: /^(true|yes|1)$/i.test(meta.get('default') ?? ''),
            artist: body(sections.find(item => item.name === 'artist')), rendering: body(sections.find(item => item.name === 'rendering')),
            negative: body(sections.find(item => item.name === 'negative')),
            steps: number('steps', 28), scale: number('scale', 5), cfgRescale: number('cfg rescale', 0), sampler: meta.get('sampler') || 'k_euler_ancestral',
        }
    }
    if (kind.toLowerCase() === 'outfit') {
        return { kind: 'outfit', id, name, clothing: body(sections.find(item => item.name === 'clothing')) }
    }
    const outfits: ParsedCharacter['outfits'] = []
    for (const section of sections.filter(item => item.name === 'outfit')) {
        if (!section.id || !VALID_ID.test(section.id)) throw new Error(`「${name}」의 의상 ID「${section.id ?? ''}」를 확인해 주세요.`)
        if (outfits.some(item => item.id === section.id)) throw new Error(`「${name}」에 의상「${section.id}」가 두 번 있습니다.`)
        outfits.push({ id: section.id, name: section.label || section.id, clothing: body(section) })
    }
    return {
        kind: 'character', id, name, aliases: list(meta.get('aliases') ?? ''), note: meta.get('note') ?? '',
        defaultOutfit: meta.get('default outfit') ?? meta.get('default') ?? '',
        appearance: body(sections.find(item => item.name === 'appearance')), outfits,
    }
}

/**
 * Build the preset library from lore sources ordered from lowest to highest precedence
 * (module, character, chat). A later scope replaces an earlier preset with the same id.
 */
export function collectPainterLorePresets(sources: PainterLoreSource[], evaluate: (content: string) => string): PainterLoreLibrary {
    const warnings: string[] = []
    const characters = new Map<string, ParsedCharacter>()
    const shared = new Map<string, ParsedOutfit>()
    const styleMap = new Map<string, ParsedStyle>()
    for (const source of sources) {
        for (const entry of source.entries) {
            if (entry.mode === 'folder' || entry.enabled === false || !/bardpainter/i.test(entry.content)) continue
            try {
                const parsed = parsePainterLoreEntry(evaluate(entry.content))
                if (parsed?.kind === 'character') characters.set(parsed.id, parsed)
                else if (parsed?.kind === 'style') styleMap.set(parsed.id, parsed)
                else if (parsed) shared.set(parsed.id, parsed)
            } catch (error) {
                warnings.push(`${entry.comment || entry.id || '이름 없는 로어'}: ${error instanceof Error ? error.message : String(error)}`)
            }
        }
    }
    const expand = (text: string, owner: string) => text.replace(/<painter\.([\w.-]+)>/g, (_, ref: string) => {
        const outfit = shared.get(ref)
        if (outfit) return outfit.clothing
        warnings.push(`${owner}: 공용 의상 <painter.${ref}>이 없거나 꺼져 있어 뺐습니다.`)
        return '\u0000'
    // A dropped reference takes one neighboring comma with it; the rest of the text stays verbatim.
    }).replace(/(,\s*)?\u0000(\s*,\s*)?/g, (_, before?: string, after?: string) => before && after ? ', ' : '').trim()
    const outfits: PainterOutfit[] = [...shared.values()].map(item => ({
        id: PAINTER_LORE_OUTFIT_PREFIX + item.id, subjectId: '', name: item.name, clothing: expand(item.clothing, item.name), state: '',
    }))
    const identities: PainterIdentity[] = []
    for (const item of characters.values()) {
        const id = PAINTER_LORE_IDENTITY_PREFIX + item.id
        const own = item.outfits.map(outfit => ({ id: `${id}:${outfit.id}`, subjectId: id, name: outfit.name, clothing: expand(outfit.clothing, item.name), state: '' }))
        outfits.push(...own)
        const defaultOutfitId = item.defaultOutfit ? `${id}:${item.defaultOutfit}` : undefined
        if (defaultOutfitId && !own.some(outfit => outfit.id === defaultOutfitId)) warnings.push(`${item.name}: 기본 의상「${item.defaultOutfit}」이 없습니다.`)
        identities.push({
            id, name: item.name, aliases: item.aliases, appearance: expand(item.appearance, item.name),
            ...(item.note ? { note: item.note } : {}),
            outfitIds: own.map(outfit => outfit.id),
            ...(defaultOutfitId && own.some(outfit => outfit.id === defaultOutfitId) ? { defaultOutfitId } : {}),
        })
    }
    const styles: PainterStyle[] = [...styleMap.values()].map(({ kind: _kind, isDefault: _default, id, ...style }) => ({ ...style, id: PAINTER_LORE_STYLE_PREFIX + id }))
    const defaults = [...styleMap.values()].filter(item => item.isDefault)
    if (defaults.length > 1) warnings.push(`기본 그림체가 ${defaults.length}개입니다. 마지막「${defaults[defaults.length - 1].name}」을 씁니다.`)
    const defaultStyleId = defaults.length ? PAINTER_LORE_STYLE_PREFIX + defaults[defaults.length - 1].id : undefined
    return { identities, outfits, styles, ...(defaultStyleId ? { defaultStyleId } : {}), warnings }
}

const fold = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim()
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** True when a name occurs in text: whole words for Latin names, substrings for others (Korean, Japanese). */
export function painterNameOccurs(name: string, text: string): boolean {
    const key = fold(name)
    if (key.length < 2) return false
    if (/^[\x20-\x7e]+$/.test(key)) return new RegExp(`(^|[^a-z0-9])${escape(key)}($|[^a-z0-9])`).test(fold(text))
    return fold(text).includes(key)
}

/** Lore presets named in the scene text, plus those already used by draft blocks. */
export function painterLoreCandidates(identities: PainterIdentity[], text: string, keepIds: Iterable<string> = []): PainterIdentity[] {
    const keep = new Set(keepIds)
    return identities.filter(item => keep.has(item.id) || [item.name, ...item.aliases].some(name => painterNameOccurs(name, text)))
}

export const isPainterLoreStyle = (id: string) => id.startsWith(PAINTER_LORE_STYLE_PREFIX)
export const isPainterLoreIdentity = (id: string) => id.startsWith(PAINTER_LORE_IDENTITY_PREFIX)
