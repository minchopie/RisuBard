import { describe, expect, it } from 'vitest'
import { reconcilePainterSubjects, capturePainterOutfit, promotePainterOutfit, applyPainterPresets } from './state'
import type { PainterOutfit, PainterSubject } from './types'
const subject = (patch: Partial<PainterSubject> = {}): PainterSubject => ({ id: '', name: '아리아', aliases: [], kind: 'character', appearance: 'black hair', clothing: 'white shirt', state: 'wet clothes', pose: 'sitting', negative: '', ...patch })
it('resolves a known alias to the same identity without overwriting its stored appearance', () => {
    const identities = [{ id: 'aria', name: '아리아', aliases: ['Aria'], appearance: 'blue eyes' }]
    const result = reconcilePainterSubjects([subject({ name: 'Aria' })], identities, [])
    expect(result[0].id).toBe('aria')
    expect(identities[0].appearance).toBe('blue eyes')
})
it('keeps locked subject edits when a new prompt is prepared', () => {
    const locked = subject({ id: 'aria', clothing: 'red coat', locked: true })
    expect(reconcilePainterSubjects([subject({ id: 'aria' })], [{ id: 'aria', name: '아리아', aliases: [], appearance: '' }], [locked])[0]).toEqual(locked)
})
it('retains omitted locked blocks at their prior positions without retaining omitted unlocked blocks', () => {
    const locked = subject({ id: 'aria', clothing: 'red coat', locked: true })
    const omitted = subject({ id: 'luke', name: '루크' })
    const returned = subject({ id: 'mira', name: '미라' })
    const result = reconcilePainterSubjects([returned], [], [locked, omitted, returned])
    expect(result.map(item => item.id)).toEqual(['aria', 'mira'])
    expect(result[0]).toEqual(locked)
    result[0].aliases.push('changed')
    expect(locked.aliases).toEqual([])
})
it.each(['manual-aria', ''])('matches a block already in the draft before allocating another ID (%s)', id => {
    const previous = subject({ id: 'manual-aria', aliases: ['Aria'] })
    const [result] = reconcilePainterSubjects([subject({ id, name: 'Aria' })], [], [previous])
    expect(result.id).toBe('manual-aria')
})
it('never registers saved identities for unrecognized subjects', () => {
    const identities = [{ id: 'aria', name: '아리아', aliases: [], appearance: 'blue hair' }]
    const [result] = reconcilePainterSubjects([subject({ name: '처음 보는 사람' })], identities, [])
    expect(result.id).not.toBe('')
    expect(identities).toEqual([{ id: 'aria', name: '아리아', aliases: [], appearance: 'blue hair' }])
})
it('prefers the identity with a saved look when a blank entry shares its name', () => {
    const identities = [{ id: 'blank', name: '아리아', aliases: [], appearance: '' }, { id: 'real', name: 'Aria', aliases: ['아리아'], appearance: 'blue hair' }]
    expect(reconcilePainterSubjects([subject({ name: '아리아' })], identities, [])[0].id).toBe('real')
})
it('ignores IDs the model invented', () => {
    const [result] = reconcilePainterSubjects([subject({ id: 'made-up', name: '아리아' })], [{ id: 'aria', name: '아리아', aliases: [], appearance: 'x' }], [])
    expect(result.id).toBe('aria')
})
it('rejects a merged draft above 22 subjects without dropping locks', () => {
    const locked = subject({ id: 'locked', name: '보존할 인물', locked: true })
    const generated = Array.from({ length: 22 }, (_, index) => subject({ name: `new-${index}` }))
    expect(() => reconcilePainterSubjects(generated, [], [locked])).toThrow()
})
it('saves clothing without pose, appearance or transient state by default', () => {
    const outfit = capturePainterOutfit(subject({ id: 'aria' }), '여행복', false)
    expect(outfit).toMatchObject({ subjectId: 'aria', name: '여행복', clothing: 'white shirt', state: '' })
    expect(outfit).not.toHaveProperty('pose')
    expect(outfit).not.toHaveProperty('appearance')
})
it('promotion copies a chat outfit to a separately editable bot outfit', () => {
    const original = capturePainterOutfit(subject({ id: 'aria' }), '여행복', true)
    const promoted = promotePainterOutfit(original)
    expect(promotePainterOutfit({ ...original, attachToCard: true }).attachToCard).not.toBe(true)
    expect(promoted.id).not.toBe(original.id)
    promoted.clothing = 'black dress'
    expect(original.clothing).toBe('white shirt')
})

describe('applyPainterPresets', () => {
    const presets = [{ id: 'severa', name: '세베라', aliases: ['Severa'], appearance: 'black hair, grey eyes', note: '세베루스 스네이프의 여동생' }, { id: 'blank', name: '루크', aliases: [], appearance: '' }]
    const outfits: Record<string, PainterOutfit[]> = { severa: [{ id: 'robe', subjectId: 'severa', name: '로브', clothing: 'black robe', state: 'dusty hem' }] }
    const outfitsFor = (id: string) => outfits[id] ?? []
    it('inserts saved appearance and outfit text verbatim and records how the preset was found', () => {
        const [byName, byNote] = applyPainterPresets([
            subject({ id: 'severa', name: 'Severa', appearance: '', clothing: '', state: 'wet', outfitId: 'robe' }),
            subject({ id: 'severa', name: '스네이프의 여동생', appearance: 'paraphrased hair' }),
        ], presets, outfitsFor, [])
        expect(byName).toMatchObject({ appearance: 'black hair, grey eyes', clothing: 'black robe', state: 'dusty hem, wet', outfitId: 'robe', presetMatch: 'name' })
        expect(byNote).toMatchObject({ appearance: 'black hair, grey eyes', clothing: 'white shirt', presetMatch: 'context' })
        expect(byNote.outfitId).toBeUndefined()
    })
    it('prefers a lore link and rejects outfits that belong to another identity', () => {
        const [result] = applyPainterPresets([subject({ id: 'severa', outfitId: 'someone-else' })], presets, outfitsFor, [], new Set(['severa']))
        expect(result.presetMatch).toBe('lore')
        expect(result.outfitId).toBeUndefined()
        expect(result.clothing).toBe('white shirt')
    })
    it('replaces earlier model text with the saved preset but keeps text the user edited', () => {
        const stale = subject({ id: 'severa', appearance: 'model guess', clothing: 'model coat', state: '', outfitId: 'robe' })
        const [refreshed] = applyPainterPresets([subject({ id: 'severa', appearance: '', clothing: '', state: '', outfitId: 'robe' })], presets, outfitsFor, [stale])
        expect(refreshed).toMatchObject({ appearance: 'black hair, grey eyes', clothing: 'black robe' })
        const edited = { ...stale, appearance: 'edited hair', appearanceEdited: true, clothing: 'edited robe', outfitEdited: true }
        const [kept] = applyPainterPresets([subject({ id: 'severa', appearance: '', clothing: '', state: '', outfitId: 'robe' })], presets, outfitsFor, [edited])
        expect(kept).toMatchObject({ appearance: 'edited hair', appearanceEdited: true, clothing: 'edited robe', outfitEdited: true })
    })
    it('keeps hand-edited pose always and hand-edited state only with the same outfit', () => {
        const before = subject({ id: 'severa', pose: 'my pose', poseEdited: true, state: 'my state', stateEdited: true, outfitId: 'robe' })
        const [same] = applyPainterPresets([subject({ id: 'severa', pose: 'model pose', state: 'model state', outfitId: 'robe' })], presets, outfitsFor, [before])
        expect(same).toMatchObject({ pose: 'my pose', poseEdited: true, state: 'my state', stateEdited: true })
        const [changed] = applyPainterPresets([subject({ id: 'severa', pose: 'model pose', state: 'model state' })], presets, outfitsFor, [before])
        expect(changed).toMatchObject({ pose: 'my pose', poseEdited: true, state: 'model state' })
        expect(changed.stateEdited).toBeUndefined()
        const [fresh] = applyPainterPresets([subject({ id: 'severa', poseEdited: true, stateEdited: true })], presets, outfitsFor, [])
        expect(fresh.poseEdited).toBeUndefined()
        expect(fresh.stateEdited).toBeUndefined()
    })
    it('keeps the previous sex only when the planner omits it', () => {
        const before = subject({ id: 'severa', sex: 'female' })
        expect(applyPainterPresets([subject({ id: 'severa' })], presets, outfitsFor, [before])[0].sex).toBe('female')
        expect(applyPainterPresets([subject({ id: 'severa', sex: 'other' })], presets, outfitsFor, [before])[0].sex).toBe('other')
    })
    it('keeps the user-added mark across revisions', () => {
        const [result] = applyPainterPresets([subject({ id: 'new' })], presets, outfitsFor, [subject({ id: 'new', manual: true })])
        expect(result.manual).toBe(true)
    })
    it('leaves unmatched, preset-without-appearance and locked subjects to the model text', () => {
        const locked = subject({ id: 'severa', appearance: 'locked hair', locked: true })
        const [free, blank, kept] = applyPainterPresets([subject({ id: 'new' }), subject({ id: 'blank', name: '루크' }), locked], presets, outfitsFor, [])
        expect(free).toMatchObject({ appearance: 'black hair' })
        expect(free.presetMatch).toBeUndefined()
        expect(blank).toMatchObject({ appearance: 'black hair', presetMatch: 'name' })
        expect(kept).toBe(locked)
    })
    it('fails clearly when the model leaves appearance empty without a saved preset', () => {
        expect(() => applyPainterPresets([subject({ id: 'blank', name: '루크', appearance: '' })], presets, outfitsFor, [])).toThrow('루크')
    })
})
