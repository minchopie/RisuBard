import { expect, it } from 'vitest'
import { collectPainterLorePresets, painterLoreCandidates, painterNameOccurs, parsePainterLoreEntry } from './lorePresets'

const izuku = `@@dont_activate
{{#if ts}}[bardpainter character: izuku_ts]{{/if}}
name: Izuku Midoriya (TS)
aliases: Deku, 미도리야
note: U.A. 1-A
default outfit: uniform
[appearance]
girl, 0.9::midoriya izuku::|0.45::kuroki tomoko::, green hair
[outfit: uniform | 교복]
u.a. school uniform, grey blazer
[outfit: casual_summer]
white crop t-shirt, text: PLUSULTRA
[outfit: swimsuit | 수영복]
<painter.swimsuit_fem>, scars on arms`

const swimsuit = `@@dont_activate
[bardpainter outfit: swimsuit_fem]
name: 여자 수영복
[clothing]
blue competitive swimsuit, one-piece swimsuit`

const entry = (id: string, content: string) => ({ id, comment: id, content, mode: 'normal' })
const cbs = (on: boolean) => (text: string) => text.replace(/\{\{#if ts\}\}([\s\S]*?)\{\{\/if\}\}/g, on ? '$1' : '')

it('parses a character preset and keeps NovelAI text verbatim', () => {
    const parsed = parsePainterLoreEntry(cbs(true)(izuku))
    expect(parsed).toMatchObject({ kind: 'character', id: 'izuku_ts', name: 'Izuku Midoriya (TS)', aliases: ['Deku', '미도리야'], note: 'U.A. 1-A', defaultOutfit: 'uniform' })
    if (parsed?.kind !== 'character') throw new Error('character expected')
    expect(parsed.appearance).toBe('girl, 0.9::midoriya izuku::|0.45::kuroki tomoko::, green hair')
    expect(parsed.outfits.map(item => [item.id, item.name])).toEqual([['uniform', '교복'], ['casual_summer', 'casual_summer'], ['swimsuit', '수영복']])
    expect(parsed.outfits[1].clothing).toBe('white crop t-shirt, text: PLUSULTRA')
})

it('ignores ordinary lore and variants whose CBS removed the header', () => {
    expect(parsePainterLoreEntry('[Character: Izuku]\nAppearance: green hair')).toBeUndefined()
    expect(parsePainterLoreEntry(cbs(false)(izuku))).toBeUndefined()
})

it('builds identities with shared outfits expanded and later scopes winning', () => {
    const library = collectPainterLorePresets([
        { scope: 'module', entries: [entry('s', swimsuit)] },
        { scope: 'character', entries: [entry('a', izuku), { ...entry('f', ''), mode: 'folder' }] },
    ], cbs(true))
    expect(library.warnings).toEqual([])
    expect(library.identities).toHaveLength(1)
    const identity = library.identities[0]
    expect(identity).toMatchObject({ id: 'lore:izuku_ts', defaultOutfitId: 'lore:izuku_ts:uniform' })
    const swim = library.outfits.find(item => item.id === 'lore:izuku_ts:swimsuit')
    expect(swim?.clothing).toBe('blue competitive swimsuit, one-piece swimsuit, scars on arms')
    expect(library.outfits.find(item => item.id === 'lore-outfit:swimsuit_fem')?.subjectId).toBe('')

    const chatOverride = collectPainterLorePresets([
        { scope: 'character', entries: [entry('a', izuku)] },
        { scope: 'chat', entries: [entry('b', izuku.replace('green hair', 'blue hair'))] },
    ], cbs(true))
    expect(chatOverride.identities[0].appearance).toContain('blue hair')
})

it('reports a missing shared outfit and a bad entry instead of guessing', () => {
    const library = collectPainterLorePresets([{ scope: 'character', entries: [entry('a', izuku), entry('bad', '[bardpainter character: 미도리야]')] }], cbs(true))
    expect(library.warnings.some(item => item.includes('<painter.swimsuit_fem>'))).toBe(true)
    expect(library.warnings.some(item => item.startsWith('bad:'))).toBe(true)
    expect(library.outfits.find(item => item.id === 'lore:izuku_ts:swimsuit')?.clothing).toBe('scars on arms')
})

it('matches Latin names on word boundaries and other scripts as substrings', () => {
    expect(painterNameOccurs('Ida', 'Iida watched the idea form.')).toBe(false)
    expect(painterNameOccurs('Iida', 'Iida watched.')).toBe(true)
    expect(painterNameOccurs('미도리야', '미도리야가 웃었다.')).toBe(true)
    const library = collectPainterLorePresets([{ scope: 'character', entries: [entry('a', izuku)] }], cbs(true))
    expect(painterLoreCandidates(library.identities, '데쿠는 없다').map(item => item.id)).toEqual([])
    expect(painterLoreCandidates(library.identities, '미도리야가 손을 흔들었다').map(item => item.id)).toEqual(['lore:izuku_ts'])
    expect(painterLoreCandidates(library.identities, 'nobody', ['lore:izuku_ts'])).toHaveLength(1)
})

it('parses a style entry with generation values and marks the default', () => {
    const style = `@@dont_activate
[bardpainter style: anime]
name: 애니풍
default: true
steps: 30
scale: 5.5
cfg rescale: 0.1
sampler: k_dpmpp_2m
[artist]
0.8::artist:ruri no houseki::, official art
[rendering]
-1::close-up::
[negative]
blank page, text`
    const library = collectPainterLorePresets([{ scope: 'character', entries: [entry('s', style)] }], text => text)
    expect(library.warnings).toEqual([])
    expect(library.defaultStyleId).toBe('lore-style:anime')
    expect(library.styles).toEqual([{ id: 'lore-style:anime', name: '애니풍', artist: '0.8::artist:ruri no houseki::, official art', rendering: '-1::close-up::',
        negative: 'blank page, text', steps: 30, scale: 5.5, cfgRescale: 0.1, sampler: 'k_dpmpp_2m' }])
    const bad = collectPainterLorePresets([{ scope: 'character', entries: [entry('b', style.replace('steps: 30', 'steps: many'))] }], text => text)
    expect(bad.styles).toEqual([])
    expect(bad.warnings[0]).toContain('steps')
})
