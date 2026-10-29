import { language } from 'src/lang'
import { collectPersonaBuilderSources } from '../personaBuilder'
import { requestChatData } from '../process/request/request'
import { risuChatParser } from '../process/scripts'
import { getDatabase, type character, type Chat } from '../storage/database.svelte'
import { endStatus, startStatus } from '../status/requestStatus'
import { findCharacterbyId, getPersonaPrompt, getUserName } from '../util'
import { resolveRisuBardChatSettings } from './risuBardSettings'
import { v4 as uuidv4 } from 'uuid'
import {
    buildInputAssistantMessages,
    cleanInputAssistantResult,
    normalizeInputAssistantSettings,
    resolveInputAssistantPreset,
    type InputAssistantChatLine,
    type InputAssistantContextSelection,
} from './inputAssistant'

function recentConversation(character: character, chat: Chat, count: number, userName: string): InputAssistantChatLine[] {
    if (count <= 0) return []
    const disabledThrough = chat.message.findLastIndex((message) => message.disabled === 'allBefore')
    return chat.message.slice(disabledThrough + 1)
        .filter((message) => !message.disabled && !message.isComment)
        .slice(-count)
        .map((message) => ({
            speaker: message.role === 'user'
                ? userName
                : (message.saying ? findCharacterbyId(message.saying)?.name : undefined) ?? character.name,
            text: message.data,
        }))
}

function formatLore(entries: Array<{ title: string; content: string }>): string {
    return entries
        .filter((entry) => entry.content.trim())
        .map((entry) => `## ${entry.title}\n${entry.content.trim()}`)
        .join('\n\n')
}

/**
 * Lorebook entries the next turn would activate, split into character (incl. chat-local)
 * and module entries. Runs on a copy of the chat with the draft appended, so activation
 * flags written during matching never reach the real chat.
 */
async function matchLorebooks(character: character, chat: Chat, userInput: string) {
    const { loadLoreBookV3Prompt } = await import('../process/lorebook.svelte')
    const preview: Chat = {
        ...chat,
        message: [...chat.message, { role: 'user', data: userInput }],
        scriptstate: { ...chat.scriptstate },
    }
    const result = await loadLoreBookV3Prompt({ character, chat: preview })
    const characterEntries: Array<{ title: string; content: string }> = []
    const moduleEntries: Array<{ title: string; content: string }> = []
    for (const active of result.actives) {
        const entry = active.sourceIdentity.entry
        const item = { title: entry.comment?.trim() || entry.key?.trim() || 'Untitled', content: active.prompt }
        if (active.sourceIdentity.scopeId.startsWith('module:')) moduleEntries.push(item)
        else characterEntries.push(item)
    }
    return { characterLorebook: formatLore(characterEntries), moduleLorebook: formatLore(moduleEntries) }
}

/** Writes the next user message from the draft. Throws with a user-facing message on failure. */
export async function runInputAssistant(input: {
    character: character
    chat: Chat
    userInput: string
    signal?: AbortSignal
}): Promise<string> {
    const db = getDatabase()
    const settings = normalizeInputAssistantSettings(db.risuBardInputAssistantSettings)
    const preset = resolveInputAssistantPreset(
        db.risuBardInputAssistantPromptPresets,
        db.risuBardInputAssistantPromptPresetId,
    )
    const { character, chat } = input
    const userName = getUserName()
    const include = settings.include
    const contexts: Partial<Record<keyof InputAssistantContextSelection, string>> = {}
    if (include.systemPrompt || include.characterDescription) {
        const sources = collectPersonaBuilderSources({ database: db, character, moduleLorebooks: [] })
        if (include.systemPrompt) contexts.systemPrompt = sources.systemPrompt
        if (include.characterDescription) contexts.characterDescription = sources.characterDescription
    }
    if (include.persona) contexts.persona = getPersonaPrompt({ character, chat })
    if (include.characterLorebook || include.moduleLorebook) {
        const lore = await matchLorebooks(character, chat, input.userInput)
        if (include.characterLorebook) contexts.characterLorebook = lore.characterLorebook
        if (include.moduleLorebook) contexts.moduleLorebook = lore.moduleLorebook
    }
    const formated = buildInputAssistantMessages({
        instruction: risuChatParser(preset.content, { chara: character, chat }),
        userName,
        contexts: Object.fromEntries(Object.entries(contexts)
            .map(([key, value]) => [key, risuChatParser(value ?? '', { chara: character, chat })])),
        conversation: recentConversation(character, chat, settings.messageCount, userName),
        userInput: input.userInput,
    })
    // The floating request status card: ModelPreset and plugin requests report it
    // themselves under this id; classic providers do not, so the card is opened
    // here and closed below (endStatus keeps the first terminal write).
    if (input.signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    const statusId = `input-assistant-${uuidv4()}`
    const showStatus = resolveRisuBardChatSettings(db, chat.risuBardSettings, character.risuBardPinnedSettings).showRequestStatus
    if (showStatus) {
        const separate = db.seperateModelsForAxModels ? db.seperateModels?.otherAx : ''
        startStatus(statusId, {
            kind: settings.model === 'model' ? 'main' : 'sub',
            purpose: 'input-assistant',
            label: settings.model === 'model' ? db.aiModel : (separate || db.subModel),
            chatId: chat.id,
            phase: 'connecting',
            now: Date.now(),
        })
        // Close the card as soon as the user cancels; some providers only notice the signal late.
        input.signal?.addEventListener('abort', () => endStatus(statusId, 'aborted', { now: Date.now() }), { once: true })
    }
    let outcome: 'done' | 'failed' | 'aborted' = 'failed'
    let failure: string | undefined
    try {
        const response = await requestChatData({
            formated,
            bias: {},
            currentChar: character,
            chatId: statusId,
            realChatId: chat.id,
            useStreaming: false,
            noMultiGen: true,
            tools: [],
            disablePromptCache: true,
            logSource: 'other',
            logPurpose: 'input-assistant',
        }, settings.model, input.signal)
        if (input.signal?.aborted) {
            outcome = 'aborted'
            throw new DOMException('Aborted', 'AbortError')
        }
        if (response.type === 'fail') throw new Error(response.result || language.risuBardInputAssistant.emptyResult)
        if (response.type !== 'success') throw new Error(language.risuBardInputAssistant.unsupportedResponse)
        const text = cleanInputAssistantResult(response.result)
        if (!text) throw new Error(language.risuBardInputAssistant.emptyResult)
        outcome = 'done'
        return text
    }
    catch (error) {
        if (input.signal?.aborted) outcome = 'aborted'
        else failure = error instanceof Error ? error.message : String(error)
        throw error
    }
    finally {
        if (showStatus) endStatus(statusId, outcome, { now: Date.now(), error: failure })
    }
}
