import { beforeEach, describe, expect, test, vi } from 'vitest'
vi.mock('svelte-sonner', () => ({ toast: { warning: vi.fn() } }))
vi.mock('../log', () => ({ addLog: vi.fn() }))
import { toast } from 'svelte-sonner'
import type { character, loreBook } from '../storage/database.svelte'
import { CHARACTER_UPDATE, applyUpdate, planUpdate, type UpdateChoice, type UpdatePlan } from '../characterUpdate'
import { editedValue } from '../characterUpdateView'
import { ASSET_MAID_COMMENT, applyAssetMaidPreset, finalizeAssetMaidMerge as finalizeWith, mergeAssetMaid, presetAssetMaidMerge } from './characterUpdateRefKeep'

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
    if (Object.keys(assets).length) data.entities.assets = Object.fromEntries(Object.entries(assets).map(([index, name]) => [`asset:${index}`, { fingerprints: { descriptor: `am2:${name}` } }]))
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

beforeEach(() => vi.mocked(toast.warning).mockClear())

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
        expect(portable(entry).entities.assets).toEqual({ 'asset:2': { fingerprints: { descriptor: 'am2:u1' } }, 'asset:3': { fingerprints: { descriptor: 'am2:u2' } } })
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
        expect(portable(entry).entities.assets['asset:4']).toEqual({ fingerprints: { descriptor: 'am2:card2' } })
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
