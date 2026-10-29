import { describe, expect, it } from 'vitest'
import { PAINTER_MODIFIER_GROUPS, painterModifierCatalogPrompt } from './modifierCatalog'
import { normalizePainterFreeTags, normalizePainterModifiers, renderPainterPlan } from './modifierRender'
import type { PainterDraft, PainterPlan, PainterPlanSubject, PainterSubject } from './types'

const block = (id: string, extra: Partial<PainterSubject> = {}): PainterSubject => ({
    id, name: id, aliases: [], kind: 'character', appearance: 'brown hair', clothing: 'school uniform',
    state: '', pose: '', negative: '', sex: 'female', ...extra,
})
const entry = (modifiers: Record<string, string[]> = {}, extra: Partial<PainterPlanSubject> = {}): PainterPlanSubject => ({
    modifiers, freeTags: {}, stateIds: [], notes: { placement: '', action: '' }, ...extra,
})
const draftOf = (...subjects: PainterSubject[]): PainterDraft => ({ rendering: '', scene: 'old scene', negative: '', subjects })
const planOf = (scene: Record<string, string[]>, subjects: Record<string, PainterPlanSubject>, extra: Partial<PainterPlan> = {}): PainterPlan => ({
    version: 3, scene: { modifiers: scene, freeTags: {}, notes: '' }, subjects, interactions: [], ...extra,
})

describe('BardPainter modifier catalog', () => {
    it('keeps group and option IDs unique and every rule pointing at an existing option', () => {
        const groupIds = PAINTER_MODIFIER_GROUPS.map(group => group.id)
        expect(new Set(groupIds).size).toBe(groupIds.length)
        const exists = (groupId: string, ids: string[]) => {
            const group = PAINTER_MODIFIER_GROUPS.find(item => item.id === groupId)
            expect(group, groupId).toBeDefined()
            for (const id of ids) expect(group!.options.some(option => option.id === id), `${groupId}.${id}`).toBe(true)
        }
        for (const group of PAINTER_MODIFIER_GROUPS) {
            const optionIds = group.options.map(option => option.id)
            expect(new Set(optionIds).size, group.id).toBe(optionIds.length)
            for (const option of group.options) {
                for (const rule of option.rules ?? []) {
                    for (const map of [rule.when?.option, rule.when?.notOption, 'add' in rule ? rule.add : undefined]) {
                        for (const [groupId, ids] of Object.entries(map ?? {})) exists(groupId, ids)
                    }
                    if ('replace' in rule) for (const [groupId, id] of Object.entries(rule.replace)) exists(groupId, [id])
                    if ('remove' in rule) for (const [groupId, ids] of Object.entries(rule.remove)) exists(groupId, ids === '*' ? [] : ids)
                }
            }
        }
    })

    it('offers only planner-selected groups for the active viewpoint', () => {
        const third = painterModifierCatalogPrompt('third-person')
        expect(third).toContain('gaze.direction (subject, up to 1')
        expect(third).toContain('action.held (subject, up to 2; objects held in the hands, as Danbooru holding tags such as holding cup): free tags starting with "holding"')
        expect(third).not.toContain('orientation.facing')
        expect(third).not.toContain('camera.pov')
        expect(painterModifierCatalogPrompt('first-person')).toContain('camera.pov (scene, up to 1')
    })
})

describe('BardPainter modifier normalization', () => {
    it('drops unknown, local and other-scope selections and truncates to the group limit', () => {
        expect(normalizePainterModifiers({
            'gaze.direction': ['looking_down', 'looking_up'],
            'expression.general': ['smile', 'bogus', 'smile', 'blush'],
            'orientation.facing': ['facing_away'],
            'camera.view': ['from_above'],
            'unknown.group': ['x'],
        }, 'subject', 'third-person')).toEqual({ 'gaze.direction': ['looking_down'], 'expression.general': ['smile'] })
        expect(normalizePainterModifiers({ 'camera.pov': ['pov_hands'] }, 'scene', 'third-person')).toEqual({})
        expect(normalizePainterModifiers({ 'camera.pov': ['pov_hands'] }, 'scene', 'first-person')).toEqual({ 'camera.pov': ['pov_hands'] })
    })

    it('accepts only short lowercase Danbooru-style free tags with the required prefix', () => {
        expect(normalizePainterFreeTags({ 'scene.location': ['Kitchen', 'school_hallway', 'a very long sentence about the room', '1.5::bedroom::'] }, 'scene', 'third-person'))
            .toEqual({ 'scene.location': ['kitchen', 'school hallway'] })
        expect(normalizePainterFreeTags({ 'action.held': ['holding_cup', 'cup', 'holding phone', 'holding bag'] }, 'subject', 'third-person'))
            .toEqual({ 'action.held': ['holding cup', 'holding phone'] })
    })
})

describe('BardPainter plan rendering', () => {
    it('writes count tags, scene tags in catalog order and per-subject pose lines', () => {
        const draft = draftOf(block('a'), block('b', { sex: 'male' }))
        const plan = planOf({ 'scene.time': ['day'], 'framing.crop': ['cowboy_shot'], 'camera.view': ['from_above'] }, {
            a: entry({ 'expression.general': ['smile'], 'pose.body': ['standing'], 'gaze.direction': ['looking_at_another'] },
                { freeTags: { 'action.held': ['holding cup'] }, notes: { placement: 'on the left', action: '' } }),
            b: entry({ 'pose.body': ['sitting'] }),
        }, { scene: { modifiers: { 'scene.time': ['day'], 'framing.crop': ['cowboy_shot'], 'camera.view': ['from_above'] }, freeTags: { 'scene.location': ['kitchen'] }, notes: 'a door frame in the foreground' } })
        const { draft: result, warnings } = renderPainterPlan(draft, plan, 'third-person')
        expect(result.scene).toBe('1girl, 1boy, from above, cowboy shot, day, kitchen\na door frame in the foreground')
        expect(result.subjects[0].pose).toBe('standing, looking at another, smile, holding cup\non the left')
        expect(result.subjects[1].pose).toBe('sitting')
        expect(result.plan).toBe(plan)
        expect(warnings).toEqual([])
    })

    it('turns subjects away from the camera and drops tags for hidden faces', () => {
        const draft = draftOf(block('a'), block('b'))
        const plan = planOf({ 'camera.view': ['from_behind'] }, {
            a: entry({ 'expression.general': ['smile'], 'gaze.direction': ['looking_down'], 'pose.arms': ['arms_up'] }),
            b: entry({ 'expression.general': ['smile'], 'gaze.direction': ['looking_back'] }),
        })
        const { draft: result } = renderPainterPlan(draft, plan, 'third-person')
        expect(result.scene).toBe('2girls, from behind')
        expect(result.subjects[0].pose).toBe('facing away, arms up')
        expect(result.subjects[1].pose).toBe('facing away, looking back, smile')
    })

    it('drops pose tags for body parts cut by the crop', () => {
        const draft = draftOf(block('a'))
        const plan = planOf({ 'framing.crop': ['upper_body'], 'framing.head_crop': ['head_out_of_frame'] }, {
            a: entry({ 'pose.arms': ['crossed_arms'], 'pose.legs': ['crossed_legs', 'crossed_ankles'], 'expression.general': ['smile'], 'gaze.direction': ['looking_down'] }),
        })
        const { draft: result } = renderPainterPlan(draft, plan, 'third-person')
        expect(result.scene).toBe('1girl, solo, upper body, head out of frame')
        expect(result.subjects[0].pose).toBe('crossed arms')
    })

    it('adds pov in first person and turns a lone character toward the viewer', () => {
        const draft = draftOf(block('a'))
        const plan = planOf({ 'camera.pov': ['pov_hands'], 'camera.view': ['from_above'] }, {
            a: entry({ 'gaze.direction': ['looking_at_another'] }),
        })
        const { draft: result } = renderPainterPlan(draft, plan, 'first-person')
        expect(result.scene).toBe('1girl, solo, pov, from above, pov hands')
        expect(result.subjects[0].pose).toBe('looking at viewer')
        expect(renderPainterPlan(draft, plan, 'third-person').draft.scene).toBe('1girl, solo, from above')
        const pair = renderPainterPlan(draftOf(block('a'), block('b')), planOf({}, { a: entry({ 'gaze.direction': ['looking_at_another'] }) }), 'first-person')
        expect(pair.draft.subjects[0].pose).toBe('looking at another')
    })

    it('omits count tags and warns when a visible character has no known sex', () => {
        const { draft, warnings } = renderPainterPlan(draftOf(block('a'), block('b', { sex: 'unknown' })), planOf({ 'scene.time': ['night'] }, {}), 'third-person')
        expect(draft.scene).toBe('night')
        expect(warnings).toEqual(['성별을 알 수 없는 인물(b)이 있어 인원수 태그를 넣지 않았습니다.'])
        expect(renderPainterPlan(draftOf(block('lamp', { kind: 'object', sex: undefined })), planOf({ 'scene.time': ['night'] }, {}), 'third-person').draft.scene)
            .toBe('no humans, night')
    })

    it('keeps locked and hand-edited text while still counting it', () => {
        const locked = block('a', { locked: true, pose: 'locked pose', state: 'locked state' })
        const edited = block('b', { sex: 'male', pose: 'my pose', poseEdited: true, state: 'wet' })
        const plan = planOf({}, {
            a: entry({ 'pose.body': ['sitting'] }, { stateIds: ['nude'] }),
            b: entry({ 'pose.body': ['standing'] }, { stateIds: ['trembling'] }),
        })
        const { draft } = renderPainterPlan(draftOf(locked, edited), plan, 'third-person')
        expect(draft.subjects[0]).toBe(locked)
        expect(draft.subjects[1].pose).toBe('my pose')
        expect(draft.subjects[1].state).toBe('wet, trembling')
        expect(draft.scene).toBe('nsfw, 1girl, 1boy')
        expect(renderPainterPlan({ ...draftOf(edited), sceneEdited: true }, plan, 'third-person').draft.scene).toBe('old scene')
    })

    it('routes acts with the hidden viewer to the visible participant without viewer prose', () => {
        const plan = planOf({}, { a: entry() }, { interactions: [
            { source: 'viewer', target: 'a', acts: ['headpat'], description: 'The viewer pats her.', sourceAction: 'pats', targetAction: 'receives a headpat' },
            { source: 'a', target: 'viewer', acts: ['groping'], description: '', sourceAction: '', targetAction: '' },
        ] })
        const { draft } = renderPainterPlan(draftOf(block('a')), plan, 'first-person')
        expect(draft.subjects[0].pose).toBe('target#headpat, source#groping')
        expect(draft.scene).toBe('nsfw, 1girl, solo, pov, groping')
    })

    it('turns position choices into NovelAI centers for characters and objects without adding tags', () => {
        const draft = draftOf(block('a', { center: { x: 0.9, y: 0.9 } }), block('b'), block('case', { kind: 'object', sex: undefined }), block('c', { center: { x: 0.1, y: 0.1 } }))
        const plan = planOf({}, {
            a: entry({ 'frame.position': ['left'], 'frame.height': ['low'], 'pose.body': ['squatting'] }),
            b: entry({ 'frame.height': ['high'] }),
            case: entry({ 'frame.position': ['center'] }),
            c: entry(),
        })
        const { draft: result } = renderPainterPlan(draft, plan, 'third-person')
        expect(result.subjects[0]).toMatchObject({ center: { x: 0.3, y: 0.7 }, pose: 'squatting' })
        expect(result.subjects[1].center).toEqual({ x: 0.5, y: 0.3 })
        expect(result.subjects[2].center).toEqual({ x: 0.5, y: 0.5 })
        expect(result.subjects[3]).not.toHaveProperty('center')
        const locked = block('d', { locked: true, center: { x: 0.9, y: 0.5 } })
        expect(renderPainterPlan(draftOf(locked), planOf({}, { d: entry({ 'frame.position': ['left'] }) }), 'third-person').draft.subjects[0]).toBe(locked)
    })

    it('routes acts and relation prose between two visible subjects', () => {
        const plan = planOf({}, {}, { interactions: [
            { source: 'b', target: 'a', acts: ['hug'], description: 'The two embrace.', sourceAction: 'wraps both arms around her', targetAction: 'leans in' },
        ] })
        const { draft } = renderPainterPlan(draftOf(block('a'), block('b')), plan, 'third-person')
        expect(draft.scene).toBe('2girls\nThe two embrace.')
        expect(draft.subjects[0].pose).toBe('mutual#hug\nleans in')
        expect(draft.subjects[1].pose).toBe('mutual#hug\nwraps both arms around her')
    })
})
