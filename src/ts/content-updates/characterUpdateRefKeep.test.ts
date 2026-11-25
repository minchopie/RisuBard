import { beforeEach, describe, expect, test, vi } from 'vitest'
vi.mock('svelte-sonner', () => ({ toast: { warning: vi.fn(), success: vi.fn() } }))
vi.mock('../log', () => ({ addLog: vi.fn() }))
vi.mock('../storage/chatStorage', () => ({ fetchChatFromServer: vi.fn() }))
vi.mock('../storage/database.svelte', () => ({ getDatabase: vi.fn() }))
import { toast } from 'svelte-sonner'
import { addLog } from '../log'
import { fetchChatFromServer } from '../storage/chatStorage'
import type { character, loreBook } from '../storage/database.svelte'
import { getDatabase } from '../storage/database.svelte'
import { CHARACTER_UPDATE, applyUpdate, baseSnapshot, planUpdate, type UpdateChoice, type UpdatePlan } from '../characterUpdate'
import { editedValue } from '../characterUpdateView'
import { ASSET_MAID_COMMENT, assetMaidCharacterLocators, applyAssetMaidPreset, finalizeAssetMaidMerge as finalizeWith, keepChatPictures, mergeAssetMaid, presetAssetMaidMerge } from './characterUpdateRefKeep'

const lore = (comment: string, content: string, extra: Partial<loreBook> = {}): loreBook => ({
    key: comment.toLowerCase(), secondkey: '', insertorder: 100, comment, content, mode: 'normal', alwaysActive: false, selective: false, bookVersion: 2, ...extra,
})
const fp = (name: string) => ({ fingerprints: { exact: `am2:${name}-x`, content: `am2:${name}-c`, anchor: `am2:${name}-a` } })
type FormSpec = { id: string, asset?: number }
type EntrySpec = { at: number, fp: string, forms: FormSpec[] }
function maidEntry(entries: EntrySpec[], assets: Record<number, string> = {}, extra: Partial<loreBook> = {}): loreBook {
    const data: any = {
        schema: 'asset-maid.portable', version: 1, scope: 'character',
        entities: { lorebooks: Object.fromEntries(entries.map(entry => [`lore:${entry.at}`, fp(entry.fp)])) },
        features: { characterForms: { entries: entries.map(entry => ({ target: `lore:${entry.at}`, defaultFormId: entry.forms[0]?.id, forms: entry.forms.map(form => ({ id: form.id, label: form.id, ...(form.asset !== undefined ? { reference: { asset: `asset:${form.asset}` } } : {}) })) })) } },
    }
    if (Object.keys(assets).length) data.entities.assets = Object.fromEntries(Object.entries(assets).map(([index, name]) => [`asset:${index}`, { fingerprints: { descriptor: assetMaidCharacterLocators([pic(name)])[0]?.descriptor ?? `am2:${name}` } }]))
    return lore(ASSET_MAID_COMMENT, '@@dont_activate ' + JSON.stringify(data), { key: '', ...extra })
}
const portable = (entry: loreBook | undefined) => JSON.parse(entry!.content.slice(entry!.content.indexOf('{')))
const refs = (entry: loreBook | undefined) => portable(entry).features.characterForms.entries.flatMap((e: any) => e.forms.filter((f: any) => f.reference).map((f: any) => `${e.target}/${f.id}=${f.reference.asset}`))
const pic = (name: string): [string, string, string] => [name, `assets/${name}.png`, 'png']

function bot(overrides: Partial<character> = {}): character {
    return { chaId: 'installed', name: 'Bot', desc: 'd', firstMessage: 'hi', notes: '', chats: [], chatFolders: [], chatPage: 0, viewScreen: 'none', bias: [],
        emotionImages: [], globalLore: [], sdData: [], customscript: [], triggerscript: [], utilityBot: false, exampleMessage: '', creatorNotes: '',
        systemPrompt: '', postHistoryInstructions: '', alternateGreetings: [], tags: [], creator: 'maker', characterVersion: '1', personality: '',
        scenario: '', firstMsgIndex: -1, replaceGlobalNote: '', additionalText: '', extentions: {}, additionalAssets: [], ...overrides } as character
}

let last: { plan: UpdatePlan, choices: Record<string, UpdateChoice> } | null = null
/** Mirrors chooseCharacterUpdate + offerUpdate in characterUpdateFlow: an 'edit' pick becomes { value } built by upstream editedValue. */
function apply(plan: UpdatePlan, mine: character, theirs: character, picks: Record<string, 'mine' | 'theirs' | 'edit'>, edits: Record<string, string>) {
    const choices: Record<string, UpdateChoice> = {}
    for (const item of plan.items) {
        const pick = picks[item.id]
        if (pick === 'edit') choices[item.id] = { value: editedValue(item, edits[item.id]) }
        else if (pick) choices[item.id] = pick
    }
    last = { plan, choices }
    return applyUpdate(CHARACTER_UPDATE, mine, theirs, plan, choices)
}
/** The offerUpdate hook: finalize with the plan and choices the merge was applied with. */
const finalize = (merged: character, mine: character, theirs: character) => finalizeWith(merged, mine, theirs, last!.plan, last!.choices)

/** Installed: two characters, the user's pictures after the card's, references on both. New: a changed body, one more card picture. */
function scenario() {
    const people = [lore('Character: Aria', 'aria'), lore('Character: Bea', 'bea')]
    const base = bot({ globalLore: [...people], additionalAssets: [pic('card1')] })
    const mine = bot({
        globalLore: [...people, maidEntry([{ at: 0, fp: 'aria', forms: [{ id: 'f1', asset: 1 }, { id: 'f2', asset: 2 }] }, { at: 1, fp: 'bea', forms: [{ id: 'g1', asset: 1 }] }], { 1: 'u1', 2: 'u2' }, { id: 'maid-id' })],
        additionalAssets: [pic('card1'), pic('u1'), pic('u2'), pic('__asset_maid_crop_x1')],
    })
    // The author moved Bea before Aria, added a picture before the user's and shipped a body without references.
    const theirs = bot({
        chaId: 'incoming', characterVersion: '2',
        globalLore: [lore('Character: Bea', 'bea'), lore('Character: Aria', 'aria'), maidEntry([{ at: 1, fp: 'aria', forms: [{ id: 'f1' }, { id: 'f2' }] }, { at: 0, fp: 'bea', forms: [{ id: 'g1' }] }])],
        additionalAssets: [pic('card1'), pic('card2')],
    })
    return { mine, theirs, base }
}

beforeEach(() => vi.clearAllMocks())

describe('lore format copies (A1)', () => {
    test('risu_id, risu_loreCache and risu_bookVersion in extentions are not edits', () => {
        const entry = lore('World', 'text', { extentions: { risu_case_sensitive: false, note: 'a' } })
        const imported = lore('World', 'text', { extentions: { risu_case_sensitive: false, note: 'a', risu_id: 'x', risu_loreCache: null, risu_bookVersion: 2 } })
        expect(planUpdate(CHARACTER_UPDATE, bot({ globalLore: [entry] }), bot({ globalLore: [imported] }), bot({ globalLore: [entry] })).items).toEqual([])
        expect(planUpdate(CHARACTER_UPDATE, bot({ globalLore: [entry] }), bot({ globalLore: [imported] }), null).items).toEqual([])
        // An entry the user rewrote stays theirs to keep: only the copies differ on the author's side.
        const rewritten = lore('World', 'my text', { extentions: { risu_case_sensitive: false, note: 'a' } })
        const plan = planUpdate(CHARACTER_UPDATE, bot({ globalLore: [rewritten] }), bot({ globalLore: [imported] }), bot({ globalLore: [entry] }))
        expect(plan.items.map(item => [item.status, item.choice])).toEqual([['mine', 'mine']])
        // Real extension changes still count, and an extentions object left empty equals none.
        const changed = lore('World', 'text', { extentions: { risu_case_sensitive: false, note: 'b', risu_id: 'x' } })
        expect(planUpdate(CHARACTER_UPDATE, bot({ globalLore: [entry] }), bot({ globalLore: [changed] }), bot({ globalLore: [entry] })).items.map(item => item.status)).toEqual(['update'])
        const bare = lore('World', 'text')
        expect(planUpdate(CHARACTER_UPDATE, bot({ globalLore: [bare] }), bot({ globalLore: [lore('World', 'text', { extentions: { risu_id: 'x' } })] }), bot({ globalLore: [bare] })).items).toEqual([])
    })
})

describe('Asset Maid references across a card update (A2)', () => {
    test('preselects the new body with the user references, renumbered to the default picture order', () => {
        const { mine, theirs, base } = scenario()
        const plan = planUpdate(CHARACTER_UPDATE, mine, theirs, base)
        const item = plan.items.find(entry => entry.field === 'globalLore' && entry.status === 'conflict')!
        const keep = presetAssetMaidMerge(plan, mine, theirs)!
        expect(keep.id).toBe(item.id)
        expect(keep.kept).toBe(3)
        expect(keep.held).toEqual([])
        expect(keep.text.startsWith('@@dont_activate {')).toBe(true)
        // Default order (upstream mergeList): card1, then the user's u1, u2, crop after it, then the new card2.
        expect(refs({ content: keep.text } as loreBook).sort()).toEqual(['lore:0/g1=asset:1', 'lore:1/f1=asset:1', 'lore:1/f2=asset:2'])
    })

    test('a bulk "모두 새 버전" keeps the merge, the pictures it needs and the crop pictures', () => {
        const { mine, theirs, base } = scenario()
        const plan = planUpdate(CHARACTER_UPDATE, mine, theirs, base)
        const keep = presetAssetMaidMerge(plan, mine, theirs)!
        const picks: Record<string, 'mine' | 'theirs' | 'edit'> = { [keep.id]: 'edit' }
        for (const item of plan.items) if (picks[item.id] !== 'edit') picks[item.id] = 'theirs' // chooseCharacterUpdateMany skips 'edit'
        const merged = apply(plan, mine, theirs, picks, { [keep.id]: keep.text })
        expect(merged.additionalAssets!.map(asset => asset[0])).toEqual(['card1', 'card2'])
        const result = finalize(merged, mine, theirs)!
        expect(result).toMatchObject({ kept: 3, held: [], appended: 3 })
        expect(merged.additionalAssets!.map(asset => asset[0])).toEqual(['card1', 'card2', 'u1', 'u2', '__asset_maid_crop_x1'])
        const entry = merged.globalLore.find(e => e.comment === ASSET_MAID_COMMENT)
        expect(entry!.id).toBe('maid-id')
        expect(refs(entry).sort()).toEqual(['lore:0/g1=asset:2', 'lore:1/f1=asset:2', 'lore:1/f2=asset:3'])
        expect(portable(entry).entities.assets).toEqual({ 'asset:2': { fingerprints: { descriptor: assetMaidCharacterLocators([pic('u1')])[0]!.descriptor } }, 'asset:3': { fingerprints: { descriptor: assetMaidCharacterLocators([pic('u2')])[0]!.descriptor } } })
        // Everything else of the new body is the new body.
        const body = portable(entry)
        for (const e of body.features.characterForms.entries) for (const f of e.forms) delete f.reference
        delete body.entities.assets
        expect(body).toEqual(portable(theirs.globalLore[2]))
    })

    test('the new body\'s own references follow their pictures, and the user reference wins on the same form', () => {
        const { mine, theirs, base } = scenario()
        theirs.globalLore[2] = maidEntry([{ at: 1, fp: 'aria', forms: [{ id: 'f1', asset: 1 }, { id: 'f2' }] }, { at: 0, fp: 'bea', forms: [{ id: 'g1' }, { id: 'g2', asset: 1 }] }], { 1: 'card2' })
        const plan = planUpdate(CHARACTER_UPDATE, mine, theirs, base)
        const keep = presetAssetMaidMerge(plan, mine, theirs)!
        const merged = apply(plan, mine, theirs, { [keep.id]: 'edit' }, { [keep.id]: keep.text })
        const result = finalize(merged, mine, theirs)!
        expect(result.replaced).toBe(1)
        const entry = merged.globalLore.find(e => e.comment === ASSET_MAID_COMMENT)
        expect(merged.additionalAssets!.map(asset => asset[0])).toEqual(['card1', 'u1', 'u2', '__asset_maid_crop_x1', 'card2'])
        expect(result.appended).toBe(0)
        expect(refs(entry).sort()).toEqual(['lore:0/g1=asset:1', 'lore:0/g2=asset:4', 'lore:1/f1=asset:1', 'lore:1/f2=asset:2'])
        expect(portable(entry).entities.assets['asset:4']).toEqual({ fingerprints: { descriptor: assetMaidCharacterLocators([pic('card2')])[0]!.descriptor } })
    })

    test('references whose character or form is gone are held and reported, the rest move', () => {
        const { mine, theirs, base } = scenario()
        theirs.globalLore = [lore('Character: Aria', 'aria'), maidEntry([{ at: 0, fp: 'aria', forms: [{ id: 'f1' }] }])]
        const plan = planUpdate(CHARACTER_UPDATE, mine, theirs, base)
        const keep = presetAssetMaidMerge(plan, mine, theirs)!
        expect(keep.held.map(entry => [entry.character, entry.formId, entry.reason])).toEqual([
            ['Character: Aria', 'f2', 'form-missing'], ['Character: Bea', 'g1', 'character-missing'],
        ])
        const merged = apply(plan, mine, theirs, { [keep.id]: 'edit' }, { [keep.id]: keep.text })
        const result = finalize(merged, mine, theirs)!
        expect(result.held).toHaveLength(2)
        expect(refs(merged.globalLore.find(e => e.comment === ASSET_MAID_COMMENT))).toEqual(['lore:0/f1=asset:1'])
        expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(1)
        expect(String(vi.mocked(toast.warning).mock.calls[0][0])).toContain('2개')
    })

    test('falls back to the lore comment when the fingerprints changed', () => {
        const { mine, theirs, base } = scenario()
        theirs.globalLore[2] = maidEntry([{ at: 1, fp: 'aria-v2', forms: [{ id: 'f1' }, { id: 'f2' }] }, { at: 0, fp: 'bea-v2', forms: [{ id: 'g1' }] }])
        const keep = presetAssetMaidMerge(planUpdate(CHARACTER_UPDATE, mine, theirs, base), mine, theirs)!
        expect(keep.kept).toBe(3)
        expect(refs({ content: keep.text } as loreBook).sort()).toEqual(['lore:0/g1=asset:1', 'lore:1/f1=asset:1', 'lore:1/f2=asset:2'])
    })

    test('text the user rewrote or a side picked by hand is left as chosen', () => {
        for (const pick of ['edit', 'mine', 'theirs'] as const) {
            const { mine, theirs, base } = scenario()
            const plan = planUpdate(CHARACTER_UPDATE, mine, theirs, base)
            const keep = presetAssetMaidMerge(plan, mine, theirs)!
            const text = pick === 'edit' ? keep.text.replace('"version":1', '"version":1,"note":"mine"') : ''
            const merged = apply(plan, mine, theirs, { [keep.id]: pick }, { [keep.id]: text })
            const before = JSON.stringify(merged)
            expect(finalize(merged, mine, theirs)).toBeNull()
            expect(JSON.stringify(merged)).toBe(before)
        }
    })

    test('nothing is preselected without user references, outside a two-sided change, or for another update', () => {
        const { mine, theirs, base } = scenario()
        const bare = bot({ globalLore: [...mine.globalLore.slice(0, 2), maidEntry([{ at: 0, fp: 'aria', forms: [{ id: 'f1' }] }])] })
        expect(presetAssetMaidMerge(planUpdate(CHARACTER_UPDATE, bare, theirs, base), bare, theirs)).toBeNull()
        // The user's entry unchanged since install: upstream already takes the new one.
        const installed = bot({ ...mine, globalLore: [...mine.globalLore] })
        const sameBase = bot({ ...base, globalLore: [...mine.globalLore] })
        expect(presetAssetMaidMerge(planUpdate(CHARACTER_UPDATE, installed, theirs, sameBase), installed, theirs)).toBeNull()
        // A finalize for another bot or import does nothing.
        const plan = planUpdate(CHARACTER_UPDATE, mine, theirs, base)
        const keep = presetAssetMaidMerge(plan, mine, theirs)!
        const merged = apply(plan, mine, theirs, { [keep.id]: 'edit' }, { [keep.id]: keep.text })
        expect(finalize(merged, mine, bot({ ...theirs }))).toBeNull()
    })

    test('without a base the entry is preselected the same way', () => {
        const { mine, theirs } = scenario()
        const plan = planUpdate(CHARACTER_UPDATE, mine, theirs, null)
        const keep = presetAssetMaidMerge(plan, mine, theirs)!
        expect(plan.items.find(item => item.id === keep.id)!.status).toBe('differs')
        const picks: Record<string, 'mine' | 'theirs' | 'edit'> = { [keep.id]: 'edit' }
        for (const item of plan.items) if (picks[item.id] !== 'edit') picks[item.id] = 'theirs'
        const merged = apply(plan, mine, theirs, picks, { [keep.id]: keep.text })
        expect(finalize(merged, mine, theirs)).toMatchObject({ kept: 3, held: [] })
        expect(refs(merged.globalLore.find(e => e.comment === ASSET_MAID_COMMENT)).sort()).toEqual(['lore:0/g1=asset:2', 'lore:1/f1=asset:2', 'lore:1/f2=asset:3'])
    })

    test('a base file loaded later renumbers an untouched preselection and keeps a pick of the user\'s', () => {
        const { mine, theirs, base } = scenario()
        // The new card puts its new picture first: without a base it is not kept by default (differs -> mine), with a base it is added.
        theirs.additionalAssets = [pic('card2'), pic('card1')]
        const dialog = { choices: {} as Record<string, string>, edits: {} as Record<string, string> }
        const noBase = planUpdate(CHARACTER_UPDATE, mine, theirs, null)
        applyAssetMaidPreset(dialog, noBase, mine, theirs)
        const id = Object.keys(dialog.choices)[0]
        const first = dialog.edits[id]
        expect(refs({ content: first } as loreBook).sort()).toEqual(['lore:0/g1=asset:1', 'lore:1/f1=asset:1', 'lore:1/f2=asset:2'])
        const withBase = planUpdate(CHARACTER_UPDATE, mine, theirs, base)
        applyAssetMaidPreset(dialog, withBase, mine, theirs)
        expect(dialog.choices[id]).toBe('edit')
        expect(refs({ content: dialog.edits[id] } as loreBook).sort()).toEqual(['lore:0/g1=asset:2', 'lore:1/f1=asset:2', 'lore:1/f2=asset:3'])
        const merged = apply(withBase, mine, theirs, { [id]: 'edit' }, { [id]: dialog.edits[id] })
        expect(finalize(merged, mine, theirs)).toMatchObject({ kept: 3 })
        expect(merged.additionalAssets!.map(asset => asset[0])).toEqual(['card2', 'card1', 'u1', 'u2', '__asset_maid_crop_x1'])
        expect(refs(merged.globalLore.find(e => e.comment === ASSET_MAID_COMMENT)).sort()).toEqual(['lore:0/g1=asset:2', 'lore:1/f1=asset:2', 'lore:1/f2=asset:3'])
        // A pick the user made stays through a new comparison.
        const picked = { choices: { [id]: 'mine' } as Record<string, string>, edits: {} as Record<string, string> }
        presetAssetMaidMerge(noBase, mine, theirs)
        applyAssetMaidPreset(picked, withBase, mine, theirs)
        expect(picked).toEqual({ choices: { [id]: 'mine' }, edits: {} })
        const kept = apply(withBase, mine, theirs, { [id]: 'mine' }, {})
        expect(finalize(kept, mine, theirs)).toBeNull()
        // An untouched preselection is removed when the new comparison has none.
        const bare = { choices: {} as Record<string, string>, edits: {} as Record<string, string> }
        applyAssetMaidPreset(bare, withBase, mine, theirs)
        applyAssetMaidPreset(bare, { hasBase: true, items: [] }, mine, theirs)
        expect(bare).toEqual({ choices: {}, edits: {} })
    })

    test('"내 버전 유지" is not turned into the merge even when the texts are equal', () => {
        const { mine, theirs, base } = scenario()
        // The new body is the installed one without references: the merge text equals the installed text.
        const own = mine.globalLore[2]
        theirs.globalLore = [...mine.globalLore.slice(0, 2), maidEntry([{ at: 0, fp: 'aria', forms: [{ id: 'f1' }, { id: 'f2' }] }, { at: 1, fp: 'bea', forms: [{ id: 'g1' }] }])]
        theirs.additionalAssets = [...mine.additionalAssets!]
        base.additionalAssets = [...mine.additionalAssets!]
        const plan = planUpdate(CHARACTER_UPDATE, mine, theirs, base)
        const keep = presetAssetMaidMerge(plan, mine, theirs)!
        expect(keep.text).toBe(own.content)
        const merged = apply(plan, mine, theirs, { [keep.id]: 'mine' }, {})
        const before = JSON.stringify(merged)
        expect(finalize(merged, mine, theirs)).toBeNull()
        expect(JSON.stringify(merged)).toBe(before)
    })

    test('duplicate fingerprints are not settled by the old lore index', () => {
        const { mine, theirs, base } = scenario()
        // Two entries of the new body share Aria's fingerprints and have no comment to tell them apart.
        theirs.globalLore = [lore('Character: Bea', 'bea'), lore('Twin', 'aria'), lore('Twin', 'aria', { key: 'twin2' }), maidEntry([{ at: 1, fp: 'aria', forms: [{ id: 'f1' }, { id: 'f2' }] }, { at: 2, fp: 'aria', forms: [{ id: 'f1' }, { id: 'f2' }] }, { at: 0, fp: 'bea', forms: [{ id: 'g1' }] }])]
        const keep = presetAssetMaidMerge(planUpdate(CHARACTER_UPDATE, mine, theirs, base), mine, theirs)!
        expect(keep.held.map(entry => [entry.formId, entry.reason])).toEqual([['f1', 'character-ambiguous'], ['f2', 'character-ambiguous']])
        expect(keep.kept).toBe(1)
    })

    test('lore targets follow their entries to the merged lorebook', () => {
        const { mine, theirs, base } = scenario()
        // The user added a lore entry of their own at the top: upstream keeps it, so the new card's entries move down by one.
        mine.globalLore = [lore('My notes', 'mine only'), ...mine.globalLore]
        const mineData = portable(mine.globalLore[3])
        for (const entry of mineData.features.characterForms.entries) entry.target = `lore:${Number(entry.target.split(':')[1]) + 1}`
        mineData.entities.lorebooks = Object.fromEntries(Object.entries(mineData.entities.lorebooks).map(([key, value]) => [`lore:${Number(key.split(':')[1]) + 1}`, value]))
        mine.globalLore[3] = { ...mine.globalLore[3], content: '@@dont_activate ' + JSON.stringify(mineData) }
        const plan = planUpdate(CHARACTER_UPDATE, mine, theirs, base)
        const keep = presetAssetMaidMerge(plan, mine, theirs)!
        const merged = apply(plan, mine, theirs, { [keep.id]: 'edit' }, { [keep.id]: keep.text })
        expect(merged.globalLore.map(entry => entry.comment)).toEqual(['My notes', 'Character: Bea', 'Character: Aria', ASSET_MAID_COMMENT])
        expect(finalize(merged, mine, theirs)).toMatchObject({ kept: 3, held: [] })
        const body = portable(merged.globalLore[3])
        expect(body.features.characterForms.entries.map((entry: any) => [entry.target, merged.globalLore[Number(entry.target.split(':')[1])].comment]))
            .toEqual([['lore:2', 'Character: Aria'], ['lore:1', 'Character: Bea']])
        expect(Object.keys(body.entities.lorebooks).sort()).toEqual(['lore:1', 'lore:2'])
        expect(body.entities.lorebooks['lore:2']).toEqual(fp('aria'))
    })

    test('an untouched edit equal to the new body is still renumbered to the final picture order', () => {
        // No base; installed pictures [extra, u], new [new, u]; both bodies point their one form at u (asset:1).
        const people = [lore('Character: Aria', 'aria')]
        const mine = bot({ globalLore: [...people, maidEntry([{ at: 0, fp: 'aria', forms: [{ id: 'f1', asset: 1 }] }], { 1: 'u' })], additionalAssets: [pic('extra'), pic('u')] })
        const theirs = bot({ chaId: 'incoming', globalLore: [...people, maidEntry([{ at: 0, fp: 'aria', forms: [{ id: 'f1', asset: 1 }] }], { 1: 'u' }, { insertorder: 5 })], additionalAssets: [pic('new'), pic('u')] })
        const plan = planUpdate(CHARACTER_UPDATE, mine, theirs, null)
        const keep = presetAssetMaidMerge(plan, mine, theirs)!
        expect(keep.text).toBe(theirs.globalLore[1].content)
        const picks: Record<string, 'mine' | 'theirs' | 'edit'> = { [keep.id]: 'edit' }
        for (const item of plan.items) if (item.field === 'additionalAssets') picks[item.id] = item.key === 'new' ? 'theirs' : 'mine'
        for (const item of plan.items) picks[item.id] ??= 'theirs'
        const merged = apply(plan, mine, theirs, picks, { [keep.id]: keep.text })
        // upstream order: the installed-only picture first, then the new card's: u moves from 1 to 2.
        expect(merged.additionalAssets!.map(asset => asset[0])).toEqual(['extra', 'new', 'u'])
        expect(finalize(merged, mine, theirs)).toMatchObject({ kept: 1 })
        const [ref] = refs(merged.globalLore.find(e => e.comment === ASSET_MAID_COMMENT))
        expect(merged.additionalAssets![Number(ref.split('asset:')[1])][0]).toBe('u')
        // "새 버전 적용" on the same text is the user's choice: nothing is renumbered.
        const again = presetAssetMaidMerge(plan, mine, theirs)!
        const chosen = apply(plan, mine, theirs, { ...picks, [again.id]: 'theirs' }, {})
        expect(finalize(chosen, mine, theirs)).toBeNull()
    })

    test('a new character the user left out is taken out of the body; nothing points at another entry', () => {
        const { mine, base } = scenario()
        // The new card adds Cleo before the others; the user keeps it out ("내 버전 유지" on an added entry).
        const theirs = bot({
            chaId: 'incoming',
            globalLore: [lore('Character: Cleo', 'cleo'), lore('Character: Aria', 'aria'), lore('Character: Bea', 'bea'),
                maidEntry([{ at: 0, fp: 'cleo', forms: [{ id: 'c1' }] }, { at: 1, fp: 'aria', forms: [{ id: 'f1' }, { id: 'f2' }] }, { at: 2, fp: 'bea', forms: [{ id: 'g1' }] }])],
            additionalAssets: [pic('card1')],
        })
        const plan = planUpdate(CHARACTER_UPDATE, mine, theirs, base)
        const keep = presetAssetMaidMerge(plan, mine, theirs)!
        const cleo = plan.items.find(item => item.status === 'added' && (item.theirs as loreBook).comment === 'Character: Cleo')!
        const merged = apply(plan, mine, theirs, { [keep.id]: 'edit', [cleo.id]: 'mine' }, { [keep.id]: keep.text })
        expect(merged.globalLore.map(entry => entry.comment)).toEqual(['Character: Aria', 'Character: Bea', ASSET_MAID_COMMENT])
        const result = finalize(merged, mine, theirs)!
        expect(result).toMatchObject({ kept: 3, held: [], dropped: ['Character: Cleo'] })
        const body = portable(merged.globalLore[2])
        expect(body.features.characterForms.entries.map((entry: any) => [entry.target, merged.globalLore[Number(entry.target.split(':')[1])].comment]))
            .toEqual([['lore:0', 'Character: Aria'], ['lore:1', 'Character: Bea']])
        expect(Object.keys(body.entities.lorebooks).sort()).toEqual(['lore:0', 'lore:1'])
        expect(body.entities.lorebooks['lore:0']).toEqual(fp('aria'))
        expect(vi.mocked(toast.warning)).toHaveBeenCalledTimes(1)
    })

    test('of two new entries with the same key, leaving out the first does not hand its place to the second', () => {
        const { mine, base } = scenario()
        // Same mode/comment/key/secondkey, different text: upstream tells them apart only by their order (slot #1).
        const theirs = bot({
            chaId: 'incoming',
            globalLore: [lore('Character: Aria', 'aria'), lore('Character: Bea', 'bea'), lore('Twin', 'first twin'), lore('Twin', 'second twin'),
                maidEntry([{ at: 0, fp: 'aria', forms: [{ id: 'f1' }, { id: 'f2' }] }, { at: 1, fp: 'bea', forms: [{ id: 'g1' }] }, { at: 2, fp: 'twin-a', forms: [{ id: 't1', asset: 0 }] }, { at: 3, fp: 'twin-b', forms: [{ id: 't2', asset: 0 }] }], { 0: 'card1' })],
            additionalAssets: [pic('card1')],
        })
        const plan = planUpdate(CHARACTER_UPDATE, mine, theirs, base)
        const keep = presetAssetMaidMerge(plan, mine, theirs)!
        const twins = plan.items.filter(item => item.status === 'added' && (item.theirs as loreBook).comment === 'Twin')
        expect(twins).toHaveLength(2)
        const merged = apply(plan, mine, theirs, { [keep.id]: 'edit', [twins[0].id]: 'mine', [twins[1].id]: 'theirs' }, { [keep.id]: keep.text })
        expect(merged.globalLore.map(entry => entry.content)).toContain('second twin')
        expect(merged.globalLore.map(entry => entry.content)).not.toContain('first twin')
        const result = finalize(merged, mine, theirs)!
        expect(result.dropped).toEqual(['Twin'])
        const body = portable(merged.globalLore.find(e => e.comment === ASSET_MAID_COMMENT))
        const twin = body.features.characterForms.entries.filter((entry: any) => entry.forms.some((form: any) => form.id.startsWith('t')))
        expect(twin).toHaveLength(1)
        expect(twin[0].forms[0].id).toBe('t2')
        expect(merged.globalLore[Number(twin[0].target.split(':')[1])].content).toBe('second twin')
        expect(body.entities.lorebooks[twin[0].target]).toEqual(fp('twin-b'))
    })

    test('two installed entries that land on one new entry are both held, not overwritten', () => {
        const { mine, theirs, base } = scenario()
        // The installed body has a copy of Aria (same fingerprints, same comment) with its own picture; the new body has one Aria.
        mine.globalLore = [lore('Character: Aria', 'aria'), lore('Character: Bea', 'bea'), lore('Character: Aria', 'aria', { key: 'aria copy' }),
            maidEntry([{ at: 0, fp: 'aria', forms: [{ id: 'f1', asset: 1 }] }, { at: 1, fp: 'bea', forms: [{ id: 'g1', asset: 1 }] }, { at: 2, fp: 'aria', forms: [{ id: 'f1', asset: 2 }] }], { 1: 'u1', 2: 'u2' })]
        const plan = planUpdate(CHARACTER_UPDATE, mine, theirs, base)
        const keep = presetAssetMaidMerge(plan, mine, theirs)!
        expect(keep.kept).toBe(1)
        expect(keep.held.map(entry => [entry.target, entry.formId, entry.reason])).toEqual([['lore:0', 'f1', 'character-ambiguous'], ['lore:2', 'f1', 'character-ambiguous']])
        expect(refs({ content: keep.text } as loreBook)).toEqual(['lore:0/g1=asset:1'])
    })

    test('mergeAssetMaid leaves anything that is not Portable data alone', () => {
        expect(mergeAssetMaid(lore(ASSET_MAID_COMMENT, 'not json'), lore(ASSET_MAID_COMMENT, '{}'), bot(), bot(), [])).toBeNull()
    })
})

// 0.9.96-ver11: records describe the final pictures, including re-imports of an already broken card.
describe('Asset Maid free-created characters', () => {
    const target = 'custom:character_7f584fee-9d28-4609-8c6e-fa7b87aa9f8d'
    const customBody = (entries: unknown[], assets?: Record<number, string>) => {
        const entry = maidEntry([], assets)
        const body = portable(entry)
        body.features.characterForms.entries = entries
        return { ...entry, content: '@@dont_activate ' + JSON.stringify(body) }
    }

    test.each([new Map<number, number>(), undefined])('keeps both sides and renumbers pictures with map %s', map => {
        const mine = customBody([{ target, forms: [
            { id: 'blank', reference: {} }, { id: 'incoming' }, { id: 'both', reference: {} },
            { id: 'mine', reference: { asset: 'asset:0' } }, { id: 'replace', reference: { asset: 'asset:0' } },
        ] }], { 0: 'mine' })
        const theirs = customBody([{ target, forms: [
            { id: 'blank' }, { id: 'incoming', reference: {} }, { id: 'both', reference: { asset: 'asset:0' } },
            { id: 'mine', reference: {} }, { id: 'replace', reference: { asset: 'asset:0' } },
        ] }], { 0: 'theirs' })
        const pictures = [pic('other'), pic('theirs')]
        const merged = mergeAssetMaid(mine, theirs, { additionalAssets: [pic('mine')] }, { additionalAssets: [pic('theirs')] }, pictures, map)!
        expect(merged).toMatchObject({ kept: 2, replaced: 1, appended: 1, held: [], dropped: [] })
        expect(portable({ ...theirs, content: merged.content }).features.characterForms.entries).toEqual([{ target, forms: [
            { id: 'blank', reference: {} }, { id: 'incoming', reference: {} }, { id: 'both', reference: { asset: 'asset:1' } },
            { id: 'mine', reference: { asset: 'asset:2' } }, { id: 'replace', reference: { asset: 'asset:2' } },
        ] }])
        expect(pictures).toEqual([pic('other'), pic('theirs'), pic('mine')])
    })

    test.each([[0, 'character-missing'], [2, 'character-ambiguous']])('holds when there are %i exact targets', (count, reason) => {
        const forms = [{ id: 'f', reference: { asset: 'asset:0' } }]
        const mine = customBody([{ target, forms }])
        const theirs = customBody([{ target: target + '-other', forms }, ...Array.from({ length: count }, () => ({ target, forms }))], { 0: 'incoming' })
        const merged = mergeAssetMaid(mine, theirs, { additionalAssets: [pic('mine')] }, { additionalAssets: [pic('incoming')] }, [pic('incoming')], new Map())!
        expect(merged.held).toEqual([{ side: 'mine', target, character: '', formId: 'f', reference: forms[0].reference, reason }])
        expect(merged).toMatchObject({ kept: 0, replaced: 0, appended: 0, dropped: [] })
    })

    test('empty slots alone keep upstream choices and do not restore a removed crop', () => {
        const mine = bot({ additionalAssets: [pic('__asset_maid_crop_unused')], globalLore: [customBody([{ target, forms: [{ id: 'f', reference: {} }, { id: 'removed', reference: {} }] }])] })
        const theirs = bot({ globalLore: [customBody([{ target, forms: [{ id: 'f', label: 'New' }, { id: 'incoming', reference: {} }] }])] })
        const plan = planUpdate(CHARACTER_UPDATE, mine, theirs, null)
        expect(presetAssetMaidMerge(plan, mine, theirs)).toBeNull()
        const merged = apply(plan, mine, theirs, Object.fromEntries<'theirs'>(plan.items.map(item => [item.id, 'theirs'])), {})
        finalize(merged, mine, theirs)
        expect(merged.additionalAssets ?? []).toEqual([])
        expect(portable(merged.globalLore[0]).features.characterForms.entries[0].forms).toEqual([{ id: 'f', label: 'New' }, { id: 'incoming', reference: {} }])
    })

    test('preserves an empty slot in a preset carried by a real reference and never holds missing or ambiguous empty slots', () => {
        const forms = [{ id: 'f', reference: {} }]
        const mine = bot({ additionalAssets: [pic('mine')], globalLore: [customBody([
            { target, forms: [...forms, { id: 'removed', reference: {} }, { id: 'picture', reference: { asset: 'asset:0' } }] },
            { target: 'custom:missing', forms }, { target: 'custom:duplicate', forms }, { target: 'custom:claim', forms }, { target: 'custom:claim', forms },
        ], { 0: 'mine' })] })
        const theirs = bot({ globalLore: [customBody([
            { target, forms: [{ id: 'f' }, { id: 'picture' }] },
            { target: 'custom:duplicate', forms }, { target: 'custom:duplicate', forms }, { target: 'custom:claim', forms },
        ])] })
        const plan = planUpdate(CHARACTER_UPDATE, mine, theirs, null)
        const keep = presetAssetMaidMerge(plan, mine, theirs)!
        expect(keep).toMatchObject({ kept: 1, held: [] })
        const choices = Object.fromEntries<'edit' | 'theirs'>(plan.items.map(item => [item.id, item.id === keep.id ? 'edit' : 'theirs']))
        const merged = apply(plan, mine, theirs, choices, { [keep.id]: keep.text })
        expect(finalize(merged, mine, theirs)).toMatchObject({ kept: 1, held: [] })
        expect(portable(merged.globalLore[0]).features.characterForms.entries[0].forms).toEqual([
            { id: 'f', reference: {} }, { id: 'picture', reference: { asset: 'asset:0' } },
        ])
    })
})

describe('Asset Maid final character picture fingerprints', () => {
    const setup = (own: [string, string, string][], next: [string, string, string][]) => {
        const mine = bot({ additionalAssets: own, globalLore: [lore('Person', 'person'), maidEntry([{ at: 0, fp: 'person', forms: [{ id: 'default', asset: 0 }] }], { 0: 'stale' })] })
        const theirs = bot({ additionalAssets: next, globalLore: [lore('Person', 'person'), maidEntry([{ at: 0, fp: 'person', forms: [{ id: 'default', asset: 0 }] }], { 0: 'new' })] })
        return { mine, theirs }
    }
    const merge = (mine: character, theirs: character, result = [...theirs.additionalAssets!]) => {
        const merged = mergeAssetMaid(mine.globalLore[1], theirs.globalLore[1], mine, theirs, result)!
        return { merged, data: JSON.parse(merged.content.slice(merged.content.indexOf('{'))), result }
    }
    test('a renamed picture with unchanged bytes and an already broken re-import use the final descriptor', () => {
        for (const own of [['Old', 'same', 'png'], ['New', 'same', 'png']] as [string, string, string][]) {
            const { mine, theirs } = setup([own], [['New', 'same', 'png']])
            const { merged, data } = merge(mine, theirs)
            expect(merged.kept).toBe(1)
            expect(data.entities.assets['asset:0']).toEqual({ fingerprints: { descriptor: assetMaidCharacterLocators(theirs.additionalAssets!)[0]!.descriptor } })
            const plan = planUpdate(CHARACTER_UPDATE, mine, theirs, null)
            const dialog = { choices: {}, edits: {} }
            applyAssetMaidPreset(dialog, plan, mine, theirs)
            expect(Object.values(dialog.choices)).toContain('edit')
        }
    })
    test('a correct record (including its key order and explicit zero) is untouched byte for byte', () => {
        const { mine, theirs } = setup([pic('Same')], [pic('Same')])
        const body = portable(mine.globalLore[1])
        body.entities.assets['asset:0'] = { occurrence: 0, fingerprints: { descriptor: assetMaidCharacterLocators(mine.additionalAssets!)[0]!.descriptor } }
        mine.globalLore[1].content = theirs.globalLore[1].content = '@@dont_activate ' + JSON.stringify(body)
        expect(merge(mine, theirs).merged.content).toBe(theirs.globalLore[1].content)
    })
    test('a user-added reference absent from the new card is appended, with occurrence counting unreferenced pictures too', () => {
        const { mine, theirs } = setup([['same', 'user-file', 'png']], [[' SAME ', 'card-file', '.PNG']])
        const { merged, data, result } = merge(mine, theirs)
        expect(merged).toMatchObject({ kept: 1, appended: 1 })
        expect(data.features.characterForms.entries[0].forms[0].reference.asset).toBe('asset:1')
        expect(result[1]).toEqual(mine.additionalAssets![0])
        expect(data.entities.assets['asset:1']).toEqual({ fingerprints: { descriptor: assetMaidCharacterLocators(result)[1]!.descriptor }, occurrence: 1 })
    })
    test('module and ineligible picture records stay unchanged', () => {
        for (const [picture, module] of [[pic('Same'), true], [pic('__asset_maid_crop_x'), false], [['no-extension', 'path.png', ''], false]] as [[string, string, string], boolean][]) {
            const { mine, theirs } = setup([picture], [picture])
            const body = portable(mine.globalLore[1])
            if (module) body.entities.assets['asset:0'].module = 'module:0'
            mine.globalLore[1].content = '@@dont_activate ' + JSON.stringify(body)
            // 0.9.103-ver4: a module record keeps its record under its own number (past the card pictures)
            const { data } = merge(mine, theirs)
            expect(data.entities.assets[data.features.characterForms.entries[0].forms[0].reference.asset]).toEqual(body.entities.assets['asset:0'])
        }
    })
    test('normalization, extension fallback, generated assets and duplicate occurrences match fixed plugin vectors', () => {
        const loc = assetMaidCharacterLocators([[' Face ', 'a', '.PNG'], ['face', 'b', 'png'], ['face.png', 'c', ''], ['face', 'c.png', ''],
            ['Face.__am__.chat.01234567-89ab-cdef-0123-456789abcdef', 'a', 'png'], ['__asset_maid_crop_x', 'a', 'png']])
        expect(loc[0]!.descriptor).toBe('am2:ea0e75c854e67fbcc3fe6bcb78516d09')
        expect(loc[1]).toEqual({ ...loc[0], occurrence: 1 })
        expect(loc[2]!.descriptor).toBe('am2:1564117d8c7f9b4f6acd3d5ca8d9df9b')
        expect(loc.slice(3)).toEqual([null, null, null])
    })
    test('no conflicting body or no retained user references leaves preselection unchanged', () => {
        const { mine, theirs } = setup([pic('Same')], [pic('Same')])
        // With the incoming card already recorded as the base, a stale body is mine-only: the ver8 gate stays closed.
        const base = baseSnapshot(CHARACTER_UPDATE, theirs)
        const mineOnly = planUpdate(CHARACTER_UPDATE, mine, theirs, base)
        expect(mineOnly.items.find(item => item.field === 'globalLore' && (item.mine as loreBook)?.comment === ASSET_MAID_COMMENT)?.status).toBe('mine')
        expect(presetAssetMaidMerge(mineOnly, mine, theirs)).toBeNull()
        mine.globalLore[1].content = theirs.globalLore[1].content
        expect(presetAssetMaidMerge(planUpdate(CHARACTER_UPDATE, mine, theirs, null), mine, theirs)).toBeNull()
        mine.globalLore[1] = maidEntry([{ at: 0, fp: 'person', forms: [{ id: 'gone', asset: 0 }] }], { 0: 'stale' })
        expect(presetAssetMaidMerge(planUpdate(CHARACTER_UPDATE, mine, theirs, null), mine, theirs)).toBeNull()
    })
})

describe('Asset Maid finalize recovery of an already installed broken body', () => {
    function broken() {
        const pictures = [pic('anchor'), pic('renamed'), pic('renamed')]
        const entry = maidEntry([{ at: 0, fp: 'person', forms: [{ id: 'default', asset: 1 }, { id: 'other', asset: 2 }] }], { 0: 'anchor', 1: 'old', 2: 'old' })
        const body = portable(entry)
        body.entities.assets['asset:1'] = { extra: { keep: true }, occurrence: 4, fingerprints: { anchor: 'keep', descriptor: 'stale-one' } }
        body.entities.assets['asset:2'].occurrence = 8
        body.entities.assets['asset:99'] = { module: null, fingerprints: { descriptor: 'module-stays' } }
        body.features.characterForms.entries[0].forms[0].reference.crop = { rect: [1, 2, 3, 4] }
        entry.content = '@@dont_activate \n' + JSON.stringify(body, null, 2)
        const mine = bot({ globalLore: [lore('Person', 'person'), entry], additionalAssets: pictures })
        const theirs = structuredClone(mine)
        const data = portable(theirs.globalLore[1]), locators = assetMaidCharacterLocators(pictures)
        for (const at of [1, 2]) data.entities.assets[`asset:${at}`] = { fingerprints: { descriptor: locators[at]!.descriptor }, ...(locators[at]!.occurrence ? { occurrence: locators[at]!.occurrence } : {}) }
        theirs.globalLore[1].content = '@@dont_activate ' + JSON.stringify(data)
        return { mine, theirs }
    }
    function run(mine: character, theirs: character, base: Partial<character> | null = baseSnapshot(CHARACTER_UPDATE, theirs)) {
        const plan = planUpdate(CHARACTER_UPDATE, mine, theirs, base)
        const dialog = { choices: {} as Record<string, 'mine' | 'theirs' | 'edit'>, edits: {} as Record<string, string> }
        applyAssetMaidPreset(dialog, plan, mine, theirs)
        const merged = apply(plan, mine, theirs, dialog.choices, dialog.edits)
        const before = structuredClone(merged)
        const pendingResult = finalize(merged, mine, theirs)
        return { merged, before, plan, pendingResult }
    }
    test('mine-only with the incoming base repairs just descriptors and occurrences, preserving every reference and other field', () => {
        const { mine, theirs } = broken()
        const { merged, before, plan, pendingResult } = run(mine, theirs)
        expect(plan.items.find(item => item.field === 'globalLore')?.choice).toBe('mine')
        expect(pendingResult).toBeNull()
        const data = portable(merged.globalLore[1]), old = portable(before.globalLore[1])
        expect(JSON.stringify(data.features)).toBe(JSON.stringify(old.features))
        expect(data.entities.assets['asset:0']).toEqual(old.entities.assets['asset:0'])
        expect(data.entities.assets['asset:99']).toEqual(old.entities.assets['asset:99'])
        expect(data.entities.assets['asset:1']).toEqual({ extra: { keep: true }, fingerprints: { anchor: 'keep', descriptor: assetMaidCharacterLocators(merged.additionalAssets!)[1]!.descriptor } })
        expect(data.entities.assets['asset:2'].occurrence).toBe(1)
        expect(merged.globalLore[1].content.startsWith('@@dont_activate \n{')).toBe(true)
        expect(merged.additionalAssets).toEqual(before.additionalAssets)
        expect(merged.globalLore[0]).toEqual(before.globalLore[0])
        expect(addLog).toHaveBeenCalledWith(expect.objectContaining({ level: 'info', source: 'character-update', message: expect.stringContaining('2개') }))
        expect(toast.success).toHaveBeenCalledOnce()
        const once = JSON.stringify(merged)
        finalizeWith(merged, mine, theirs, plan, {})
        expect(JSON.stringify(merged)).toBe(once)
        expect(addLog).toHaveBeenCalledTimes(1)
    })
    test('healthy mine, update and differs choices keep the selected body byte for byte', () => {
        for (const status of ['mine', 'update', 'differs']) {
            const { theirs: healthy } = broken()
            const mine = structuredClone(healthy), theirs = structuredClone(healthy)
            mine.globalLore[1].content += ' '
            theirs.globalLore[1].content += '\n'
            const base = status === 'mine' ? baseSnapshot(CHARACTER_UPDATE, theirs) : status === 'update' ? baseSnapshot(CHARACTER_UPDATE, mine) : null
            // No preset: this is the final chosen healthy Portable, regardless of the comparison category.
            presetAssetMaidMerge(null, mine, theirs)
            const plan = planUpdate(CHARACTER_UPDATE, mine, theirs, base)
            expect(plan.items.find(item => item.field === 'globalLore')?.status).toBe(status)
            const choices: Record<string, UpdateChoice> = Object.fromEntries(plan.items.filter(item => !item.choice).map(item => [item.id, 'mine' as const]))
            const merged = applyUpdate(CHARACTER_UPDATE, mine, theirs, plan, choices)
            const before = JSON.stringify(merged)
            finalizeWith(merged, mine, theirs, plan, {})
            expect(JSON.stringify(merged)).toBe(before)
        }
        expect(addLog).not.toHaveBeenCalled()
    })
    test('one resolved record pointing at another numbered picture blocks the whole recovery', () => {
        const { mine, theirs } = broken()
        const data = portable(mine.globalLore[1])
        data.entities.assets['asset:2'] = { fingerprints: { descriptor: assetMaidCharacterLocators(mine.additionalAssets!)[0]!.descriptor } }
        mine.globalLore[1].content = '@@dont_activate ' + JSON.stringify(data)
        const { merged, before } = run(mine, theirs)
        expect(merged.globalLore[1].content).toBe(before.globalLore[1].content)
        expect(addLog).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', description: expect.stringContaining('그림과 일치하지 않아') }))
    })
    test('without any resolved record there is no numbering evidence, even when matching pictures exist', () => {
        const { mine, theirs } = broken()
        const data = portable(mine.globalLore[1])
        delete data.entities.assets['asset:0']
        mine.globalLore[1].content = '@@dont_activate ' + JSON.stringify(data)
        const { merged, before } = run(mine, theirs)
        expect(merged.globalLore[1].content).toBe(before.globalLore[1].content)
        expect(addLog).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', description: expect.stringContaining('기록이 없어') }))
    })
    test('a legacy fingerprint that the plugin still resolves is never rewritten or used as semantic numbering proof', () => {
        const { mine, theirs } = broken()
        const data = portable(mine.globalLore[1])
        // Actual cc(AE(anchor)) vector; kRe indexes this alias as well as semanticDescriptor.
        data.entities.assets['asset:1'] = { fingerprints: { descriptor: 'am2:3bc773119d270ffc9f404c9f2e77987c' } }
        mine.globalLore[1].content = '@@dont_activate ' + JSON.stringify(data)
        const { merged, before } = run(mine, theirs)
        expect(merged.globalLore[1].content).toBe(before.globalLore[1].content)
        expect(addLog).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', message: expect.stringContaining('1개'), description: expect.stringContaining('그림과 일치하지 않아') }))
    })
    test('missing and ineligible numbered pictures are left intact and reported', () => {
        const { mine, theirs } = broken()
        const data = portable(mine.globalLore[1])
        data.entities.assets['asset:2'].occurrence = 0
        data.entities.assets['asset:8'] = { fingerprints: { descriptor: 'missing' } }
        mine.additionalAssets![1] = pic('__asset_maid_crop_kept')
        mine.additionalAssets![2] = ['unsupported', 'file', 'gif']
        theirs.additionalAssets = structuredClone(mine.additionalAssets)
        mine.globalLore[1].content = '@@dont_activate ' + JSON.stringify(data)
        const { merged, before } = run(mine, theirs)
        expect(merged.globalLore[1].content).toBe(before.globalLore[1].content)
        expect(addLog).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', message: expect.stringContaining('3개'), description: expect.stringContaining('asset:8') }))
        expect(toast.warning).toHaveBeenCalledOnce()
    })
    test('a partially recoverable body repairs only eligible candidates', () => {
        const { mine, theirs } = broken()
        const data = portable(mine.globalLore[1])
        data.entities.assets['asset:8'] = { fingerprints: { descriptor: 'missing' } }
        mine.globalLore[1].content = '@@dont_activate ' + JSON.stringify(data)
        const { merged } = run(mine, theirs)
        expect(portable(merged.globalLore[1]).entities.assets['asset:8']).toEqual(data.entities.assets['asset:8'])
        expect(addLog).toHaveBeenCalledWith(expect.objectContaining({ level: 'warning', message: expect.stringContaining('2개를 복구') }))
    })
    test('duplicate entries, non-Portable and malformed records are preserved without throwing', () => {
        for (const content of ['not-json', '{"schema":"another"}', '{"schema":"asset-maid.portable","entities":{"assets":[null]}}', '{"schema":"asset-maid.portable","entities":{"assets":{"asset:0":null,"asset:1":{"fingerprints":"bad"},"asset:2":{"fingerprints":{"descriptor":"x"},"occurrence":-1}}}}']) {
            const mine = bot({ globalLore: [lore(ASSET_MAID_COMMENT, content)] })
            const { merged, before } = run(mine, structuredClone(mine))
            expect(JSON.stringify(merged)).toBe(JSON.stringify(before))
        }
        const { mine, theirs } = broken()
        mine.globalLore.push(structuredClone(mine.globalLore[1]))
        const { merged, before } = run(mine, theirs)
        expect(JSON.stringify(merged)).toBe(JSON.stringify(before))
    })
    test('the existing pending merge stays identical to R1 and recovery is idempotent afterward', () => {
        const { mine, theirs, base } = scenario()
        const { merged, pendingResult, plan } = run(mine, theirs, base)
        expect(pendingResult).toMatchObject({ kept: 3, held: [] })
        expect(merged.globalLore.find(entry => entry.comment === ASSET_MAID_COMMENT)?.content).toBe(pendingResult!.content)
        const before = JSON.stringify(merged)
        finalizeWith(merged, mine, theirs, plan, {})
        expect(JSON.stringify(merged)).toBe(before)
        expect(addLog).not.toHaveBeenCalled()
    })
})

describe('character pictures referenced by installed chats', async () => {
    const maidName = 'X.__am__.chat.01234567-89ab-cdef-0123-456789abcdef'
    const chat = (...texts: string[]): character['chats'][number] => ({
        name: 'Chat 1', note: '', localLore: [], message: texts.map(data => ({ role: 'char', data })),
    })
    const update = (mine: character, theirs = bot(), base: Partial<character> | null = baseSnapshot(CHARACTER_UPDATE, bot())) => {
        const plan = planUpdate(CHARACTER_UPDATE, mine, theirs, base)
        const choices: Record<string, UpdateChoice> = Object.fromEntries(plan.items.map(item => [item.id, 'theirs']))
        return { plan, choices, merged: applyUpdate(CHARACTER_UPDATE, mine, theirs, plan, choices) }
    }
    const database = (characters: character[], assets?: character['additionalAssets']) => {
        vi.mocked(getDatabase).mockReturnValue({
            characters, modules: assets ? [{ id: 'module', name: 'Module', description: '', assets }] : [],
        } as ReturnType<typeof getDatabase>)
    }
    beforeEach(() => database([]))

    const pictureUpdate = () => {
        const mine = bot({
            additionalAssets: [pic('card'), pic(maidName), pic('my-pic'), pic('unused')],
            chats: [chat(`<span class="am-image"><img class="am-image__media" data-am-asset="${maidName}" src="{{raw::${maidName}}}" width="20" height="20" alt=""></span>`),
                chat('{{img::my-pic}}')],
        })
        const theirs = bot({ additionalAssets: [pic('card'), pic('new-card-pic')] })
        return { mine, theirs, base: baseSnapshot(CHARACTER_UPDATE, bot({ additionalAssets: [pic('card')] })) }
    }

    test('finalizing the Portable body alone leaves chat pictures untouched', () => {
        const { mine, theirs, base } = pictureUpdate()
        const { plan, choices, merged } = update(mine, theirs, base)
        const pictures = merged.additionalAssets
        expect(finalizeWith(merged, mine, theirs, plan, choices)).toBeNull()
        expect(merged.additionalAssets).toBe(pictures)
        expect(merged.additionalAssets).toEqual(theirs.additionalAssets)
        expect(fetchChatFromServer).not.toHaveBeenCalled()
        expect(addLog).not.toHaveBeenCalled()
    })

    test('reads placeholder and stub bodies in order without replacing their slots', async () => {
        const { mine, theirs, base } = pictureUpdate()
        const [body, stubBody] = mine.chats
        const placeholder = { ...chat(), id: 'closed', _placeholder: true }
        const stub = { id: 'stub', name: 'Chat 2', _stub: true } as unknown as character['chats'][number]
        const chats = [placeholder, stub]
        mine.chats = chats
        const { merged } = update(mine, theirs, base)
        let resolvePlaceholder!: (result: typeof body) => void
        const placeholderRead = new Promise<typeof body>(resolve => { resolvePlaceholder = resolve })
        vi.mocked(fetchChatFromServer).mockReturnValueOnce(placeholderRead).mockResolvedValueOnce(stubBody)

        const keeping = keepChatPictures(merged, mine)
        expect(fetchChatFromServer).toHaveBeenCalledExactlyOnceWith(mine.chaId, 0, 'closed')
        resolvePlaceholder(body)
        await keeping

        expect(fetchChatFromServer).toHaveBeenCalledTimes(2)
        expect(fetchChatFromServer).toHaveBeenNthCalledWith(2, mine.chaId, 1, 'stub')
        expect(merged.additionalAssets).toEqual([...theirs.additionalAssets!, ...mine.additionalAssets!.slice(1, 3)])
        expect(mine.chats).toBe(chats)
        expect(mine.chats[0]).toBe(placeholder)
        expect(mine.chats[0]).toMatchObject({ _placeholder: true, message: [] })
        expect(mine.chats[1]).toBe(stub)
        expect(mine.chats[1]).not.toHaveProperty('message')
        expect(toast.warning).not.toHaveBeenCalled()
    })

    test('warns once for missing and rejected reads and keeps pictures from the next chat', async () => {
        const mine = bot({ additionalAssets: [pic('open')], chats: [
            { ...chat(), id: 'missing', _placeholder: true },
            { ...chat(), id: 'rejected', _placeholder: true },
            chat('{{img::open}}'),
        ] })
        const { merged } = update(mine)
        vi.mocked(fetchChatFromServer).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Read failed'))

        await keepChatPictures(merged, mine)

        expect(merged.additionalAssets).toEqual([pic('open')])
        const message = expect.stringMatching(/보존 1, 복구 0.* 채팅 2개는 읽지 못해 확인하지 못했어요\.$/)
        expect(addLog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ level: 'warning', source: 'character-update', message }))
        expect(toast.warning).toHaveBeenCalledOnce()
        expect(vi.mocked(toast.warning).mock.calls[0][0]).toEqual(message)
        expect(toast.success).not.toHaveBeenCalled()
    })

    test('warns about an unread chat even when there are no pictures to keep', async () => {
        const mine = bot({ chats: [{ ...chat(), id: 'missing', _placeholder: true }] })
        const { merged } = update(mine)
        const pictures = merged.additionalAssets
        vi.mocked(fetchChatFromServer).mockResolvedValueOnce(null)

        await keepChatPictures(merged, mine)

        expect(merged.additionalAssets).toBe(pictures)
        const message = expect.stringMatching(/보존 0, 복구 0.* 채팅 1개는 읽지 못해 확인하지 못했어요\.$/)
        expect(addLog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ level: 'warning', source: 'character-update', message }))
        expect(toast.warning).toHaveBeenCalledOnce()
        expect(vi.mocked(toast.warning).mock.calls[0][0]).toEqual(message)
        expect(toast.success).not.toHaveBeenCalled()
    })

    test('uses an open chat with an ID without fetching it', async () => {
        const open = { ...chat('{{raw::open}}'), id: 'open', _stub: true }
        const mine = bot({ additionalAssets: [pic('open')], chats: [open] })
        const { merged } = update(mine)
        await keepChatPictures(merged, mine)
        expect(merged.additionalAssets).toEqual([pic('open')])
        expect(fetchChatFromServer).not.toHaveBeenCalled()
    })

    test.each([true, false])('keeps only chat pictures dropped by all-theirs (base: %s)', async hasBase => {
        const { mine, theirs, base } = pictureUpdate()
        const { plan, merged } = update(mine, theirs, hasBase ? base : null)
        const removed = plan.items.filter(item => item.field === 'additionalAssets' && item.mine && !item.theirs)
        expect(removed.map(item => item.status)).toEqual(Array(3).fill(hasBase ? 'mineOnly' : 'differs'))
        expect(merged.additionalAssets).toEqual(theirs.additionalAssets)
        await keepChatPictures(merged, mine)
        expect(merged.additionalAssets).toEqual([...theirs.additionalAssets!, ...mine.additionalAssets!.slice(1, 3)])
        expect(merged.additionalAssets![2]).not.toBe(mine.additionalAssets![1])
        expect(merged.additionalAssets![3]).not.toBe(mine.additionalAssets![2])
        expect(addLog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            level: 'info', source: 'character-update', message: expect.stringContaining('보존 2, 복구 0'),
        }))
        expect(toast.success).toHaveBeenCalledOnce()
        expect(toast.warning).not.toHaveBeenCalled()
        expect(getDatabase).not.toHaveBeenCalled()
    })

    test('default choices leave the upstream result and its picture array untouched', async () => {
        const { mine, theirs, base } = pictureUpdate()
        const plan = planUpdate(CHARACTER_UPDATE, mine, theirs, base)
        const merged = applyUpdate(CHARACTER_UPDATE, mine, theirs, plan)
        const upstream = structuredClone(merged), pictures = merged.additionalAssets
        await keepChatPictures(merged, mine)
        expect(merged).toEqual(upstream)
        expect(JSON.stringify(merged)).toBe(JSON.stringify(upstream))
        expect(merged.additionalAssets).toBe(pictures)
        expect(addLog).not.toHaveBeenCalled()
        expect(toast.success).not.toHaveBeenCalled()
        expect(toast.warning).not.toHaveBeenCalled()
        expect(getDatabase).not.toHaveBeenCalled()
    })

    test('keeps the old name after a rename, matching chat references case-insensitively', async () => {
        const old = pic('Old'), renamed: [string, string, string] = ['New', old[1], old[2]]
        const mine = bot({ additionalAssets: [old], chats: [chat('{{raw::Old}}', '{{raw::old}}')] })
        const theirs = bot({ additionalAssets: [renamed] })
        const { merged } = update(mine, theirs, baseSnapshot(CHARACTER_UPDATE, mine))
        await keepChatPictures(merged, mine)
        expect(merged.additionalAssets).toEqual([renamed, old])
        expect(addLog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ description: 'Old (보존)' }))
    })

    test('leaves the incoming path for the same name', async () => {
        const mine = bot({ additionalAssets: [pic('card')], chats: [chat('{{raw::CARD}}')] })
        const theirs = bot({ additionalAssets: [['card', 'assets/changed.png', 'png']] })
        const { merged } = update(mine, theirs, baseSnapshot(CHARACTER_UPDATE, mine))
        const pictures = merged.additionalAssets
        await keepChatPictures(merged, mine)
        expect(merged.additionalAssets).toBe(pictures)
        expect(merged.additionalAssets).toEqual(theirs.additionalAssets)
        expect(addLog).not.toHaveBeenCalled()
    })

    test('copies every installed path for a missing name in installed order', async () => {
        const duplicates: [string, string, string][] = [pic('My-pic'), ['my-pic', 'assets/second.png', 'png']]
        const mine = bot({ additionalAssets: duplicates, chats: [chat('{{img::MY-PIC}}')] })
        const theirs = bot()
        const { merged } = update(mine, theirs)
        await keepChatPictures(merged, mine)
        expect(merged.additionalAssets).toEqual(duplicates)
        duplicates.forEach((picture, index) => expect(merged.additionalAssets![index]).not.toBe(picture))
    })

    test('preserves emotion tokens in the emotion list alone', async () => {
        const smile: [string, string] = ['Smile', 'assets/emotion.png']
        const mine = bot({ additionalAssets: [pic('smile')], emotionImages: [smile], chats: [chat('{{emotion::smile}}')] })
        const theirs = bot({ emotionImages: [['sad', 'assets/sad.png']] })
        const { merged } = update(mine, theirs)
        await keepChatPictures(merged, mine)
        expect(merged.emotionImages).toEqual([...theirs.emotionImages, smile])
        expect(merged.emotionImages[1]).not.toBe(smile)
        expect(merged.additionalAssets).toEqual([])
    })

    const broken = (pictures: character['additionalAssets'] = []) => {
        const mine = bot({ chats: [chat('{{raw::lost}}')] })
        const theirs = bot({ additionalAssets: pictures })
        return { mine, ...update(mine, theirs) }
    }
    const trash = (chaId: string, picture = pic('Lost')) => bot({ chaId, trashTime: 42, additionalAssets: [picture] })

    test.each([1, 2])('recovers one tuple from %d trash copies of the same path', async count => {
        const picture = pic('Lost')
        database([trash('first', picture), ...(count === 2 ? [trash('second', picture)] : [])])
        const { mine, merged } = broken([pic('new')])
        await keepChatPictures(merged, mine)
        expect(merged.additionalAssets).toEqual([pic('new'), picture])
        expect(merged.additionalAssets![1]).not.toBe(picture)
        expect(addLog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            level: 'info', source: 'character-update', description: 'lost (복구)', message: expect.stringContaining('보존 0, 복구 1'),
        }))
        expect(toast.success).toHaveBeenCalledOnce()
        expect(toast.warning).not.toHaveBeenCalled()
    })

    test('holds a reference with different paths in two trash characters', async () => {
        database([trash('first'), trash('second', ['lost', 'assets/other.png', 'png'])])
        const { mine, merged } = broken()
        const pictures = merged.additionalAssets
        await keepChatPictures(merged, mine)
        expect(merged.additionalAssets).toBe(pictures)
        expect(merged.additionalAssets).toEqual([])
        expect(addLog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ level: 'warning', description: 'lost (보류: 경로가 여럿)' }))
        expect(toast.warning).toHaveBeenCalledOnce()
        expect(toast.success).not.toHaveBeenCalled()
    })

    test('ignores a reference with matches only in a live character or the installed identity', async () => {
        const { mine, merged } = broken()
        database([bot({ chaId: 'live', additionalAssets: [pic('lost')] }), trash(mine.chaId)])
        const upstream = structuredClone(merged), pictures = merged.additionalAssets
        await keepChatPictures(merged, mine)
        expect(merged).toEqual(upstream)
        expect(merged.additionalAssets).toBe(pictures)
        expect(addLog).not.toHaveBeenCalled()
        expect(toast.success).not.toHaveBeenCalled()
        expect(toast.warning).not.toHaveBeenCalled()
    })

    test('skips trash recovery when a module already supplies the name', async () => {
        database([trash('backup')], [pic('LOST')])
        const { mine, merged } = broken()
        const pictures = merged.additionalAssets
        await keepChatPictures(merged, mine)
        expect(merged.additionalAssets).toBe(pictures)
        expect(merged.additionalAssets).toEqual([])
        expect(addLog).not.toHaveBeenCalled()
        expect(toast.success).not.toHaveBeenCalled()
        expect(toast.warning).not.toHaveBeenCalled()
    })

    test('ignores source tokens, stub chats, malformed message arrays and non-string data', async () => {
        const mine = bot({ additionalAssets: [pic('source'), pic('stub'), pic('invalid')], chats: [
            chat('{{source::source}}'), { _stub: true },
            { message: '{{raw::invalid}}' }, { message: [{ data: 42 }, null] },
        ] as unknown as character['chats'] })
        const theirs = bot()
        const { merged } = update(mine, theirs)
        const pictures = merged.additionalAssets
        await keepChatPictures(merged, mine)
        expect(merged.additionalAssets).toBe(pictures)
        expect(merged.additionalAssets).toEqual([])
        expect(getDatabase).not.toHaveBeenCalled()
        expect(addLog).not.toHaveBeenCalled()
    })

    test('replaces a non-array field only when there is a picture to append', async () => {
        const nonArray = {} as character['additionalAssets']
        const { mine, merged } = broken()
        merged.additionalAssets = nonArray
        await keepChatPictures(merged, mine)
        expect(merged.additionalAssets).toBe(nonArray)
        mine.additionalAssets = [pic('lost')]
        await keepChatPictures(merged, mine)
        expect(merged.additionalAssets).toEqual(mine.additionalAssets)
        expect(merged.additionalAssets).not.toBe(mine.additionalAssets)
    })

    test('limits a single log to 20 names and reports the remaining count', async () => {
        const names = Array.from({ length: 22 }, (_, i) => `ambiguous-${i}`)
        database([
            { ...trash('first'), additionalAssets: names.map(pic) },
            { ...trash('second'), additionalAssets: names.map(name => [name, `assets/other-${name}.png`, 'png']) },
        ])
        const mine = bot({ chats: [chat(...names.map(name => `{{img::${name}}}`))] })
        const theirs = bot()
        const { merged } = update(mine, theirs)
        await keepChatPictures(merged, mine)
        expect(addLog).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            level: 'warning', description: [...names.slice(0, 20).map(name => `${name} (보류: 경로가 여럿)`), '… 외 2개'].join('\n'),
        }))
        expect(toast.warning).toHaveBeenCalledOnce()
    })
})

// 0.9.103-ver4: pictures are found by their records, and Asset Maid's picture picks (features.assetSelection) take the same way.

describe('Asset Maid picture picks (assetSelection) across a card update', () => {
    type Picks = { selections?: { target: string, assets: string[] }[], characterReferences?: Record<string, unknown>[] }
    /** The entry with Asset Maid picture picks and records for the named pictures ("asset:N" need not be the picture's position). */
    const withPicks = (entry: loreBook, picks: Picks | null, assets: Record<number, string> = {}): loreBook => {
        const data = portable(entry)
        if (picks) data.features.assetSelection = picks
        data.entities.assets = { ...data.entities.assets, ...Object.fromEntries(Object.entries(assets).map(([index, name]) => [`asset:${index}`, { fingerprints: { descriptor: assetMaidCharacterLocators([pic(name)])[0]!.descriptor } }])) }
        return { ...entry, content: '@@dont_activate ' + JSON.stringify(data) }
    }
    /** A number of the body -> the picture Asset Maid finds for it (descriptor and occurrence), or MISSING. */
    const named = (entry: loreBook | undefined, pictures: readonly unknown[]) => {
        const data = portable(entry), locators = assetMaidCharacterLocators(pictures)
        return (token: string) => {
            const record = data.entities.assets?.[token]
            const at = record ? locators.findIndex(locator => locator?.descriptor === record.fingerprints?.descriptor && locator?.occurrence === (record.occurrence ?? 0)) : -1
            return at < 0 ? `MISSING ${token}` : (pictures[at] as string[])[0]
        }
    }
    const rows = (entry: loreBook | undefined, pictures: readonly unknown[]) => {
        const name = named(entry, pictures)
        return Object.fromEntries((portable(entry).features.assetSelection?.selections ?? []).map((row: any) => [row.target, row.assets.map(name)]))
    }
    const formPictures = (entry: loreBook | undefined, pictures: readonly unknown[]) => {
        const name = named(entry, pictures)
        return portable(entry).features.characterForms.entries.flatMap((e: any) => e.forms.filter((f: any) => f.reference?.asset).map((f: any) => `${e.target}/${f.id}=${name(f.reference.asset)}`)).sort()
    }
    /** Every "asset:N" anywhere in the features has its record (Asset Maid rejects the whole body otherwise). */
    const dangling = (entry: loreBook | undefined) => {
        const data = portable(entry)
        return [...JSON.stringify(data.features).matchAll(/"(asset:\d+)"/g)].map(match => match[1]).filter(token => !data.entities.assets?.[token])
    }
    const maid = (char: character) => char.globalLore.find(entry => entry.comment === ASSET_MAID_COMMENT)
    const run = (mine: character, theirs: character, base: character | null, picks: (plan: UpdatePlan, id: string) => Record<string, 'mine' | 'theirs' | 'edit'> = (_plan, id) => ({ [id]: 'edit' })) => {
        const plan = planUpdate(CHARACTER_UPDATE, mine, theirs, base)
        const keep = presetAssetMaidMerge(plan, mine, theirs)!
        const merged = apply(plan, mine, theirs, picks(plan, keep.id), { [keep.id]: keep.text })
        const result = finalize(merged, mine, theirs)
        return { keep, merged, result, entry: maid(merged) }
    }
    const everything = (side: 'mine' | 'theirs') => (plan: UpdatePlan, id: string) => {
        const picks: Record<string, 'mine' | 'theirs' | 'edit'> = { [id]: 'edit' }
        for (const item of plan.items) if (picks[item.id] !== 'edit') picks[item.id] = side // chooseCharacterUpdateMany skips 'edit'
        return picks
    }

    test('the user references follow the picture their record names, not the picture at their number', () => {
        const { mine, theirs, base } = scenario()
        // Numbers written elsewhere (Asset Maid counts other pictures too): asset:1 names u2 and asset:2 names u1.
        mine.globalLore[2] = maidEntry([{ at: 0, fp: 'aria', forms: [{ id: 'f1', asset: 1 }, { id: 'f2', asset: 2 }] }, { at: 1, fp: 'bea', forms: [{ id: 'g1', asset: 1 }] }], { 1: 'u2', 2: 'u1' })
        const { result, merged, entry } = run(mine, theirs, base)
        expect(result).toMatchObject({ kept: 3, held: [], selected: 0 })
        expect(formPictures(entry, merged.additionalAssets!)).toEqual(['lore:0/g1=u2', 'lore:1/f1=u2', 'lore:1/f2=u1'])
        expect(dangling(entry)).toEqual([])
    })

    test('rows are joined by character: the new body\'s pictures first, then the user\'s own picks; every number keeps its record', () => {
        const { mine, theirs, base } = scenario()
        mine.globalLore[2] = withPicks(mine.globalLore[2], { selections: [{ target: 'lore:0', assets: ['asset:1', 'asset:0'] }, { target: 'lore:1', assets: ['asset:2'] }] }, { 0: 'card1' })
        // The new body numbers card2 as asset:7 (its position is 1) and picks card1 for Aria too.
        theirs.globalLore[2] = withPicks(theirs.globalLore[2], { selections: [{ target: 'lore:1', assets: ['asset:7', 'asset:3'] }] }, { 7: 'card2', 3: 'card1' })
        const { keep, result, merged, entry } = run(mine, theirs, base)
        expect(rows({ content: keep.text } as loreBook, ['card1', 'u1', 'u2', '__asset_maid_crop_x1', 'card2'].map(pic))).toEqual({ 'lore:1': ['card2', 'card1', 'u1'], 'lore:0': ['u2'] })
        expect(result).toMatchObject({ kept: 3, held: [], selected: 3 })
        expect(merged.additionalAssets!.map(asset => asset[0])).toEqual(['card1', 'u1', 'u2', '__asset_maid_crop_x1', 'card2'])
        expect(rows(entry, merged.additionalAssets!)).toEqual({ 'lore:1': ['card2', 'card1', 'u1'], 'lore:0': ['u2'] })
        expect(Object.keys(portable(entry).features.assetSelection)).toEqual(['selections'])
        expect(dangling(entry)).toEqual([])
    })

    test('the user\'s picks are carried when the new body has none, even without references', () => {
        const { mine, theirs, base } = scenario()
        mine.globalLore[2] = withPicks(maidEntry([{ at: 0, fp: 'aria', forms: [{ id: 'f1' }] }, { at: 1, fp: 'bea', forms: [{ id: 'g1' }] }], { 1: 'u1' }), { selections: [{ target: 'lore:0', assets: ['asset:1'] }] })
        const { keep, result, merged, entry } = run(mine, theirs, base)
        expect(keep.kept).toBe(0)
        expect(result).toMatchObject({ kept: 0, held: [], selected: 1 })
        expect(rows(entry, merged.additionalAssets!)).toEqual({ 'lore:1': ['u1'] })
        expect(dangling(entry)).toEqual([])
        // Without any pick or reference of the user's, nothing is preselected (as before).
        mine.globalLore[2] = maidEntry([{ at: 0, fp: 'aria', forms: [{ id: 'f1' }] }])
        expect(presetAssetMaidMerge(planUpdate(CHARACTER_UPDATE, mine, theirs, base), mine, theirs)).toBeNull()
    })

    test('a pick whose picture the new card removed is left out and reported; a row left empty is dropped', () => {
        const { mine, theirs, base } = scenario()
        mine.globalLore[2] = withPicks(mine.globalLore[2], { selections: [{ target: 'lore:0', assets: ['asset:0', 'asset:1'] }, { target: 'lore:1', assets: ['asset:0'] }] }, { 0: 'card1' })
        theirs.additionalAssets = [pic('card2')]
        const { result, merged, entry } = run(mine, theirs, base)
        expect(merged.additionalAssets!.map(asset => asset[0])).not.toContain('card1')
        expect(rows(entry, merged.additionalAssets!)).toEqual({ 'lore:1': ['u1'] })
        expect(result!.held.map(held => [held.side, held.character, held.reason, held.selection])).toEqual([
            ['mine', 'Character: Aria', 'asset-missing', true], ['mine', 'Character: Bea', 'asset-missing', true],
        ])
        expect(String(vi.mocked(toast.warning).mock.calls[0][0])).toContain('선택 그림 2개')
        expect(dangling(entry)).toEqual([])
    })

    test('"모두 새 버전" drops the picks of pictures it removes and keeps the rest; "내 버전" keeps the installed body as it is', () => {
        const { mine, theirs, base } = scenario()
        mine.additionalAssets = [...mine.additionalAssets!, pic('u3')]
        mine.globalLore[2] = withPicks(mine.globalLore[2], { selections: [{ target: 'lore:0', assets: ['asset:1'] }, { target: 'lore:1', assets: ['asset:4'] }] }, { 4: 'u3' })
        theirs.globalLore[2] = withPicks(theirs.globalLore[2], { selections: [{ target: 'lore:0', assets: ['asset:1'] }] }, { 1: 'card2' })
        const all = run(mine, theirs, base, everything('theirs'))
        // u1 stays because a reference needs it; u3 (only picked) goes with the user's choice.
        expect(all.merged.additionalAssets!.map(asset => asset[0])).toEqual(['card1', 'card2', 'u1', 'u2', '__asset_maid_crop_x1'])
        expect(rows(all.entry, all.merged.additionalAssets!)).toEqual({ 'lore:0': ['card2'], 'lore:1': ['u1'] })
        expect(all.result!.held.map(held => [held.character, held.reason])).toEqual([['Character: Bea', 'asset-missing']])
        expect(dangling(all.entry)).toEqual([])
        // "모두 내 버전" for the rest: the new card2 is not added, so the new body's pick of it goes and the user's u3 stays.
        const keepMine = run(mine, theirs, base, everything('mine'))
        const byName = Object.entries(rows(keepMine.entry, keepMine.merged.additionalAssets!)).map(([target, names]) => [keepMine.merged.globalLore[Number(target.slice(5))].comment, names])
        expect(byName).toEqual([['Character: Bea', ['u3']], ['Character: Aria', ['u1']]]) // the new body's row first
        expect(keepMine.result!.held.map(held => [held.side, held.character, held.reason])).toEqual([['theirs', 'Character: Bea', 'asset-missing']])
        expect(dangling(keepMine.entry)).toEqual([])
        const own = run(mine, theirs, base, (_plan, id) => ({ [id]: 'mine' }))
        expect(own.result).toBeNull()
        expect(own.entry!.content).toBe(mine.globalLore[2].content)
    })

    test('character references: the new body\'s follow their pictures, the user\'s win on the same character', () => {
        const { mine, theirs, base } = scenario()
        // Targets without forms ("self", "description:self"): Asset Maid uses a character reference only there.
        mine.globalLore[2] = withPicks(mine.globalLore[2], { characterReferences: [{ target: 'self', asset: 'asset:2', enabled: true }] })
        theirs.globalLore[2] = withPicks(theirs.globalLore[2], { characterReferences: [{ target: 'self', asset: 'asset:9' }, { target: 'description:self', analysisEnabled: false }] }, { 9: 'card2' })
        const { result, merged, entry } = run(mine, theirs, base)
        expect(result).toMatchObject({ held: [], selected: 1 })
        const name = named(entry, merged.additionalAssets!)
        expect(portable(entry).features.assetSelection.characterReferences.map((ref: any) => ({ ...ref, asset: ref.asset && name(ref.asset) })))
            .toEqual([{ target: 'self', asset: 'u2', enabled: true }, { target: 'description:self', analysisEnabled: false }])
        expect(dangling(entry)).toEqual([])
    })

    test('a module picture keeps its own record and number; it never takes over a card picture\'s number', () => {
        const { mine, theirs, base } = scenario()
        const data = portable(theirs.globalLore[2])
        data.features.characterForms.entries[0].forms[0].reference = { asset: 'asset:9' } // Aria f1 -> card2
        data.entities.assets = { 'asset:9': { fingerprints: { descriptor: assetMaidCharacterLocators([pic('card2')])[0]!.descriptor } }, 'asset:1': { module: 'module:0', fingerprints: { descriptor: 'am2:map' } } }
        data.features.assetSelection = { selections: [{ target: 'lore:1', assets: ['asset:1', 'asset:9'] }] }
        theirs.globalLore[2] = { ...theirs.globalLore[2], content: '@@dont_activate ' + JSON.stringify(data) }
        mine.globalLore[2] = maidEntry([{ at: 0, fp: 'aria', forms: [{ id: 'f2', asset: 2 }] }], { 2: 'u2' })
        const { result, merged, entry } = run(mine, theirs, base)
        const body = portable(entry)
        const [moduleToken, cardToken] = body.features.assetSelection.selections[0].assets
        expect(body.entities.assets[moduleToken]).toEqual({ module: 'module:0', fingerprints: { descriptor: 'am2:map' } })
        expect(Number(moduleToken.slice(6))).toBeGreaterThanOrEqual(merged.additionalAssets!.length)
        expect(named(entry, merged.additionalAssets!)(cardToken)).toBe('card2')
        expect(formPictures(entry, merged.additionalAssets!)).toEqual(['lore:1/f1=card2', 'lore:1/f2=u2'])
        expect(result!.held).toEqual([])
        expect(dangling(entry)).toEqual([])
    })

    test('rows of lore entries without forms, "self" rows and two rows of one character are joined; a pick without a record is held', () => {
        const { mine, theirs, base } = scenario()
        const cleo = lore('Character: Cleo', 'cleo')
        base.globalLore = [...base.globalLore, cleo]
        mine.globalLore = [mine.globalLore[0], mine.globalLore[1], cleo, mine.globalLore[2]]
        theirs.globalLore = [theirs.globalLore[0], theirs.globalLore[1], cleo, theirs.globalLore[2]]
        const withCleo = (entry: loreBook, picks: Picks, assets: Record<number, string>) => {
            const data = portable(withPicks(entry, picks, assets))
            data.entities.lorebooks['lore:2'] = fp('cleo') // Cleo has no forms on either side
            return { ...entry, content: '@@dont_activate ' + JSON.stringify(data) }
        }
        mine.globalLore[3] = withCleo(mine.globalLore[3], { selections: [{ target: 'lore:2', assets: ['asset:1'] }, { target: 'lore:2', assets: ['asset:2'] }, { target: 'self', assets: ['asset:1', 'asset:5'] }] }, {})
        theirs.globalLore[3] = withCleo(theirs.globalLore[3], { selections: [{ target: 'self', assets: ['asset:4'] }] }, { 4: 'card2' })
        const { result, merged, entry } = run(mine, theirs, base)
        const byName = Object.fromEntries(Object.entries(rows(entry, merged.additionalAssets!)).map(([target, names]) => [target === 'self' ? 'self' : merged.globalLore[Number(target.slice(5))].comment, names]))
        expect(byName).toEqual({ self: ['card2', 'u1'], 'Character: Cleo': ['u1', 'u2'] })
        expect(result!.held.map(held => [held.side, held.target, held.reason, held.reference.asset])).toEqual([['mine', 'self', 'asset-missing', 'asset:5']])
        expect(dangling(entry)).toEqual([])
    })

    test('a picture the user\'s character reference brings back keeps the user\'s picks of it', () => {
        const { mine, theirs, base } = scenario()
        mine.additionalAssets = [...mine.additionalAssets!, pic('u3')]
        // ("self" has no forms: Asset Maid uses a character reference only there.)
        mine.globalLore[2] = withPicks(mine.globalLore[2], { selections: [{ target: 'self', assets: ['asset:4'] }], characterReferences: [{ target: 'self', asset: 'asset:4' }] }, { 4: 'u3' })
        const { result, merged, entry } = run(mine, theirs, base, everything('theirs'))
        expect(merged.additionalAssets!.map(asset => asset[0])).toContain('u3')
        const name = named(entry, merged.additionalAssets!)
        expect(Object.values(rows(entry, merged.additionalAssets!))).toEqual([['u3']])
        expect(portable(entry).features.assetSelection.characterReferences.map((ref: any) => name(ref.asset))).toEqual(['u3'])
        expect(result!.held).toEqual([])
        expect(dangling(entry)).toEqual([])
    })

    test('the new body\'s outfit references follow their pictures too', () => {
        const { mine, theirs, base } = scenario()
        const data = portable(theirs.globalLore[2])
        data.features.characterForms.entries[0].forms[0].outfits = [{ id: 'o1', label: 'o1', description: '', parts: {}, reference: { asset: 'asset:6' } }]
        data.features.outfits = { entries: [{ target: 'lore:0', outfits: [{ id: 'o2', label: 'o2', description: '', parts: {}, reference: { asset: 'asset:6' } }] }] }
        data.entities.assets = { 'asset:6': { fingerprints: { descriptor: assetMaidCharacterLocators([pic('card2')])[0]!.descriptor } } }
        theirs.globalLore[2] = { ...theirs.globalLore[2], content: '@@dont_activate ' + JSON.stringify(data) }
        const { merged, entry } = run(mine, theirs, base)
        const body = portable(entry), name = named(entry, merged.additionalAssets!)
        expect(name(body.features.characterForms.entries[0].forms[0].outfits[0].reference.asset)).toBe('card2')
        expect(name(body.features.outfits.entries[0].outfits[0].reference.asset)).toBe('card2')
        expect(dangling(entry)).toEqual([])
    })

    describe('mergeAssetMaid on bodies built by hand', () => {
        const A = pic('a'), B = pic('b')
        const record = (picture: [string, string, string]) => ({ fingerprints: { descriptor: assetMaidCharacterLocators([picture])[0]!.descriptor } })
        const moduleRecord = { module: 'module:map', fingerprints: { descriptor: 'am2:map-a' } }
        const body = (features: Record<string, unknown>, entities: Record<string, unknown> = {}, lorebooks: Record<string, unknown> = { 'lore:0': fp('aria') }) =>
            lore(ASSET_MAID_COMMENT, '@@dont_activate ' + JSON.stringify({ schema: 'asset-maid.portable', version: 1, scope: 'character', entities: { lorebooks, ...entities }, features }))
        const merge = (mineEntry: loreBook, theirsEntry: loreBook, pictures: { mine: unknown[], theirs: unknown[] }, result: unknown[], map?: Map<number, number>) => {
            const mine = bot({ globalLore: [lore('Character: Aria', 'aria'), mineEntry], additionalAssets: pictures.mine as [string, string, string][] })
            const theirs = bot({ globalLore: [lore('Character: Aria', 'aria'), theirsEntry], additionalAssets: pictures.theirs as [string, string, string][] })
            const merged = mergeAssetMaid(mineEntry, theirsEntry, mine, theirs, result, map)!
            const entry = { content: merged.content } as loreBook
            return { merged, entry, data: portable(entry), name: named(entry, result) }
        }

        test('a picture the user\'s character reference brings back keeps the new body\'s picks and outfit references of it', () => {
            const mineEntry = body({ assetSelection: { characterReferences: [{ target: 'self', asset: 'asset:0' }] } }, { assets: { 'asset:0': record(A) } })
            const theirsEntry = body({ assetSelection: { selections: [{ target: 'self', assets: ['asset:5'] }] }, outfits: { entries: [{ target: 'self', outfits: [{ id: 'o', label: 'o', description: '', parts: {}, reference: { asset: 'asset:5' } }] }] } }, { assets: { 'asset:5': record(A) } })
            const result: unknown[] = []
            const { merged, data, name } = merge(mineEntry, theirsEntry, { mine: [A], theirs: [A] }, result)
            expect(result).toEqual([A])
            expect(merged.held).toEqual([])
            expect(data.features.assetSelection.selections.map((row: any) => row.assets.map(name))).toEqual([['a']])
            expect(name(data.features.outfits.entries[0].outfits[0].reference.asset)).toBe('a')
        })

        test('custom characters and member descriptions the new body has keep the user\'s picks', () => {
            const picks = { selections: [{ target: 'custom:demo', assets: ['asset:0'] }, { target: 'member:0/description:self', assets: ['asset:0'] }], characterReferences: [{ target: 'custom:demo', asset: 'asset:0' }] }
            const mineEntry = body({ assetSelection: picks }, { assets: { 'asset:0': record(A) }, members: { 'member:0': {} } })
            const theirsEntry = body({ characters: { entries: [{ id: 'demo' }] } }, { members: { 'member:0': {} } })
            const { merged, data, name } = merge(mineEntry, theirsEntry, { mine: [A], theirs: [A] }, [A])
            expect(merged).toMatchObject({ held: [], selected: 3 })
            expect(data.features.assetSelection.selections.map((row: any) => [row.target, row.assets.map(name)])).toEqual([['custom:demo', ['a']], ['member:0/description:self', ['a']]])
            expect(data.features.assetSelection.characterReferences.map((ref: any) => [ref.target, name(ref.asset)])).toEqual([['custom:demo', 'a']])
            // A custom character the new body does not have is held.
            const { merged: gone } = merge(mineEntry, body({}), { mine: [A], theirs: [A] }, [A])
            expect(gone.held.map(held => [held.target, held.reason])).toEqual([['custom:demo', 'character-missing'], ['custom:demo', 'character-missing'], ['member:0/description:self', 'character-missing']])
        })

        test('one module picture named on both sides is one number', () => {
            const mineEntry = body({ assetSelection: { selections: [{ target: 'self', assets: ['asset:3'] }] } }, { assets: { 'asset:3': moduleRecord } })
            const theirsEntry = body({ assetSelection: { selections: [{ target: 'self', assets: ['asset:7', 'asset:1'] }] } }, { assets: { 'asset:7': moduleRecord, 'asset:1': record(B) } })
            const { data } = merge(mineEntry, theirsEntry, { mine: [A], theirs: [A, B] }, [A, B])
            const tokens = data.features.assetSelection.selections[0].assets
            expect(tokens).toHaveLength(2)
            expect(tokens.map((token: string) => data.entities.assets[token])).toEqual([moduleRecord, record(B)])
        })

        test('a reference number without a record is held and taken out, never left without its record', () => {
            const theirsEntry = body({ characterForms: { entries: [{ target: 'lore:0', defaultFormId: 'f', forms: [{ id: 'f', label: 'f', reference: { asset: 'asset:0' } }] }] } })
            const { merged, data } = merge(body({}), theirsEntry, { mine: [A], theirs: [A] }, [A])
            expect(merged.held.map(held => [held.side, held.formId, held.reason])).toEqual([['theirs', 'f', 'asset-missing']])
            expect(data.features.characterForms.entries[0].forms[0].reference).toBeUndefined()
            expect(dangling(entry_(data))).toEqual([])
        })

        test('picks of a new-body lore entry left out of the lorebook go with it and are reported', () => {
            const theirsEntry = body({ assetSelection: { selections: [{ target: 'lore:0', assets: ['asset:0'] }] } }, { assets: { 'asset:0': record(A) } })
            const { merged, data } = merge(body({}), theirsEntry, { mine: [A], theirs: [A] }, [A], new Map())
            expect(merged.dropped).toEqual(['Character: Aria'])
            expect(data.features.assetSelection).toEqual({ selections: [] })
        })

        test('one module picture is one number however each side wrote its record', () => {
            const mineEntry = body({ assetSelection: { selections: [{ target: 'self', assets: ['asset:3'] }] } }, { assets: { 'asset:3': { module: 'module:map', fingerprints: { descriptor: 'am2:map-a', content: 'am2:c' } } } })
            const theirsEntry = body({ assetSelection: { selections: [{ target: 'self', assets: ['asset:7'] }] } }, { assets: { 'asset:7': { fingerprints: { descriptor: 'am2:map-a' }, module: 'module:map' } } })
            const { data } = merge(mineEntry, theirsEntry, { mine: [A], theirs: [A] }, [A])
            expect(data.features.assetSelection.selections[0].assets).toHaveLength(1)
        })

        test('a new-body form reference finds a picture the user\'s character reference brought back', () => {
            const old: [string, string, string] = ['old', 'assets/a.png', 'png'], renamed: [string, string, string] = ['new', 'assets/a.png', 'png']
            const mineEntry = body({ assetSelection: { characterReferences: [{ target: 'self', asset: 'asset:0' }] } }, { assets: { 'asset:0': record(old) } })
            const theirsEntry = body({ characterForms: { entries: [{ target: 'self', defaultFormId: 'f', forms: [{ id: 'f', label: 'f', reference: { asset: 'asset:0' } }] }] } }, { assets: { 'asset:0': record(renamed) } })
            const result: unknown[] = []
            const { merged, data, name } = merge(mineEntry, theirsEntry, { mine: [old], theirs: [renamed] }, result)
            expect(result).toEqual([old])
            expect(merged.held).toEqual([])
            expect(name(data.features.characterForms.entries[0].forms[0].reference.asset)).toBe('old')
            expect(dangling(entry_(data))).toEqual([])
        })

        test('a member\'s lore target stays when the new body\'s record of it is the same entry', () => {
            const lorebooks = { 'lore:0': fp('aria'), 'member:0/lore:0': fp('member-lore') }
            const mineEntry = body({ assetSelection: { selections: [{ target: 'member:0/lore:0', assets: ['asset:0'] }] } }, { assets: { 'asset:0': record(A) }, members: { 'member:0': {} } }, lorebooks)
            const { merged, data, name } = merge(mineEntry, body({}, { members: { 'member:0': {} } }, lorebooks), { mine: [A], theirs: [A] }, [A])
            expect(merged).toMatchObject({ held: [], selected: 1 })
            expect(data.features.assetSelection.selections.map((row: any) => [row.target, row.assets.map(name)])).toEqual([['member:0/lore:0', ['a']]])
            const { merged: other } = merge(mineEntry, body({}, { members: { 'member:0': {} } }, { 'lore:0': fp('aria'), 'member:0/lore:0': fp('someone-else') }), { mine: [A], theirs: [A] }, [A])
            expect(other.held.map(held => held.reason)).toEqual(['character-missing'])
        })

        test('two left-out entries with the same name are reported as two', () => {
            const theirsEntry = body({ assetSelection: { selections: [{ target: 'lore:0', assets: ['asset:0'] }, { target: 'lore:1', assets: ['asset:0'] }] } }, { assets: { 'asset:0': record(A) } }, { 'lore:0': fp('a'), 'lore:1': fp('b') })
            const mine = bot({ globalLore: [lore('Same', 'a'), lore('Same', 'b'), body({})], additionalAssets: [A] })
            const theirs = bot({ globalLore: [lore('Same', 'a'), lore('Same', 'b'), theirsEntry], additionalAssets: [A] })
            expect(mergeAssetMaid(mine.globalLore[2], theirsEntry, mine, theirs, [A], new Map())!.dropped).toEqual(['Same', 'Same'])
        })

        test('an empty custom slot of the user\'s does not keep a new-body reference from a picture brought back', () => {
            const forms = (reference: unknown) => ({ characterForms: { entries: [{ target: 'custom:demo', defaultFormId: 'f', forms: [{ id: 'f', label: 'f', reference }] }] } })
            const mineEntry = body({ ...forms({}), assetSelection: { characterReferences: [{ target: 'self', asset: 'asset:0' }] } }, { assets: { 'asset:0': record(A) } })
            const theirsEntry = body(forms({ asset: 'asset:0' }), { assets: { 'asset:0': record(A) } })
            const { merged, data, name } = merge(mineEntry, theirsEntry, { mine: [A], theirs: [A] }, [])
            expect(merged.held).toEqual([])
            expect(name(data.features.characterForms.entries[0].forms[0].reference.asset)).toBe('a')
        })

        test('a character reference of the user\'s goes to the default form when the new body gave the character forms', () => {
            const mineEntry = body({ assetSelection: { characterReferences: [{ target: 'lore:0', asset: 'asset:0', enabled: true }] } }, { assets: { 'asset:0': record(A) } })
            const theirsEntry = body({ characterForms: { entries: [{ target: 'lore:0', defaultFormId: 'g', forms: [{ id: 'f', label: 'f' }, { id: 'g', label: 'g', reference: { asset: 'asset:1' } }] }] } }, { assets: { 'asset:1': record(B) } })
            const { merged, data, name } = merge(mineEntry, theirsEntry, { mine: [A], theirs: [B] }, [A, B])
            expect(merged).toMatchObject({ held: [], selected: 1 })
            const [f, g] = data.features.characterForms.entries[0].forms
            expect(f.reference).toBeUndefined()
            expect({ ...g.reference, asset: name(g.reference.asset) }).toEqual({ asset: 'a', enabled: true })
            expect(data.features.assetSelection).toBeUndefined()
        })

        test('a character reference of the user\'s does not take a form another installed character\'s reference already took', () => {
            const lorebooks = { 'lore:0': fp('aria'), 'lore:1': fp('aria') }
            const mineEntry = body({ characterForms: { entries: [{ target: 'lore:0', defaultFormId: 'f', forms: [{ id: 'f', label: 'f', reference: { asset: 'asset:0' } }] }] },
                assetSelection: { characterReferences: [{ target: 'lore:1', asset: 'asset:1' }] } }, { assets: { 'asset:0': record(A), 'asset:1': record(B) } }, lorebooks)
            const theirsEntry = body({ characterForms: { entries: [{ target: 'lore:0', defaultFormId: 'f', forms: [{ id: 'f', label: 'f' }] }] } })
            const mine = bot({ globalLore: [lore('Character: Aria', 'aria'), lore('Character: Aria', 'aria'), mineEntry], additionalAssets: [A, B] })
            const theirs = bot({ globalLore: [lore('Character: Aria', 'aria'), theirsEntry], additionalAssets: [A, B] })
            const merged = mergeAssetMaid(mineEntry, theirsEntry, mine, theirs, [A, B])!
            const data = portable({ content: merged.content } as loreBook)
            expect(named({ content: merged.content } as loreBook, [A, B])(data.features.characterForms.entries[0].forms[0].reference.asset)).toBe('a')
            expect(merged).toMatchObject({ kept: 1, selected: 0 })
            expect(merged.held.map(held => [held.target, held.reason, held.selection])).toEqual([['lore:1', 'character-ambiguous', true]])
        })

        test('of two character references of one target, the last (the one Asset Maid uses) is carried', () => {
            const mineEntry = body({ assetSelection: { characterReferences: [{ target: 'self', asset: 'asset:0' }, { target: 'self', asset: 'asset:1' }] } }, { assets: { 'asset:0': record(A), 'asset:1': record(B) } })
            const theirsEntry = body({ characterForms: { entries: [{ target: 'self', defaultFormId: 'f', forms: [{ id: 'f', label: 'f' }] }] } })
            const { merged, data, name } = merge(mineEntry, theirsEntry, { mine: [A, B], theirs: [A, B] }, [A, B])
            expect(merged).toMatchObject({ held: [], selected: 1 })
            expect(name(data.features.characterForms.entries[0].forms[0].reference.asset)).toBe('b')
            const { data: noForms, name: noFormsName } = merge(mineEntry, body({}), { mine: [A, B], theirs: [A, B] }, [A, B])
            expect(noForms.features.assetSelection.characterReferences.map((ref: any) => [ref.target, noFormsName(ref.asset)])).toEqual([['self', 'b']])
        })

        test('of the new body\'s character references of one target only the last counts, even when its picture is left out', () => {
            const C: [string, string, string] = pic('c')
            const mineEntry = body({ assetSelection: { characterReferences: [{ target: 'description:self', asset: 'asset:1' }] } }, { assets: { 'asset:1': record(C) } })
            const theirsEntry = body({ assetSelection: { characterReferences: [{ target: 'self', asset: 'asset:0' }, { target: 'self', asset: 'asset:1' }] } }, { assets: { 'asset:0': record(A), 'asset:1': record(B) } })
            const { merged, data, name } = merge(mineEntry, theirsEntry, { mine: [A, C], theirs: [A, B] }, [A, C])
            expect(data.features.assetSelection.characterReferences.map((ref: any) => [ref.target, name(ref.asset)])).toEqual([['description:self', 'c']])
            expect(merged.held.map(held => [held.side, held.target, held.reference.asset, held.reason])).toEqual([['theirs', 'self', 'asset:1', 'asset-missing']])
        })

        test('a character reference the installed body never used (its character has forms) is not carried', () => {
            const C: [string, string, string] = pic('c')
            const mineEntry = body({ characterForms: { entries: [{ target: 'self', defaultFormId: 'f', forms: [{ id: 'f', label: 'f', reference: { asset: 'asset:0' } }] }] },
                assetSelection: { characterReferences: [{ target: 'self', asset: 'asset:1' }] } }, { assets: { 'asset:0': record(A), 'asset:1': record(B) } })
            const theirsEntry = body({ assetSelection: { characterReferences: [{ target: 'self', asset: 'asset:0' }] } }, { assets: { 'asset:0': record(C) } })
            const result: unknown[] = [C]
            const { merged, data, name } = merge(mineEntry, theirsEntry, { mine: [A, B], theirs: [C] }, result)
            expect(result).toEqual([C])
            expect(merged.selected).toBe(0)
            expect(data.features.assetSelection.characterReferences.map((ref: any) => [ref.target, name(ref.asset)])).toEqual([['self', 'c']])
            expect(merged.held.map(held => [held.side, held.formId, held.reason])).toEqual([['mine', 'f', 'character-missing']])
        })

        test('a form target written with spaces still makes the installed character reference unused (Asset Maid trims targets)', () => {
            const C: [string, string, string] = pic('c')
            const mineEntry = body({ characterForms: { entries: [{ target: ' self ', defaultFormId: 'f', forms: [{ id: 'f', label: 'f', reference: { asset: 'asset:0' } }] }] },
                assetSelection: { characterReferences: [{ target: 'self', asset: 'asset:1' }] } }, { assets: { 'asset:0': record(A), 'asset:1': record(B) } })
            const theirsEntry = body({ assetSelection: { characterReferences: [{ target: 'self', asset: 'asset:0' }] } }, { assets: { 'asset:0': record(C) } })
            const result: unknown[] = [C]
            const { merged, data, name } = merge(mineEntry, theirsEntry, { mine: [A, B], theirs: [C] }, result)
            expect(result).toEqual([C])
            expect(merged.selected).toBe(0)
            expect(data.features.assetSelection.characterReferences.map((ref: any) => [ref.target, name(ref.asset)])).toEqual([['self', 'c']])
        })

        test('text that reads like a lore number stays (also in matching keys and aliases); targets, target lists and keys move', () => {
            const forms = { characterForms: { entries: [{ target: 'lore:0', defaultFormId: 'f', matchingKeys: { mode: 'replace', values: ['lore:88', 'lore:0', 'ordinary'] }, forms: [{ id: 'f', label: 'lore:88', description: 'lore:0' }] }] },
                assetMatching: { entries: [{ target: 'lore:0', result: { kind: 'aliases', values: ['lore:0', 'ordinary'] } }] },
                sourceSelection: { selectedTargets: ['lore:0'], workspaceDisabledTargets: ['lore:0'] } }
            const theirsEntry = body(forms)
            const mine = bot({ globalLore: [lore('Character: Aria', 'aria'), body({})], additionalAssets: [] })
            const theirs = bot({ globalLore: [lore('Character: Aria', 'aria'), theirsEntry], additionalAssets: [] })
            const merged = mergeAssetMaid(mine.globalLore[1], theirsEntry, mine, theirs, [], new Map([[0, 3]]))!
            const data = portable({ content: merged.content } as loreBook)
            expect(data.features.characterForms.entries[0]).toMatchObject({ target: 'lore:3', forms: [{ id: 'f', label: 'lore:88', description: 'lore:0' }] })
            expect(data.features.characterForms.entries[0].matchingKeys.values).toEqual(['lore:88', 'lore:0', 'ordinary'])
            expect(data.features.assetMatching.entries[0]).toEqual({ target: 'lore:3', result: { kind: 'aliases', values: ['lore:0', 'ordinary'] } })
            expect(data.features.sourceSelection).toEqual({ selectedTargets: ['lore:3'], workspaceDisabledTargets: ['lore:3'] })
            expect(Object.keys(data.entities.lorebooks)).toEqual(['lore:3'])
        })

        test('a lore target written with spaces moves with its record (Asset Maid trims targets)', () => {
            const theirsEntry = body({ characterForms: { entries: [{ target: ' lore:0 ', defaultFormId: 'f', forms: [{ id: 'f', label: 'f' }] }] } })
            const mine = bot({ globalLore: [lore('Character: Aria', 'aria'), body({})], additionalAssets: [] })
            const theirs = bot({ globalLore: [lore('Character: Aria', 'aria'), theirsEntry], additionalAssets: [] })
            const merged = mergeAssetMaid(mine.globalLore[1], theirsEntry, mine, theirs, [], new Map([[0, 1]]))!
            const data = portable({ content: merged.content } as loreBook)
            expect(data.features.characterForms.entries.map((entry: any) => entry.target)).toEqual(['lore:1'])
            expect(Object.keys(data.entities.lorebooks)).toEqual(['lore:1'])
            expect(merged.dropped).toEqual([])
            expect(mergeAssetMaid(mine.globalLore[1], theirsEntry, mine, theirs, [], new Map())!.dropped).toEqual(['Character: Aria'])
        })

        test('targets written with spaces are the same targets when the user\'s references are matched', () => {
            const people = [lore('Same', 'a'), lore('Same', 'b')]
            const lorebooks = { 'lore:0': fp('a'), 'lore:1': fp('b') }
            const form = (asset?: string) => [{ id: 'f', label: 'f', ...(asset ? { reference: { asset } } : {}) }]
            const mineEntry = body({ characterForms: { entries: [{ target: ' lore:0 ', defaultFormId: 'f', forms: form('asset:0') }, { target: 'self', defaultFormId: 'f', forms: form('asset:0') }] } }, { assets: { 'asset:0': record(A) } }, lorebooks)
            const theirsEntry = body({ characterForms: { entries: [{ target: ' lore:0 ', defaultFormId: 'f', forms: form() }, { target: 'lore:1', defaultFormId: 'f', forms: form() }, { target: 'self', defaultFormId: 'f', forms: form() }] } }, {}, lorebooks)
            const mine = bot({ globalLore: [...people, mineEntry], additionalAssets: [A] }), theirs = bot({ globalLore: [...people, theirsEntry], additionalAssets: [A] })
            const merged = mergeAssetMaid(mineEntry, theirsEntry, mine, theirs, [A])!
            expect(merged).toMatchObject({ kept: 2, held: [] })
            const entry = { content: merged.content } as loreBook
            expect(formPictures(entry, [A])).toEqual(['lore:0/f=a', 'self/f=a'])
            // A character reference of the user's goes to the new body's form even when its target is written with spaces.
            const refEntry = body({ assetSelection: { characterReferences: [{ target: 'lore:0', asset: 'asset:0' }] } }, { assets: { 'asset:0': record(A) } }, lorebooks)
            const formsEntry = body({ characterForms: { entries: [{ target: ' lore:0 ', defaultFormId: 'f', forms: form('asset:1') }] } }, { assets: { 'asset:1': record(B) } }, lorebooks)
            const second = mergeAssetMaid(refEntry, formsEntry, bot({ globalLore: [...people, refEntry], additionalAssets: [A] }), bot({ globalLore: [...people, formsEntry], additionalAssets: [B] }), [B, A])!
            const data = portable({ content: second.content } as loreBook)
            expect(second).toMatchObject({ held: [], selected: 1 })
            expect(formPictures({ content: second.content } as loreBook, [B, A])).toEqual(['lore:0/f=a'])
            expect(data.features.assetSelection).toBeUndefined()
        })

        test('form references on "self" move like any other same target', () => {
            const forms = (asset: string) => ({ characterForms: { entries: [{ target: 'self', defaultFormId: 'form_default', forms: [{ id: 'form_default', label: 'd', reference: { asset } }] }] } })
            const { merged, data, name } = merge(body(forms('asset:0'), { assets: { 'asset:0': record(A) } }), body(forms('asset:4'), { assets: { 'asset:4': record(B) } }), { mine: [A], theirs: [B] }, [A, B])
            expect(merged).toMatchObject({ kept: 1, replaced: 1, held: [] })
            expect(name(data.features.characterForms.entries[0].forms[0].reference.asset)).toBe('a')
        })

        test('a missing pick named several times is held once', () => {
            const mineEntry = body({ assetSelection: { selections: [{ target: 'self', assets: ['asset:0', 'asset:0', 'asset:1'] }, { target: 'self', assets: ['asset:0'] }] } }, { assets: { 'asset:0': record(A), 'asset:1': record(B) } })
            const { merged, data, name } = merge(mineEntry, body({}), { mine: [A, B], theirs: [B] }, [B])
            expect(merged.held.map(held => [held.target, held.reference.asset, held.reason])).toEqual([['self', 'asset:0', 'asset-missing']])
            expect(merged.selected).toBe(1)
            expect(data.features.assetSelection.selections.map((row: any) => row.assets.map(name))).toEqual([['b']])
        })
    })
    const entry_ = (data: unknown) => ({ content: '@@dont_activate ' + JSON.stringify(data) }) as loreBook

    test('without picks on either side the body has no assetSelection, as before', () => {
        const { mine, theirs, base } = scenario()
        const { entry } = run(mine, theirs, base)
        expect('assetSelection' in portable(entry).features).toBe(false)
    })
})
