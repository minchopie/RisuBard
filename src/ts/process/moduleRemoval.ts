import { DBState } from '../stores.svelte'
import { normalizePersonaEnabledModules } from '../storage/database.svelte'
import { normalizeCollectionOrganizerState } from '../collectionOrganizer'
import { requestImmediateSave } from '../globalApi.svelte'

// Shared by the module settings page and the chat sidebar module list.
export function removeModules(moduleIds: readonly string[]) {
    const db = DBState.db
    const moduleIdsToDelete = new Set(moduleIds)
    db.enabledModules = (db.enabledModules ?? []).filter((moduleId) => !moduleIdsToDelete.has(moduleId))
    db.modules = db.modules.filter((module) => !moduleIdsToDelete.has(module.id))
    if (db.collectionOrganizers) {
        db.collectionOrganizers = {
            ...db.collectionOrganizers,
            modules: normalizeCollectionOrganizerState(
                db.collectionOrganizers.modules,
                db.modules.map((module) => module.id),
            ),
        }
    }
    db.personaEnabledModules = normalizePersonaEnabledModules(
        db.personaEnabledModules,
        [
            ...db.personas,
            ...db.characters.flatMap((character) => character.personas ?? []),
        ],
        db.modules.map((module) => module.id),
    )
    void requestImmediateSave()
}
