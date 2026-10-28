import { forageStorage, setPatchSyncBaseline } from '../globalApi.svelte'
import { getDatabase, isChatStub } from './database.svelte'
import { ensureChatHydrated, saveChatToServer } from './chatStorage'
import { decodeRisuSave, findDangerousChatOps, RisuSavePatcher } from './risuSave'

/** One owned save before the normal save runtime starts; never starts autosave or changes the recovery gate. */
export async function writePartialSyncResume(input: { transaction: string; characters: string[]; chats: [string, string][] }, validateBaseline: (database: any) => Promise<void>): Promise<void> {
    let persisted = false
    try {
        const owned = () => {
            if (forageStorage.realStorage.syncTransaction !== input.transaction) throw new Error('Sync recovery ownership changed')
        }
        owned()
        const readBaseline = async () => {
            const { value } = await forageStorage.getItemWithEtag('database/database.bin')
            owned()
            if (!value) throw new Error('Sync recovery database is unavailable')
            const database = await decodeRisuSave(value)
            await validateBaseline(database)
            owned()
            return database
        }
        let baseline = await readBaseline()
        for (const [characterId, chatId] of input.chats) {
            const character = getDatabase().characters.find(c => c.chaId === characterId)
            const index = character?.chats.findIndex(c => c.id === chatId) ?? -1
            if (!character || index < 0 || isChatStub(character.chats[index])) throw new Error('Sync recovery chat body is unavailable')
            const chat = await ensureChatHydrated(character.chats, index, characterId)
            owned()
            if (!chat || chat._placeholder || isChatStub(chat)) throw new Error('Sync recovery chat body is unavailable')
            persisted = true
            await saveChatToServer(characterId, index, chatId, chat)
            owned()
        }
        // Re-read after chat saves and on every retry: a lost patch/flush response must not leave a stale expectedHash.
        if (input.chats.length) baseline = await readBaseline()
        const patcher = new RisuSavePatcher()
        await patcher.init(baseline)
        const patch = await patcher.set(getDatabase(), {
            character: [...new Set(input.characters)], chat: input.chats,
            root: true, botPreset: true, modules: true, plugins: true, pluginCustomStorage: true,
        }, { trackedCharactersOnly: true })
        if (findDangerousChatOps(patch.patch).length) throw new Error('Sync recovery patch contains chat body operations')
        owned()
        if (patch.patch.length) {
            persisted = true
            const result = await forageStorage.patchItem('database/database.bin', patch)
            owned()
            if (!result.success || result.chatGuardRejected || result.canonicalFilesChanged || result.externalEditMode || result.externalChangesPending) throw new Error('Sync recovery save was not accepted')
            if (result.etag) forageStorage.setDbEtag(result.etag)
        }
        persisted = true // Flush may persist an earlier accepted write even when this patch is empty.
        await forageStorage.flushDatabase(false, true)
        owned()
        setPatchSyncBaseline(patcher.snapshot())
    } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { persisted })
    }
}
