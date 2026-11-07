// Persona transfer (transfer-sync, 0.9.91-ver1): applying personas received with the manual transfer screen.
// Same rule as the NAS persona publish (content-updates): a persona with the same name is updated in place — its id stays,
// so chats and bots bound to it keep it — and any other persona is added with a new id. Nothing is deleted.
import type { RisuPersona } from '../storage/database.svelte'

/** One persona as the server hands it over (pictures and module files as base64). */
export interface ReceivedPersona {
    name: string
    personaPrompt: string
    note?: string
    largePortrait?: boolean
    portraitPrompt?: Record<string, unknown>
    embeddedModule?: Record<string, any> & { id: string; name: string; assets?: [string, string, string][] }
    image: string | null
    moduleIcon?: string | null
    moduleAssets?: (string | null)[]
}
export interface PersonaApplyIo {
    saveImage(bytes: Uint8Array): Promise<string>
    reencodeImage(bytes: Uint8Array): Promise<Uint8Array>
    saveAsset(bytes: Uint8Array, customId: string, fileName: string): Promise<string>
    newId(): string
}
interface PersonaDatabase {
    personas: RisuPersona[]
    selectedPersona: number
    personaPrompt: string
    userNote?: string
    userIcon: string
}
export interface PersonaPlan { updated: string[]; added: string[] }

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), c => c.charCodeAt(0))

/** Which received personas replace an existing one (same name) and which are new — computed before anything changes. */
export function planPersonas(db: Pick<PersonaDatabase, 'personas'>, rows: Pick<ReceivedPersona, 'name'>[]): PersonaPlan {
    const plan: PersonaPlan = { updated: [], added: [] }
    for (const row of rows) (db.personas.some(p => p?.name === row.name) ? plan.updated : plan.added).push(row.name)
    return plan
}

export async function applyReceivedPersonas(db: PersonaDatabase, rows: ReceivedPersona[], io: PersonaApplyIo): Promise<PersonaPlan> {
    // Targets are fixed first, so two received personas with the same new name are both added (never merged into each other).
    const targets = rows.map(row => db.personas.findIndex(p => p?.name === row.name))
    const plan = planPersonas(db, rows)
    // Every picture and module file is stored before the database changes, so a failure leaves the personas as they were.
    const prepared = []
    for (const row of rows) {
        const icon = row.image ? await io.saveImage(await io.reencodeImage(bytesOf(row.image))) : null
        let module: ReceivedPersona['embeddedModule'] | undefined
        if (row.embeddedModule) {
            module = structuredClone(row.embeddedModule)
            const assets: [string, string, string][] = []
            for (const [j, [name, , ext]] of (module.assets ?? []).entries()) {
                const data = row.moduleAssets?.[j]
                if (!data) continue
                assets.push([name, await io.saveAsset(bytesOf(data), '', ext ? `${name}.${ext}` : name), ext])
            }
            if (module.assets) module.assets = assets
            if (row.moduleIcon) module.icon = await io.saveImage(await io.reencodeImage(bytesOf(row.moduleIcon)))
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
        const index = targets[i]
        if (index >= 0) {
            const persona = db.personas[index]
            Object.assign(persona, fields)
            if (icon) persona.icon = icon // a persona sent without a picture keeps this device's picture
            // The selected persona is also held in the active fields (persona.ts changeUserPersona/saveUserPersona);
            // update them too, or the next saveUserPersona would write the old values back over the row.
            if (db.selectedPersona === index) {
                db.personaPrompt = persona.personaPrompt
                db.userNote = persona.note
                db.userIcon = persona.icon
            }
        } else {
            db.personas.push({ ...fields, name: row.name, icon: icon ?? '', personaPrompt: row.personaPrompt, id: io.newId() })
        }
    }
    return plan
}

/** The confirm text before applying. */
export function personaPlanText(plan: PersonaPlan): string {
    const lines = [`페르소나 ${plan.updated.length + plan.added.length}개를 가져올까요?`]
    if (plan.updated.length) lines.push(`같은 이름이 있어 내용을 바꿈: ${plan.updated.join(', ')}`)
    if (plan.added.length) lines.push(`새로 추가: ${plan.added.join(', ')}`)
    if (plan.updated.length) lines.push('바꾸는 페르소나는 그대로 유지돼서, 연결된 대화·봇도 그대로 그 페르소나를 써요.')
    return lines.join('\n')
}
