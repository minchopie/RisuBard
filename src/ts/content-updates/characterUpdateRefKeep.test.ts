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
        const theirs = customBody([{ target: target + '-other', forms }, ...Array.from({ length: count }, () => ({ target, forms }))])
        const merged = mergeAssetMaid(mine, theirs, { additionalAssets: [pic('mine')] }, { additionalAssets: [pic('incoming')] }, [pic('incoming')], new Map())!
        expect(merged.held).toEqual([{ side: 'mine', target, character: '', formId: 'f', reference: forms[0].reference, reason }])
        expect(merged).toMatchObject({ kept: 0, replaced: 0, appended: 0, dropped: [] })
    })

    test('empty slots alone keep upstream choices and do not restore a removed crop', () => {
        const mine = bot({ additionalAssets: [pic('__asset_maid_crop_unused')], globalLore: [customBody([{ target, forms: [{ id: 'f', reference: {} }, { id: 'removed', reference: {} }] }])] })
        const theirs = bot({ globalLore: [customBody([{ target, forms: [{ id: 'f', label: 'New' }, { id: 'incoming', reference: {} }] }])] })
        const plan = planUpdate(CHARACTER_UPDATE, mine, theirs, null)
        expect(presetAssetMaidMerge(plan, mine, theirs)).toBeNull()
        const merged = apply(plan, mine, theirs, Object.fromEntries(plan.items.map(item => [item.id, 'theirs'])))
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
        const choices = Object.fromEntries(plan.items.map(item => [item.id, item.id === keep.id ? 'edit' : 'theirs']))
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
            expect(merge(mine, theirs).data.entities.assets['asset:0']).toEqual(body.entities.assets['asset:0'])
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
