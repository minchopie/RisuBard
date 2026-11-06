// Content updates (client): asks "a new character/persona was published on the NAS — import it?" and imports it with
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
]).then(([database, globalApi, cards, importTransaction, inlays, alert, stores, generation, uuid]) => ({ database, globalApi, cards, importTransaction, inlays, alert, stores, generation, uuid }))

export type ContentKind = 'character' | 'persona'
export interface ContentItem {
    key: string; kind: ContentKind; title: string; version: string; file: string; fileName: string
    sha256: string; bytes: number; publishedAt: string; publishedBy: string; decision: '' | 'applied' | 'declined' | 'published'
}
export interface ContentOverview { configured: boolean; items: ContentItem[]; pending: ContentItem[] }
export type ContentDecision = 'applied' | 'declined'
/** 'reset' forgets this device's answer so the item is asked about again. */
export type ContentDecisionInput = ContentDecision | 'reset'

const CHECK_INTERVAL = 10 * 60_000
const START_DELAY = 8_000
export const contentUpdateStatus = writable('')

const post = async <T>(path: string, body: unknown): Promise<T> =>
    (await transferRequest('/content-updates' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()

export const fetchOverview = () => post<ContentOverview>('/overview', {})
export const recordDecision = (item: Pick<ContentItem, 'key' | 'sha256'>, decision: ContentDecisionInput) => post('/decide', { key: item.key, sha256: item.sha256, decision })

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource))
    return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('')
}

export async function fetchContent(item: ContentItem): Promise<Uint8Array> {
    const response = await transferRequest('/content-updates/fetch', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: item.key, sha256: item.sha256 }),
    })
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length !== item.bytes || await sha256Hex(bytes) !== item.sha256) throw new Error('받은 파일이 배포본과 달라요. 다시 시도해 주세요.')
    return bytes
}

const kindLabel = (kind: ContentKind) => kind === 'character' ? '캐릭터 카드' : '페르소나'
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

/** What a picked file is: a character card (.charx/.json/.png with a card) or a persona PNG. */
export async function describeFile(name: string, bytes: Uint8Array): Promise<Described> {
    const lower = name.toLowerCase()
    if (lower.endsWith('.charx')) {
        const files = unzipSync(bytes, { filter: file => file.name === 'card.json' })
        if (!files['card.json']) throw new Error('card.json이 없는 charx예요.')
        const card = JSON.parse(strFromU8(files['card.json']))
        return fromCard(card)
    }
    if (lower.endsWith('.json')) return fromCard(JSON.parse(new TextDecoder().decode(bytes)))
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
    throw new Error('charx, json, png 파일만 올릴 수 있어요.')
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
    const same = db.personas.filter(persona => persona?.name === data.name)
    if (same.length) {
        // Same id, so chats and bots bound to this persona keep using it.
        for (const persona of same.slice(0, 1)) {
            persona.personaPrompt = data.personaPrompt
            persona.note = data.note
            persona.icon = icon
        }
    } else {
        const added: RisuPersona = { name: data.name, icon, personaPrompt: data.personaPrompt, note: data.note, id: uuid.v4() }
        db.personas.push(added)
    }
}

/** Imports one published item; resolves to the decision to record (declined when the user cancelled the import). */
export async function applyItem(item: ContentItem, bytes: Uint8Array): Promise<ContentDecision> {
    const { cards, globalApi, importTransaction, alert } = await app()
    if (item.kind === 'persona') {
        await applyPersona(bytes)
        alert.notifySuccess(`페르소나 「${item.title}」를 가져왔어요.`)
        return 'applied'
    }
    try {
        const result = await cards.importCharacterProcess({ name: item.fileName, data: bytes })
        globalApi.checkCharOrder()
        // runImport answers null when the user cancelled (in the update dialog or the install choice).
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

async function busy(): Promise<boolean> {
    const { stores, generation } = await app()
    return !get(stores.loadedStore) || get(transferBusy) || get(generation.isAnyGenerating) || get(stores.alertStore).type !== 'none'
}

/** Asks about each published item this device has not answered yet. `force` ignores the interval (the settings button). */
export async function checkContentUpdates(force = false): Promise<ContentOverview | null> {
    if (running) return null
    if (!force && Date.now() - lastCheck < CHECK_INTERVAL) return null
    running = true
    if (await busy()) { running = false; return null }
    lastCheck = Date.now()
    try {
        const { alert } = await app()
        const overview = await fetchOverview()
        for (const item of overview.pending) {
            if (await busy()) break
            const choice = await alert.alertConfirmMulti(
                `새 ${kindLabel(item.kind)}가 올라왔어요. 지금 가져올까요?`,
                ['네, 가져오기', '아니오'],
                `${itemLabel(item)}\n${(item.bytes / 1_000_000).toFixed(1)} MB · ${new Date(item.publishedAt).toLocaleString()}${item.publishedBy ? ` · ${item.publishedBy}` : ''}`
                + (item.kind === 'character' ? '\n\n이미 있는 같은 캐릭터를 고르면 대화는 그대로 두고 카드만 새 판으로 바꿔요.' : '\n\n같은 이름의 페르소나가 있으면 그 페르소나를 새 내용으로 바꿔요.'),
            )
            if (choice !== 0) { await recordDecision(item, 'declined'); continue }
            try {
                contentUpdateStatus.set(`${itemLabel(item)} 받는 중…`)
                const bytes = await fetchContent(item)
                contentUpdateStatus.set('')
                await recordDecision(item, await applyItem(item, bytes))
            } catch (error) {
                contentUpdateStatus.set('')
                alert.alertError(`「${itemLabel(item)}」를 가져오지 못했어요. 다음에 다시 물어볼게요.\n${error instanceof Error ? error.message : String(error)}`)
                break
            }
        }
        return overview
    } catch (error) {
        // No NAS, offline or an old server: stay quiet and try again later.
        console.warn('[ContentUpdates] check skipped:', error instanceof Error ? error.message : String(error))
        return null
    } finally {
        running = false
    }
}

/** Node/embedded runtime only (the NAS lives behind the app server). Checks a little after start and when the app comes back. */
export function startContentUpdates(available: boolean = isNodeServer) {
    if (started || !available) return
    started = true
    setTimeout(() => { void checkContentUpdates(true) }, START_DELAY)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') void checkContentUpdates()
    })
}

// ── Publishing (settings) ──

export async function publishContent(input: { key: string; kind: ContentKind; title: string; version: string; fileName: string; bytes: Uint8Array }): Promise<ContentItem> {
    const meta = encodeURIComponent(JSON.stringify({ key: input.key, kind: input.kind, title: input.title, version: input.version, fileName: input.fileName }))
    const response = await transferRequest('/content-updates/publish', {
        method: 'POST',
        // Not application/octet-stream: the server streams this body to a file instead of buffering it.
        headers: { 'content-type': 'application/x-risubard-content', 'x-content-meta': meta },
        body: input.bytes as BodyInit,
    })
    return response.json()
}
