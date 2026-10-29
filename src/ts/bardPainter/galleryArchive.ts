import { zipSync } from 'fflate'
import { getInlayAssetBlob } from '../process/files/inlays'
import type { character, Chat } from '../storage/database.svelte'
import { loadPainterGalleryRecord } from './gallery'

const INLAY = /{{(?:inlay|inlayed|inlayeddata)::(.+?)}}/g

/**
 * Image ids a bot still shows: its chats (every swipe), greetings, description and lorebooks.
 * Unloaded chats are read from the server without loading them into the app; a chat that
 * cannot be read throws, so an image is never reported unused by mistake.
 */
export async function usedInlayIds(bot: character, fetchChat?: (chaId: string, index: number, chatId: string) => Promise<Chat | null>): Promise<Set<string>> {
    const ids = new Set<string>()
    const add = (text: unknown) => { if (typeof text === 'string') for (const match of text.matchAll(INLAY)) ids.add(match[1]) }
    add(bot.firstMessage); add(bot.desc)
    for (const greeting of bot.alternateGreetings ?? []) add(greeting)
    for (const entry of bot.globalLore ?? []) add(entry.content)
    for (let index = 0; index < bot.chats.length; index++) {
        let chat: Chat | null = bot.chats[index]
        if (chat._placeholder) {
            fetchChat ??= (await import('../storage/chatStorage')).fetchChatFromServer
            chat = await fetchChat(bot.chaId, index, chat.id)
        }
        if (!chat || !Array.isArray(chat.message)) throw new Error(`「${bot.chats[index].name || '이름 없는 챗'}」을 읽지 못해 본문 사용 여부를 확인할 수 없습니다.`)
        for (const message of chat.message) { add(message.data); for (const swipe of message.swipes ?? []) add(swipe) }
        for (const entry of chat.localLore ?? []) add(entry.content)
    }
    return ids
}

export interface ArchiveFile { id: string; name: string; data: Uint8Array }

const safe = (value: string) => value.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'image'

/** The image bytes plus, when one exists, the painter generation record as JSON beside it. */
export async function readArchiveFiles(items: Array<{ id: string; label: string }>): Promise<{ files: ArchiveFile[]; ids: string[]; failed: string[] }> {
    const files: ArchiveFile[] = [], ids: string[] = [], failed: string[] = [], names = new Set<string>()
    for (const item of items) {
        try {
            const asset = await getInlayAssetBlob(item.id)
            if (!asset) { failed.push(item.id); continue }
            let base = `${safe(item.label)}_${item.id.slice(0, 8)}`
            for (let index = 2; names.has(base); index++) base = `${safe(item.label)}_${item.id.slice(0, 8)}_${index}`
            names.add(base)
            files.push({ id: item.id, name: `${base}.${asset.ext || 'png'}`, data: new Uint8Array(await asset.data.arrayBuffer()) })
            const record = await loadPainterGalleryRecord(item.id).catch(() => null)
            if (record) files.push({ id: item.id, name: `${base}.json`, data: new TextEncoder().encode(JSON.stringify(record, null, 2)) })
            ids.push(item.id)
        } catch { failed.push(item.id) }
    }
    return { files, ids, failed }
}

/** Images are already compressed, so the zip only stores them. */
export function zipArchiveFiles(files: ArchiveFile[]): Uint8Array {
    return zipSync(Object.fromEntries(files.map(file => [file.name, [file.data, { level: 0 }]])))
}

type DirectoryHandle = { getFileHandle(name: string, options: { create: boolean }): Promise<{ createWritable(): Promise<{ write(data: Uint8Array): Promise<void>; close(): Promise<void> }> }> }

/** Write files into a folder the user picked; returns the ids whose every file was written. */
export async function writeArchiveFolder(directory: DirectoryHandle, files: ArchiveFile[]): Promise<Set<string>> {
    const failed = new Set<string>()
    for (const file of files) {
        try {
            const handle = await directory.getFileHandle(file.name, { create: true })
            const stream = await handle.createWritable()
            await stream.write(file.data)
            await stream.close()
        } catch { failed.add(file.id) }
    }
    return new Set(files.map(file => file.id).filter(id => !failed.has(id)))
}
