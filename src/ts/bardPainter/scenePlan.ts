import { PAINTER_CATALOG_ACTS, PAINTER_CATALOG_STATES, compileCatalogActs, compileCatalogStates } from './catalog'
import type { PainterViewpoint } from './modifierCatalog'
import { normalizePainterFreeTags, normalizePainterModifiers, renderPainterPlan } from './modifierRender'
import type { PainterDraft, PainterPlan, PainterPlanSubject, PainterSubject } from './types'

function object(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text(value: unknown, field: string): string {
    if (typeof value !== 'string' || value.length > 1200) {
        throw new Error(`장면 계획의 ${field} 항목을 확인해 주세요.`)
    }
    // Keep each instruction within the pose paragraph used by the existing editor.
    return value.replace(/\s+/g, ' ').trim()
}

const lines = (...values: string[]) => [...new Set(values.filter(Boolean))].join('\n')
/** Joins comma tag lists, dropping duplicates such as a catalog tag the model also wrote. */
const tags = (...values: string[]) => [...new Set(values.flatMap(value => value.split(',')).map(tag => tag.trim()).filter(Boolean))].join(', ')

const isExcluded = (subject: unknown, excludedSubjectNames?: ReadonlySet<string>) => object(subject) && subject.kind === 'character'
    && [subject.name, ...(Array.isArray(subject.aliases) ? subject.aliases : [])]
        .some(name => typeof name === 'string' && excludedSubjectNames?.has(name.trim().toLowerCase()))

const SEXES = new Set(['female', 'male', 'other', 'unknown'])

const ids = (value: unknown, catalog: Readonly<Record<string, unknown>>) =>
    Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string').map(id => id.trim()))].filter(id => Object.hasOwn(catalog, id)) : []

/**
 * Version 3 keeps catalog selections in draft.plan, keyed by `#position` in the returned
 * subjects. The text is rendered once here so the draft is usable on its own; the runtime
 * renders again after locked blocks and saved presets are in place.
 */
function compileScenePlanV3(value: Record<string, unknown>, excludedSubjectNames: ReadonlySet<string> | undefined, viewpoint: PainterViewpoint): unknown {
    // modifiers are required so a version 2 body labelled 3 cannot pass with its pose text dropped.
    if (!object(value.scene) || !object(value.scene.modifiers) || !Array.isArray(value.subjects) || value.subjects.length > 22
        || value.subjects.some(subject => !object(subject) || !object(subject.modifiers))
        || !Array.isArray(value.interactions) || value.interactions.length > 64) {
        throw new Error('장면 계획 형식이 올바르지 않습니다.')
    }
    const keys = new Map<number, string>()
    const subjects: PainterSubject[] = []
    const entries: Record<string, PainterPlanSubject> = {}
    value.subjects.forEach((subject, index) => {
        if (!object(subject)) throw new Error('인물 또는 사물 블록 형식을 확인해 주세요.')
        // The excluded viewer keeps a key outside the draft so interactions with it stay routable.
        if (isExcluded(subject, excludedSubjectNames)) { keys.set(index, `viewer#${index}`); return }
        const key = `#${subjects.length}`
        keys.set(index, key)
        const character = subject.kind === 'character'
        const notes = object(subject.notes) ? subject.notes : {}
        entries[key] = {
            modifiers: normalizePainterModifiers(subject.modifiers, 'subject', viewpoint, !character),
            freeTags: character ? normalizePainterFreeTags(subject.freeTags, 'subject', viewpoint) : {},
            stateIds: ids(subject.stateIds, PAINTER_CATALOG_STATES),
            notes: { placement: text(notes.placement ?? '', '화면 배치'), action: text(notes.action ?? '', '독립 행동') },
            ...(typeof subject.evidence === 'string' && subject.evidence.trim() ? { evidence: text(subject.evidence.slice(0, 1200), '등장 근거') } : {}),
        }
        subjects.push({ ...subject, pose: '', modifiers: undefined, freeTags: undefined, notes: undefined, stateIds: undefined, evidence: undefined } as unknown as PainterSubject)
    })
    const interactions = value.interactions.map(relation => {
        if (!object(relation)) throw new Error('상호작용 형식을 확인해 주세요.')
        const { source, target } = relation
        if (typeof source !== 'number' || typeof target !== 'number' || source === target || !keys.has(source) || !keys.has(target)) {
            throw new Error('상호작용에 연결된 인물 또는 사물을 확인해 주세요.')
        }
        const acts = ids(relation.acts, PAINTER_CATALOG_ACTS)
        const description = text(relation.description, '관계')
        if (!description && !acts.length) throw new Error('상호작용의 관계 설명이 필요합니다.')
        return { source: keys.get(source)!, target: keys.get(target)!, acts, description,
            sourceAction: text(relation.sourceAction, '행동 주체'), targetAction: text(relation.targetAction, '행동 상대') }
    })
    const scene = value.scene
    const plan: PainterPlan = {
        version: 3,
        scene: {
            modifiers: normalizePainterModifiers(scene.modifiers, 'scene', viewpoint),
            freeTags: normalizePainterFreeTags(scene.freeTags, 'scene', viewpoint),
            notes: text(scene.notes ?? '', '장면 메모'),
        },
        subjects: entries, interactions,
    }
    // Render against positional keys, then copy the text back onto the planner's own blocks.
    const keyed = subjects.map((subject, index) => ({ ...subject, id: `#${index}`, locked: false, poseEdited: false, stateEdited: false,
        state: typeof subject.state === 'string' ? subject.state : '',
        sex: SEXES.has(subject.sex as string) ? subject.sex : undefined }) as PainterSubject)
    const draft = { rendering: '', scene: '', negative: '', subjects: keyed } as PainterDraft
    const rendered = renderPainterPlan(draft, plan, viewpoint).draft
    if (!rendered.scene.trim()) throw new Error('장면 계획에 구도나 배경 선택이 필요합니다.')
    return {
        size: value.size, rendering: value.rendering, negative: value.negative,
        scene: rendered.scene,
        subjects: subjects.map((subject, index) => ({ ...subject, pose: rendered.subjects[index].pose, state: rendered.subjects[index].state, center: rendered.subjects[index].center })),
        plan,
    }
}

/** Project AI-only planning fields into the existing editable draft; never recompile saved edits. */
export function compilePainterScenePlan(value: unknown, excludedSubjectNames?: ReadonlySet<string>, viewpoint: PainterViewpoint = 'third-person'): unknown {
    if (!object(value) || value.version === undefined) return value
    if (value.version === 3) return compileScenePlanV3(value, excludedSubjectNames, viewpoint)
    if (value.version !== 2 || !object(value.scene) || !Array.isArray(value.subjects)
        || value.subjects.length > 22 || !Array.isArray(value.interactions) || value.interactions.length > 64) {
        throw new Error('장면 계획 형식이 올바르지 않습니다.')
    }
    const sceneTags = text(value.scene.tags, 'tags')
    const sceneText = ['location', 'framing', 'camera'].map(key => text(value.scene[key], key))
    if (!lines(sceneTags, ...sceneText)) throw new Error('장면 계획에 구도나 배경 설명이 필요합니다.')

    const actions = value.subjects.map(() => [] as string[])
    const actTags = value.subjects.map(() => [] as string[])
    const catalogSceneTags: string[] = []
    let explicit = false
    const excluded = new Set<number>()
    value.subjects.forEach((subject, index) => {
        if (object(subject) && subject.kind === 'character'
            && [subject.name, ...(Array.isArray(subject.aliases) ? subject.aliases : [])]
                .some(name => typeof name === 'string' && excludedSubjectNames?.has(name.trim().toLowerCase()))) {
            excluded.add(index)
        }
    })
    const relations: string[] = []
    for (const relation of value.interactions) {
        if (!object(relation)) throw new Error('상호작용 형식을 확인해 주세요.')
        const { source, target } = relation
        if (typeof source !== 'number' || typeof target !== 'number'
            || !Number.isInteger(source) || !Number.isInteger(target)
            || source < 0 || target < 0 || source >= actions.length || target >= actions.length || source === target) {
            throw new Error('상호작용에 연결된 인물 또는 사물을 확인해 주세요.')
        }
        const description = text(relation.description, '관계')
        const acts = compileCatalogActs(relation.acts)
        if (!description && !acts.scene.length && !acts.source.length) throw new Error('상호작용의 관계 설명이 필요합니다.')
        const sourceAction = text(relation.sourceAction, '행동 주체')
        const targetAction = text(relation.targetAction, '행동 상대')
        // Catalog tags never name the viewer, so a first-person act still reaches the visible participant.
        catalogSceneTags.push(...acts.scene)
        explicit ||= acts.explicit
        if (!excluded.has(source)) actTags[source].push(...acts.source)
        if (!excluded.has(target)) actTags[target].push(...acts.target)
        // Preserve original indices until routing is complete; the viewer must not survive as another actor's prose.
        if (excluded.has(source) || excluded.has(target)) continue
        relations.push(description)
        actions[source].push(sourceAction)
        actions[target].push(targetAction)
    }

    const subjects = value.subjects.map((subject, index) => {
        if (!object(subject) || !object(subject.pose)) throw new Error('인물의 자세 계획을 확인해 주세요.')
        const pose = subject.pose
        const states = compileCatalogStates(subject.stateIds)
        if (!excluded.has(index)) explicit ||= states.explicit
        return {
            ...subject,
            stateIds: undefined,
            // The model must incorporate old edits into its plan, not mask the plan with a stale override.
            prompt: undefined,
            state: tags(typeof subject.state === 'string' ? subject.state : '', ...states.tags),
            pose: lines(tags(text(pose.tags, '자세 태그'), ...actTags[index]), text(pose.placement, '화면 배치'),
                text(pose.posture, '자세'), text(pose.action, '독립 행동'), ...actions[index],
                text(pose.expression, '표정'), text(pose.gaze, '시선')),
        }
    }).filter((_, index) => !excluded.has(index))

    return {
        size: value.size,
        rendering: value.rendering,
        scene: lines(tags(explicit ? 'nsfw' : '', sceneTags, ...catalogSceneTags), ...sceneText, ...relations),
        negative: value.negative,
        subjects,
    }
}
