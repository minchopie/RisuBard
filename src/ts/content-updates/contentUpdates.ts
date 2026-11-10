// Content updates (client): asks "a new character/persona/prompt preset was published on the NAS — import it?" and imports it with
// the app's own import. A character goes through upstream importCharacterProcess, which offers to update the installed
// bot (upstream "update an installed bot" dialog, chats kept, a backup copy in the trash). A persona with the same name
// is updated in place (same id, so chats bound to it keep it); otherwise it is added.
import { get, writable } from 'svelte/store'
import { unzipSync, strFromU8 } from 'fflate'
import type { RisuPersona } from '../storage/database.svelte'
// Same module paths as the settings screen (TransferPanel), so they are one instance there and in its tests.
import { transferBusy, transferRequest } from '../playTransfer'
import { isNodeServer } from '../platform'
// The app's database, import and dialog modules are loaded when first needed, so the settings panel (and its tests)
// does not pull the whole app into the transfer screen.
const app = () => Promise.all([
    import('../storage/database.svelte'), import('../globalApi.svelte'), import('../characterCards'), import('../storage/importTransaction'),
    import('../process/files/inlays'), import('../alert'), import('../stores.svelte'), import('../process/generationState'), import('uuid'),
    import('../importSession'),
]).then(([database, globalApi, cards, importTransaction, inlays, alert, stores, generation, uuid, session]) => ({ database, globalApi, cards, importTransaction, inlays, alert, stores, generation, uuid, session }))

export type ContentKind = 'character' | 'persona' | 'preset'
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

const post = async <T>(path: string, body: unknown): Promise<T> =>
    (await transferRequest('/content-updates' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()

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

export const fetchOverview = async () => { await freshRoute(); return post<ContentOverview>('/overview', {}) }
export const recordDecision = (item: Pick<ContentItem, 'key' | 'sha256'>, decision: ContentDecisionInput) => post('/decide', { key: item.key, sha256: item.sha256, decision })

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
    return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('')
}

export async function fetchContent(item: ContentItem): Promise<Uint8Array> {
    await freshRoute()
    const response = await transferRequest('/content-updates/fetch', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: item.key, sha256: item.sha256 }),
    })
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length !== item.bytes || await sha256Hex(bytes) !== item.sha256) throw new Error('받은 파일이 배포본과 달라요. 다시 시도해 주세요.')
    return bytes
}

export const kindLabel = (kind: ContentKind) => kind === 'character' ? '캐릭터 카드' : kind === 'preset' ? '프롬프트 프리셋' : '페르소나'
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

export interface Described { kind: ContentKind; title: string; version: string }

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

/** What a picked file is: a character card (.charx/.json/.png with a card), a persona PNG or a prompt preset (.risup/.risupreset/.preset.json). */
export async function describeFile(name: string, bytes: Uint8Array): Promise<Described> {
    const lower = name.toLowerCase()
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
    throw new Error('charx, json, png, risup 파일만 올릴 수 있어요.')
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

/** Imports one published item; resolves to the decision to record (declined when the user cancelled the import). */
export async function applyItem(item: ContentItem, bytes: Uint8Array): Promise<ContentDecision> {
    const { cards, globalApi, importTransaction, alert, session } = await app()
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

/** `ignoreAlert`: the caller's own dialog is the open one (app code update apply). */
export async function busy(ignoreAlert = false): Promise<boolean> {
    const { stores, generation, session } = await app()
    // An import in progress or waiting in rollback recovery has its own dialog: finish that first.
    return !get(stores.loadedStore) || get(transferBusy) || get(generation.isAnyGenerating) || (!ignoreAlert && get(stores.alertStore).type !== 'none')
        || get(session.importSession).phase !== 'idle'
}

/** A NAS sync cycle is running (startup/foreground sync, possibly preparing an apply): a question waits for it to end. */
async function syncCycleRunning(): Promise<boolean> {
    try { return !!get((await import('../nasSyncCoordinator')).coordinatorState)?.running } catch { return false }
}

/** Asks about each published item this device has not answered yet. `force` ignores the interval (the settings button). */
export async function checkContentUpdates(force = false): Promise<ContentOverview | null> {
    return (await runCheck(force)).overview
}
/** `retry`: this call stopped because the app was (or became) busy before every item was answered — the start check tries again. */
async function runCheck(force: boolean): Promise<{ overview: ContentOverview | null; retry: boolean }> {
    if (running) return { overview: null, retry: true }
    if (!force && Date.now() - lastCheck < CHECK_INTERVAL) return { overview: null, retry: false }
    running = true
    if (await busy() || await syncCycleRunning()) { running = false; return { overview: null, retry: true } }
    let retry = false
    lastCheck = Date.now()
    try {
        const { alert } = await app()
        const overview = await fetchOverview()
        for (const item of overview.pending) {
            if (await busy()) { retry = true; break }
            const choice = await alert.alertConfirmMulti(
                `새 ${kindLabel(item.kind)}가 올라왔어요. 지금 가져올까요?`,
                ['네, 가져오기', '아니오'],
                `${itemLabel(item)}\n${(item.bytes / 1_000_000).toFixed(1)} MB · ${new Date(item.publishedAt).toLocaleString()}${item.publishedBy ? ` · ${item.publishedBy}` : ''}`
                + (item.kind === 'character' ? '\n\n이미 있는 같은 캐릭터를 고르면 대화는 그대로 두고 카드만 새 판으로 바꿔요.'
                    : item.kind === 'preset' ? '\n\n같은 이름의 프롬프트 프리셋이 있으면 그 프리셋을 새 내용으로 바꿔요(이 기기의 API 키·주소는 그대로). 이름이 다르면 새로 추가해요.'
                    : '\n\n같은 이름의 페르소나가 있으면 그 페르소나를 새 내용으로 바꿔요.'),
            )
            // -1 is the dialog's own cancel/close: no answer yet, so it is asked again at the next check.
            if (choice === -1) break
            if (choice !== 0) { await recordDecision(item, 'declined'); continue }
            try {
                contentUpdateStatus.set(`${itemLabel(item)} 받는 중…`)
                const bytes = await fetchContent(item)
                contentUpdateStatus.set('')
                // A transfer, sync apply or reply may have started while the file was coming: leave it for the next check.
                if (await busy()) { retry = true; break }
                await recordDecision(item, await applyItem(item, bytes))
            } catch (error) {
                contentUpdateStatus.set('')
                alert.alertError(`「${itemLabel(item)}」를 가져오지 못했어요. 다음에 다시 물어볼게요.\n${error instanceof Error ? error.message : String(error)}`)
                break
            }
        }
        return { overview, retry }
    } catch (error) {
        // No NAS, offline or an old server: stay quiet and try again later.
        console.warn('[ContentUpdates] check skipped:', error instanceof Error ? error.message : String(error))
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
    const response = await transferRequest('/content-updates/publish', {
        method: 'POST',
        // Not application/octet-stream: the server streams this body to a file instead of buffering it.
        headers: { 'content-type': 'application/x-risubard-content', 'x-content-meta': meta },
        body: input.bytes as BodyInit,
    })
    return response.json()
}
