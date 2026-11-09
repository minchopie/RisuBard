// fork lore-lua (0.9.92-ver3): what Lua getFullChat returns for one stored message.
// The host sends every chat message of a request with its id as `memo` (index.svelte.ts `memo: msg.chatId`); giving
// getFullChat the same id lets a card match the request's chat messages to the stored ones by id instead of by text.
// Fields are only added: role, data and time stay as before, and a message without an id gets no `id` key.
export interface LuaChatEntrySource {
    role: string
    data: string
    time?: number
    chatId?: string
}

export function luaChatEntry(message: LuaChatEntrySource): { role: string, data: string, time: number, id?: string } {
    const entry: { role: string, data: string, time: number, id?: string } = {
        role: message.role,
        data: message.data,
        time: message.time ?? 0,
    }
    if (typeof message.chatId === 'string' && message.chatId !== '') entry.id = message.chatId
    return entry
}
