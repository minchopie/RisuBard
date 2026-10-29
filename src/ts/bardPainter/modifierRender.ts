import { compileCatalogActs, compileCatalogStates } from './catalog'
import { PAINTER_BODY_PARTS, PAINTER_MODIFIER_GROUPS } from './modifierCatalog'
import type { ModifierCondition, ModifierGroup, ModifierRule, PainterBodyPart, PainterView, PainterViewpoint } from './modifierCatalog'
import type { PainterDraft, PainterPlan, PainterSubject } from './types'

type Selection = Map<string, string[]>
type Cast = NonNullable<ModifierCondition['cast']>

const groups = new Map(PAINTER_MODIFIER_GROUPS.map(group => [group.id, group]))
const optionOf = (groupId: string, optionId: string) => groups.get(groupId)?.options.find(option => option.id === optionId)
const offered = (group: ModifierGroup, scope: ModifierGroup['scope'], viewpoint: PainterViewpoint) =>
    group.scope === scope && group.select.by === 'ai' && (!group.viewpoint || group.viewpoint === viewpoint)

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()) : []

/** Keeps offered option IDs only; unknown values are dropped so one stray ID cannot fail the plan. */
export function normalizePainterModifiers(value: unknown, scope: ModifierGroup['scope'], viewpoint: PainterViewpoint, object = false): Record<string, string[]> {
    const result: Record<string, string[]> = {}
    if (!record(value)) return result
    for (const [groupId, ids] of Object.entries(value)) {
        const group = groups.get(groupId)
        if (!group || group.freeTags || !offered(group, scope, viewpoint) || (object && !group.objects)) continue
        const kept = [...new Set(strings(ids))].filter(id => optionOf(groupId, id)).slice(0, group.select.max)
        if (kept.length) result[groupId] = kept
    }
    return result
}

const FREE_TAG = /^[a-z0-9][a-z0-9 ()'.-]*$/

/** Danbooru-style tags only: lowercase words, no weights, names or sentences. */
export function normalizePainterFreeTags(value: unknown, scope: ModifierGroup['scope'], viewpoint: PainterViewpoint): Record<string, string[]> {
    const result: Record<string, string[]> = {}
    if (!record(value)) return result
    for (const [groupId, tags] of Object.entries(value)) {
        const group = groups.get(groupId)
        if (!group?.freeTags || !offered(group, scope, viewpoint)) continue
        const prefix = group.freeTags.prefix
        const kept = [...new Set(strings(tags).map(tag => tag.toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim()))]
            .filter(tag => tag.length <= 48 && tag.split(' ').length <= 5 && FREE_TAG.test(tag) && (!prefix || tag.startsWith(prefix)))
            .slice(0, group.freeTags.max)
        if (kept.length) result[groupId] = kept
    }
    return result
}

interface RuleContext { scene: Selection; cast: Cast; viewpoint: PainterViewpoint }

function selected(context: RuleContext, own: Selection | undefined, groupId: string): string[] {
    const selection = groups.get(groupId)?.scope === 'scene' ? context.scene : own
    return selection?.get(groupId) ?? []
}

function matches(when: ModifierCondition | undefined, context: RuleContext, own: Selection | undefined): boolean {
    if (!when) return true
    if (when.cast && when.cast !== context.cast) return false
    if (when.viewpoint && when.viewpoint !== context.viewpoint) return false
    const any = (map: Record<string, string[]>) => Object.entries(map).some(([groupId, ids]) => selected(context, own, groupId).some(id => ids.includes(id)))
    if (when.option && !any(when.option)) return false
    if (when.notOption && any(when.notOption)) return false
    return true
}

/** Selected options with their rules, in rendering order. */
function* selectedOptions(selection: Selection) {
    const entries = [...selection.entries()].sort(([a], [b]) => (groups.get(a)?.order ?? 0) - (groups.get(b)?.order ?? 0))
    for (const [groupId, ids] of entries) {
        for (const id of ids) {
            const option = optionOf(groupId, id)
            if (option) yield { group: groups.get(groupId)!, option }
        }
    }
}

/**
 * Applies add, replace and remove rules. A scene rule naming a subject group changes every
 * character; rules switched on by earlier rules get two more passes, then the result stands.
 */
function applyRules(context: RuleContext, subjects: Selection[]) {
    for (let pass = 0; pass < 3; pass++) {
        let changed = false
        const targets = (groupId: string, own: Selection | undefined) =>
            groups.get(groupId)?.scope === 'scene' ? [context.scene] : own ? [own] : subjects
        const apply = (rule: ModifierRule, own: Selection | undefined) => {
            if ('add' in rule) {
                for (const [groupId, ids] of Object.entries(rule.add)) {
                    for (const selection of targets(groupId, own)) {
                        const current = selection.get(groupId) ?? []
                        const added = ids.filter(id => optionOf(groupId, id) && !current.includes(id))
                            .slice(0, Math.max(0, groups.get(groupId)!.select.max - current.length))
                        if (added.length) { selection.set(groupId, [...current, ...added]); changed = true }
                    }
                }
            } else if ('replace' in rule) {
                for (const [groupId, id] of Object.entries(rule.replace)) {
                    for (const selection of targets(groupId, own)) {
                        const current = selection.get(groupId)
                        if (optionOf(groupId, id) && (current?.length !== 1 || current[0] !== id)) { selection.set(groupId, [id]); changed = true }
                    }
                }
            } else if ('remove' in rule) {
                for (const [groupId, ids] of Object.entries(rule.remove)) {
                    for (const selection of targets(groupId, own)) {
                        const current = selection.get(groupId) ?? []
                        const kept = ids === '*' ? [] : current.filter(id => !ids.includes(id))
                        if (kept.length === current.length) continue
                        if (kept.length) selection.set(groupId, kept)
                        else selection.delete(groupId)
                        changed = true
                    }
                }
            }
        }
        for (const { option } of [...selectedOptions(context.scene)]) {
            for (const rule of option.rules ?? []) if (matches(rule.when, context, undefined)) apply(rule, undefined)
        }
        for (const own of subjects) {
            for (const { option } of [...selectedOptions(own)]) {
                for (const rule of option.rules ?? []) if (matches(rule.when, context, own)) apply(rule, own)
            }
        }
        if (!changed) break
    }
}

type Visible = (part: PainterBodyPart | undefined, from: PainterView[] | undefined) => boolean

/** Body parts start visible from the front; crops hide parts and facing rules turn them. */
function visibility(context: RuleContext, own: Selection): Visible {
    const views = new Map<PainterBodyPart, PainterView[]>(PAINTER_BODY_PARTS.map(part => [part, ['front']]))
    const hidden = new Set<PainterBodyPart>()
    for (const selection of [context.scene, own]) {
        for (const { option } of selectedOptions(selection)) {
            for (const rule of option.rules ?? []) {
                if (!('visibility' in rule) || !matches(rule.when, context, own)) continue
                for (const [part, value] of Object.entries(rule.visibility) as Array<[PainterBodyPart | '*', PainterView[]]>) {
                    for (const target of part === '*' ? PAINTER_BODY_PARTS : [part]) {
                        if (value.length) views.set(target, value)
                        else hidden.add(target)
                    }
                }
            }
        }
    }
    return (part, from) => !part || (!hidden.has(part) && (!from || views.get(part)!.some(view => from.includes(view))))
}

const weighted = ([weight, tag]: [number, string]) => weight === 1 ? tag : `${weight}::${tag}::`

function renderTags(selection: Selection, freeTags: Record<string, string[]>, visible: Visible): string[] {
    const items: Array<{ order: number; tag: string }> = []
    for (const { group, option } of selectedOptions(selection)) {
        if (!visible(option.bodyPart ?? group.bodyPart, option.visibleFrom ?? group.visibleFrom)) continue
        items.push(...option.tags.map(tag => ({ order: group.order, tag: weighted(tag) })))
    }
    for (const [groupId, tags] of Object.entries(freeTags)) {
        const group = groups.get(groupId)!
        if (visible(group.bodyPart, group.visibleFrom)) items.push(...tags.map(tag => ({ order: group.order, tag })))
    }
    // Array.prototype.sort is stable, so options keep their selection order within a group.
    return items.sort((a, b) => a.order - b.order).map(item => item.tag)
}

function countTags(characters: PainterSubject[]): { tags: string[]; unknown: string[] } {
    const unknown = characters.filter(subject => !subject.sex || subject.sex === 'unknown').map(subject => subject.name)
    if (unknown.length) return { tags: [], unknown }
    if (!characters.length) return { tags: ['no humans'], unknown }
    const count = (sex: PainterSubject['sex'], word: string) => {
        const n = characters.filter(subject => subject.sex === sex).length
        return n ? [`${n >= 6 ? '6+' : n}${word}${n > 1 ? 's' : ''}`] : []
    }
    return { tags: [...count('female', 'girl'), ...count('male', 'boy'), ...count('other', 'other'), ...(characters.length === 1 ? ['solo'] : [])], unknown }
}

/** Position options of a block; an unset axis stays centered, no position option means none. */
function centerOf(modifiers: Record<string, string[]>): PainterSubject['center'] {
    let x: number | undefined, y: number | undefined
    for (const [groupId, ids] of Object.entries(modifiers)) {
        for (const id of ids) {
            const center = optionOf(groupId, id)?.center
            x ??= center?.x
            y ??= center?.y
        }
    }
    return x === undefined && y === undefined ? undefined : { x: x ?? 0.5, y: y ?? 0.5 }
}

const clean = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
const lines = (...values: string[]) => [...new Set(values.filter(Boolean))].join('\n')
/** Joins comma tag lists, dropping duplicates such as a free tag that repeats a catalog tag. */
const tags = (...values: string[]) => [...new Set(values.flatMap(value => value.split(',')).map(tag => tag.trim()).filter(Boolean))].join(', ')

/**
 * Re-keys plan entries from parse positions (planKey) to final block IDs once reconciliation has
 * run. Locked blocks keep their previous selections; planKey never survives into saved drafts.
 */
export function bindPainterPlan(plan: PainterPlan, subjects: PainterSubject[], previous?: PainterPlan): { plan: PainterPlan; subjects: PainterSubject[] } {
    const idOf = new Map<string, string>()
    const entries: PainterPlan['subjects'] = {}
    const bound = subjects.map(({ planKey, ...subject }) => {
        if (planKey) idOf.set(planKey, subject.id)
        const entry = subject.locked ? previous?.subjects[subject.id] : planKey ? plan.subjects[planKey] : undefined
        if (entry) entries[subject.id] = entry
        return subject
    })
    const id = (key: string) => idOf.get(key) ?? key
    return {
        plan: { ...plan, subjects: entries, interactions: plan.interactions.map(relation => ({ ...relation, source: id(relation.source), target: id(relation.target) })) },
        subjects: bound,
    }
}

const normalizeQuote = (value: string) => value.replace(/[\s"'“”‘’「」『』]+/g, ' ').trim().toLowerCase()

/** Names of planned characters whose presence quote is missing from the text sent to the planner. */
export function painterUnsupportedPresence(plan: PainterPlan, subjects: PainterSubject[], texts: string[]): string[] {
    const haystack = texts.map(normalizeQuote)
    return subjects.filter(subject => {
        if (subject.kind !== 'character' || subject.locked || !plan.subjects[subject.id]) return false
        const quote = normalizeQuote(plan.subjects[subject.id].evidence ?? '')
        return !quote || !haystack.some(text => text.includes(quote))
    }).map(subject => subject.name)
}

export interface PainterPlanRenderResult { draft: PainterDraft; warnings: string[] }

/**
 * Writes scene, pose and state text from a version 3 plan once the final cast is known: after
 * locked blocks are restored and saved presets are applied. Locked blocks and text the user
 * edited by hand are kept; locked blocks still count toward count tags and the nsfw rating.
 */
export function renderPainterPlan(draft: PainterDraft, plan: PainterPlan, viewpoint: PainterViewpoint): PainterPlanRenderResult {
    const characters = draft.subjects.filter(subject => subject.kind === 'character')
    const context: RuleContext = {
        scene: new Map(Object.entries(normalizePainterModifiers(plan.scene.modifiers, 'scene', viewpoint))),
        cast: characters.length === 0 ? 'none' : characters.length === 1 ? 'solo' : 'multi',
        viewpoint,
    }
    const selections = new Map(characters.map(subject =>
        [subject.id, new Map(Object.entries(normalizePainterModifiers(plan.subjects[subject.id]?.modifiers, 'subject', viewpoint))) as Selection]))
    applyRules(context, [...selections.values()])

    const ids = new Set(draft.subjects.map(subject => subject.id))
    const actTags = new Map<string, string[]>()
    const actions = new Map<string, string[]>()
    const push = (map: Map<string, string[]>, id: string, values: string[]) => map.set(id, [...(map.get(id) ?? []), ...values])
    const relations: string[] = []
    const sceneActs: string[] = []
    let explicit = false
    for (const relation of plan.interactions) {
        const acts = compileCatalogActs(relation.acts)
        // Catalog tags never name the viewer, so an act with the hidden viewer still reaches the visible participant.
        sceneActs.push(...acts.scene)
        explicit ||= acts.explicit
        if (ids.has(relation.source)) push(actTags, relation.source, acts.source)
        if (ids.has(relation.target)) push(actTags, relation.target, acts.target)
        if (!ids.has(relation.source) || !ids.has(relation.target)) continue
        relations.push(clean(relation.description))
        push(actions, relation.source, [clean(relation.sourceAction)])
        push(actions, relation.target, [clean(relation.targetAction)])
    }

    const subjects = draft.subjects.map(subject => {
        const entry = plan.subjects[subject.id]
        const states = compileCatalogStates(entry?.stateIds ?? [])
        explicit ||= states.explicit
        if (subject.locked) return subject
        const selection = selections.get(subject.id)
        const poseTags = selection ? renderTags(selection, normalizePainterFreeTags(entry?.freeTags, 'subject', viewpoint), visibility(context, selection)) : []
        const { center: _previous, ...rest } = subject
        const center = centerOf(normalizePainterModifiers(entry?.modifiers, 'subject', viewpoint, subject.kind !== 'character'))
        return {
            ...rest,
            ...(center ? { center } : {}),
            pose: subject.poseEdited ? subject.pose
                : lines(tags(...poseTags, ...(actTags.get(subject.id) ?? [])), clean(entry?.notes.placement), clean(entry?.notes.action), ...(actions.get(subject.id) ?? [])),
            state: subject.stateEdited ? subject.state : tags(subject.state, ...states.tags),
        }
    })

    const count = countTags(characters)
    const sceneTags = renderTags(context.scene, normalizePainterFreeTags(plan.scene.freeTags, 'scene', viewpoint), () => true)
    const scene = lines(tags(explicit ? 'nsfw' : '', ...count.tags, viewpoint === 'first-person' ? 'pov' : '', ...sceneTags, ...sceneActs),
        clean(plan.scene.notes), ...relations)
    return {
        draft: { ...draft, scene: draft.sceneEdited || !scene ? draft.scene : scene, subjects, plan },
        warnings: count.unknown.length
            ? [`성별을 알 수 없는 인물(${count.unknown.join(', ')})이 있어 인원수 태그를 넣지 않았습니다.`]
            : [],
    }
}
