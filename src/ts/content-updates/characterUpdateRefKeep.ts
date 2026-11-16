// RisuBard fork 0.9.96-ver8 (content-updates; hook lines in upstream characterUpdateFlow.svelte.ts, owned by host-bridges):
// a card update keeps the Asset Maid references the user set on the installed bot.
//
// Asset Maid (a plugin) keeps its data in one lore entry of the card, comment __ASSET_MAID_DATA__, as Portable JSON
// ("asset-maid.portable"): features.characterForms.entries[] = { target: "lore:<index>", forms: [{ id, reference: { asset:
// "asset:<index>" } }] }, entities.lorebooks["lore:N"].fingerprints (exact/content/anchor) and entities.assets["asset:N"].fingerprints.
// "lore:N" / "asset:N" are indexes into the card's globalLore / additionalAssets. Upstream's update merges a lore entry as a whole, so
// when the user set references (installed entry) and the author shipped another body (new entry), one side is lost whichever is picked.
//
// applyAssetMaidPreset(), when the review opens (or is compared again with a base file): if that entry differs on both sides (or nobody
// knows who changed it), it is picked as an edit (upstream's own "edit" choice, which a bulk "모두 새 버전" leaves alone) whose text is
// the new body with the user's references moved to the same character (lore fingerprints, then the lore comment; never the bare index)
// and the same form id. References whose character or form is gone from the new body are listed and reported (held), never dropped
// silently. A preselection the user has not touched follows a new comparison; a pick or text the user made stays.
// finalizeAssetMaidMerge(), right after upstream applyUpdate with the decision's plan and choices: only when the user applied that
// preselected edit as it was, the merge is redone against the final lorebook and pictures: every "lore:N" of the body follows its
// entry to the final lore order (upstream's merge replayed on stand-ins; characters left out of the lorebook are taken out of the body),
// the user's referenced pictures and Asset Maid crop pictures stay (appended when a choice dropped them), every "asset:N" (the user's
// and the new body's own) is renumbered to the final picture order, and entities.assets / entities.lorebooks are rekeyed to match.
import { toast } from 'svelte-sonner'
import { addLog } from '../log'
import { applyUpdate, CHARACTER_UPDATE, type UpdateChoice, type UpdatePlan } from '../characterUpdate'
import type { character, loreBook } from '../storage/database.svelte'

export const ASSET_MAID_COMMENT = '__ASSET_MAID_DATA__'
const CROP_PREFIX = '__asset_maid_crop_'
const FINGERPRINTS = ['exact', 'anchor', 'content'] as const

type Asset = [string, string, string]
type Reference = { asset?: string, [key: string]: unknown }
type Form = { id?: string, reference?: Reference | null, [key: string]: unknown }
type Entry = { target?: string, forms?: Form[], [key: string]: unknown }
type Fingerprinted = { fingerprints?: Record<string, string> }
interface Portable {
    schema?: string
    entities?: { lorebooks?: Record<string, Fingerprinted>, assets?: Record<string, Fingerprinted>, [key: string]: unknown }
    features?: { characterForms?: { entries?: Entry[] }, [key: string]: unknown }
    [key: string]: unknown
}

export type HeldReason = 'character-missing' | 'character-ambiguous' | 'form-missing' | 'asset-missing'
export interface HeldReference { side: 'mine' | 'theirs', target: string, character: string, formId: string, reference: Reference, reason: HeldReason }
export interface AssetMaidMerge {
    content: string
    /** The user's references now on the new body. */
    kept: number
    /** Of those, forms where the new body had a reference of its own. */
    replaced: number
    held: HeldReference[]
    /** Pictures put back at the end of additionalAssets. */
    appended: number
    /** Characters of the new body whose lore entry is not in the merged lorebook (taken out of the body). */
    dropped: string[]
}

/** Directive prefix ("@@dont_activate ") and the Portable JSON, or null for anything else. */
function parse(content: unknown): { prefix: string, data: Portable } | null {
    if (typeof content !== 'string') return null
    const at = content.indexOf('{')
    if (at < 0) return null
    const prefix = content.slice(0, at)
    if (prefix.trim() && !prefix.trim().startsWith('@@')) return null
    try {
        const data = JSON.parse(content.slice(at))
        return data && typeof data === 'object' && data.schema === 'asset-maid.portable' ? { prefix, data } : null
    } catch {
        return null
    }
}

function indexOf(ref: unknown, kind: 'lore' | 'asset'): number {
    const match = typeof ref === 'string' ? (kind === 'lore' ? /^lore:(\d+)$/ : /^asset:(\d+)$/).exec(ref) : null
    return match ? Number(match[1]) : -1
}
const entriesOf = (data: Portable): Entry[] => Array.isArray(data.features?.characterForms?.entries) ? data.features!.characterForms!.entries! : []
const commentOf = (lore: readonly loreBook[] | undefined, target: unknown) => String(lore?.[indexOf(target, 'lore')]?.comment ?? '')

/**
 * The new body's entry for the character the user's entry points to, or why there is none. Each fingerprint, then the lore comment,
 * narrows the candidates; a test nobody passes is skipped. More than one left is ambiguous: the lore index alone proves nothing.
 */
function locate(entry: Entry, mine: { data: Portable, lore?: loreBook[] }, theirs: { data: Portable, lore?: loreBook[] }): Entry | HeldReason {
    const own = mine.data.entities?.lorebooks?.[entry.target ?? '']?.fingerprints ?? {}
    const tests: ((other: Entry) => boolean)[] = FINGERPRINTS.filter(kind => !!own[kind]).map(kind => (other: Entry) =>
        theirs.data.entities?.lorebooks?.[other.target ?? '']?.fingerprints?.[kind] === own[kind])
    const comment = commentOf(mine.lore, entry.target)
    if (comment) tests.push(other => commentOf(theirs.lore, other.target) === comment)
    let candidates = entriesOf(theirs.data), narrowed = false
    for (const test of tests) {
        const found = candidates.filter(test)
        if (!found.length) continue
        candidates = found
        narrowed = true
        if (found.length === 1) return found[0]
    }
    return narrowed ? 'character-ambiguous' : 'character-missing'
}

/** Index of a picture in the result: the same entry, else the same file. */
function findAsset(list: readonly unknown[], asset: Asset): number {
    const same = JSON.stringify(asset)
    const exact = list.findIndex(item => JSON.stringify(item) === same)
    if (exact >= 0 || !asset[1]) return exact
    return list.findIndex(item => Array.isArray(item) && item[1] === asset[1])
}

/** Upstream's lore item keys of a whole list (characterUpdate.ts loreKey + keyed() slot): the keys plan items carry. */
function loreSlots(list: readonly loreBook[] | undefined): string[] {
    const seen = new Map<string, number>()
    return (list ?? []).map(entry => {
        const key = JSON.stringify([entry?.mode ?? '', entry?.comment ?? '', entry?.key ?? '', entry?.secondkey ?? ''])
        const slot = seen.get(key) ?? 0
        seen.set(key, slot + 1)
        return slot ? `${key}#${slot}` : key
    })
}

/**
 * New-card lore index -> merged lore index. The merge is run again by upstream applyUpdate on stand-ins that carry only the key
 * fields and the original item key, with the same plan items and choices, so every entry is followed exactly as upstream placed it
 * (sides, edits, entries left out, duplicates). Null when the stand-in result does not line up with the real one.
 */
function loreMap(plan: UpdatePlan, choices: Record<string, UpdateChoice>, mine: Partial<character>, theirs: Partial<character>, mergedLore: readonly loreBook[]): Map<number, number> | null {
    const standIns = (list: readonly loreBook[] | undefined) => {
        const keys = loreSlots(list)
        return (list ?? []).map((entry, index) => ({ mode: entry?.mode, comment: entry?.comment, key: entry?.key, secondkey: entry?.secondkey, slot: keys[index] }))
    }
    const items = plan.items.filter(item => item.field === 'globalLore')
    const picks: Record<string, UpdateChoice> = {}
    for (const item of items) {
        const choice = choices[item.id] ?? item.choice
        if (choice) picks[item.id] = typeof choice === 'object' ? { value: { slot: item.key } } : choice
    }
    const placed = applyUpdate(CHARACTER_UPDATE, { globalLore: standIns(mine.globalLore) } as unknown as character,
        { globalLore: standIns(theirs.globalLore) } as unknown as character, { hasBase: plan.hasBase, items }, picks).globalLore as unknown as { slot?: string }[]
    if (!Array.isArray(placed) || placed.length !== mergedLore.length) return null
    const at = new Map(placed.map((entry, index) => [entry?.slot, index]))
    const out = new Map<number, number>()
    loreSlots(theirs.globalLore).forEach((key, index) => { if (at.has(key)) out.set(index, at.get(key)!) })
    return out
}

const DROP = Symbol('drop')
/**
 * Every "lore:N" value and key of the body moved by the map. Something that points at an entry not in the merged lorebook is taken
 * out (an object whose target it is, a list item, a key), so no number is left to point at another character.
 */
function moveLore(value: unknown, map: Map<number, number>): unknown {
    const move = (text: string): string | typeof DROP => {
        const at = indexOf(text, 'lore')
        return at < 0 ? text : map.has(at) ? `lore:${map.get(at)}` : DROP
    }
    if (typeof value === 'string') return move(value)
    if (Array.isArray(value)) return value.map(item => moveLore(item, map)).filter(item => item !== DROP)
    if (!value || typeof value !== 'object') return value
    if (typeof (value as Entry).target === 'string' && move((value as Entry).target!) === DROP) return DROP
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
        const name = move(key)
        const moved = moveLore(item, map)
        if (name !== DROP && moved !== DROP) out[name] = moved
    }
    return out
}

/**
 * The new entry's body with the installed entry's references moved onto it and every "asset:N" pointing into `result`; pictures the
 * user's references need are appended to `result` when missing. With `map` (new-card lore index -> merged index), every "lore:N" is moved
 * to the merged lorebook; characters that are not there are taken out and their references held. Null when either side is not Asset
 * Maid Portable data.
 */
export function mergeAssetMaid(mineEntry: loreBook, theirsEntry: loreBook, mine: Partial<character>, theirs: Partial<character>, result: unknown[], map?: Map<number, number> | null): AssetMaidMerge | null {
    const own = parse(mineEntry?.content), other = parse(theirsEntry?.content)
    if (!own || !other) return null
    let data: Portable = JSON.parse(JSON.stringify(other.data))
    const mineAssets = (mine.additionalAssets ?? []) as Asset[], theirsAssets = (theirs.additionalAssets ?? []) as Asset[]
    const assets: Record<string, Fingerprinted> = {}
    const held: HeldReference[] = []
    let kept = 0, replaced = 0, appended = 0
    const place = (reference: Reference, side: 'mine' | 'theirs'): Reference | null => {
        if (reference.asset === undefined) return { ...reference }
        const picture = (side === 'mine' ? mineAssets : theirsAssets)[indexOf(reference.asset, 'asset')]
        if (!Array.isArray(picture)) return null
        let at = findAsset(result, picture)
        if (at < 0 && side === 'mine') {
            result.push([...picture])
            at = result.length - 1
            appended++
        }
        if (at < 0) return null
        const record = (side === 'mine' ? own.data : other.data).entities?.assets?.[reference.asset]
        if (record) assets[`asset:${at}`] = JSON.parse(JSON.stringify(record))
        return { ...reference, asset: `asset:${at}` }
    }
    const placed = (entry: Entry) => !map || map.has(indexOf(entry.target, 'lore'))
    const dropped = entriesOf(data).filter(entry => !placed(entry)).map(entry => commentOf(theirs.globalLore, entry.target) || String(entry.target ?? ''))
    // The new body's own references follow their pictures to their place in the result.
    for (const entry of entriesOf(data)) for (const form of entry.forms ?? []) {
        if (!form?.reference) continue
        const moved = placed(entry) ? place(form.reference, 'theirs') : null
        if (moved) form.reference = moved
        else {
            held.push({ side: 'theirs', target: String(entry.target ?? ''), character: commentOf(theirs.globalLore, entry.target), formId: String(form.id ?? ''), reference: form.reference, reason: placed(entry) ? 'asset-missing' : 'character-missing' })
            delete form.reference
        }
    }
    // Where each installed entry goes. Two installed entries that land on the same new entry cannot both be right: both are held.
    const located = new Map<Entry, Entry | HeldReason>()
    const claims = new Map<Entry, Set<Entry>>()
    for (const entry of entriesOf(own.data)) {
        if (!(entry.forms ?? []).some(form => form?.reference)) continue
        const target = locate(entry, { data: own.data, lore: mine.globalLore }, { data, lore: theirs.globalLore })
        located.set(entry, target)
        if (typeof target !== 'string') claims.set(target, (claims.get(target) ?? new Set()).add(entry))
    }
    for (const entry of entriesOf(own.data)) for (const form of entry.forms ?? []) {
        const reference = form?.reference
        if (!reference) continue
        const note = (reason: HeldReason) => held.push({ side: 'mine', target: String(entry.target ?? ''), character: commentOf(mine.globalLore, entry.target), formId: String(form.id ?? ''), reference, reason })
        const target = located.get(entry)!
        if (typeof target === 'string') { note(target); continue }
        if (claims.get(target)!.size > 1) { note('character-ambiguous'); continue }
        if (!placed(target)) { note('character-missing'); continue }
        const slot = (target.forms ?? []).find(candidate => candidate?.id === form.id)
        if (!slot) { note('form-missing'); continue }
        const moved = place(reference, 'mine')
        if (!moved) { note('asset-missing'); continue }
        if (slot.reference) replaced++
        slot.reference = moved
        kept++
    }
    const entities = { ...(data.entities ?? {}) }
    if (Object.keys(assets).length) entities.assets = assets
    else delete entities.assets
    data.entities = entities
    if (map) data = moveLore(data, map) as Portable
    return { content: other.prefix + JSON.stringify(data), kept, replaced, held, appended, dropped }
}

let pending: { id: string, text: string, chaId: string, incoming: object, mineEntry: loreBook, theirsEntry: loreBook } | null = null

/**
 * The merged Asset Maid entry to preselect as an edit, or null when no reference of the user's can be carried. Pictures are numbered as the
 * default choices place them; finalizeAssetMaidMerge numbers lore and pictures again after the real choices.
 */
export function presetAssetMaidMerge(plan: UpdatePlan | null, mine: character, theirs: character): { id: string, text: string, kept: number, held: HeldReference[] } | null {
    pending = null
    const item = plan?.items.find(entry => entry.field === 'globalLore' && (entry.status === 'conflict' || entry.status === 'differs')
        && (entry.mine as loreBook | undefined)?.comment === ASSET_MAID_COMMENT && (entry.theirs as loreBook | undefined)?.comment === ASSET_MAID_COMMENT)
    if (!plan || !item) return null
    const pictures = plan.items.filter(entry => entry.field === 'additionalAssets')
    const order = applyUpdate(CHARACTER_UPDATE, { additionalAssets: mine.additionalAssets ?? [] } as character,
        { additionalAssets: theirs.additionalAssets ?? [] } as character, { hasBase: plan.hasBase, items: pictures },
        Object.fromEntries(pictures.map(entry => [entry.id, entry.choice ?? 'mine']))).additionalAssets ?? []
    const merged = mergeAssetMaid(item.mine as loreBook, item.theirs as loreBook, mine, theirs, [...order])
    // Nothing of the user's moved (none set, or none has a place in the new body): upstream's choice as it is.
    if (!merged || merged.kept === 0) return null
    pending = { id: item.id, text: merged.content, chaId: mine.chaId, incoming: theirs, mineEntry: item.mine as loreBook, theirsEntry: item.theirs as loreBook }
    return { id: item.id, text: merged.content, kept: merged.kept, held: merged.held }
}

/**
 * Hook of the update dialog (reviewCharacterUpdate, loadCharacterUpdateBaseFile): puts the preselection into the dialog's choices and
 * edits. An earlier preselection the user left untouched is replaced (or removed when the new comparison has none); any pick or text
 * of the user's stays.
 */
export function applyAssetMaidPreset(dialog: { choices: Record<string, string>, edits: Record<string, string> }, plan: UpdatePlan | null, mine: character, theirs: character) {
    const previous = pending
    const keep = presetAssetMaidMerge(plan, mine, theirs)
    const choices = { ...dialog.choices }, edits = { ...dialog.edits }
    if (previous && choices[previous.id] === 'edit' && edits[previous.id] === previous.text) {
        delete choices[previous.id]
        delete edits[previous.id]
    }
    if (keep && !choices[keep.id]) {
        choices[keep.id] = 'edit'
        edits[keep.id] = keep.text
    } else if (keep && !(choices[keep.id] === 'edit' && edits[keep.id] === keep.text)) {
        pending = null // the user already decided this entry
    }
    dialog.choices = choices
    dialog.edits = edits
}

const reasonText: Record<HeldReason, string> = {
    'character-missing': '새 판에 같은 인물이 없음',
    'character-ambiguous': '새 판에 같은 인물이 여럿',
    'form-missing': '새 판에 같은 폼이 없음',
    'asset-missing': '그림을 찾지 못함',
}

function report(held: HeldReference[], dropped: string[]) {
    if (!held.length && !dropped.length) return
    const lines = held.map(entry => `${entry.character || entry.target} / ${entry.formId} (${entry.side === 'mine' ? '내 레퍼런스' : '새 판 레퍼런스'}: ${reasonText[entry.reason]}, ${entry.reference.asset ?? ''})`)
    for (const name of dropped) lines.push(`${name} (업데이트 뒤 로어에 없어 Asset Maid 설정에서 뺌)`)
    const message = held.length ? `Asset Maid 레퍼런스 ${held.length}개는 새 판으로 옮기지 못했어요(보류).` : `Asset Maid 인물 ${dropped.length}개는 업데이트 뒤 로어에 없어 설정에서 뺐어요.`
    addLog({ level: 'warning', message, description: lines.join('\n'), source: 'character-update' })
    // Not notifyWarning: it would also close the "applying" notice of the import that is still running.
    toast.warning(message, { description: lines.slice(0, 8).join('\n') + (lines.length > 8 ? `\n… 외 ${lines.length - 8}개 (로그)` : '') })
}

/**
 * After the choices are applied (offerUpdate, with the decision's plan and choices): renumbers the preselected merge against the final
 * lorebook and pictures. Does nothing unless the user applied the preselected edit as it was ('edit' with exactly that text).
 */
export function finalizeAssetMaidMerge(merged: character, mine: character, theirs: character, plan: UpdatePlan, choices: Record<string, UpdateChoice>): AssetMaidMerge | null {
    const current = pending
    pending = null
    if (!current || current.chaId !== mine.chaId || current.incoming !== theirs) return null
    const choice = choices[current.id]
    if (!choice || typeof choice !== 'object' || (choice.value as loreBook | undefined)?.content !== current.text) return null
    const lore = merged.globalLore ?? []
    const at = lore.findIndex(entry => entry?.comment === ASSET_MAID_COMMENT && entry.content === current.text)
    if (at < 0) return null
    const pictures: unknown[] = [...(merged.additionalAssets ?? [])]
    const map = loreMap(plan, choices, mine, theirs, lore)
    if (!map) console.warn('Asset Maid merge: lore order could not be followed; lore numbers left as in the new card')
    const result = mergeAssetMaid(current.mineEntry, current.theirsEntry, mine, theirs, pictures, map)
    if (!result) return null
    // Asset Maid crop pictures belong to the user's references (their crop data stays on the device) too.
    for (const picture of (mine.additionalAssets ?? []) as Asset[]) {
        if (String(picture?.[0] ?? '').startsWith(CROP_PREFIX) && findAsset(pictures, picture) < 0) {
            pictures.push([...picture])
            result.appended++
        }
    }
    merged.additionalAssets = pictures as Asset[]
    merged.globalLore = lore.map((entry, index) => index === at ? { ...entry, content: result.content } : entry)
    report(result.held, result.dropped)
    return result
}
