import { v4 } from 'uuid'
import type { Chat, character } from '../storage/database.svelte'

/** Shared stable IDs indicate copied history, not permission to delete it. */
export function countSharedMergeMessages(chats: readonly Chat[]): number {
    const seen = new Set<string>()
    let count = 0
    for (const chat of chats) {
        const ids = new Set(chat.message.map(message => message.chatId).filter(Boolean))
        for (const id of ids) {
            if (seen.has(id)) count++
            seen.add(id)
        }
    }
    return count
}

export function buildMergedChat(
    sources: readonly Chat[], name: string, createId: () => string = v4,
): Chat {
    if (sources.length < 2 || !name.trim()) throw new Error('챗을 두 개 이상 선택하고 이름을 입력해 주세요.')
    if (sources.some(chat => !chat.id || chat._placeholder || !Array.isArray(chat.message))
        || new Set(sources.map(chat => chat.id)).size !== sources.length) {
        throw new Error('선택한 챗을 모두 불러오지 못했거나 같은 챗이 중복되었습니다.')
    }
    if (sources.some(chat => chat.isStreaming || chat.risuBardWikiReboot)) {
        throw new Error('응답 생성이나 위키 리부트가 진행 중인 챗은 병합할 수 없습니다. 작업을 완료하거나 취소해 주세요.')
    }
    // Callers snapshot Svelte proxies first. Keep settings, never derived memory.
    const copies = structuredClone(sources) as Chat[]
    const merged = copies.at(-1)!
    merged.id = createId()
    merged.name = name.trim()
    merged.fmIndex = sources[0].fmIndex ?? -1
    merged.firstMessageDisabled = sources[0].firstMessageDisabled === true
        || sources[0].message.some(message => message.disabled === 'allBefore')
    delete merged.folderId
    delete merged.hypaV3Data
    delete merged.sdData
    delete merged.suggestMessages
    delete merged.risuBardWikiReboot
    delete merged.isStreaming
    delete merged.activeStreamingDisplayOptimizationMode
    delete merged._placeholder

    const messages: Chat['message'] = []
    const bookmarks: string[] = []
    const bookmarkNames: Record<string, string> = {}
    for (const source of copies) {
        const sourceBookmarks = new Set(source.bookmarks ?? [])
        const disabledThrough = source.message.findLastIndex(message => message.disabled === 'allBefore')
        for (const [index, message] of source.message.entries()) {
            // A session-local cutoff must not exclude earlier merged sessions.
            if (index <= disabledThrough) message.disabled = true
            const oldId = message.chatId
            message.chatId = createId()
            delete message.risubardMemoryConfirmed
            delete message.risubardCanonicalReceipt
            delete message.risubardWikiPending
            if (oldId && sourceBookmarks.has(oldId)) {
                bookmarks.push(message.chatId)
                if (source.bookmarkNames?.[oldId]) bookmarkNames[message.chatId] = source.bookmarkNames[oldId]
            }
            messages.push(message)
        }
    }
    merged.message = messages
    merged.bookmarks = bookmarks
    merged.bookmarkNames = bookmarkNames
    return merged
}

/** Keep the active chat unchanged until the new chat is durably saved. */
export async function mergeCharacterChats(
    character: Pick<character, 'chats' | 'chatPage'>,
    orderedIds: readonly string[], name: string,
    deps: {
        hydrate(id: string): Promise<Chat | null>
        snapshot(chat: Chat): Chat
        save(): Promise<unknown>
        createId?: () => string
    },
): Promise<Chat> {
    const sources: Chat[] = []
    for (const id of orderedIds) {
        if (!character.chats.some(chat => chat.id === id)) throw new Error('선택한 챗이 더 이상 존재하지 않습니다.')
        const chat = await deps.hydrate(id)
        if (!chat || chat.id !== id) throw new Error('챗 데이터를 불러오지 못했습니다. 다시 시도해 주세요.')
        sources.push(chat)
    }
    if (orderedIds.some(id => !character.chats.some(chat => chat.id === id))) {
        throw new Error('선택한 챗이 변경되었습니다. 다시 선택해 주세요.')
    }
    const merged = buildMergedChat(sources.map(chat => deps.snapshot(chat)), name, deps.createId)
    character.chats = [...character.chats, merged]
    try { await deps.save() }
    catch (cause) {
        character.chats = character.chats.filter(chat => chat.id !== merged.id)
        // Persist rollback too: a failed save may have partially written the list.
        try { await deps.save() }
        catch (rollbackError) {
            throw new Error(`${String(cause)}; 병합 취소 저장 실패: ${String(rollbackError)}`)
        }
        throw cause
    }
    return merged
}
