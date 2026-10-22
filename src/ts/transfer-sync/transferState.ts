import { writable } from 'svelte/store'
export const transferBusy = writable(false)
/** True while `transferBusy` is held by the NAS sync apply (armed stage or startup recovery): the busy overlay then offers a pause. */
export const syncBusyOwned = writable(false)
export const transferStatus = writable('')
/** While set, ordinary autosave is held: only the NAS sync apply's own saves (syncOwned) may persist. Cleared on a verified
 *  finish, a proven rollback or an explicit recovery hold; an unresolved outcome keeps it so no autosave can overwrite evidence. */
export const syncSaveHold = writable(false)
/** Set to Date.now() by the save runtime after an ordinary (not sync-owned) save persisted: the NAS sync coordinator's trigger. */
export const canonicalSaveSettled = writable(0)
