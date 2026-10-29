import { describe, expect, test } from 'vitest'
import { buildAnalyzerMessages, editPainterCharacterLore, findPainterCharacterEntries, formatPainterCharacterLore, painterPresetSlug, parseAnalyzerResponse, planAnalyzerItems } from './analyzer'
import { parsePainterLoreEntry } from './lorePresets'

const kisuke = '@@dont_activate\n[bardpainter character: kisuke]\nname: 야가미 키스케\naliases: 키스케\ndefault outfit: uniform\n[appearance]\n1boy, black hair\n[outfit: uniform | 교복]\nschool uniform, red necktie\n'

describe('character analyzer', () => {
    test('asks for data only and refuses an empty instruction', () => {
        expect(() => buildAnalyzerMessages({ instruction: ' ', userName: 'User', sources: [], existing: [] })).toThrow('지시문')
        const [system, user] = buildAnalyzerMessages({ instruction: '키스케 잠옷', userName: '하루', sources: [{ name: '페르소나', content: 'tall' }], existing: [] })
        expect(system.content).toContain('"targets"')
        expect(JSON.parse(user.content)).toMatchObject({ instruction: '키스케 잠옷', userName: '하루', references: [{ name: '페르소나' }] })
    })

    test('parses fenced JSON, makes ids safe and drops empty targets', () => {
        const raw = '```json\n{"targets":[{"id":"Yagami Kisuke!","name":"야가미 키스케","aliases":["키스케","야가미 키스케"],"appearance":"","outfits":[{"id":"","name":"잠옷 [줄무늬]","clothing":"striped pajamas"},{"id":"x","name":"빈 옷","clothing":""}]},{"name":"빈 대상","appearance":"","outfits":[]}]}\n```'
        expect(parseAnalyzerResponse(raw)).toEqual([{ id: 'Yagami Kisuke!', name: '야가미 키스케', aliases: ['키스케'], appearance: '',
            outfits: [{ id: 'outfit', name: '잠옷 줄무늬', clothing: 'striped pajamas' }] }])
        expect(() => parseAnalyzerResponse('{"targets":[]}')).toThrow('외형이나 의상')
        expect(() => parseAnalyzerResponse('not json')).toThrow('JSON')
        expect(painterPresetSlug('Yagami Kisuke!', 'character', ['yagami_kisuke'])).toBe('yagami_kisuke_2')
        expect(painterPresetSlug('야가미', 'character')).toBe('character')
    })

    test('matches existing presets by name or alias and picks the action', () => {
        const existing = findPainterCharacterEntries([
            { scope: 'module:m', entries: [{ content: kisuke }] },
            { scope: 'character', entries: [{ content: 'ordinary lore' }, { content: kisuke.replace('1boy, black hair', '1boy, brown hair') }] },
        ], text => text)
        expect(existing).toHaveLength(1)
        expect(existing[0]).toMatchObject({ scope: 'character', presetId: 'kisuke', appearance: '1boy, brown hair' })
        const items = planAnalyzerItems([
            { id: '', name: '키스케', aliases: [], appearance: '', outfits: [{ id: 'pajamas', name: '잠옷', clothing: 'pajamas' }] },
            { id: 'haru', name: '하루', aliases: [], appearance: '1girl, short hair', outfits: [] },
            { id: '', name: '야가미 키스케', aliases: [], appearance: '1boy, black hair, tall', outfits: [] },
        ], existing, 'module:m')
        expect(items.map(item => [item.name, item.action, item.destination, item.presetId])).toEqual([
            ['야가미 키스케', 'outfit', 'character', 'kisuke'], ['하루', 'create', 'module:m', 'haru'], ['야가미 키스케', 'overwrite', 'character', 'kisuke']])
        expect(items[0].appearance).toBe('1boy, brown hair')
    })

    test('writes new presets the lore parser reads back', () => {
        const text = formatPainterCharacterLore({ presetId: 'haru', name: '하루', aliases: ['user', 'a|b'], appearance: '1girl, short hair', outfits: [{ id: 'pajamas', name: '잠옷', clothing: 'pajamas' }] })
        expect(parsePainterLoreEntry(text)).toMatchObject({ kind: 'character', id: 'haru', name: '하루', aliases: ['user', 'a b'], defaultOutfit: 'pajamas',
            appearance: '1girl, short hair', outfits: [{ id: 'pajamas', name: '잠옷', clothing: 'pajamas' }] })
    })

    test('edits only the appearance and outfits of an existing entry', () => {
        const next = editPainterCharacterLore(kisuke, { appearance: '1boy, black hair, tall', outfits: [
            { id: 'uniform', name: '동복', clothing: 'winter uniform' }, { id: 'pajamas', name: '잠옷', clothing: 'striped pajamas' }] })
        expect(next.startsWith('@@dont_activate\n[bardpainter character: kisuke]\nname: 야가미 키스케')).toBe(true)
        expect(parsePainterLoreEntry(next)).toMatchObject({ appearance: '1boy, black hair, tall', defaultOutfit: 'uniform',
            outfits: [{ id: 'uniform', name: '동복', clothing: 'winter uniform' }, { id: 'pajamas', name: '잠옷', clothing: 'striped pajamas' }] })
        const outfitOnly = editPainterCharacterLore('{{#if {{getvar::night}}}}\n[bardpainter character: k]\n[appearance]\n1boy\n{{/if}}', { outfits: [{ id: 'coat', name: '코트', clothing: 'coat' }] })
        expect(outfitOnly).toBe('{{#if {{getvar::night}}}}\n[bardpainter character: k]\n[appearance]\n1boy\n{{/if}}\n[outfit: coat | 코트]\ncoat')
        expect(editPainterCharacterLore('[bardpainter character: k]\nname: K', { appearance: 'tall', outfits: [] })).toBe('[bardpainter character: k]\nname: K\n[appearance]\ntall')
        expect(() => editPainterCharacterLore('plain', { outfits: [] })).toThrow('헤더')
    })
})
