import { describe, expect, it } from 'vitest'
import { buildPainterImageRequest, buildPainterMessages, parsePainterDraft } from './prompt'
import { PAINTER_STYLES } from './styles'
import { createPainterSettings, painterGenerationSettings, painterImageSize, painterSizeMode } from './types'

const subject = (name: string) => ({
    id: '', name, aliases: [], kind: 'character', appearance: 'brown hair', clothing: 'blue coat, black boots', state: '', negative: '',
    pose: { tags: 'standing', placement: '', posture: '', action: '', expression: '', gaze: '' },
})
const plan = () => ({
    version: 2, rendering: '', negative: '',
    scene: { tags: '1girl, 1boy', location: 'A quiet station platform at dusk.', framing: 'Both figures shown from the waist up.', camera: 'Eye-level view from across the tracks.' },
    subjects: [subject('Aria'), subject('Leon')],
    interactions: [{ source: 1, target: 0, description: 'The man on the right passes a cup to the woman on the left.', sourceAction: 'Extends a cup toward the woman on the left.', targetAction: 'Receives the cup from the man on the right.' }],
})

describe('BardPainter scene-plan compilation', () => {
    it('routes relations to their participants and compiles composition and natural language into editable blocks', () => {
        const input = plan()
        input.subjects[0].pose = { tags: 'standing', placement: 'On the left.', posture: 'Leaning forward slightly.', action: '', expression: 'A slight smile.', gaze: 'Looking at the cup.' }
        const draft = parsePainterDraft(JSON.stringify(input))
        expect(draft.scene).toBe('1girl, 1boy\nA quiet station platform at dusk.\nBoth figures shown from the waist up.\nEye-level view from across the tracks.\nThe man on the right passes a cup to the woman on the left.')
        expect(draft.subjects[0].pose).toBe('standing\nOn the left.\nLeaning forward slightly.\nReceives the cup from the man on the right.\nA slight smile.\nLooking at the cup.')
        expect(draft.subjects[1].pose).toBe('standing\nExtends a cup toward the woman on the left.')
        expect(draft.subjects[0].clothing).toBe('blue coat, black boots')
        expect(draft).not.toHaveProperty('interactions')
        const request = buildPainterImageRequest(draft, PAINTER_STYLES[0], createPainterSettings(), 1)
        expect(request.parameters.v4_prompt.caption.base_caption).toBe(draft.scene)
        expect(request.parameters.characterPrompts[0].prompt).toContain('Receives the cup')
        expect(request.parameters.characterPrompts[0].prompt).not.toContain('Extends a cup')
        expect(request.parameters.characterPrompts[1].prompt).toContain('Extends a cup')
        expect(request.input).not.toContain('blue coat')
    })

    it('keeps subsequent manual edits authoritative and round-trips the compiled legacy draft', () => {
        const draft = parsePainterDraft(JSON.stringify(plan()))
        draft.scene = '  my own scene  '
        draft.subjects[0].prompt = '  custom appearance\n\ncustom outfit\n\ncustom pose  '
        expect(parsePainterDraft(JSON.stringify(draft)).subjects[0].prompt).toBe(draft.subjects[0].prompt)
        const request = buildPainterImageRequest(draft, PAINTER_STYLES[0], createPainterSettings(), 1)
        expect(request.input).toBe('my own scene')
        expect(request.parameters.characterPrompts[0].prompt).toBe(draft.subjects[0].prompt)
    })

    it('accepts scenery without actors and does not require artificial actions or interactions', () => {
        const input = { ...plan(), subjects: [], interactions: [] }
        input.scene.tags = 'landscape'
        expect(parsePainterDraft(JSON.stringify(input)).subjects).toEqual([])
    })

    it('does not allow a returned stale prompt override to bypass the newly compiled pose', () => {
        const input = plan()
        Object.assign(input.subjects[0], { prompt: 'old pose', locked: true })
        const draft = parsePainterDraft(JSON.stringify(input))
        expect(draft.subjects[0].prompt).toBeUndefined()
        expect(draft.subjects[0].locked).toBeUndefined()
        expect(draft.subjects[0].pose).toContain('Receives the cup')
    })

    it('drops first-person viewer relations before they become global prose or another actors actions', () => {
        const input = plan()
        input.scene = { tags: 'pov', location: 'A station platform.', framing: '', camera: '' }
        input.subjects[1].name = 'Viewer'
        const draft = parsePainterDraft(JSON.stringify(input), new Set(['viewer']))
        expect(draft.subjects.map(subject => subject.name)).toEqual(['Aria'])
        expect(draft.scene).toBe('pov\nA station platform.')
        expect(draft.subjects[0].pose).toBe('standing')
        expect(draft.subjects[0].clothing).toBe('blue coat, black boots')
    })

    it('keeps original participant indices when the excluded viewer precedes visible actors', () => {
        const input = plan()
        input.subjects.unshift(subject('Viewer'))
        input.interactions[0].source = 2
        input.interactions[0].target = 1
        const draft = parsePainterDraft(JSON.stringify(input), new Set(['viewer']))
        expect(draft.subjects.map(subject => subject.name)).toEqual(['Aria', 'Leon'])
        expect(draft.subjects[0].pose).toContain('Receives the cup')
        expect(draft.subjects[1].pose).toContain('Extends a cup')
    })

    it('expands catalog acts and states into routed action tags without model-written explicit prose', () => {
        const input = plan()
        Object.assign(input.interactions[0], { acts: ['vaginal', 'position_missionary', 'hug', 'unknown_id'], description: '', sourceAction: '', targetAction: '' })
        Object.assign(input.subjects[0], { state: 'sweat', stateIds: ['nude', 'cum_in_pussy', 'bogus'] })
        const draft = parsePainterDraft(JSON.stringify(input))
        expect(draft.scene.split('\n')[0]).toBe('nsfw, 1girl, 1boy, sex, vaginal, missionary')
        expect(draft.subjects[1].pose).toBe('standing, source#vaginal, mutual#hug')
        expect(draft.subjects[0].pose.split('\n')[0]).toBe('standing, target#vaginal, mutual#hug')
        expect(draft.subjects[0].state).toBe('sweat, nude, cum in pussy')
        expect(draft.subjects[0]).not.toHaveProperty('stateIds')
    })

    it('keeps catalog tags for the visible partner when the first-person viewer is excluded', () => {
        const input = plan()
        input.subjects[1].name = 'Viewer'
        Object.assign(input.interactions[0], { acts: ['fellatio'] })
        const draft = parsePainterDraft(JSON.stringify(input), new Set(['viewer']))
        expect(draft.scene).toContain('nsfw, 1girl, 1boy, oral, fellatio')
        expect(draft.scene).not.toContain('passes a cup')
        expect(draft.subjects[0].pose).toBe('standing, target#fellatio')
    })

    it('does not mark non-explicit catalog acts as nsfw and still requires a description or act', () => {
        const input = plan()
        Object.assign(input.interactions[0], { acts: ['headpat'], description: '' })
        expect(parsePainterDraft(JSON.stringify(input)).scene.startsWith('1girl, 1boy')).toBe(true)
        Object.assign(input.interactions[0], { acts: ['unknown'] })
        expect(() => parsePainterDraft(JSON.stringify(input))).toThrow()
        Object.assign(input.interactions[0], { acts: 'vaginal' })
        expect(() => parsePainterDraft(JSON.stringify(input))).toThrow()
    })

    it('keeps a valid planner canvas, drops an unknown one and resolves the request size by mode', () => {
        const chosen = parsePainterDraft(JSON.stringify({ ...plan(), size: 'wide_landscape' }))
        expect(chosen.size).toBe('wide_landscape')
        expect(parsePainterDraft(JSON.stringify({ ...plan(), size: '2000x100' }))).not.toHaveProperty('size')
        const ai = createPainterSettings()
        expect(painterImageSize(ai, chosen)).toEqual({ width: 1216, height: 832 })
        expect(painterImageSize(ai, {})).toEqual({ width: 832, height: 1216 })
        expect(painterImageSize({ ...ai, sizeMode: 'fixed', width: 1024, height: 1024 }, chosen)).toEqual({ width: 1024, height: 1024 })
        // Legacy settings without a mode: only the untouched old default becomes AI choice.
        expect(painterSizeMode({ width: 832, height: 1216 })).toBe('ai')
        expect(painterSizeMode({ width: 1216, height: 832 })).toBe('fixed')
        expect(painterGenerationSettings({ ...ai, sizeMode: undefined, width: 1216, height: 832 }).sizeMode).toBe('fixed')
    })

    it('asks for a canvas only in AI mode and states the fixed canvas otherwise', () => {
        const anchor = { characterId: 'c', chatId: 'h', messageId: 'm', start: 0, end: 1, text: 'scene' }
        const system = (settings: ReturnType<typeof createPainterSettings>) => buildPainterMessages({ anchor, settings, style: PAINTER_STYLES[0], sources: [], identities: [] })[0].content
        expect(system(createPainterSettings())).toContain('Choose size, the canvas ID, from: tall_portrait 832x1216, wide_landscape 1216x832, portrait 896x1152, landscape 1152x896, square 1024x1024')
        const fixed = system({ ...createPainterSettings(), sizeMode: 'fixed', width: 1152, height: 896 })
        expect(fixed).toContain('fixed the canvas at 1152x896 (landscape)')
        expect(fixed).not.toContain('Choose size')
    })

    it.each([-1, 2, 0.5, '0', null])('rejects an invalid interaction participant %s', source => {
        const input = plan()
        Object.assign(input.interactions[0], { source })
        expect(() => parsePainterDraft(JSON.stringify(input))).toThrow()
    })

    it.each([
        (input: ReturnType<typeof plan>) => { input.interactions[0].source = input.interactions[0].target },
        (input: ReturnType<typeof plan>) => { input.scene = { tags: '', location: '', framing: '', camera: '' } },
        (input: ReturnType<typeof plan>) => { input.scene.camera = 'x'.repeat(1201) },
        (input: ReturnType<typeof plan>) => { Object.assign(input.subjects[0], { pose: 'unstructured' }) },
        (input: ReturnType<typeof plan>) => { Object.assign(input, { version: 3 }) },
        (input: ReturnType<typeof plan>) => { Object.assign(input, { interactions: null }) },
    ])('rejects malformed plans before image generation (%#)', mutate => {
        const input = plan()
        mutate(input)
        expect(() => parsePainterDraft(JSON.stringify(input))).toThrow()
    })

    it('parses a version 3 plan into a rendered draft with positional plan keys', () => {
        const v3 = {
            version: 3, size: '', rendering: '', negative: '',
            scene: { modifiers: { 'scene.time': ['night'], 'camera.view': ['bogus'] }, freeTags: { 'scene.location': ['Kitchen'] }, notes: '' },
            subjects: [
                { id: '', name: 'Me', aliases: [], kind: 'character', sex: 'male', evidence: '', appearance: 'x', outfitId: '', clothing: '', state: '', stateIds: [], modifiers: {}, freeTags: {}, notes: { placement: '', action: '' }, negative: '' },
                { id: '', name: 'Aria', aliases: [], kind: 'character', sex: 'female', evidence: 'Aria smiles', appearance: 'red hair', outfitId: '', clothing: '', state: 'wet', stateIds: ['trembling', 'nope'],
                    modifiers: { 'expression.general': ['smile'], 'gaze.direction': ['looking_at_another'] }, freeTags: { 'action.held': ['holding cup'] }, notes: { placement: 'left', action: '' }, negative: '' },
            ],
            interactions: [{ source: 0, target: 1, acts: ['headpat'], description: 'A hand rests on her head.', sourceAction: 'pats', targetAction: 'leans in' }],
        }
        const draft = parsePainterDraft(JSON.stringify(v3), new Set(['me']), 'first-person')
        expect(draft.scene).toBe('1girl, solo, pov, night, kitchen')
        expect(draft.subjects).toHaveLength(1)
        expect(draft.subjects[0]).toMatchObject({ name: 'Aria', sex: 'female', state: 'wet, trembling', pose: 'looking at viewer, smile, holding cup, target#headpat\nleft' })
        expect(draft.plan).toMatchObject({
            version: 3,
            scene: { modifiers: { 'scene.time': ['night'] }, freeTags: { 'scene.location': ['kitchen'] } },
            subjects: { '#0': { stateIds: ['trembling'], evidence: 'Aria smiles' } },
            interactions: [{ source: 'viewer#0', target: '#0', acts: ['headpat'] }],
        })
    })

    it('sends character coordinates only when every block has a position', () => {
        const draft = parsePainterDraft(JSON.stringify(plan()))
        draft.subjects[0].center = { x: 0.3, y: 0.7 }
        const unplaced = buildPainterImageRequest(draft, PAINTER_STYLES[0], createPainterSettings(), 1).parameters
        expect(unplaced.v4_prompt.use_coords).toBe(false)
        expect(unplaced.characterPrompts.map(item => item.center)).toEqual([{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }])
        draft.subjects[1].center = { x: 0.7, y: 0.5 }
        const placed = buildPainterImageRequest(draft, PAINTER_STYLES[0], createPainterSettings(), 1).parameters
        expect(placed.use_coords).toBe(true)
        expect(placed.v4_prompt.use_coords).toBe(true)
        expect(placed.characterPrompts.map(item => item.center)).toEqual([{ x: 0.3, y: 0.7 }, { x: 0.7, y: 0.5 }])
        expect(placed.v4_prompt.caption.char_captions.map(item => item.centers)).toEqual([[{ x: 0.3, y: 0.7 }], [{ x: 0.7, y: 0.5 }]])
        expect(placed.v4_negative_prompt.caption.char_captions.map(item => item.centers)).toEqual([[{ x: 0.3, y: 0.7 }], [{ x: 0.7, y: 0.5 }]])
        const left = buildPainterImageRequest(draft, PAINTER_STYLES[0], { ...createPainterSettings(), positionMode: 'novelai' }, 1).parameters
        expect(left.v4_prompt.use_coords).toBe(false)
        expect(left.characterPrompts.map(item => item.center)).toEqual([{ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }])
    })

    it('rejects a version 3 plan without modifier objects', () => {
        const input = { ...plan(), version: 3, scene: { modifiers: {}, freeTags: {}, notes: '' } }
        expect(() => parsePainterDraft(JSON.stringify(input))).toThrow('장면 계획 형식')
    })

    it('keeps a valid planner sex and drops an unknown value', () => {
        const input = plan()
        Object.assign(input.subjects[0], { sex: 'female' })
        Object.assign(input.subjects[1], { sex: 'robot' })
        const draft = parsePainterDraft(JSON.stringify(input))
        expect(draft.subjects[0].sex).toBe('female')
        expect(draft.subjects[1]).not.toHaveProperty('sex')
    })
})
