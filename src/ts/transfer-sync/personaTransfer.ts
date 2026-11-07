// Persona transfer (transfer-sync, 0.9.91-ver1): applying personas received with the manual transfer screen.
// Same rule as the NAS persona publish (content-updates): a persona with the same name is updated in place — its id stays,
// so chats and bots bound to it keep it — and any other persona is added with a new id. Nothing is deleted or merged away:
// when a name is not unique (it appears more than once in the file, or more than once on this device) the received persona
// is added as a new one instead of overwriting a guess. A persona added from a file gets that file's stable id for it
// (`transferId`), so applying the same file again (after an unconfirmed save) updates it instead of adding it twice.
import type { RisuPersona } from '../storage/database.svelte'

/** One persona as the server hands it over; pictures and module files are `blobs/<sha256>` keys into `blobs`. */
export interface ReceivedPersona {
    name: string
    /** Stable id the server derives from the received file and the row: the id a persona added from this row gets. */
    transferId?: string
    personaPrompt: string
    note?: string
    largePortrait?: boolean
    portraitPrompt?: Record<string, unknown>
    embeddedModule?: Record<string, any> & { id: string; name: string; assets?: [string, string, string][] }
    image?: string | null
    moduleIcon?: string | null
    moduleAssets?: (string | null)[]
}
/** Distinct pictures/module files of one received file, base64 by `blobs/<sha256>` key (each sent once). */
export type ReceivedBlobs = Record<string, string>
export interface PersonaApplyIo {
    saveImage(bytes: Uint8Array): Promise<string>
    reencodeImage(bytes: Uint8Array): Promise<Uint8Array>
    saveAsset(bytes: Uint8Array, customId: string, fileName: string): Promise<string>
    newId(): string
}
interface PersonaDatabase {
    personas: RisuPersona[]
    selectedPersona: number
    username: string
    personaPrompt: string
    userNote?: string
    userIcon: string
}
export interface PersonaPlan {
    /** Per received row: the index of the persona it updates, or -1 when it is added. */
    targets: number[]
    updated: string[]
    added: string[]
    /** Names added as new because the name was not unique here or in the file (subset of `added`, once each). */
    ambiguous: string[]
}

/** Which received personas replace an existing one and which are added — fixed before anything changes. */
export function planPersonas(db: Pick<PersonaDatabase, 'personas'>, rows: Pick<ReceivedPersona, 'name' | 'transferId'>[]): PersonaPlan {
    const received = new Map<string, number>()
    for (const row of rows) received.set(row.name, (received.get(row.name) ?? 0) + 1)
    const plan: PersonaPlan = { targets: [], updated: [], added: [], ambiguous: [] }
    for (const row of rows) {
        // Added from this same file before (its save was not confirmed, or the file is applied again): that persona, by id.
        const again = row.transferId ? db.personas.findIndex(p => p?.id === row.transferId) : -1
        if (again >= 0) { plan.targets.push(again); plan.updated.push(row.name); continue }
        const local = db.personas.flatMap((p, i) => (p?.name === row.name ? [i] : []))
        if (local.length === 1 && received.get(row.name) === 1) { plan.targets.push(local[0]); plan.updated.push(row.name); continue }
        plan.targets.push(-1); plan.added.push(row.name)
        if ((local.length || received.get(row.name)! > 1) && !plan.ambiguous.includes(row.name)) plan.ambiguous.push(row.name)
    }
    return plan
}

/** The persona rows and active persona fields, as plain values (restorable when an apply is not confirmed). */
export function snapshotPersonas(db: PersonaDatabase) {
    return JSON.parse(JSON.stringify({ personas: db.personas, selectedPersona: db.selectedPersona, username: db.username,
        personaPrompt: db.personaPrompt, userNote: db.userNote ?? null, userIcon: db.userIcon })) as {
        personas: RisuPersona[]; selectedPersona: number; username: string; personaPrompt: string; userNote: string | null; userIcon: string }
}
export function restorePersonas(db: PersonaDatabase, snapshot: ReturnType<typeof snapshotPersonas>) {
    db.personas.splice(0, db.personas.length, ...snapshot.personas)
    db.selectedPersona = snapshot.selectedPersona
    db.username = snapshot.username
    db.personaPrompt = snapshot.personaPrompt
    if (snapshot.userNote === null) delete db.userNote; else db.userNote = snapshot.userNote
    db.userIcon = snapshot.userIcon
}

export async function applyReceivedPersonas(db: PersonaDatabase, rows: ReceivedPersona[], blobs: ReceivedBlobs, io: PersonaApplyIo): Promise<PersonaPlan> {
    const plan = planPersonas(db, rows)
    const bytesOf = (key: string | null | undefined) => {
        if (!key) return null
        const base64 = blobs[key]
        if (typeof base64 !== 'string') throw new Error('받은 페르소나 파일의 그림이 빠져 있어요.')
        return Uint8Array.from(atob(base64), c => c.charCodeAt(0))
    }
    // Every picture and module file is stored before the database changes, so a failure here leaves the personas as they were.
    const prepared = []
    for (const row of rows) {
        const image = bytesOf(row.image)
        const icon = image ? await io.saveImage(await io.reencodeImage(image)) : null
        let module: ReceivedPersona['embeddedModule'] | undefined
        if (row.embeddedModule) {
            module = structuredClone(row.embeddedModule)
            const assets: [string, string, string][] = []
            for (const [j, [name, , ext]] of (module.assets ?? []).entries()) {
                const data = bytesOf(row.moduleAssets?.[j])
                if (!data) continue
                assets.push([name, await io.saveAsset(data, '', ext ? `${name}.${ext}` : name), ext])
            }
            if (module.assets) module.assets = assets
            const moduleIcon = bytesOf(row.moduleIcon)
            if (moduleIcon) module.icon = await io.saveImage(await io.reencodeImage(moduleIcon))
        }
        prepared.push({ row, icon, module })
    }
    for (const [i, { row, icon, module }] of prepared.entries()) {
        const fields: Partial<RisuPersona> = { personaPrompt: row.personaPrompt }
        // A missing note is left as it is (an empty and an absent note mean the same to sync, so neither is invented here).
        if (typeof row.note === 'string') fields.note = row.note
        if (typeof row.largePortrait === 'boolean') fields.largePortrait = row.largePortrait
        if (row.portraitPrompt) fields.portraitPrompt = row.portraitPrompt as RisuPersona['portraitPrompt']
        if (module) fields.embeddedModule = module as RisuPersona['embeddedModule']
        const index = plan.targets[i]
        if (index >= 0) {
            const persona = db.personas[index]
            Object.assign(persona, fields)
            if (icon) persona.icon = icon // a persona sent without a picture keeps this device's picture
            // The selected persona is also held in the active fields (persona.ts changeUserPersona/saveUserPersona);
            // update all of them, or the next saveUserPersona would write the old values back over the row.
            if (db.selectedPersona === index) {
                db.username = persona.name
                db.personaPrompt = persona.personaPrompt
                db.userNote = persona.note
                db.userIcon = persona.icon
            }
        } else {
            db.personas.push({ ...fields, name: row.name, icon: icon ?? '', personaPrompt: row.personaPrompt, id: row.transferId ?? io.newId() })
        }
    }
    return plan
}

/** The confirm text before applying. */
export function personaPlanText(plan: PersonaPlan): string {
    const lines = [`페르소나 ${plan.updated.length + plan.added.length}개를 가져올까요?`]
    if (plan.updated.length) lines.push(`같은 이름이 있어 내용을 바꿈: ${plan.updated.join(', ')}`)
    const plain = plan.added.filter(name => !plan.ambiguous.includes(name))
    if (plain.length) lines.push(`새로 추가: ${plain.join(', ')}`)
    if (plan.ambiguous.length) lines.push(`이름이 겹쳐서 덮어쓰지 않고 새로 추가: ${plan.ambiguous.join(', ')}`)
    if (plan.updated.length) lines.push('바꾸는 페르소나는 그대로 유지돼서, 연결된 대화·봇도 그대로 그 페르소나를 써요.')
    return lines.join('\n')
}
