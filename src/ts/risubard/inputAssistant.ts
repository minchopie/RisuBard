import type { BardLoreInstructionPreset } from '../lorebook/bardLoreInstructionPreset'

export const INPUT_ASSISTANT_DEFAULT_PRESET_ID = 'risubard-input-assistant-default'
export const INPUT_ASSISTANT_MAX_MESSAGES = 100

export type InputAssistantModel = 'model' | 'otherAx'

export interface InputAssistantContextSelection {
    systemPrompt: boolean
    characterDescription: boolean
    persona: boolean
    characterLorebook: boolean
    moduleLorebook: boolean
}

export interface InputAssistantSettings {
    /** Experimental feature; the chat input shows the button only when enabled. */
    enabled: boolean
    model: InputAssistantModel
    /** Number of recent chat messages sent with each request; 0 sends none. */
    messageCount: number
    include: InputAssistantContextSelection
}

export const INPUT_ASSISTANT_CONTEXT_KEYS = [
    'systemPrompt',
    'characterDescription',
    'persona',
    'characterLorebook',
    'moduleLorebook',
] as const satisfies readonly (keyof InputAssistantContextSelection)[]

const DEFAULT_CONTENT = [
    "You are {{user}}'s input assistant in a roleplay chat with {{char}}.",
    "Write the next message {{user}} will send, based on the user's input.",
    '',
    'The user input mixes the in-story message with instructions addressed to you. Instructions usually appear in parentheses or brackets, such as "(leave the spell to you)" or "(add (ooc: ...) at the end)".',
    '- Keep every action, line of dialogue, and detail the user wrote. Fill in content only where the user asks you to.',
    '- Follow each instruction, then remove the instruction itself from the message.',
    '- When the user asks you to add a passage such as an (ooc: ...) note, copy that passage exactly, character for character, at the requested place.',
    '- If the user input is empty, write a fitting next message for {{user}} from the recent conversation.',
    "- Write only {{user}}'s turn. Do not write {{char}}'s dialogue or reactions, and do not continue the story past {{user}}'s turn, except inside a passage the user told you to add.",
    '- Match the language, point of view, tense, and formatting of the user input and the recent conversation.',
    '- Use the reference context only to keep names, setting, and facts consistent.',
    '',
    'Output only the finished message. No preface, explanation, quotation marks, tags, or code fences.',
].join('\n')

export function createDefaultInputAssistantPreset(): BardLoreInstructionPreset {
    return {
        schemaVersion: 1,
        id: INPUT_ASSISTANT_DEFAULT_PRESET_ID,
        name: 'RisuBard Default',
        revision: 1,
        builtin: true,
        content: DEFAULT_CONTENT,
    }
}

export function createDefaultInputAssistantSettings(): InputAssistantSettings {
    return {
        enabled: false,
        model: 'otherAx',
        messageCount: 10,
        include: {
            systemPrompt: true,
            characterDescription: true,
            persona: true,
            characterLorebook: true,
            moduleLorebook: false,
        },
    }
}

export function normalizeInputAssistantSettings(value: unknown): InputAssistantSettings {
    const defaults = createDefaultInputAssistantSettings()
    if (!value || typeof value !== 'object') return defaults
    const source = value as Partial<InputAssistantSettings>
    const count = Number(source.messageCount)
    const include = { ...defaults.include }
    for (const key of INPUT_ASSISTANT_CONTEXT_KEYS) {
        if (typeof source.include?.[key] === 'boolean') include[key] = source.include[key]
    }
    return {
        enabled: source.enabled === true,
        model: source.model === 'model' ? 'model' : 'otherAx',
        messageCount: Number.isFinite(count)
            ? Math.min(INPUT_ASSISTANT_MAX_MESSAGES, Math.max(0, Math.trunc(count)))
            : defaults.messageCount,
        include,
    }
}

function normalizeCustomPreset(value: unknown): BardLoreInstructionPreset | undefined {
    if (!value || typeof value !== 'object') return undefined
    const preset = value as Partial<BardLoreInstructionPreset>
    if (
        preset.id === INPUT_ASSISTANT_DEFAULT_PRESET_ID
        || typeof preset.id !== 'string'
        || !preset.id.trim()
        || typeof preset.name !== 'string'
        || !preset.name.trim()
        || typeof preset.content !== 'string'
    ) return undefined
    return {
        schemaVersion: 1,
        id: preset.id,
        name: preset.name.trim(),
        revision: Number.isInteger(preset.revision) && (preset.revision ?? 0) > 0 ? preset.revision! : 1,
        builtin: false,
        content: preset.content,
    }
}

/** The built-in preset always comes first and always carries the current default text. */
export function normalizeInputAssistantPresetState(value: {
    presets?: unknown
    activePresetId?: string
}): { presets: BardLoreInstructionPreset[]; activePresetId: string } {
    const builtin = createDefaultInputAssistantPreset()
    const seen = new Set([builtin.id])
    const custom = (Array.isArray(value.presets) ? value.presets : [])
        .map(normalizeCustomPreset)
        .filter((preset): preset is BardLoreInstructionPreset => {
            if (!preset || seen.has(preset.id)) return false
            seen.add(preset.id)
            return true
        })
    const presets = [builtin, ...custom]
    const activePresetId = presets.some((preset) => preset.id === value.activePresetId)
        ? value.activePresetId!
        : builtin.id
    return { presets, activePresetId }
}

export function resolveInputAssistantPreset(
    presets: BardLoreInstructionPreset[] | undefined,
    activePresetId: string | undefined,
): BardLoreInstructionPreset {
    if (activePresetId && activePresetId !== INPUT_ASSISTANT_DEFAULT_PRESET_ID) {
        const custom = presets?.find((preset) => preset.id === activePresetId && !preset.builtin)
        if (custom) return custom
    }
    return presets?.find((preset) => preset.id === INPUT_ASSISTANT_DEFAULT_PRESET_ID)
        ?? createDefaultInputAssistantPreset()
}

const CONTEXT_TITLES: Record<keyof InputAssistantContextSelection, [name: string, title: string]> = {
    systemPrompt: ['system_prompt', 'System prompt'],
    characterDescription: ['character_description', 'Character description'],
    persona: ['persona', "{{user}}'s persona"],
    characterLorebook: ['character_lorebook', 'Character lorebook'],
    moduleLorebook: ['module_lorebook', 'Module lorebook'],
}

function escapeClosers(value: string): string {
    return value.replace(/<\/(context|conversation|user_input)>/gi, '<\\/$1>')
}

export interface InputAssistantChatLine {
    speaker: string
    text: string
}

export function buildInputAssistantMessages(input: {
    instruction: string
    userName: string
    contexts: Partial<Record<keyof InputAssistantContextSelection, string>>
    conversation: InputAssistantChatLine[]
    userInput: string
}): Array<{ role: 'system' | 'user'; content: string }> {
    if (!input.instruction.trim()) throw new Error('input-assistant-instruction-required')
    const contexts = INPUT_ASSISTANT_CONTEXT_KEYS
        .filter((key) => input.contexts[key]?.trim())
        .map((key) => {
            const [name, title] = CONTEXT_TITLES[key]
            return `<context name="${name}" title="${title.replaceAll('{{user}}', input.userName)}">\n${escapeClosers(input.contexts[key]!.trim())}\n</context>`
        })
    const conversation = input.conversation
        .filter((line) => line.text.trim())
        .map((line) => `${line.speaker}: ${line.text.trim()}`)
        .join('\n\n')
    const user = [
        contexts.length ? `# Reference context\n${contexts.join('\n\n')}` : '',
        conversation ? `# Recent conversation\n<conversation>\n${escapeClosers(conversation)}\n</conversation>` : '',
        `# User input (message and instructions for ${input.userName})\n<user_input>\n${escapeClosers(input.userInput.trim())}\n</user_input>`,
    ].filter(Boolean).join('\n\n')
    return [
        { role: 'system', content: input.instruction.trim() },
        { role: 'user', content: user },
    ]
}

/** Removes wrappers a model sometimes adds around the finished message. */
export function cleanInputAssistantResult(value: string): string {
    let text = value.trim()
    const fence = /^```[^\n]*\n([\s\S]*?)\n```$/.exec(text)
    if (fence) text = fence[1].trim()
    const tag = /^<(message|user_input)>\s*([\s\S]*?)\s*<\/\1>$/i.exec(text)
    if (tag) text = tag[2].trim()
    return text
}
