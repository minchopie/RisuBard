// RisuBard 0.9.91-ver3 (transfer-sync): device marks on chat names.
// - A chat made with the chat list's + button is named after this device: `(pc) Chat 3`, `(tablet) Chat 3`, `(phone) Chat 3`.
// - A chat that still has a default name (`New Chat N`, `Chat N`) shows the device that first recorded it in NAS sync, and a sibling
//   copy that NAS sync made when one chat went two ways shows the device that continued that copy. These two marks are display only:
//   the stored names never change, so they produce no sync revision and no new conflict.
import { writable, type Readable } from 'svelte/store'
import { detectDeviceKind, type SyncDeviceKind } from './nasSyncUi'

export interface ChatDeviceLabels { origin: Record<string, SyncDeviceKind>; branch: Record<string, SyncDeviceKind> }
const KINDS: readonly string[] = ['pc', 'tablet', 'phone']
const MARK = /^\((?:pc|tablet|phone)\) /
const DEFAULT_NAME = /^(?:New Chat|Chat) \d+$/
const empty = (): ChatDeviceLabels => ({ origin: {}, branch: {} })
const store = writable<ChatDeviceLabels>(empty())
export const chatDeviceLabels: Readable<ChatDeviceLabels> = { subscribe: store.subscribe }

export function thisDeviceKind(): SyncDeviceKind {
    try { return detectDeviceKind(navigator.userAgent, window.screen) } catch { return 'pc' }
}
/** Name for a chat made on this device, e.g. `(pc) Chat 3` for the third chat (the caller still makes it unique). */
export function newChatName(existing: number, kind: SyncDeviceKind = thisDeviceKind()): string {
    return `(${kind}) Chat ${existing + 1}`
}
/** What the chat list shows. Only the list text changes; `chat.name` is never written here. */
export function chatDisplayName(chat: { id?: string; name?: string } | null | undefined, labels: ChatDeviceLabels): string {
    const name = chat?.name ?? ''
    const id = chat?.id
    if (typeof id !== 'string' || !id) return name
    const branch = labels.branch[id]
    if (branch) return `(${branch}) ${name.replace(MARK, '')}`
    const origin = labels.origin[id]
    if (origin && DEFAULT_NAME.test(name)) return `(${origin}) ${name}`
    return name
}
const pick = (value: unknown): Record<string, SyncDeviceKind> => {
    const out: Record<string, SyncDeviceKind> = {}
    if (value && typeof value === 'object') for (const [id, kind] of Object.entries(value)) if (typeof kind === 'string' && KINDS.includes(kind)) out[id] = kind as SyncDeviceKind
    return out
}
export function parseChatDeviceLabels(data: any): ChatDeviceLabels { return { origin: pick(data?.origin), branch: pick(data?.branch) } }

let running: Promise<void> | null = null, again = false
/** Reads the marks from the NAS sync service. Sync off or unreachable: no marks (names show as stored). */
export function refreshChatDeviceLabels(): Promise<void> {
    if (running) { again = true; return running }
    running = (async () => {
        try {
            do {
                again = false
                const sync = await import('./nasSync')
                const read = async () => (await sync.syncRequest('/chat-labels')).json()
                let data = await read()
                // The service has never been told what this device is (the sync panel normally does that when it opens): tell it once,
                // the same display-only profile the panel reports, so this device's own chats get a mark too.
                if (data && data.self == null) { await sync.reportSyncProfile({ kind: thisDeviceKind() }); data = await read() }
                store.set(parseChatDeviceLabels(data))
            } while (again)
        } catch { store.set(empty()) }
        finally { running = null }
    })()
    return running
}
