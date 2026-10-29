import { v4 } from 'uuid'
import type { PainterIdentity, PainterOutfit, PainterSubject } from './types'

const normalize = (name: string) => name.trim().toLocaleLowerCase()

type Named = { id: string; name: string; aliases: string[] }
const namesOf = (item: Named) => [item.name, ...item.aliases].map(normalize).filter(Boolean)

/**
 * Give each planned subject a stable ID: an existing draft block first, then a saved
 * identity, otherwise a fresh draft-only ID. Saved identities are never created here.
 */
export function reconcilePainterSubjects(subjects: PainterSubject[], identities: PainterIdentity[], previous: PainterSubject[]): PainterSubject[] {
    const used = new Set<string>()
    const known = (id: string) => previous.some((item) => item.id === id) || identities.some((item) => item.id === id)
    const unique = <T extends Named>(pool: T[], names: Set<string>) => {
        const matches = pool.filter((item) => !used.has(item.id) && namesOf(item).some((name) => names.has(name)))
        return matches.length === 1 ? matches[0] : undefined
    }
    const result = subjects.map((subject) => {
        const names = new Set(namesOf(subject))
        let id = subject.id && !used.has(subject.id) && known(subject.id) ? subject.id : undefined
        // A same-named blank identity must not shadow the one that actually holds a saved look.
        id ??= unique(previous, names)?.id ?? unique(identities.filter((item) => item.appearance.trim()), names)?.id ?? unique(identities, names)?.id
        if (!id) id = v4()
        used.add(id)
        const locked = previous.find((item) => item.id === id && item.locked)
        // A locked block keeps its text but still answers to the planner's plan entry for interactions.
        return locked ? { ...locked, aliases: [...locked.aliases], ...(subject.planKey ? { planKey: subject.planKey } : {}) } : { ...subject, id }
    })
    previous.forEach((subject, index) => {
        if (subject.locked && !used.has(subject.id)) {
            result.splice(Math.min(index, result.length), 0, { ...subject, aliases: [...subject.aliases] })
            used.add(subject.id)
        }
    })
    if (result.length > 22) throw new Error('잠긴 블록을 포함하면 대상이 22개를 넘습니다. 블록 수를 줄인 뒤 다시 작성해 주세요.')
    return result
}

const joinTags = (...values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))].join(', ')

/**
 * Fill recognized subjects with saved preset text verbatim. Only text the user edited by
 * hand survives a revision; earlier model text never shadows a saved preset.
 */
export function applyPainterPresets(subjects: PainterSubject[], presets: PainterIdentity[], outfitsFor: (identityId: string) => PainterOutfit[],
    previous: PainterSubject[], loreIdentityIds: ReadonlySet<string> = new Set()): PainterSubject[] {
    return subjects.map((source) => {
        if (source.locked) return source
        const subject: PainterSubject = { ...source, aliases: [...source.aliases] }
        delete subject.presetMatch; delete subject.appearanceEdited; delete subject.outfitEdited; delete subject.manual; delete subject.prompt
        delete subject.poseEdited; delete subject.stateEdited
        const identity = subject.kind === 'character' ? presets.find((item) => item.id === subject.id) : undefined
        const before = previous.find((item) => item.id === subject.id)
        if (before?.manual) subject.manual = true
        if (!subject.sex && before?.sex) subject.sex = before.sex
        if (before?.poseEdited) {
            subject.pose = before.pose
            subject.poseEdited = true
        }
        const outfit = identity && subject.outfitId ? outfitsFor(identity.id).find((item) => item.id === subject.outfitId) : undefined
        if (!outfit) delete subject.outfitId
        if (identity) {
            const names = new Set([subject.name, ...subject.aliases].map(normalize).filter(Boolean))
            subject.presetMatch = loreIdentityIds.has(identity.id) ? 'lore'
                : [identity.name, ...identity.aliases].some((name) => names.has(normalize(name))) ? 'name' : 'context'
            if (identity.appearance.trim()) subject.appearance = identity.appearance
        }
        if (before?.appearanceEdited && before.appearance.trim()) {
            subject.appearance = before.appearance
            subject.appearanceEdited = true
        }
        if (outfit) {
            const edited = before?.outfitEdited && before.outfitId === outfit.id
            subject.clothing = edited ? before.clothing : outfit.clothing
            subject.state = joinTags(edited ? before.state : outfit.state, subject.state)
            if (edited) subject.outfitEdited = true
        }
        // Hand-edited state text belongs to the outfit it was written for, like edited clothing.
        if (before?.stateEdited && before.outfitId === subject.outfitId) {
            subject.state = before.state
            subject.stateEdited = true
        }
        if (!subject.appearance.trim()) {
            if (!before?.appearance.trim()) throw new Error(`「${subject.name}」의 외형이 비어 있습니다. 캐릭터 프리셋에 기본 외형을 저장하거나 다시 작성해 주세요.`)
            subject.appearance = before.appearance
        }
        return subject
    })
}

export function capturePainterOutfit(subject: PainterSubject, name: string, includeState: boolean): PainterOutfit {
    if (!name.trim() || !subject.id || !subject.clothing.trim()) throw new Error('의상 이름과 의상 프롬프트를 입력해 주세요.')
    return { id: v4(), subjectId: subject.id, name: name.trim(), clothing: subject.clothing, state: includeState ? subject.state : '' }
}

export function promotePainterOutfit(outfit: PainterOutfit): PainterOutfit {
    const copy = { ...outfit, id: v4() }
    delete copy.attachToCard
    return copy
}
