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
// A separate async hook after finalization reads closed chats on demand and keeps their named pictures alongside those from open chats.
// Skip module names during trash recovery, report ambiguous paths and unread chats, and skip names with no trash candidate.
// 0.9.103-ver4: a picture is found by its record (descriptor and occurrence, as Asset Maid finds it), not by its "asset:N" number, and
// Asset Maid's picture picks (features.assetSelection) go the same way as the references: rows joined by character, the new body's first.
import { toast } from 'svelte-sonner'
import { addLog } from '../log'
import { applyUpdate, CHARACTER_UPDATE, type UpdateChoice, type UpdatePlan } from '../characterUpdate'
import { fetchChatFromServer } from '../storage/chatStorage'
import { getDatabase, type character, type loreBook } from '../storage/database.svelte'

export const ASSET_MAID_COMMENT = '__ASSET_MAID_DATA__'
const CROP_PREFIX = '__asset_maid_crop_'
const FINGERPRINTS = ['exact', 'anchor', 'content'] as const

type Asset = [string, string, string]
type Reference = { asset?: string, [key: string]: unknown }
type Form = { id?: string, reference?: Reference | null, [key: string]: unknown }
type Entry = { target?: string, forms?: Form[], [key: string]: unknown }
type Fingerprinted = { fingerprints?: Record<string, string>, module?: unknown, occurrence?: number }
type CharacterReference = Reference & { target?: string }
type Selection = { selections?: { target?: string, assets?: unknown[] }[], characterReferences?: CharacterReference[] }
interface Portable {
    schema?: string
    entities?: { lorebooks?: Record<string, Fingerprinted>, assets?: Record<string, Fingerprinted>, [key: string]: unknown }
    features?: { characterForms?: { entries?: Entry[] }, assetSelection?: Selection, [key: string]: unknown }
    [key: string]: unknown
}

export type HeldReason = 'character-missing' | 'character-ambiguous' | 'form-missing' | 'asset-missing'
export interface HeldReference { side: 'mine' | 'theirs', target: string, character: string, formId: string, reference: Reference, reason: HeldReason, selection?: true }
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
    /** The user's own picture picks (assetSelection rows and character references) now on the new body. */
    selected: number
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
    // 0.9.103-ver4: Asset Maid trims a target, so " lore:3 " is lore:3 (a moved target is written without the spaces).
    const match = typeof ref === 'string' ? (kind === 'lore' ? /^lore:(\d+)$/.exec(ref.trim()) : /^asset:(\d+)$/.exec(ref)) : null
    return match ? Number(match[1]) : -1
}
const entriesOf = (data: Portable): Entry[] => Array.isArray(data.features?.characterForms?.entries) ? data.features!.characterForms!.entries! : []
const commentOf = (lore: readonly loreBook[] | undefined, target: unknown) => String(lore?.[indexOf(target, 'lore')]?.comment ?? '')
const isCustomTarget = (target: unknown) => typeof target === 'string' && target.startsWith('custom:') && target.length > 'custom:'.length

/**
 * The new body's entry for the character the user's entry points to, or why there is none. Each fingerprint, then the lore comment,
 * narrows the candidates; a test nobody passes is skipped. More than one left is ambiguous: the lore index alone proves nothing.
 */
function locate(entry: Entry, mine: { data: Portable, lore?: loreBook[] }, theirs: { data: Portable, lore?: loreBook[] }): Entry | HeldReason {
    // 0.9.103-ver4: every target that is not "lore:N" ("custom:…", "self", "description:self", member targets) is the same target.
    if (typeof entry.target === 'string' && indexOf(entry.target, 'lore') < 0) {
        const matches = entriesOf(theirs.data).filter(other => other.target === entry.target)
        return matches.length === 1 ? matches[0] : matches.length ? 'character-ambiguous' : 'character-missing'
    }
    const own = mine.data.entities?.lorebooks?.[entry.target ?? '']?.fingerprints ?? {}
    const tests: ((other: Entry) => boolean)[] = FINGERPRINTS.filter(kind => !!own[kind]).map(kind => (other: Entry) =>
        theirs.data.entities?.lorebooks?.[other.target ?? '']?.fingerprints?.[kind] === own[kind])
    const comment = commentOf(mine.lore, entry.target)
    if (comment) tests.push(other => commentOf(theirs.lore, other.target) === comment)
    let candidates = entriesOf(theirs.data).filter(other => !isCustomTarget(other.target)), narrowed = false
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

/** Asset Maid 0.9.91 cc, including its string-input form for legacy fingerprint lookups. */
function assetMaidFingerprint(input: string): string {
    const hashes = [2166136261, 2654435769, 2246822507, 3266489909]
    for (let i = 0; i < input.length; i++) for (let seed = 0; seed < hashes.length; seed++) {
        hashes[seed] ^= input.charCodeAt(i)
        hashes[seed] = Math.imul(hashes[seed], 16777619)
        hashes[seed] ^= hashes[seed] >>> 13
    }
    return `am2:${hashes.map(hash => (hash >>> 0).toString(16).padStart(8, '0')).join('')}`
}

/** Asset Maid 0.9.91 aee/AE/vRe, restricted to character arrays (YQ/cn/Bze/fi). */
function characterLocators(pictures: readonly unknown[]): ({ descriptor: string, fingerprint: string, occurrence: number } | null)[] {
    const text = (value: unknown) => value == null ? '' : String(value).trim()
    const seen = new Map<string, number>()
    return pictures.map(picture => {
        if (!Array.isArray(picture)) return null
        const name = text(picture[0]), key = text(picture[1])
        const extension = text(picture[2]).replace(/^\./, '').toLowerCase()
            || (text(name || key).split(/[\\/.]/g).at(-1)?.toLowerCase() ?? '')
        if (!name || !key || !['png', 'jpg', 'jpeg', 'webp', 'avif'].includes(extension)
            || name.startsWith(CROP_PREFIX)) return null
        // fi/jQ: only a valid, canonically labelled generated chat/outfit name is excluded.
        const generated = /^(.+)\.__am__\.(chat|outfit)\.([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/u.exec(name)
        if (generated) {
            const label = generated[1].normalize('NFKC').replace(/(?:\.__am__\.|\{\{|\}\}|<|>|[\u0000-\u001f\u007f])/giu, ' ')
                .replace(/[:"/\\|?*]/gu, ' ').replace(/\s+/gu, ' ').replace(/^[.\s]+|[.\s]+$/gu, '').slice(0, 96).trim() || 'Asset Maid'
            if (label === generated[1]) return null
        }
        const normalizedName = name.toLocaleLowerCase(), normalizedExtension = extension.trim().replace(/^\./u, '').toLocaleLowerCase()
        const bucket = [normalizedName, normalizedExtension, 'character', ''].join('\0')
        const occurrence = seen.get(bucket) ?? 0
        seen.set(bucket, occurrence + 1)
        const input = JSON.stringify({ name: normalizedName, extension: normalizedExtension, owner: 'self', origin: { kind: 'character' } })
        return { descriptor: assetMaidFingerprint(input), fingerprint: assetMaidFingerprint(bucket), occurrence }
    })
}

export function assetMaidCharacterLocators(pictures: readonly unknown[]): ({ descriptor: string, occurrence: number } | null)[] {
    return characterLocators(pictures).map(locator => locator ? { descriptor: locator.descriptor, occurrence: locator.occurrence } : null)
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
const TARGET_LISTS = new Set(['selectedTargets', 'workspaceDisabledTargets'])
/**
 * Every "lore:N" value and key of the body moved by the map. Something that points at an entry not in the merged lorebook is taken
 * out (an object whose target it is, a list item, a key), so no number is left to point at another character.
 * 0.9.103-ver4: as in Asset Maid, a lore number is a "target", an item of a target list (sourceSelection's selectedTargets and
 * workspaceDisabledTargets) or a key; other text ("label", "description", matching keys and aliases, …) stays as written even when it
 * reads "lore:N".
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
        const moved = typeof item === 'string' && key !== 'target' ? item
            : Array.isArray(item) && !TARGET_LISTS.has(key) ? item.map(entry => typeof entry === 'string' ? entry : moveLore(entry, map)).filter(entry => entry !== DROP)
            : moveLore(item, map)
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
    // 0.9.103-ver4: Asset Maid trims every target ("wr"); both bodies are read that way, so " lore:0 " and "lore:0" are one target below.
    const text = (value: unknown) => value == null ? '' : String(value).trim() // Asset Maid's wr()
    const trimmed = (key: string, value: unknown) => key === 'target' && value != null ? text(value) : value
    const sameId = (a: unknown, b: unknown) => a === b || text(a) === text(b) // form ids too
    own.data = JSON.parse(JSON.stringify(own.data), trimmed)
    let data: Portable = JSON.parse(JSON.stringify(other.data), trimmed)
    const mineAssets = (mine.additionalAssets ?? []) as Asset[], theirsAssets = (theirs.additionalAssets ?? []) as Asset[]
    const assets: Record<string, Fingerprinted> = {}
    const held: HeldReference[] = []
    let kept = 0, replaced = 0, appended = 0, selected = 0
    // Asset Maid finds a picture by its record (descriptor and occurrence among the character's pictures, legacy fingerprint too);
    // "asset:N" is only the number the body was written with and need not be the picture's position. The position is used as before
    // when the record names no character picture of that side.
    // A module picture is none of the card's pictures: it keeps its record under a number past every card picture the result can get
    // (one number per module picture, whichever side names it and however its record is written). A number without a record of its
    // side is not placed: it could only
    // point at some other picture.
    const sideLocators: Partial<Record<'mine' | 'theirs', ReturnType<typeof characterLocators>>> = {}
    const moduleTokens = new Map<string, string>(), moduleBase = result.length + mineAssets.length
    const place = (reference: Reference, side: 'mine' | 'theirs', append = side === 'mine'): Reference | null => {
        if (reference.asset === undefined) return { ...reference }
        const list = side === 'mine' ? mineAssets : theirsAssets, number = indexOf(reference.asset, 'asset')
        const record = (side === 'mine' ? own.data : other.data).entities?.assets?.[reference.asset]
        if (!record) return null
        if ('module' in record) {
            const key = JSON.stringify([record.module, record.fingerprints?.descriptor, record.occurrence ?? 0])
            let token = moduleTokens.get(key)
            if (!token) {
                token = `asset:${moduleBase + moduleTokens.size}`
                moduleTokens.set(key, token)
                assets[token] = JSON.parse(JSON.stringify(record))
            }
            return { ...reference, asset: token }
        }
        const descriptor = record.fingerprints?.descriptor
        let picture: unknown = list[number]
        if (descriptor) {
            const found = sideLocators[side] ??= characterLocators(list)
            const named = (locator: (typeof found)[number]) => !!locator && (locator.descriptor === descriptor || locator.fingerprint === descriptor) && locator.occurrence === (record.occurrence ?? 0)
            const match = named(found[number]) ? number : found.findIndex(named)
            if (match >= 0) picture = list[match]
        }
        if (!Array.isArray(picture)) return null
        let at = findAsset(result, picture as Asset)
        if (at < 0 && append) {
            result.push([...picture] as Asset)
            at = result.length - 1
            appended++
        }
        if (at < 0) return null
        assets[`asset:${at}`] = JSON.parse(JSON.stringify(record))
        return { ...reference, asset: `asset:${at}` }
    }
    // Only lore targets follow the lore map; "custom:…", "self", "description:self" and member targets stay.
    const placed = (entry: Entry) => !map || indexOf(entry.target, 'lore') < 0 || map.has(indexOf(entry.target, 'lore'))
    const dropped = entriesOf(data).filter(entry => !placed(entry)).map(entry => commentOf(theirs.globalLore, entry.target) || String(entry.target ?? ''))
    const droppedTargets = new Set(entriesOf(data).filter(entry => !placed(entry)).map(entry => String(entry.target ?? '')))
    // The new body's own references follow their pictures to their place in the result. One whose picture is not there yet is looked
    // for again after the user's references brought their pictures back (below).
    const missing: [Entry, Form, Reference][] = []
    for (const entry of entriesOf(data)) for (const form of entry.forms ?? []) {
        if (!form?.reference) continue
        const moved = placed(entry) ? place(form.reference, 'theirs') : null
        if (moved) form.reference = moved
        else {
            if (placed(entry)) missing.push([entry, form, form.reference])
            else held.push({ side: 'theirs', target: String(entry.target ?? ''), character: commentOf(theirs.globalLore, entry.target), formId: String(form.id ?? ''), reference: form.reference, reason: 'character-missing' })
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
    const ownSlots = new Set<Form>() // forms of the new body that took a reference of the user's
    for (const entry of entriesOf(own.data)) for (const form of entry.forms ?? []) {
        const reference = form?.reference
        if (!reference) continue
        const custom = isCustomTarget(entry.target)
        const empty = custom && Object.keys(reference).length === 0
        const note = (reason: HeldReason) => {
            if (!empty) held.push({ side: 'mine', target: String(entry.target ?? ''), character: commentOf(mine.globalLore, entry.target), formId: String(form.id ?? ''), reference, reason })
        }
        const target = located.get(entry)!
        if (typeof target === 'string') { note(target); continue }
        if (claims.get(target)!.size > 1) { note('character-ambiguous'); continue }
        if (!placed(target)) { note('character-missing'); continue }
        const slot = (target.forms ?? []).find(candidate => sameId(candidate?.id, form.id))
        if (!slot) { note('form-missing'); continue }
        if (empty) {
            slot.reference ??= {}
            continue
        }
        const moved = place(reference, 'mine')
        if (!moved) { note('asset-missing'); continue }
        if (slot.reference && (!custom || Object.keys(slot.reference).length > 0)) replaced++
        slot.reference = moved
        ownSlots.add(slot)
        kept++
    }
    // Asset Maid's picture picks (the rows of its asset analysis tab and the character references) take the same way, so every number
    // of the body keeps its record. Rows are joined by character: the new body's pictures first, then the user's picks not there yet.
    // A pick whose picture is not in the result is left out (no picture is added for a pick) and a row left empty is dropped; the user's
    // character reference wins on the same character, as a form reference does. Pictures the user's character references bring back
    // are settled before any pick or outfit reference is looked for.
    const selection = data.features?.assetSelection, ownSelection = own.data.features?.assetSelection
    const hold = (side: 'mine' | 'theirs', target: unknown, asset: unknown, reason: HeldReason) => held.push({ side, target: String(target ?? ''),
        character: commentOf(side === 'mine' ? mine.globalLore : theirs.globalLore, target), formId: '', reference: { asset: String(asset ?? '') }, reason, selection: true })
    // Where each of the user's rows (and references) goes: a lore target to the same character of the new body (any of its lore
    // targets, with or without forms); "self", "description:self", custom characters and members stay when the new body has them
    // (Asset Maid's own target check), a member's lore target when the new body's record of it is the same entry. Rows of two different
    // characters that land on one new character cannot both be right: both held.
    const candidates = { data: { ...data, features: { characterForms: { entries: [...new Set([...entriesOf(data).map(entry => entry.target),
        ...Object.keys(data.entities?.lorebooks ?? {})])].map(target => ({ target })) } } }, lore: theirs.globalLore }
    const customIds = new Set(((data.features?.characters as { entries?: { id?: unknown }[] } | undefined)?.entries ?? []).map(entry => text(entry?.id)))
    const members = (data.entities?.members ?? {}) as Record<string, unknown>
    const sameLore = (target: string) => {
        const before = own.data.entities?.lorebooks?.[target]?.fingerprints, after = data.entities?.lorebooks?.[target]?.fingerprints
        return !!before && !!after && FINGERPRINTS.some(kind => !!before[kind] && before[kind] === after[kind])
    }
    const targetKept = (target: string) => isCustomTarget(target) ? customIds.has(target.slice('custom:'.length))
        : target === 'self' || target === 'description:self' || !!members[target] || !!members[/^(member:\d+)\/description:self$/u.exec(target)?.[1] ?? '']
            || sameLore(target)
    const where = (list: unknown) => {
        const items = (Array.isArray(list) ? list : []).filter(item => typeof item?.target === 'string') as Entry[]
        const found = items.map((item): Entry | HeldReason => indexOf(item.target, 'lore') >= 0 ? locate(item, { data: own.data, lore: mine.globalLore }, candidates)
            : targetKept(item.target!) ? { target: item.target } : 'character-missing')
        return items.map((item, index): [Entry, Entry | HeldReason] => {
            const target = found[index]
            if (typeof target === 'string') return [item, target]
            return [item, found.some((other, at) => other === target && items[at].target !== item.target) ? 'character-ambiguous' : placed(target) ? target : 'character-missing']
        })
    }
    const ownReferences: CharacterReference[] = []
    // Asset Maid ignores a character reference of a character that has forms: such a reference of the installed body was never in use.
    const ownFormTargets = new Set(entriesOf(own.data).map(entry => String(entry.target ?? '').trim())) // Asset Maid trims targets
    const ownCharacterReferences = where((Array.isArray(ownSelection?.characterReferences) ? ownSelection.characterReferences : [])
        .filter(reference => !ownFormTargets.has(String(reference?.target ?? '').trim())))
    for (const [index, [reference, target]] of ownCharacterReferences.entries()) {
        // Asset Maid takes the last reference of a target: an earlier one of the same target was never in use.
        if (ownCharacterReferences.slice(index + 1).some(([later]) => later.target === reference.target)) continue
        if (typeof target === 'string') { hold('mine', reference.target, (reference as CharacterReference).asset, target); continue }
        // Asset Maid uses a character reference only for a character without forms: where the new body gave the character forms the
        // installed body did not have, the user's reference goes to its default form, as a form reference of the user's would. A form
        // that already took another reference of the user's (from another installed character) keeps it; this one is held.
        const forms = entriesOf(data).find(entry => entry.target === target.target)
        const slot = forms ? (forms.forms ?? []).find(form => sameId(form?.id, forms.defaultFormId)) ?? forms.forms?.[0] : undefined
        if (slot && ownSlots.has(slot)) { hold('mine', reference.target, (reference as CharacterReference).asset, 'character-ambiguous'); continue }
        const moved = place(reference as CharacterReference, 'mine')
        if (!moved) { hold('mine', reference.target, (reference as CharacterReference).asset, 'asset-missing'); continue }
        selected++
        if (slot) {
            const copy: Reference = { ...moved }
            delete copy.target
            slot.reference = copy
            ownSlots.add(slot)
            continue
        }
        ownReferences.push({ ...moved, target: target.target })
    }
    // The new body's form references that missed their picture, now that every picture the user's references need is back; a form
    // the user's reference took stays the user's (as on any form the user set), only a picture still missing is reported.
    for (const [entry, form, reference] of missing) {
        if (form.reference && (!isCustomTarget(entry.target) || Object.keys(form.reference).length > 0)) continue // as for the user's own
        const moved = place(reference, 'theirs')
        if (moved) form.reference = moved
        else held.push({ side: 'theirs', target: String(entry.target ?? ''), character: commentOf(theirs.globalLore, entry.target), formId: String(form.id ?? ''), reference, reason: 'asset-missing' })
    }
    // The new body's outfit references (forms[].outfits[], features.outfits) follow their pictures too, or their numbers would be left
    // without a record.
    const outfits = data.features?.outfits as { entries?: Entry[] } | undefined
    for (const [entry, list] of [...entriesOf(data).flatMap(entry => (entry.forms ?? []).map(form => [entry, form?.outfits] as const)),
        ...(Array.isArray(outfits?.entries) ? outfits.entries : []).map(entry => [entry, entry?.outfits] as const)]) {
        for (const outfit of (Array.isArray(list) ? list : []) as Form[]) {
            if (!outfit?.reference) continue
            const moved = placed(entry) ? place(outfit.reference, 'theirs') : null
            if (moved) outfit.reference = moved
            else {
                held.push({ side: 'theirs', target: String(entry.target ?? ''), character: commentOf(theirs.globalLore, entry.target), formId: String(outfit.id ?? ''), reference: outfit.reference, reason: placed(entry) ? 'asset-missing' : 'character-missing' })
                delete outfit.reference
            }
        }
    }
    if (selection || ownSelection) {
        const rows = new Map<string, string[]>(), references = new Map<string, CharacterReference>()
        const pick = (token: unknown, side: 'mine' | 'theirs') => typeof token === 'string' ? place({ asset: token }, side, false)?.asset : undefined
        // A pick named twice for one character (in one row or two) counts once.
        const seen = new Set<string>()
        const first = (side: 'mine' | 'theirs', target: string, token: unknown) => !seen.has(JSON.stringify([side, target, token])) && !!seen.add(JSON.stringify([side, target, token]))
        // A row or reference of the new body whose lore entry is left out goes with it (reported with the dropped characters).
        const drop = (target: string) => {
            if (droppedTargets.has(target)) return
            droppedTargets.add(target)
            dropped.push(commentOf(theirs.globalLore, target) || target)
        }
        for (const row of Array.isArray(selection?.selections) ? selection.selections : []) {
            if (typeof row?.target !== 'string') continue
            if (!placed(row)) { drop(row.target); continue }
            const tokens = rows.get(row.target) ?? []
            for (const token of Array.isArray(row.assets) ? row.assets : []) {
                if (!first('theirs', row.target, token)) continue
                const moved = pick(token, 'theirs')
                if (!moved) hold('theirs', row.target, token, 'asset-missing')
                else if (!tokens.includes(moved)) tokens.push(moved)
            }
            rows.set(row.target, tokens)
        }
        const theirsCharacterReferences = Array.isArray(selection?.characterReferences) ? selection.characterReferences : []
        for (const [index, reference] of theirsCharacterReferences.entries()) {
            if (typeof reference?.target !== 'string') continue
            if (theirsCharacterReferences.slice(index + 1).some(later => later?.target === reference.target)) continue // the last one is in use
            if (!placed(reference)) { drop(reference.target); continue }
            const moved = place(reference, 'theirs')
            if (moved) references.set(reference.target, moved)
            else hold('theirs', reference.target, reference.asset, 'asset-missing')
        }
        for (const reference of ownReferences) references.set(reference.target!, reference)
        for (const [row, target] of where(ownSelection?.selections)) {
            const assets = Array.isArray(row.assets) ? row.assets : []
            if (typeof target === 'string') { for (const token of assets) if (first('mine', row.target!, token)) hold('mine', row.target, token, target); continue }
            const tokens = rows.get(target.target!) ?? []
            for (const token of assets) {
                if (!first('mine', target.target!, token)) continue
                const moved = pick(token, 'mine')
                if (!moved) { hold('mine', row.target, token, 'asset-missing'); continue }
                if (!tokens.includes(moved)) tokens.push(moved)
                selected++
            }
            rows.set(target.target!, tokens)
        }
        const next: Selection = { ...selection }
        const filled = [...rows].filter(([, tokens]) => tokens.length).map(([target, assets]) => ({ target, assets }))
        if (filled.length || Array.isArray(selection?.selections)) next.selections = filled
        if (references.size || Array.isArray(selection?.characterReferences)) next.characterReferences = [...references.values()]
        if (selection || Object.keys(next).length) data.features = { ...data.features, assetSelection: next }
    }
    // Final order includes user-added pictures; occurrence counts every eligible picture, not just referenced ones.
    const locators = assetMaidCharacterLocators(result)
    for (const [token, record] of Object.entries(assets)) {
        if ('module' in record) continue
        const locator = locators[indexOf(token, 'asset')]
        if (!locator || (record.fingerprints?.descriptor === locator.descriptor && (record.occurrence ?? 0) === locator.occurrence)) continue
        record.fingerprints = { ...record.fingerprints, descriptor: locator.descriptor }
        if (locator.occurrence > 0) record.occurrence = locator.occurrence
        else delete record.occurrence
    }
    const entities = { ...(data.entities ?? {}) }
    if (Object.keys(assets).length) entities.assets = assets
    else delete entities.assets
    data.entities = entities
    if (map) data = moveLore(data, map) as Portable
    return { content: other.prefix + JSON.stringify(data), kept, replaced, held, appended, dropped, selected }
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
    if (!merged || (merged.kept === 0 && merged.selected === 0)) return null
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
    const lines = held.map(entry => entry.selection
        ? `${entry.character || entry.target} / 에셋 선택 (${entry.side === 'mine' ? '내 선택' : '새 판 선택'}: ${reasonText[entry.reason]}, ${entry.reference.asset ?? ''})`
        : `${entry.character || entry.target} / ${entry.formId} (${entry.side === 'mine' ? '내 레퍼런스' : '새 판 레퍼런스'}: ${reasonText[entry.reason]}, ${entry.reference.asset ?? ''})`)
    for (const name of dropped) lines.push(`${name} (업데이트 뒤 로어에 없어 Asset Maid 설정에서 뺌)`)
    const picks = held.filter(entry => entry.selection).length
    const what = !picks ? '레퍼런스' : picks === held.length ? '선택 그림' : '레퍼런스·선택 그림'
    const message = held.length ? `Asset Maid ${what} ${held.length}개는 새 판으로 옮기지 못했어요(보류).` : `Asset Maid 인물 ${dropped.length}개는 업데이트 뒤 로어에 없어 설정에서 뺐어요.`
    addLog({ level: 'warning', message, description: lines.join('\n'), source: 'character-update' })
    // Not notifyWarning: it would also close the "applying" notice of the import that is still running.
    toast.warning(message, { description: lines.slice(0, 8).join('\n') + (lines.length > 8 ? `\n… 외 ${lines.length - 8}개 (로그)` : '') })
}

/**
 * After the choices are applied (offerUpdate, with the decision's plan and choices): renumbers the preselected merge against the final
 * lorebook and pictures. Does nothing unless the user applied the preselected edit as it was ('edit' with exactly that text).
 */
function finalizePendingAssetMaidMerge(merged: character, mine: character, theirs: character, plan: UpdatePlan, choices: Record<string, UpdateChoice>): AssetMaidMerge | null {
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

/** Repair unresolved character records only when the resolved records prove asset numbers still follow picture positions. */
function repairAssetMaidRecords(merged: character) {
    const lore = Array.isArray(merged.globalLore) ? merged.globalLore : []
    const entries = lore.filter(entry => entry?.comment === ASSET_MAID_COMMENT)
    if (entries.length !== 1) return
    const parsed = parse(entries[0].content)
    const assets = parsed?.data.entities?.assets
    if (!parsed || !assets || typeof assets !== 'object' || Array.isArray(assets)) return
    const locators = characterLocators(Array.isArray(merged.additionalAssets) ? merged.additionalAssets : [])
    const buckets = new Map<string, NonNullable<typeof locators[number]>[]>()
    for (const locator of locators) if (locator) {
        for (const fingerprint of new Set([locator.descriptor, locator.fingerprint])) {
            const bucket = buckets.get(fingerprint) ?? []
            bucket.push(locator)
            buckets.set(fingerprint, bucket)
        }
    }
    const unresolved: [string, Fingerprinted][] = []
    let resolved = 0, aligned = true
    for (const [token, record] of Object.entries(assets)) {
        if (!record || typeof record !== 'object' || Array.isArray(record) || 'module' in record) continue
        if (!record.fingerprints || typeof record.fingerprints !== 'object' || Array.isArray(record.fingerprints)
            || typeof record.fingerprints.descriptor !== 'string' || (record.occurrence !== undefined && (!Number.isInteger(record.occurrence) || record.occurrence < 0))) continue
        const occurrence = record.occurrence ?? 0
        // kRe/LA also registers legacy fingerprints: a record that still resolves must never be repaired.
        const found = buckets.get(record.fingerprints?.descriptor ?? '')?.[occurrence]
        if (!found) { unresolved.push([token, record]); continue }
        resolved++
        const numbered = locators[indexOf(token, 'asset')]
        if (!numbered || record.fingerprints?.descriptor !== numbered.descriptor || occurrence !== numbered.occurrence) aligned = false
    }
    if (!unresolved.length) return
    const reasons: string[] = []
    let fixed = 0
    if (!resolved) reasons.push('풀리는 캐릭터 그림 기록이 없어 그림 번호를 확인할 수 없음')
    else if (!aligned) reasons.push('풀리는 기록의 지문·순번이 자기 번호의 그림과 일치하지 않아 그림 번호를 확인할 수 없음')
    else for (const [token, record] of unresolved) {
        const locator = locators[indexOf(token, 'asset')]
        if (!locator) { reasons.push(`${token}: 그림이 없거나 Asset Maid 대상 그림이 아님`); continue }
        record.fingerprints = { ...record.fingerprints, descriptor: locator.descriptor }
        if (locator.occurrence > 0) record.occurrence = locator.occurrence
        else delete record.occurrence
        fixed++
    }
    if (fixed) {
        const content = parsed.prefix + JSON.stringify(parsed.data)
        merged.globalLore = lore.map(entry => entry === entries[0] ? { ...entry, content } : entry)
    }
    const remaining = unresolved.length - fixed
    const message = `Asset Maid 그림 기록 ${fixed}개를 복구했어요. ${remaining}개는 그대로 뒀어요.`
    const description = reasons.length ? reasons.join('\n') : '그림 번호가 실제 그림 위치와 같은 것을 확인해, 풀리지 않는 기록의 지문과 순번만 바로잡았어요.'
    addLog({ level: remaining ? 'warning' : 'info', message, description, source: 'character-update' })
    if (remaining) toast.warning(message, { description: reasons[0] })
    else toast.success(message)
}

export async function keepChatPictures(merged: character, mine: character): Promise<void> {
    // Matches assetRegex in parser/parser.svelte.ts; source tokens aren't picture names here.
    const assetRegex = /{{(raw|path|img|image|video|audio|bgm|bg|emotion|asset|video-img|source)::(.+?)}}/gms
    const assets = new Map<string, string>(), emotions = new Map<string, string>()
    let unread = 0
    const chats = Array.isArray(mine.chats) ? mine.chats : []
    for (const [index, chat] of chats.entries()) {
        let messages = chat?.message
        if (!Array.isArray(messages) || chat._placeholder === true) {
            if (!chat?.id) continue
            try {
                messages = (await fetchChatFromServer(mine.chaId, index, chat.id))?.message
            } catch {
                messages = undefined
            }
            if (!Array.isArray(messages)) {
                unread++
                continue
            }
        }
        for (const message of messages) {
            if (typeof message?.data !== 'string') continue
            for (const [, type, name] of message.data.matchAll(assetRegex)) {
                if (type === 'source') continue
                const names = type === 'emotion' ? emotions : assets
                const key = name.toLocaleLowerCase()
                if (!names.has(key)) names.set(key, name)
            }
        }
    }

    const pictureName = (picture: unknown) => Array.isArray(picture) && typeof picture[0] === 'string' ? picture[0].toLocaleLowerCase() : ''
    const notes: string[] = []
    const note = (name: string, action: string) => {
        if (notes.length < 20) notes.push(`${name} (${action})`)
    }
    let kept = 0, recovered = 0, held = 0
    let db: ReturnType<typeof getDatabase> | undefined
    let moduleNames: Set<string> | undefined
    function additions<T extends [string, string, ...string[]]>(names: Map<string, string>, result: T[] | undefined,
        installed: T[] | undefined, fromBackup: (backup: character) => T[] | undefined): T[] {
        if (!names.size) return []
        for (const picture of Array.isArray(result) ? result : []) names.delete(pictureName(picture))
        if (!names.size) return []

        const appended: T[] = []
        const keptNames = new Set<string>()
        for (const picture of Array.isArray(installed) ? installed : []) {
            const key = pictureName(picture)
            if (!names.has(key)) continue
            appended.push([...picture] as T)
            keptNames.add(key)
        }
        for (const key of keptNames) {
            note(names.get(key)!, '보존')
            names.delete(key)
            kept++
        }
        if (!names.size) return appended

        db ??= getDatabase()
        moduleNames ??= new Set((db.modules ?? []).flatMap(module => Array.isArray(module?.assets) ? module.assets.map(pictureName) : []))
        for (const key of names.keys()) if (moduleNames.has(key)) names.delete(key)
        if (!names.size) return appended

        const candidates = new Map<string, T | null>()
        for (const backup of db.characters ?? []) {
            if (!backup?.trashTime || backup.chaId === mine.chaId) continue
            const pictures = fromBackup(backup)
            if (!Array.isArray(pictures)) continue
            for (const picture of pictures) {
                const key = pictureName(picture)
                if (!names.has(key) || typeof picture[1] !== 'string' || !picture[1]) continue
                const previous = candidates.get(key)
                if (previous === undefined) candidates.set(key, picture)
                else if (previous && previous[1] !== picture[1]) candidates.set(key, null)
            }
        }
        for (const [key, name] of names) {
            const picture = candidates.get(key)
            if (picture) {
                appended.push([...picture] as T)
                recovered++
                note(name, '복구')
            } else if (picture === null) {
                held++
                note(name, '보류: 경로가 여럿')
            }
        }
        return appended
    }

    const newAssets = additions(assets, merged.additionalAssets, mine.additionalAssets, backup => backup.additionalAssets)
    if (newAssets.length) merged.additionalAssets = [...(Array.isArray(merged.additionalAssets) ? merged.additionalAssets : []), ...newAssets]
    const newEmotions = additions(emotions, merged.emotionImages, mine.emotionImages, backup => backup.emotionImages)
    if (newEmotions.length) merged.emotionImages = [...(Array.isArray(merged.emotionImages) ? merged.emotionImages : []), ...newEmotions]

    const total = kept + recovered + held
    if (!total && !unread) return
    const message = `채팅이 쓰는 그림 ${kept + recovered}개를 업데이트 뒤에도 연결해 뒀어요(보존 ${kept}, 복구 ${recovered}).`
        + (held ? ` ${held}개는 연결하지 못했어요.` : '')
        + (unread ? ` 채팅 ${unread}개는 읽지 못해 확인하지 못했어요.` : '')
    const description = notes.join('\n') + (total > notes.length ? `\n… 외 ${total - notes.length}개` : '')
    addLog({ level: held || unread ? 'warning' : 'info', message, description, source: 'character-update' })
    if (held || unread) toast.warning(message, held ? { description: '보류된 그림의 이름과 사유는 로그에서 확인할 수 있어요.' } : undefined)
    else toast.success(message)
}

/** Finalize the preselected merge, then check the chosen Portable body even when the choice stayed 'mine'. */
export function finalizeAssetMaidMerge(merged: character, mine: character, theirs: character, plan: UpdatePlan, choices: Record<string, UpdateChoice>): AssetMaidMerge | null {
    const result = finalizePendingAssetMaidMerge(merged, mine, theirs, plan, choices)
    repairAssetMaidRecords(merged)
    return result
}
