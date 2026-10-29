import type { Message } from '../storage/database.svelte'

interface LuaChatEntry {
    role?: unknown
    data?: unknown
}

/**
 * Applies a Lua setFullChat() result. Lua only sees role and data, so a
 * rebuilt message keeps everything else of the message it replaces (chatId,
 * time, saying, generationInfo, BardWiki confirmation). Without this every
 * setFullChat erased message identity and BardWiki skipped those turns.
 *
 * Same length: messages pair by position, so edited text keeps its identity.
 * Otherwise only an unchanged role and text pairs, each source used once.
 */
export function mergeLuaFullChat(
    previous: readonly Message[],
    incoming: readonly LuaChatEntry[]
): Message[] {
    const entries = incoming.map((entry) => ({
        role: (entry?.role === 'user' ? 'user' : 'char') as Message['role'],
        data: typeof entry?.data === 'string' ? entry.data : String(entry?.data ?? ''),
    }))
    if (entries.length === previous.length) {
        return entries.map((entry, index) => previous[index]?.role === entry.role
            ? { ...previous[index], ...entry }
            : entry)
    }
    const used = new Set<number>()
    return entries.map((entry) => {
        const index = previous.findIndex((message, candidate) =>
            !used.has(candidate)
            && message.role === entry.role
            && message.data === entry.data)
        if (index < 0) return entry
        used.add(index)
        return { ...previous[index], ...entry }
    })
}
