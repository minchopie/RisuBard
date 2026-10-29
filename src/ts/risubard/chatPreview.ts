import type { Chat, character } from '../storage/database.svelte'
import type { ChatPreviewPayload } from '../storage/chatContentPage'
import { fetchChatPreviewFromServer } from '../storage/chatStorage'

// Unloaded chats only change from another device, so a short cache is enough
// while the pointer moves across the list.
const CACHE_MS = 30_000
const cache = new Map<string, { at: number, preview: ChatPreviewPayload | null }>()

function localPreview(chat: Chat): ChatPreviewPayload {
    const last = chat.message?.[chat.message.length - 1]
    return {
        id: chat.id ?? null,
        bindedPersona: chat.bindedPersona ?? '',
        lastMessage: last ? { role: last.role, data: last.data, saying: last.saying, name: last.name, time: last.time } : null,
    }
}

/** Loaded chats read local data; unloaded ones ask the server for the last message only. */
export async function loadChatPreview(target: character, chat: Chat, index: number): Promise<ChatPreviewPayload | null> {
    if (!chat._placeholder) return localPreview(chat)
    if (!chat.id) return null
    const key = `${target.chaId}\0${chat.id}`
    const cached = cache.get(key)
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.preview
    const preview = await fetchChatPreviewFromServer(target.chaId, index, chat.id)
    cache.set(key, { at: Date.now(), preview })
    return preview
}
