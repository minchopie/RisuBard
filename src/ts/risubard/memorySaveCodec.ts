import { Packr, Unpackr } from 'msgpackr/index-no-eval'
import type { Chat } from '../storage/database.svelte'

const chatPacker = new Packr({ useRecords: false })
const chatUnpacker = new Unpackr({ int64AsType: 'number', useRecords: false })

export function encodeMemorySaveChat(chat: Chat): Uint8Array {
    return chatPacker.pack(chat)
}

export function decodeMemorySaveChat(bytes: Uint8Array): unknown {
    return chatUnpacker.unpack(bytes)
}
