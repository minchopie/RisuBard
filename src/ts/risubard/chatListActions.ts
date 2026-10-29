import { get } from 'svelte/store'
import type { Chat, character } from '../storage/database.svelte'
import { ensureChatHydrated } from '../storage/chatStorage'
import { alertClear, alertConfirm, alertError, alertWait, notifyError, notifySuccess } from '../alert'
import { language } from '../../lang'
import { changeChatTo, downloadFile, requestImmediateSave } from '../globalApi.svelte'
import { DBState, ReloadGUIPointer, selectedCharID } from '../stores.svelte'
import { preservePainterChatGallery } from '../bardPainter/gallery'

const isSelectedCharacter = (target: character) =>
    DBState.db.characters[get(selectedCharID)]?.chaId === target.chaId

// Returns false when the chat must not be deleted yet; the reason is already shown.
async function preparePainterChatForDeletion(targetCharacter: character, targetChatId: string): Promise<boolean> {
    try {
        const { isPainterChatBusy } = await import('../bardPainter/runtime.svelte')
        const index = targetCharacter.chats.findIndex(chat => chat.id === targetChatId)
        if(index < 0) return false
        const chat = await ensureChatHydrated(targetCharacter.chats, index, targetCharacter.chaId)
        if (!chat || chat._placeholder || chat.id !== targetChatId) throw new Error('챗 데이터를 불러오지 못했습니다.')
        if (isPainterChatBusy(targetCharacter.chaId, targetChatId) || chat.bardPainter?.results?.some(result => result.compressionPending)) {
            notifyError('바드페인터 작업이나 이미지 저장을 마친 뒤 챗을 삭제해 주세요.')
            return false
        }
        await preservePainterChatGallery(chat)
        if (isPainterChatBusy(targetCharacter.chaId, targetChatId)) {
            notifyError('바드페인터 작업이나 이미지 저장을 마친 뒤 챗을 삭제해 주세요.')
            return false
        }
        return true
    } catch (error) {
        notifyError(`그림의 생성 기록을 보존하지 못해 챗 삭제를 중단했습니다: ${String(error)}`)
        return false
    }
}

// The server looks chats up by index until the deletion is saved, so load the next chat first.
async function hydrateBeforeRemoval(targetCharacter: character, nextChat: Chat): Promise<Chat | null> {
    if (!nextChat._placeholder) return nextChat
    const hydrated = await ensureChatHydrated(targetCharacter.chats, targetCharacter.chats.indexOf(nextChat), targetCharacter.chaId).catch(() => null)
    if (!hydrated || hydrated._placeholder) {
        notifyError('챗 데이터를 불러오지 못해 삭제를 중단했습니다.')
        return null
    }
    return hydrated
}

/**
 * Deletes chats after one confirmation, keeping painter galleries and the next
 * active chat safe. Every chat list must delete through here. Returns the ids
 * that were actually removed.
 */
export async function deleteCharacterChats(targetCharacter: character, chatIds: string[]): Promise<string[]> {
    const targetIds = targetCharacter.chats.map(chat => chat.id).filter((id): id is string => !!id && chatIds.includes(id))
    if (targetIds.length === 0) return []
    if (targetIds.length >= targetCharacter.chats.length) {
        notifyError(language.errors.onlyOneChat)
        return []
    }
    const names = targetCharacter.chats.filter(chat => targetIds.includes(chat.id)).map(chat => chat.name)
    const message = names.length === 1
        ? `${language.removeConfirm}${names[0]}`
        : `${language.removeConfirm}챗 ${names.length}개 (${names.slice(0, 10).join(', ')}${names.length > 10 ? ` 외 ${names.length - 10}개` : ''})`
    if (!await alertConfirm(message)) return []
    const deletableIds: string[] = []
    for (const id of targetIds) {
        if (await preparePainterChatForDeletion(targetCharacter, id)) deletableIds.push(id)
    }
    if (deletableIds.length === 0) return []
    const activeChatId = targetCharacter.chats[targetCharacter.chatPage]?.id
    const remaining = targetCharacter.chats.filter(chat => !deletableIds.includes(chat.id))
    if (remaining.length === 0) { notifyError(language.errors.onlyOneChat); return [] }
    const nextChat = remaining.find(chat => chat.id === activeChatId) ?? remaining[0]
    const hydrated = await hydrateBeforeRemoval(targetCharacter, nextChat)
    if (!hydrated) return []
    remaining[remaining.indexOf(nextChat)] = hydrated
    targetCharacter.chats = remaining
    const nextPage = Math.max(0, remaining.findIndex(chat => chat.id === activeChatId))
    if (isSelectedCharacter(targetCharacter)) changeChatTo(nextPage)
    else targetCharacter.chatPage = nextPage
    ReloadGUIPointer.update(value => value + 1)
    void requestImmediateSave()
    if (deletableIds.length < targetIds.length) {
        notifyError(`선택한 챗 중 ${targetIds.length - deletableIds.length}개는 삭제하지 못했습니다.`)
    }
    return deletableIds
}

/** Exports the given chats with their folders in the all-chats format that import already reads. */
export async function exportCharacterChats(targetCharacter: character, chatIds: string[]): Promise<void> {
    try {
        const indexes = targetCharacter.chats.flatMap((chat, index) => chat.id && chatIds.includes(chat.id) ? [index] : [])
        for (const [step, index] of indexes.entries()) {
            if (!targetCharacter.chats[index]?._placeholder) continue
            alertWait(`챗 데이터를 불러오는 중... (${step + 1}/${indexes.length})`)
            await ensureChatHydrated(targetCharacter.chats, index, targetCharacter.chaId)
            if (targetCharacter.chats[index]?._placeholder) {
                alertError(`"${targetCharacter.chats[index].name}" 챗을 불러오지 못해 내보내기를 중단했습니다.`)
                return
            }
        }
        alertClear()
        const chats = indexes.map(index => targetCharacter.chats[index])
        const usedFolders = new Set(chats.map(chat => chat.folderId).filter(Boolean))
        const date = new Date().toISOString().replace(/[:.]/g, '-')
        const data = new TextEncoder().encode(JSON.stringify({
            type: 'risuAllChats',
            ver: 2,
            sourceCharacterId: targetCharacter.chaId,
            data: chats,
            folders: (targetCharacter.chatFolders ?? []).filter(folder => usedFolders.has(folder.id)),
        }))
        await downloadFile(`${targetCharacter.name}_chats_${chats.length}_${date}`.replace(/[<>:"/\\|?*.,]/g, '') + '.json', data)
        notifySuccess(language.successExport)
    } catch (error) {
        alertError(error)
    }
}
