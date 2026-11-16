// Content updates (client): asks "a new character/persona/prompt preset was published on the NAS — import it?" and imports it with
// the app's own import. A character goes through upstream importCharacterProcess, which offers to update the installed
// bot (upstream "update an installed bot" dialog, chats kept, a backup copy in the trash). A persona with the same name
// is updated in place (same id, so chats bound to it keep it); otherwise it is added. A plugin (0.9.92-ver11) goes through upstream
// importPlugin with the script text, as a file picked by hand: its own dialogs ("update the existing plugin?", the API 2.1 safety check)
// are shown as they are, and an update keeps this device's argument values and on/off state (as upstream's plugin code editor does).
// A module (0.9.96-ver4, .risum) is read with upstream readModule inside an import session (assets content-addressed, rolled back on
// failure) under an id derived from the file, so every device that imports it has the same module; where an earlier module of the same
// namespace was turned on, the new one is turned on in its place in the same save (the earlier one stays in the list, off).
import { get, writable } from 'svelte/store'
import { unzipSync, strFromU8 } from 'fflate'
import type { RisuPersona } from '../storage/database.svelte'
// Same module paths as the settings screen (TransferPanel), so they are one instance there and in its tests.
import { transferBusy, transferStatus, transferRequest, transferUnavailable } from '../playTransfer'
import { isNodeServer } from '../platform'
// The app's database, import and dialog modules are loaded when first needed, so the settings panel (and its tests)
// does not pull the whole app into the transfer screen.
const app = () => Promise.all([
    import('../storage/database.svelte'), import('../globalApi.svelte'), import('../characterCards'), import('../storage/importTransaction'),
    import('../process/files/inlays'), import('../alert'), import('../stores.svelte'), import('../process/generationState'), import('uuid'),
    import('../importSession'), import('../plugins/plugins.svelte'), import('../process/modules'),
]).then(([database, globalApi, cards, importTransaction, inlays, alert, stores, generation, uuid, session, plugins, modules]) => ({ database, globalApi, cards, importTransaction, inlays, alert, stores, generation, uuid, session, plugins, modules }))

export type ContentKind = 'character' | 'persona' | 'preset' | 'plugin' | 'module'
/** 0.9.92-ver11: the kinds this client can import, sent with the overview request. The server lists only these; a client that sends
 *  none (0.9.92-ver10 and older) gets character, persona and preset only — it would import any other kind as a character card.
 *  0.9.96-ver4 adds 'module'; 0.9.92-ver11 … 0.9.96-ver3 send the first four and are not shown modules. */
export const CONTENT_KINDS: ContentKind[] = ['character', 'persona', 'preset', 'plugin', 'module']
export interface ContentItem {
    key: string; kind: ContentKind; title: string; version: string; file: string; fileName: string
    sha256: string; bytes: number; publishedAt: string; publishedBy: string; decision: '' | 'applied' | 'declined' | 'published'
}
export interface ContentOverview { configured: boolean; items: ContentItem[]; pending: ContentItem[] }
export type ContentDecision = 'applied' | 'declined'
/** 'reset' forgets this device's answer so the item is asked about again. */
export type ContentDecisionInput = ContentDecision | 'reset'

const CHECK_INTERVAL = 10 * 60_000
// 0.9.92-ver5: the first check runs as soon as the main screen is up; while the app is busy at start (startup NAS sync, another
// dialog, a reply, a NAS sync cycle) or becomes busy before every item was answered, it is tried again every START_RETRY, for
// START_WINDOW. A question closed without an answer is not asked again by it. Before, one check at 8 s was skipped when busy.
const START_DELAY = 1_500
const START_RETRY = 3_000
const START_WINDOW = 3 * 60_000
export const contentUpdateStatus = writable('')

// 0.9.92-ver6: the app server answers 423 NAS_SYNC_BUSY to these POST routes (its write gate) while a NAS sync step or an armed sync apply
// runs. That answer comes before the route runs (nothing fetched, recorded or published yet), so the request is sent again every
// BUSY_STEP until the sync step ends, for at most BUSY_WAIT. Before, it failed at once ("NAS sync apply must finish before saving").
// An armed sync apply (the answer carries `transaction`) normally finishes within seconds but may instead need recovery: it is waited
// for at most ARMED_WAIT, then reported as such, transaction kept (the same contract as nodeStorage/playTransfer: never resolved by waiting).
// The waiting text goes to contentUpdateStatus, which the settings panel shows.
const BUSY_WAIT = 60_000
const ARMED_WAIT = 15_000
const BUSY_STEP = 1_000
const BUSY_TEXT = 'NAS 동기화가 끝나면 이어서 받아요…'
/** 0.9.96-ver5: `alive` false = the caller gave up on this request (the overview time limit): it no longer waits or touches the status
 *  line. The status line is put back only when this request itself put up the waiting text and that text is still shown, so a late
 *  answer never wipes another check's progress text. */
async function contentRequest(path: string, init: RequestInit, alive: () => boolean = () => true): Promise<Response> {
    const started = Date.now(), shown = get(contentUpdateStatus)
    let waited = false
    const restore = () => { if (waited && alive() && get(contentUpdateStatus) === BUSY_TEXT) contentUpdateStatus.set(shown) }
    for (;;) {
        try { const response = await transferRequest(path, init); restore(); return response }
        catch (error: any) {
            if (error?.status !== 423 || error?.code !== 'NAS_SYNC_BUSY' || !alive()) { restore(); throw error }
            const armed = typeof error.transaction === 'string' && error.transaction !== ''
            if (Date.now() - started >= (armed ? ARMED_WAIT : BUSY_WAIT)) {
                restore()
                throw Object.assign(new Error(armed
                    ? 'NAS 동기화 적용이 끝나지 않은 상태라 처리하지 못했어요. 설정 > NAS 동기화에서 적용 결과를 확인해 주세요(NAS sync apply pending).'
                    : 'NAS 동기화가 1분 넘게 진행 중이라 지금은 처리하지 못했어요(NAS sync busy).'), { status: 423, code: 'NAS_SYNC_BUSY', ...(armed ? { transaction: error.transaction } : {}) })
            }
            waited = true; contentUpdateStatus.set(BUSY_TEXT)
            await new Promise(resolve => setTimeout(resolve, BUSY_STEP))
        }
    }
}
const post = async <T>(path: string, body: unknown, alive?: () => boolean): Promise<T> =>
    (await contentRequest('/content-updates' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, alive)).json()

// 0.9.92-ver4: the server picks the home or external NAS address from this device's Wi-Fi report, which it trusts for 2 minutes
// and which is otherwise sent only before a NAS sync cycle (Android). Report it again right before talking to the NAS, so a device
// on its home Wi-Fi uses the home address (the external one can drop large transfers from inside the home network). Best effort:
// on failure, or when it takes longer than ROUTE_REPORT_LIMIT (an unanswered native bridge waits up to 120 s), the call goes on and
// the server decides as before.
const ROUTE_REPORT_LIMIT = 3_000
async function freshRoute() {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
        await Promise.race([
            import('../nasSync').then(m => m.reportSyncNetwork(controller.signal)),
            new Promise(resolve => { timer = setTimeout(resolve, ROUTE_REPORT_LIMIT) }),
        ])
    } catch { /* the server decides as before */ } finally { clearTimeout(timer); controller.abort() }
}

// 0.9.96-ver5: the list read (a NAS folder listing and one small record per item) gives up after OVERVIEW_LIMIT, so a check never
// stays running (every later button press was then skipped without a word). A file download has no such limit: a large card on a slow
// line is an ordinary download, and the server already resumes a dropped one.
const OVERVIEW_LIMIT = 120_000
export const fetchOverview = async () => {
    let timer: ReturnType<typeof setTimeout> | undefined, alive = true
    try {
        return await Promise.race([
            (async () => { await freshRoute(); return post<ContentOverview>('/overview', { kinds: CONTENT_KINDS }, () => alive) })(),
            // At the limit the request is given up: it no longer writes the status line, so its NAS-sync waiting text is taken down here.
            new Promise<never>((_, reject) => { timer = setTimeout(() => { alive = false; if (get(contentUpdateStatus) === BUSY_TEXT) contentUpdateStatus.set(''); reject(new Error('NAS에서 배포 목록을 2분 안에 읽지 못했어요(응답 없음). 연결을 확인한 뒤 다시 눌러 주세요.')) }, OVERVIEW_LIMIT) }),
        ])
    } finally { clearTimeout(timer) }
}
export const recordDecision = (item: Pick<ContentItem, 'key' | 'sha256'>, decision: ContentDecisionInput) => post('/decide', { key: item.key, sha256: item.sha256, decision })

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
    return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('')
}

export async function fetchContent(item: ContentItem): Promise<Uint8Array> {
    await freshRoute()
    const response = await contentRequest('/content-updates/fetch', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: item.key, sha256: item.sha256 }),
    })
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length !== item.bytes || await sha256Hex(bytes) !== item.sha256) throw new Error('받은 파일이 배포본과 달라요. 다시 시도해 주세요.')
    return bytes
}

export const kindLabel = (kind: ContentKind) => kind === 'character' ? '캐릭터 카드' : kind === 'preset' ? '프롬프트 프리셋' : kind === 'plugin' ? '플러그인' : kind === 'module' ? '모듈' : '페르소나'
/** 이/가 and 을/를 after the kind label (플러그인·모듈 end in a consonant). */
const consonantKind = (kind: ContentKind) => kind === 'plugin' || kind === 'module'
export const itemLabel = (item: Pick<ContentItem, 'title' | 'version'>) =>
    item.version && !item.title.includes(item.version) ? `${item.title} (${item.version})` : item.title

// ── Reading a card or persona file (also used to fill in the publish form) ──

export interface PersonaPayload { name: string; personaPrompt: string; note?: string }

export async function readPngText(bytes: Uint8Array, keys: string[]): Promise<Record<string, string>> {
    const { PngChunk } = await import('../pngChunk')
    const found: Record<string, string> = {}
    for await (const chunk of PngChunk.readGenerator(bytes)) {
        if (chunk && typeof (chunk as any).key === 'string' && keys.includes((chunk as any).key) && found[(chunk as any).key] === undefined) {
            found[(chunk as any).key] = (chunk as any).value
        }
    }
    return found
}

export function readPersonaJson(base64: string): PersonaPayload {
    const data = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), c => c.charCodeAt(0))))
    if (typeof data?.name !== 'string' || !data.name.trim() || typeof data.personaPrompt !== 'string' || !data.personaPrompt) {
        throw new Error('페르소나 정보가 없는 PNG예요.')
    }
    return { name: data.name, personaPrompt: data.personaPrompt, note: typeof data.note === 'string' ? data.note : undefined }
}

/** A version-looking token (1.2.34-argon.4, v1.0.30-aspirant.6) or ''. */
export function versionIn(text: string | undefined): string {
    return /\bv?(\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?)\b/.exec(text ?? '')?.[1] ?? ''
}

/** The name without its version and a trailing "ver", used as the default publish name. */
export function baseName(title: string): string {
    const stripped = title.replace(/\s*\bv?\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.]+)?\b\s*(?:ver\.?|버전)?\s*$/i, '').trim()
    return stripped || title.trim()
}

export interface Described { kind: ContentKind; title: string; version: string; series?: string }

/** A prompt preset's display name from its file name (".risup", ".risupreset", ".json", a trailing "_preset" / ".preset"). */
export function presetTitle(fileName: string): string {
    return fileName.replace(/\.(?:risup|risupreset|json)$/i, '').replace(/[._]preset$/i, '').trim()
}
/** A JSON file is a character card when it carries card fields; a prompt preset when it carries preset fields and no card fields. */
export function jsonKind(data: any): 'character' | 'preset' | null {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    if (data.spec || (data.data && typeof data.data === 'object') || 'char_name' in data || 'first_mes' in data) return 'character'
    if (['promptTemplate', 'mainPrompt', 'jailbreak', 'presetVersion', 'prompt_order', 'NAISettings'].some(key => key in data)) return 'preset'
    return null
}

/** A plugin file's text as upstream importPlugin reads a picked file (UTF-8, byte order marks removed). */
export function readPluginText(bytes: Uint8Array): string {
    return new TextDecoder().decode(bytes).replace(/^﻿/gm, '')
}
/** The `//@name` and `//@version` header lines, read the way upstream importPlugin reads them (the last one of each counts). The script
 *  itself is checked by importPlugin when it is imported. */
export function pluginHeader(script: string): { name: string; version: string } {
    let name = '', version = ''
    for (const line of script.split('\n')) {
        if (line.startsWith('//@name')) name = line.slice(7).trim()
        if (line.startsWith('//@version')) version = line.split(' ').slice(1).join(' ').trim()
    }
    return { name, version }
}

/** The module record of a .risum file without its assets, read as upstream readModule reads it: byte 111, version 0, a 32-bit
 *  little-endian length, then that many rpack-encoded bytes of JSON `{ type: 'risuModule', module }`. */
export async function readRisumModule(bytes: Uint8Array): Promise<{ name: string; namespace?: string; lowLevelAccess?: boolean; trigger?: unknown[]; assets?: unknown[] }> {
    if (bytes.length < 6 || bytes[0] !== 111 || bytes[1] !== 0) throw new Error('모듈(.risum) 파일이 아니에요.')
    const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(2, true)
    if (6 + length > bytes.length) throw new Error('모듈 파일이 잘렸어요.')
    const { decodeRPack } = await import('../rpack/rpack_js')
    const main = JSON.parse(new TextDecoder().decode(await decodeRPack(bytes.subarray(6, 6 + length))))
    if (main?.type !== 'risuModule' || typeof main.module?.name !== 'string' || !main.module.name.trim()) throw new Error('모듈 이름이 없는 파일이에요.')
    return main.module
}

/** What a picked file is: a character card (.charx/.json/.png with a card), a persona PNG, a prompt preset (.risup/.risupreset/.preset.json),
 *  a plugin (.js) or a module (.risum; `series` is its namespace, the default publish name). */
export async function describeFile(name: string, bytes: Uint8Array): Promise<Described> {
    const lower = name.toLowerCase()
    if (lower.endsWith('.risum')) {
        const module = await readRisumModule(bytes)
        const title = module.name.trim(), series = typeof module.namespace === 'string' ? module.namespace.trim() : ''
        return { kind: 'module', title, version: versionIn(title), ...(series ? { series } : {}) }
    }
    if (lower.endsWith('.js')) {
        const header = pluginHeader(readPluginText(bytes))
        if (!header.name) throw new Error('플러그인 이름(//@name)이 없는 파일이에요.')
        return { kind: 'plugin', title: header.name, version: header.version }
    }
    if (lower.endsWith('.risup') || lower.endsWith('.risupreset')) {
        const title = presetTitle(name)
        if (!title) throw new Error('프리셋 이름이 없어요.')
        return { kind: 'preset', title, version: versionIn(title) }
    }
    if (lower.endsWith('.json')) {
        const data = JSON.parse(new TextDecoder().decode(bytes))
        if (jsonKind(data) === 'preset') {
            const title = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : presetTitle(name)
            if (!title) throw new Error('프리셋 이름이 없어요.')
            return { kind: 'preset', title, version: versionIn(title) }
        }
        return fromCard(data)
    }
    if (lower.endsWith('.charx')) {
        const files = unzipSync(bytes, { filter: file => file.name === 'card.json' })
        if (!files['card.json']) throw new Error('card.json이 없는 charx예요.')
        const card = JSON.parse(strFromU8(files['card.json']))
        return fromCard(card)
    }
    if (lower.endsWith('.png')) {
        const text = await readPngText(bytes, ['persona', 'ccv3', 'chara'])
        if (text.persona) {
            const persona = readPersonaJson(text.persona)
            return { kind: 'persona', title: persona.name, version: versionIn(persona.note) }
        }
        const card = text.ccv3 ?? text.chara
        if (card) return fromCard(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(card), c => c.charCodeAt(0)))))
        throw new Error('캐릭터 카드나 페르소나 정보가 없는 PNG예요.')
    }
    throw new Error('charx, json, png, risup, js, risum 파일만 올릴 수 있어요.')
}

function fromCard(card: any): Described {
    const data = card?.data ?? card
    const title = typeof data?.name === 'string' ? data.name.trim() : typeof data?.char_name === 'string' ? data.char_name.trim() : ''
    if (!title) throw new Error('캐릭터 이름이 없는 카드예요.')
    const version = typeof data?.character_version === 'string' && data.character_version.trim() ? data.character_version.trim() : versionIn(title)
    return { kind: 'character', title, version }
}

// ── Applying ──

async function applyPersona(bytes: Uint8Array): Promise<void> {
    const text = await readPngText(bytes, ['persona'])
    if (!text.persona) throw new Error('페르소나 정보가 없는 PNG예요.')
    const data = readPersonaJson(text.persona)
    const { database, inlays, uuid } = await app()
    const icon = await database.saveImage(await inlays.reencodeImage(bytes))
    const db = database.getDatabase()
    const index = db.personas.findIndex(persona => persona?.name === data.name)
    if (index >= 0) {
        // Same id, so chats and bots bound to this persona keep using it.
        const persona = db.personas[index]
        persona.personaPrompt = data.personaPrompt
        persona.note = data.note
        persona.icon = icon
        // The selected persona is also held in the active fields (persona.ts changeUserPersona/saveUserPersona);
        // update them too, or the next saveUserPersona would write the old values back over the row.
        if (db.selectedPersona === index) {
            db.personaPrompt = persona.personaPrompt
            db.userNote = persona.note
            db.userIcon = persona.icon
        }
    } else {
        const added: RisuPersona = { name: data.name, icon, personaPrompt: data.personaPrompt, note: data.note, id: uuid.v4() }
        db.personas.push(added)
    }
}

/** Connection fields an exported preset leaves blank (database.svelte.ts downloadPreset): an update keeps this device's values. */
const PRESET_DEVICE_FIELDS = ['openAIKey', 'forceReplaceUrl', 'forceReplaceUrl2', 'proxyKey', 'textgenWebUIStreamURL', 'textgenWebUIBlockingURL']

/** Imports a prompt preset with the app's own preset import. A preset with the same name is updated in place (same id, so chats
 *  bound to it keep it; this device's keys and addresses kept); otherwise it is added. Resolves to the preset's name. */
/** Id of a preset added from a published item: the same on every device (sha256 of the key and the preset name, uuid-shaped), so
 *  two devices that both import the same file end with the same prompt-presets content for NAS sync. */
export async function publishedPresetId(key: string, name: string): Promise<string> {
    const hex = await sha256Hex(new TextEncoder().encode(key + '\n' + name))
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

async function applyPreset(item: Pick<ContentItem, 'key' | 'fileName'>, bytes: Uint8Array): Promise<string> {
    const { database } = await app()
    const db = database.getDatabase()
    if (!Array.isArray(db.botPresets)) db.botPresets = []
    const before = db.botPresets.length
    await database.importPreset({ name: item.fileName, data: bytes })
    if (db.botPresets.length !== before + 1) throw new Error('프롬프트 프리셋을 읽지 못했어요.')
    const added: any = db.botPresets[before]
    // A SillyTavern preset is renamed "Imported ST Preset" by the app's import: name it after the published file instead.
    if (added.name === 'Imported ST Preset' || added.name === 'Imported' || !added.name) added.name = presetTitle(item.fileName) || added.name || 'Imported'
    const index = db.botPresets.findIndex((preset, i) => i < before && preset?.name === added.name)
    if (index < 0) { added.id = await publishedPresetId(item.key, added.name); return added.name }
    const existing: any = db.botPresets[index]
    for (const field of PRESET_DEVICE_FIELDS) if (!added[field] && existing[field]) added[field] = existing[field]
    added.id = existing.id
    db.botPresets.splice(before, 1)
    db.botPresets[index] = added
    // The active preset is also held in the root fields: load the new values there, without saving the old ones back over it.
    if (db.botPresetsId === index) database.changeToPreset(index, false)
    return added.name
}

/** Imports a plugin with upstream importPlugin, given the script text as its file picker does (no isUpdate): upstream shows its own
 *  "update the existing plugin?" question for a same-name plugin and its safety check for an API 2.1 plugin, and adds a new plugin
 *  as a hand import does. A same-name plugin that was updated then gets back this device's on/off state and its argument values for
 *  the arguments the new script still declares, as upstream's plugin code editor does (PluginSettings applyPluginCode), and the
 *  plugins are loaded again. 'declined' when importPlugin did not import it (the user said no in its dialog, or it refused the file).
 *  importPlugin also answers nothing when its own save failed after it had put the plugin in the list (it shows the error itself): that
 *  plugin is in use on this device, so it is restored, loaded and saved here like an imported one (a failed save here is an error). */
async function applyPlugin(bytes: Uint8Array): Promise<ContentDecision> {
    const { database, plugins, globalApi } = await app()
    const script = readPluginText(bytes)
    const { name } = pluginHeader(script)
    const before: any = (database.getDatabase().plugins ?? []).find((plugin: any) => plugin?.name === name)
    const original = before ? { ...before, realArg: { ...(before.realArg ?? {}) } } : null
    const imported = await plugins.importPlugin(script)
    const db = database.getDatabase()
    const index = (db.plugins ?? []).findIndex((plugin: any) => plugin?.name === name)
    const placed = index >= 0 && db.plugins[index].script === script
    if (!imported && !placed) return 'declined'
    if (imported && (!original || index < 0)) return 'applied'
    if (original) {
        const updated: any = db.plugins[index]
        const realArg = { ...(updated.realArg ?? {}) }
        for (const key of Object.keys(updated.arguments ?? {})) if (key in original.realArg) realArg[key] = original.realArg[key]
        const list = [...db.plugins]
        list[index] = { ...original, ...updated, enabled: original.enabled, realArg }
        db.plugins = list
    }
    await plugins.loadPlugins()
    await globalApi.requestImmediateSave({ flushServer: true, rejectOnFailure: true })
    return 'applied'
}

/** Id of a module added from a published item: the same on every device (sha256 of the file's SHA-256, uuid-shaped), so devices that
 *  each import the same file hold one module for NAS sync, never one copy per device. */
export async function publishedModuleId(sha256: string): Promise<string> {
    const hex = await sha256Hex(new TextEncoder().encode('module\n' + sha256))
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** A module's namespace as upstream getModules matches it (exact text; empty = none). */
const namespaceOf = (module: any): string => typeof module?.namespace === 'string' ? module.namespace : ''
/** Same series: the same namespace (exactly as upstream compares it); a module without one: the same name. */
const sameSeries = (a: any, b: any) => !!a && !!b && (namespaceOf(b) ? namespaceOf(a) === namespaceOf(b) : !namespaceOf(a) && a.name === b.name)
/** Earlier modules of the same series in the module list (any other id). */
function earlierModules(db: any, module: { id: string; name?: string; namespace?: string }): any[] {
    return (db.modules ?? []).filter((m: any) => m && m.id !== module.id && sameSeries(m, module))
}

/** The modules a list of entries turns on, as upstream getModuleByIds reads it: a module whose id or namespace is listed. */
const turnedOn = (entries: string[], modules: any[]): string[] =>
    modules.filter(m => m && (entries.includes(m.id) || (namespaceOf(m) && entries.includes(namespaceOf(m))))).map(m => m.id)

export interface ModuleSwitch { changed: boolean; characters: string[]; chats: [string, string][]; undo: () => void
    /** A list where the rewrite would not give the intended modules (see pinNamespace/switchModuleOn); nothing was changed. */
    unsafe?: boolean }
/** Rewrites every place a module is turned on: the global list (enabledModules), the per-persona lists (personaEnabledModules), each
 *  character's and chat's list (modules; placeholders included: their list lives in the chat stub) and the comma lists of module
 *  integration (moduleIntergration on the database and on every prompt preset). `swap` maps one listed entry to its replacement ids
 *  (null: kept); a replacement id already listed earlier in that list is not listed twice. */
function rewriteModuleLists(db: any, swap: (id: string) => string[] | null, dryRun: boolean, inspect?: (before: string[], after: string[]) => void): ModuleSwitch & { set: (owner: any, key: string, value: unknown) => void } {
    const writes: [any, string, unknown, unknown][] = []
    const result = {
        changed: false, characters: [] as string[], chats: [] as [string, string][],
        // Puts back every value this rewrite replaced that is still the one it wrote (read back after writing: the database is a
        // Svelte state proxy, which hands out its own proxy for an assigned array or object).
        undo: () => { for (const [owner, key, before, written] of writes.reverse()) if (owner[key] === written) owner[key] = before },
        set: (owner: any, key: string, value: unknown) => {
            result.changed = true
            if (dryRun) return
            const before = owner[key]
            owner[key] = value
            writes.push([owner, key, before, owner[key]])
        },
    }
    const replaced = (ids: unknown): string[] | null => {
        if (!Array.isArray(ids)) return null
        let hit = false
        const out: string[] = []
        for (const id of ids) {
            const next = typeof id === 'string' ? swap(id) : null
            if (!next) { out.push(id); continue }
            if (next.length !== 1 || next[0] !== id) hit = true // an entry kept as it is is no change
            for (const value of next) if (!out.includes(value)) out.push(value)
        }
        inspect?.(ids.filter((id): id is string => typeof id === 'string'), (hit ? out : ids).filter((id): id is string => typeof id === 'string'))
        return hit ? out : null
    }
    const list = (owner: any, key: string) => { const next = owner ? replaced(owner[key]) : null; if (next) result.set(owner, key, next); return !!next }
    const commaList = (owner: any, key: string) => {
        if (!owner || typeof owner[key] !== 'string') return
        const next = replaced(owner[key].split(',').map((id: string) => id.trim()).filter(Boolean))
        if (next) result.set(owner, key, next.join(','))
    }
    list(db, 'enabledModules')
    if (db.personaEnabledModules && typeof db.personaEnabledModules === 'object') {
        const next: Record<string, unknown> = {}
        let hit = false
        for (const [persona, ids] of Object.entries(db.personaEnabledModules)) { const ids2 = replaced(ids); next[persona] = ids2 ?? ids; if (ids2) hit = true }
        if (hit) result.set(db, 'personaEnabledModules', next)
    }
    for (const character of db.characters ?? []) {
        if (!character) continue
        let touched = list(character, 'modules')
        for (const chat of character.chats ?? []) {
            if (!chat || !list(chat, 'modules')) continue
            touched = true
            if (!chat._placeholder && chat.id && character.chaId) result.chats.push([character.chaId, chat.id])
        }
        if (touched && character.chaId) result.characters.push(character.chaId)
    }
    commaList(db, 'moduleIntergration')
    for (const preset of db.botPresets ?? []) commaList(preset, 'moduleIntergration')
    // A persona's embedded module id is one more entry of that persona's list (upstream resolveModuleIds), never rewritten here.
    if (inspect) for (const persona of db.personas ?? []) {
        const embedded = persona?.embeddedModule?.id
        if (typeof embedded === 'string' && embedded) inspect([embedded], [embedded])
    }
    return result
}

/** Before the new module is added (absent path): a namespace written in an on-list turns on every module of that namespace (upstream
 *  getModules), so the new module would be on at once. Such an entry is written out as the ids of the modules it turns on now (the
 *  earlier ones; none: the entry goes), and an entry of the new module's id (it turns on nothing yet) goes — the same modules stay on.
 *  Every list (and every persona's embedded module id) is checked with upstream's id-or-namespace rule: what it turns on with the new
 *  module added must be what it turns on now; otherwise `unsafe` and nothing is changed (an id that is also a namespace, …). Applied in the same synchronous step as the push, and saved with it. */
export function pinNamespace(db: any, module: { id: string; name?: string; namespace?: string }, dryRun = false): ModuleSwitch {
    const namespace = namespaceOf(module), earlier = earlierModules(db, module).map(m => m.id)
    const before = (db.modules ?? []).filter((m: any) => m && m.id !== module.id), after = [...before, module]
    const swap = (id: string) => namespace && id === namespace ? earlier : id === module.id ? [] : earlier.includes(id) ? [id] : null
    let unsafe = false
    const check = rewriteModuleLists(db, swap, true, (from, to) => {
        const was = turnedOn(from, before), now = turnedOn(to, after)
        if (was.length !== now.length || was.some(id => !now.includes(id))) unsafe = true
    })
    if (unsafe) return { changed: false, characters: [], chats: [], undo: () => {}, unsafe: true }
    if (dryRun || !check.changed) return { changed: check.changed, characters: check.characters, chats: check.chats, undo: () => {} }
    const result = rewriteModuleLists(db, swap, false)
    return { changed: result.changed, characters: result.characters, chats: result.chats, undo: result.undo }
}

/** Turns `module` (in the module list) on wherever an earlier module of its series is on (the earlier ids and the namespace text, in
 *  every list of rewriteModuleLists), and those off there: the new id takes the place of the first entry it replaces. The earlier
 *  modules stay in the module list; nothing is changed when none of them is listed. A model binding of an earlier module
 *  (moduleModelBindings, keyed by module id) is given to the new one when it has none. Every list (and every persona's embedded module
 *  id) is checked with upstream's id-or-namespace rule: afterwards it must turn on exactly what it turned on before, with the earlier
 *  modules of the series replaced by the new one — anything else (an earlier one still on, another module turned on or off) makes it
 *  `unsafe` and nothing is changed. `dryRun` only reports. */
export function switchModuleOn(db: any, module: { id: string; name?: string; namespace?: string }, dryRun = false): ModuleSwitch {
    const earlier = earlierModules(db, module)
    if (!earlier.length) return { changed: false, characters: [], chats: [], undo: () => {} }
    const namespace = namespaceOf(module)
    const earlierIds = earlier.map(m => m.id)
    const old = new Set<string>(earlierIds.filter((id: unknown) => typeof id === 'string' && id))
    if (namespace) old.add(namespace)
    const swap = (id: string) => old.has(id) || id === module.id ? [module.id] : null
    const modules = (db.modules ?? []).filter(Boolean)
    let unsafe = false
    const check = rewriteModuleLists(db, swap, true, (from, to) => {
        const was = turnedOn(from, modules), now = turnedOn(to, modules)
        const expected = new Set(was.filter(id => !earlierIds.includes(id)))
        if (was.some(id => earlierIds.includes(id) || id === module.id)) expected.add(module.id)
        if (now.length !== expected.size || now.some(id => !expected.has(id))) unsafe = true
    })
    if (unsafe) return { changed: false, characters: [], chats: [], undo: () => {}, unsafe: true }
    if (dryRun || !check.changed) return { changed: check.changed, characters: check.characters, chats: check.chats, undo: () => {} }
    const result = rewriteModuleLists(db, swap, false)
    const bindings = db.moduleModelBindings
    if (bindings && typeof bindings === 'object' && !bindings[module.id]) {
        const from = earlier.find(m => typeof bindings[m.id] === 'string' && bindings[m.id])
        if (from) result.set(db, 'moduleModelBindings', { ...bindings, [module.id]: bindings[from.id] })
    }
    return { changed: result.changed, characters: result.characters, chats: result.chats, undo: result.undo }
}

/** Whether any on-list turns `module` on now. */
function listedOn(db: any, module: { id: string }): boolean {
    let on = false
    rewriteModuleLists(db, () => null, true, from => { if (turnedOn(from, [module]).length) on = true })
    return on
}

/** A persona's embedded module runs next to the listed ones (upstream getModules adds it, telling modules apart by id only): one of
 *  this series there would stay on next to the new module. Its name, or ''. */
function embeddedConflict(db: any, module: { id: string; name?: string; namespace?: string }): string {
    const earlier = new Set(earlierModules(db, module).map(m => m.id))
    const persona = (db.personas ?? []).find((p: any) => p?.embeddedModule && p.embeddedModule.id !== module.id && (earlier.has(p.embeddedModule.id) || sameSeries(p.embeddedModule, module)))
    return persona ? String(persona.name ?? '') || '(이름 없음)' : ''
}

const saveSwitch = (globalApi: any, change: ModuleSwitch) =>
    globalApi.requestImmediateSave({ characters: change.characters, chats: change.chats, flushServer: true, rejectOnFailure: true })

const UNSAFE = '모듈 목록에 이 모듈의 id나 이름표와 겹치는 항목이 있어, 옛 모듈을 끄고 새 모듈만 켜는 것을 보장할 수 없어요. 모듈 설정을 확인해 주세요.'
/** Imports a published module (see the header). 'declined' when the import was cancelled.
 *  1. The module of this file's id is not here: upstream readModule runs inside the import session (asset writes, rollback; the NAS
 *     sync waits for it). In one synchronous step the on-lists are pinned (pinNamespace: the same modules on) and the module is added,
 *     turned off, then saved with the changed characters/chats (earlier ones still on); the import's own save follows. A rollback takes
 *     only the new module out. A list that cannot be pinned safely stops it before anything changes.
 *  2. Under the transfer busy hold, the new module is turned on in the earlier ones' places and saved once (switchModuleOn); a failed
 *     save puts the places back. A module already here (NAS sync brought it, or an earlier try added it) goes to this step directly.
 *  A persona's embedded module of the same series stops it before anything changes. Like a hand import of a .risum, no low-level-access
 *  question is asked. */
async function applyModule(item: Pick<ContentItem, 'sha256'>, bytes: Uint8Array): Promise<{ decision: ContentDecision; switched: boolean; on?: boolean }> {
    const { database, modules, session, globalApi } = await app()
    const id = await publishedModuleId(item.sha256)
    const present = () => (database.getDatabase().modules ?? []).find((m: any) => m?.id === id)
    const stopForEmbedded = (module: any) => {
        const persona = embeddedConflict(database.getDatabase(), module)
        if (persona) throw new Error(`페르소나 「${persona}」에 같은 계열 모듈이 들어 있어(페르소나 내장 모듈) 새 모듈과 함께 켜지게 돼요. 그 페르소나의 내장 모듈을 정리한 뒤 다시 받아 주세요.`)
    }
    if (!present()) {
        const result = await session.runImport(async transaction => {
            const module = await modules.readModule(Buffer.from(bytes), transaction)
            if (!module?.name) throw new Error('모듈을 읽지 못했어요.')
            transaction.check()
            if (present()) return 'present' as const // NAS sync brought it while it was being read
            module.id = id
            const db = database.getDatabase()
            stopForEmbedded(module)
            const pin = pinNamespace(db, module, true)
            if (pin.unsafe) throw new Error(UNSAFE)
            transaction.register('module', id)
            // One synchronous step, then one save with the changed characters/chats: the import's own save does not diff them.
            const pinned = pinNamespace(db, module)
            db.modules.push(module)
            if (pinned.changed) await globalApi.requestImmediateSave({ characters: pinned.characters, chats: pinned.chats, flushServer: true, rejectOnFailure: true })
            return 'added' as const
        })
        if (result === null) {
            if (get(session.importSession).phase === 'recovery') throw new Error('가져오기를 되돌리는 중 문제가 생겼어요. 가져오기 복구를 먼저 끝내 주세요.')
            return { decision: 'declined', switched: false }
        }
    }
    const module = present()
    if (!module) throw new Error('모듈을 넣지 못했어요.')
    stopForEmbedded(module)
    if (transferUnavailable()) throw new Error('NAS 동기화나 전송이 진행 중이라 모듈을 켜는 자리를 바꾸지 못했어요. 다음에 다시 물어볼게요.')
    transferBusy.set(true); transferStatus.set('모듈을 켜는 중…')
    try {
        const change = switchModuleOn(database.getDatabase(), module)
        if (change.unsafe) throw new Error(UNSAFE)
        if (!change.changed) return { decision: 'applied', switched: false, on: listedOn(database.getDatabase(), module) }
        try { await saveSwitch(globalApi, change) } catch (error) {
            change.undo()
            try { await globalApi.requestImmediateSave({ characters: change.characters, chats: change.chats, flushServer: true }) } catch { /* the error below is shown */ }
            throw error
        }
        return { decision: 'applied', switched: true }
    } finally { transferBusy.set(false); transferStatus.set('') }
}

/** Imports one published item; resolves to the decision to record (declined when the user cancelled the import). */
export async function applyItem(item: ContentItem, bytes: Uint8Array): Promise<ContentDecision> {
    const { cards, globalApi, importTransaction, alert, session } = await app()
    if (item.kind === 'module') {
        const { decision, switched, on } = await applyModule(item, bytes)
        if (decision === 'applied') alert.notifySuccess(switched
            ? `모듈 「${item.title}」을 가져와 옛 모듈 대신 켰어요. 옛 모듈은 꺼진 채 목록에 남아 있어요.`
            : on ? `모듈 「${item.title}」을 가져왔어요.`
            : `모듈 「${item.title}」을 가져왔어요. 켜 둔 같은 계열 모듈이 없어 켜지는 않았어요(모듈 설정에서 켤 수 있어요).`)
        return decision
    }
    if (item.kind === 'plugin') {
        const decision = await applyPlugin(bytes)
        if (decision === 'applied') alert.notifySuccess(`플러그인 「${item.title}」을 가져왔어요.`)
        return decision
    }
    if (item.kind === 'preset') {
        const name = await applyPreset(item, bytes)
        alert.notifySuccess(`프롬프트 프리셋 「${name}」를 가져왔어요.`)
        return 'applied'
    }
    if (item.kind === 'persona') {
        await applyPersona(bytes)
        alert.notifySuccess(`페르소나 「${item.title}」를 가져왔어요.`)
        return 'applied'
    }
    try {
        const result = await cards.importCharacterProcess({ name: item.fileName, data: bytes })
        globalApi.checkCharOrder()
        // runImport answers null when the user cancelled (in the update dialog or the install choice), and also when the
        // import failed and its rollback is waiting in recovery: that one is an error, not an answer, so it is asked again later.
        if (result === null && get(session.importSession).phase === 'recovery') throw new Error('가져오기를 되돌리는 중 문제가 생겼어요. 가져오기 복구를 먼저 끝내 주세요.')
        return result === null ? 'declined' : 'applied'
    } catch (error) {
        if (error instanceof importTransaction.ImportCancelled) return 'declined'
        throw error
    }
}

// ── Asking ──

let running = false
let lastCheck = 0
let started = false
/** 0.9.96-ver7: a check (list read, download or import) is running — the settings 「서버 끄기」 waits for it. */
export const contentCheckRunning = (): boolean => running

/** `ignoreAlert`: the caller's own dialog is the open one (app code update apply). */
export async function busy(ignoreAlert = false): Promise<boolean> {
    return (await busyReason(ignoreAlert)) !== ''
}
/** 0.9.96-ver5: why busy() is true ('' when it is not), the same conditions in the same order, worded for the settings panel. */
export async function busyReason(ignoreAlert = false): Promise<string> {
    const { stores, generation, session } = await app()
    if (!get(stores.loadedStore)) return '앱을 아직 불러오는 중이에요.'
    if (get(transferBusy)) return `다른 전송·동기화 작업이 진행 중이에요${get(transferStatus) ? `(${get(transferStatus)})` : ''}.`
    if (get(generation.isAnyGenerating)) return '답변을 만드는 중이에요.'
    if (!ignoreAlert && get(stores.alertStore).type !== 'none') return '다른 알림 창이 열려 있어요.'
    // An import in progress or waiting in rollback recovery has its own dialog: finish that first.
    const phase = get(session.importSession).phase
    if (phase === 'recovery') return '끝나지 않은 가져오기의 복구가 남아 있어요. 앱을 다시 켜면 나오는 가져오기 복구 창에서 「다시 시도」로 마무리해 주세요.'
    if (phase !== 'idle') return '다른 가져오기가 진행 중이에요.'
    return ''
}
/** 0.9.96-ver5: why transferUnavailable() (playTransfer, unchanged) is true, for the panel. A persona, preset or plugin is written
 *  under the busy state and waits for a reply, a NAS sync save or a BardWiki reboot job left on a chat to end (such a job stays until
 *  it is resumed or cancelled, also across restarts). */
async function unavailableReason(): Promise<string> {
    const known = await busyReason(true)
    if (known) return known
    const { database, generation } = await app()
    for (const character of database.getDatabase().characters ?? []) for (const chat of character?.chats ?? []) {
        const job = (chat as any)?.risuBardWikiReboot
        if (job) return `「${character.name}」의 「${chat.name || '이름 없는 채팅'}」 채팅에 위키 리부트 작업이 ${job.status === 'failed' ? '실패한 채로' : job.status === 'paused' ? '멈춘 채로' : '진행 중으로'} 남아 있어요. 그 채팅을 열어 리부트를 계속하거나 취소한 뒤 다시 받아 주세요.`
        if (chat?.isStreaming) return `「${character.name}」의 채팅에서 답변을 만드는 중이에요.`
    }
    const doing = (generation as any).doingChat
    if (doing && get(doing)) return '채팅을 보내는 중이에요.'
    return 'NAS 동기화 변경을 저장하는 중이에요. 끝난 뒤 다시 받아 주세요.'
}

/** 0.9.92-ver6: this device already has what was published (a card or persona imported by hand, or via another route): it is
 *  recorded as applied without asking. A character: same base name and the card version (or name) carries the published version — a
 *  different card file published under the same version number is not told apart (a card is not downloaded just to compare). A persona
 *  (small PNG): downloaded and compared — a persona with the same name, prompt and note (the note's version token is not trusted: the
 *  persona files keep an older one). Prompt presets are always asked. A plugin (0.9.92-ver11, a small script): downloaded and
 *  compared — a plugin with the same name and the same script text; its version line is not needed. */
export async function alreadyInstalled(item: Pick<ContentItem, 'kind' | 'title' | 'version'> & Partial<ContentItem>): Promise<boolean> {
    if (item.kind === 'plugin') return pluginInstalled(item)
    if (item.kind === 'module') return moduleInstalled(item)
    const plain = (value: string | undefined) => (value ?? '').trim().replace(/^v/i, '')
    const version = plain(item.version)
    if (!version) return false
    const { database } = await app()
    const db = database.getDatabase()
    if (item.kind === 'character') return (db.characters ?? []).some((c: any) => c && c.type !== 'group' && baseName(c.name ?? '') === baseName(item.title)
        && (plain(c.characterVersion) === version || versionIn(c.name) === version))
    if (item.kind === 'persona') {
        const named = (db.personas ?? []).filter((p: any) => p?.name === item.title)
        if (!named.length || !item.key || !item.sha256 || !item.bytes) return false
        try {
            const text = await readPngText(await fetchContent(item as ContentItem), ['persona'])
            if (!text.persona) return false
            const data = readPersonaJson(text.persona)
            // The list as it is now (a persona deleted during the download no longer counts).
            return (database.getDatabase().personas ?? []).some((p: any) => p?.name === item.title && p.name === data.name && (p.personaPrompt ?? '') === data.personaPrompt && (p.note ?? '') === (data.note ?? ''))
        } catch { return false } // could not compare: ask as before
    }
    return false
}

async function pluginInstalled(item: Pick<ContentItem, 'kind' | 'title' | 'version'> & Partial<ContentItem>): Promise<boolean> {
    const { database } = await app()
    if (!(database.getDatabase().plugins ?? []).some((plugin: any) => plugin?.name === item.title) || !item.key || !item.sha256 || !item.bytes) return false
    try {
        const script = readPluginText(await fetchContent(item as ContentItem))
        if (pluginHeader(script).name !== item.title) return false
        // The list as it is now (a plugin removed or changed during the download no longer counts).
        return (database.getDatabase().plugins ?? []).some((plugin: any) => plugin?.name === item.title && plugin.script === script)
    } catch { return false } // could not compare: ask as before
}

/** 0.9.96-ver4: a module is installed when the module of this file's id is on this device (imported here, or brought by NAS sync from a
 *  device that imported it) and no earlier module of its series is still turned on anywhere (otherwise it is asked, and the answer turns
 *  the new one on in its place). No download. */
async function moduleInstalled(item: Partial<ContentItem>): Promise<boolean> {
    if (!item.sha256) return false
    const { database } = await app()
    const id = await publishedModuleId(item.sha256)
    const db = database.getDatabase()
    const module = (db.modules ?? []).find((m: any) => m?.id === id)
    if (!module) return false
    const change = switchModuleOn(db, module, true)
    return !change.changed && !change.unsafe && !embeddedConflict(db, module)
}

/** A NAS sync cycle is running (startup/foreground sync, possibly preparing an apply): a question waits for it to end. */
export async function syncCycleRunning(): Promise<boolean> {
    try { return !!get((await import('../nasSyncCoordinator')).coordinatorState)?.running } catch { return false }
}

/** Asks about each published item this device has not answered yet. `force` ignores the interval (the settings button). 0.9.96-ver5:
 *  `first` (a published key: 「지금 물어보기」/「다시 받기」) is asked before the other pending items. */
export async function checkContentUpdates(force = false, first?: string): Promise<ContentOverview | null> {
    return (await runCheck(force, force, first)).overview
}
/** `retry`: this call stopped because the app was (or became) busy before every item was answered — the start check tries again.
 *  0.9.96-ver5: `manual` (a settings button) shows why the check stopped in contentUpdateStatus; the start and background checks
 *  stay quiet as before. */
async function runCheck(force: boolean, manual = false, first?: string): Promise<{ overview: ContentOverview | null; retry: boolean }> {
    const skip = (reason: string) => { if (manual && reason) contentUpdateStatus.set(reason) }
    // An earlier check still running shows its own progress text; otherwise say that it is still on.
    if (running) { if (!get(contentUpdateStatus)) skip('앞선 배포 확인이 아직 끝나지 않았어요(파일을 받는 중이거나 질문 창이 열려 있어요). 끝난 뒤 다시 눌러 주세요.'); return { overview: null, retry: true } }
    if (!force && Date.now() - lastCheck < CHECK_INTERVAL) return { overview: null, retry: false }
    running = true
    if (manual) contentUpdateStatus.set('')
    const startReason = await busyReason()
    if (startReason || await syncCycleRunning()) { running = false; skip(startReason || 'NAS 동기화가 진행 중이에요. 끝난 뒤 다시 눌러 주세요.'); return { overview: null, retry: true } }
    let retry = false
    lastCheck = Date.now()
    try {
        const { alert } = await app()
        const overview = await fetchOverview()
        const pending = first ? [...overview.pending.filter(item => item.key === first), ...overview.pending.filter(item => item.key !== first)] : overview.pending
        for (const item of pending) {
            let reason = await busyReason()
            if (reason) { retry = true; skip(reason); break }
            const installed = await alreadyInstalled(item)
            reason = await busyReason()
            if (reason) { retry = true; skip(reason); break } // the comparison download took a while: another dialog/activity may have started
            if (installed) { await recordDecision(item, 'applied'); continue }
            // 0.9.96-ver5: a persona, preset or plugin that cannot be written now is not asked about (before, it was asked, downloaded
            // and then dropped without a word); it is asked at a later check.
            if (item.kind !== 'character' && item.kind !== 'module' && transferUnavailable()) { retry = true; skip(`「${itemLabel(item)}」은 지금 가져올 수 없어요: ${await unavailableReason()}`); break }
            const choice = await alert.alertConfirmMulti(
                `새 ${kindLabel(item.kind)}${consonantKind(item.kind) ? '이' : '가'} 올라왔어요. 지금 가져올까요?`,
                ['네, 가져오기', '아니오'],
                `${itemLabel(item)}\n${(item.bytes / 1_000_000).toFixed(1)} MB · ${new Date(item.publishedAt).toLocaleString()}${item.publishedBy ? ` · ${item.publishedBy}` : ''}`
                + (item.kind === 'character' ? '\n\n이미 있는 같은 캐릭터를 고르면 대화는 그대로 두고 카드만 새 판으로 바꿔요.'
                    : item.kind === 'preset' ? '\n\n같은 이름의 프롬프트 프리셋이 있으면 그 프리셋을 새 내용으로 바꿔요(이 기기의 API 키·주소는 그대로). 이름이 다르면 새로 추가해요.'
                    : item.kind === 'module' ? '\n\n같은 이름표(namespace)의 옛 모듈이 켜져 있던 곳(전역·페르소나·캐릭터·채팅·프롬프트 프리셋의 모듈 통합)에서는 새 모듈로 바꿔 켜요. 옛 모듈은 지우지 않고 꺼진 채 목록에 남겨요. 켜 둔 옛 모듈이 없으면 추가만 해요. 앱을 다시 켤 필요는 없어요.'
                    : item.kind === 'plugin' ? '\n\n같은 이름의 플러그인이 있으면 새 내용으로 바꾸고 이 기기의 플러그인 설정값과 켜짐/꺼짐 상태는 그대로 둬요(새 판에서 없어진 설정 항목은 빠져요). 없으면 새로 추가해요. 앱의 플러그인 확인 창이 이어서 나오면 거기서도 답해 주세요.'
                    : '\n\n같은 이름의 페르소나가 있으면 그 페르소나를 새 내용으로 바꿔요.'),
            )
            // -1 is the dialog's own cancel/close: no answer yet, so it is asked again at the next check.
            if (choice === -1) break
            if (choice !== 0) { await recordDecision(item, 'declined'); continue }
            // 0.9.96-ver5: after "yes" a stop is always told (toast and panel); the item is asked again at a later check.
            const stopped = (reason: string) => {
                const text = `「${itemLabel(item)}」를 받았지만 지금은 가져오지 못했어요: ${reason} 다음 확인 때 다시 물어볼게요.`
                contentUpdateStatus.set(text); alert.notifyInfo(text)
            }
            try {
                // 0.9.96-ver5: the server takes the whole file from the NAS before it answers, so nothing arrives for a while on a slow
                // line. The panel shows the size and the time so far, and a toast says the download started (on any screen).
                const size = `${(item.bytes / 1_000_000).toFixed(1)} MB`, began = Date.now(), prefix = `${itemLabel(item)} (${size}) `
                const tick = () => {
                    const now = get(contentUpdateStatus), seconds = Math.floor((Date.now() - began) / 1000)
                    if (now && !now.startsWith(prefix)) return // contentRequest's NAS sync wait text stays while it waits
                    contentUpdateStatus.set(`${prefix}NAS에서 받는 중… ${seconds >= 60 ? `${Math.floor(seconds / 60)}분 ` : ''}${seconds % 60}초 지남`)
                }
                contentUpdateStatus.set(''); tick()
                const ticker = setInterval(tick, 1000)
                alert.notifyInfo(`「${itemLabel(item)}」(${size})를 받기 시작했어요. 다 받으면 이어서 가져와요. 큰 파일은 몇 분 걸릴 수 있어요.`)
                let bytes: Uint8Array
                try { bytes = await fetchContent(item) } finally { clearInterval(ticker) }
                contentUpdateStatus.set('')
                // A transfer, sync apply or reply may have started while the file was coming: leave it for the next check.
                const after = await busyReason()
                if (after) { retry = true; stopped(after); break }
                // A character or module import: the import session guards it (a module's switch step takes the busy state itself).
                if (item.kind === 'character' || item.kind === 'module') { await recordDecision(item, await applyItem(item, bytes)); continue }
                // 0.9.92-ver7 (tablet "setItem Error"): a persona/preset import owns the busy state while it writes, like the manual persona
                // import (playTransfer): a NAS sync apply never arms under it (its foreign-busy check), and one already armed is not entered.
                if (transferUnavailable()) { retry = true; stopped(await unavailableReason()); break }
                transferBusy.set(true); transferStatus.set(`${kindLabel(item.kind)}${consonantKind(item.kind) ? '을' : '를'} 가져오는 중…`)
                let decision: ContentDecision
                try { decision = await applyItem(item, bytes) } finally { transferBusy.set(false); transferStatus.set('') }
                await recordDecision(item, decision)
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error)
                // 0.9.96-ver5: a dropped NAS connection (the server resumes it while bytes keep coming) says how to get it again; the
                // reason also stays in the panel (the error dialog closes).
                const dropped = /socket hang up|aborted|ECONNRESET|ETIMEDOUT|멈췄어요|연결하지 못했어요/i.test(message)
                const retryHint = dropped ? 'NAS와의 연결이 끊겼어요. 집 Wi-Fi에 연결된 상태에서 설정 > 전송의 「캐릭터·페르소나 배포」에서 「지금 물어보기」를 누르면 다시 받아요(처음부터 다시 받아요).' : ''
                const failed = `「${itemLabel(item)}」를 가져오지 못했어요: ${message}${retryHint ? ` ${retryHint}` : ''} 다음 확인 때 다시 물어볼게요.`
                contentUpdateStatus.set(failed); alert.notifyInfo(failed)
                alert.alertError(`「${itemLabel(item)}」를 가져오지 못했어요. 다음에 다시 물어볼게요.\n${message}` + (retryHint ? `\n\n${retryHint}` : ''))
                break
            }
        }
        return { overview, retry }
    } catch (error) {
        // No NAS, offline or an old server: stay quiet and try again later (0.9.96-ver5: a settings button shows why).
        console.warn('[ContentUpdates] check skipped:', error instanceof Error ? error.message : String(error))
        skip(`배포 목록을 읽지 못했어요: ${error instanceof Error ? error.message : String(error)}`)
        return { overview: null, retry: false }
    } finally {
        running = false
    }
}

/** Node/embedded runtime only (the NAS lives behind the app server). Checks a little after start and when the app comes back. */
export function startContentUpdates(available: boolean = isNodeServer) {
    if (started || !available) return
    started = true
    const until = Date.now() + START_DELAY + START_WINDOW
    const startCheck = async () => {
        if ((await runCheck(true)).retry && Date.now() < until) setTimeout(() => { void startCheck() }, START_RETRY)
    }
    setTimeout(() => { void startCheck() }, START_DELAY)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void checkContentUpdates()
    })
    // A newer app code patch the server downloaded from the NAS: "지금 적용/나중에" (appCodeUpdate.ts).
    void import('./appCodeUpdate').then(m => m.startAppCodeUpdates()).catch(error => console.warn('[AppCodeUpdate] did not start:', String(error?.message ?? error)))
}

// ── Publishing (settings) ──

export async function publishContent(input: { key: string; kind: ContentKind; title: string; version: string; fileName: string; bytes: Uint8Array }): Promise<ContentItem> {
    const meta = encodeURIComponent(JSON.stringify({ key: input.key, kind: input.kind, title: input.title, version: input.version, fileName: input.fileName }))
    await freshRoute()
    const response = await contentRequest('/content-updates/publish', {
        method: 'POST',
        // Not application/octet-stream: the server streams this body to a file instead of buffering it.
        headers: { 'content-type': 'application/x-risubard-content', 'x-content-meta': meta },
        body: input.bytes as BodyInit,
    })
    return response.json()
}
