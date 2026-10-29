import type { Chat, Database, character } from '../storage/database.svelte'
import { composePromptBlockOverlay, getEffectivePromptToggleTemplate } from '../promptBlockOverlay'
import { resolvePersonaById } from '../personaScopes'
import type { RisuModule } from '../process/modules'

/**
 * Modules active for this chat, resolved like chat requests (process/modules getModules):
 * global, the chat persona's enabled modules, chat, character, integration and the
 * persona's embedded module. Kept here so BardPainter does not load the module manager.
 */
export function painterActiveModules(db: Database, character: character, chat: Chat): RisuModule[] {
    const persona = resolvePersonaById(db, character, chat.bindedPersona)?.persona ?? db.personas?.[db.selectedPersona ?? 0]
    const ids = new Set([...(db.enabledModules ?? []), ...(persona?.id ? db.personaEnabledModules?.[persona.id] ?? [] : []),
        ...(chat.modules ?? []), ...(character.modules ?? []),
        ...(db.moduleIntergration ?? '').split(',').map(id => id.trim()).filter(Boolean)])
    const modules = (db.modules ?? []).filter(module => module && (ids.has(module.id) || !!module.namespace && ids.has(module.namespace)))
    const embedded = persona?.embeddedModule
    return embedded && !modules.some(module => module.id === embedded.id) ? [...modules, embedded] : modules
}

export function painterPromptPreset(db: Database, chat: Chat) {
    return db.botPresets?.find(preset => preset.id === chat.bindedBotPreset)
        ?? db.botPresets?.[db.botPresetsId]
}

export function painterPromptDatabase(db: Database, chat: Chat): Database {
    const preset = painterPromptPreset(db, chat)
    const source = preset && preset !== db.botPresets?.[db.botPresetsId] ? preset : db
    return { ...db, mainPrompt: source.mainPrompt,
        promptTemplate: composePromptBlockOverlay(source.promptTemplate, db.promptBlockOverlayProfiles ?? [], source.promptBlockOverlay),
        customPromptTemplateToggle: getEffectivePromptToggleTemplate(source.customPromptTemplateToggle ?? '', db.promptBlockOverlayProfiles ?? [], source.promptBlockOverlay) }
}

/** Complete request-local toggle scope: omitted values never inherit active chat toggles. */
export async function painterImageToggleScope(db: Database, character: character, chat: Chat, values: Record<string, string>) {
    const { createPromptV2PreviewValues, parsePromptV2ToggleTree } = await import('../promptV2')
    const globals = { ...db.globalChatVariables, ...(!db.disableToggleBinding && chat.useLocallySetGlobalVariables ? chat.GLGlobalVariables : {}) }
    for (const key of Object.keys(globals)) if (key.startsWith('toggle_')) globals[key] = '0'
    // Persona-enabled and embedded persona modules count, as they do for chat requests.
    const template = [db.customPromptTemplateToggle, character.customModuleToggle,
        ...painterActiveModules(db, character, chat).map(module => module.customModuleToggle)].filter(Boolean).join('\n')
    const defaults = createPromptV2PreviewValues(parsePromptV2ToggleTree(template).definitions)
    const toggles = Object.fromEntries(Object.entries(values).filter(([key, value]) => key.startsWith('toggle_') && typeof value === 'string'))
    return { ...globals, ...defaults, ...toggles }
}
