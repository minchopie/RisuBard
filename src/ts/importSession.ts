import { language } from 'src/lang'
import { get, writable } from 'svelte/store'
import { alertWait, notifySuccess } from './alert'
import { forageStorage, requestImmediateSave, saveAsset } from './globalApi.svelte'
import { getDatabase } from './storage/database.svelte'
import { alertStore } from './stores.svelte'
import { ImportCancelled, ImportTransaction, type ImportJournal, type ImportOwner } from './storage/importTransaction'
import { startImportProgress, stopImportProgress, beginImportSave, receiveImportProgress, loseImportProgress } from './importProgress'
import { transferBusy } from './transferState'

const JOURNAL_KEY = 'risubard-pending-import-v1'
const RESET_KEY = 'risubard-reset-import-v1'
export const importSession = writable<{ phase: 'idle' | 'installing' | 'rolling-back' | 'recovery', error?: string, dismissed?: boolean, resetting?: boolean }>({ phase: 'idle' })
let active: ImportTransaction | undefined
// Lets the cancel button stop waiting for a slow install flush.
let installFlush: AbortController | undefined
let reloadForReset = false

async function removeOwners(owners: ImportOwner[]) {
    if (!owners.length) return
    const db = getDatabase()
    const characters = new Set(owners.filter(o => o.type === 'character').map(o => o.id))
    const modules = new Set(owners.filter(o => o.type === 'module').map(o => o.id))
    db.characters = db.characters.filter(c => !characters.has(c.chaId))
    db.modules = db.modules.filter(m => !modules.has(m.id))
    db.characterOrder = (db.characterOrder ?? []).flatMap<(typeof db.characterOrder)[number]>(entry => typeof entry === 'string'
        ? characters.has(entry) ? [] : [entry]
        : [{ ...entry, data: entry.data.filter(id => !characters.has(id)) }])
    if (db.characterVault?.quickAccess) db.characterVault.quickAccess = db.characterVault.quickAccess
        .filter(s => s.kind !== 'character' || !characters.has(s.id))
    beginImportSave()
    await requestImmediateSave({ flushServer: 'canonical', rejectOnFailure: true })
}

function dependencies(retainAssets = false) {
    return {
        write: (entries: Parameters<ImportTransaction['write']>[0]) => forageStorage.setItems(entries),
        journal: (record: ImportJournal | null) => {
            if (reloadForReset) return
            if (record) localStorage.setItem(JOURNAL_KEY, JSON.stringify(record))
            else localStorage.removeItem(JOURNAL_KEY)
        },
        removeOwners,
        prepareRollback: (id: string) => forageStorage.prepareImportRollback(id),
        cleanup: (keys: string[], id: string) => retainAssets
            ? forageStorage.cleanupImportAssets(keys, id, true) : forageStorage.cleanupImportAssets(keys, id),
    }
}

export function checkImportRecovery() {
    if (reloadForReset || get(importSession).phase === 'rolling-back') return
    if (!active && localStorage.getItem(JOURNAL_KEY)) {
        importSession.update(state => ({ ...state, phase: 'recovery', dismissed: false }))
        if (localStorage.getItem(RESET_KEY)) void retryImportRollback()
    }
}

// Reload aborts client work before replaying the durable installation journal.
// Never discard that journal merely to hide a failed rollback.
export function requestImportReset() {
    if (get(importSession).phase === 'idle') return
    const record = JSON.parse(localStorage.getItem(JOURNAL_KEY) ?? 'null') as ImportJournal | null
    if (record) localStorage.setItem(RESET_KEY, record.id)
    reloadForReset = true
    active?.cancel()
    location.reload()
}

export function dismissImportRecovery() {
    if (get(importSession).phase !== 'recovery') return
    // Dismiss only the prompt. The journal still blocks imports and survives reloads.
    const alert = get(alertStore)
    if (alert.type === 'wait' || alert.type === 'wait2' || alert.type === 'progress') {
        alertStore.set({ type: 'none', msg: '' })
    }
    importSession.update(state => ({ ...state, dismissed: true }))
}

export function cancelImport() {
    active?.cancel()
    installFlush?.abort(new ImportCancelled())
    importSession.set({ phase: 'rolling-back' })
    alertWait(language.importInstall.rollbackMessage)
}

export async function retryImportRollback() {
    if (get(importSession).phase !== 'recovery') return
    let resetting = false
    importSession.set({ phase: 'rolling-back' })
    startImportProgress()
    let stopWatching: (() => void) | undefined
    try {
        const record = JSON.parse(localStorage.getItem(JOURNAL_KEY) ?? 'null') as ImportJournal | null
        if (!record) throw new Error(language.importInstall.missingRecord)
        resetting = localStorage.getItem(RESET_KEY) === record.id
        importSession.set({ phase: 'rolling-back', resetting })
        if (!resetting) {
            stopWatching = await forageStorage.observeImportProgress(record.id, receiveImportProgress, loseImportProgress)
            beginImportSave()
        }
        await new ImportTransaction(new Set(), dependencies(resetting), record).rollback()
        if (reloadForReset) return
        localStorage.removeItem(RESET_KEY)
        active = undefined
        importSession.set({ phase: 'idle' })
        notifySuccess(resetting ? language.importInstall.resetComplete : language.importInstall.cancelled)
    } catch (error) {
        if (!reloadForReset) importSession.set({ phase: 'recovery', resetting, error: String(error) })
    } finally {
        stopWatching?.()
        stopImportProgress()
    }
}

export async function runImport<T>(work: (transaction: ImportTransaction) => Promise<T>): Promise<T | null> {
    if (active || localStorage.getItem(JOURNAL_KEY) || get(transferBusy)) {
        checkImportRecovery()
        throw new Error(language.importInstall.busy)
    }
    importSession.set({ phase: 'installing' })
    startImportProgress()
    alertWait(language.importInstall.preparing)
    // Claim the session before any async operation so two file imports cannot overlap.
    active = new ImportTransaction(new Set(), dependencies())
    let transaction = active
    let stopWatching: (() => void) | undefined
    try {
        const existing = await forageStorage.keys('assets/')
        transaction.check()
        active = transaction = new ImportTransaction(new Set(existing), dependencies())
        stopWatching = await forageStorage.observeImportProgress(transaction.id, receiveImportProgress, loseImportProgress)
        const result = await work(transaction)
        transaction.check()
        // Wait for all canonical data to reach the server before forgetting recovery.
        beginImportSave()
        alertWait(language.importInstall.saving)
        // A slow server must not roll back an accepted install. Wait without
        // the write timeout; the cancel button aborts the wait instead.
        installFlush = new AbortController()
        await requestImmediateSave({ flushServer: 'canonical', rejectOnFailure: true, flushSignal: installFlush.signal })
        transaction.commit()
        active = undefined
        importSession.set({ phase: 'idle' })
        notifySuccess(language.importInstall.complete)
        return result
    } catch (error) {
        if (reloadForReset) return null
        const wasCancelled = transaction.cancelled || error instanceof ImportCancelled
        importSession.set({ phase: 'rolling-back' })
        beginImportSave()
        alertWait(language.importInstall.rollbackMessage)
        try {
            await transaction.rollback()
            active = undefined
            importSession.set({ phase: 'idle' })
        } catch (rollbackError) {
            // Keep the write-ahead record. The retry button survives a page reload.
            active = undefined
            importSession.set({ phase: 'recovery', error: String(rollbackError) })
            return null
        }
        if (wasCancelled) {
            notifySuccess(language.importInstall.cancelled)
            return null
        }
        throw error
    } finally {
        installFlush = undefined
        stopWatching?.()
        stopImportProgress()
    }
}

export function importAsset(transaction?: ImportTransaction) {
    return (data: Uint8Array, customId = '', fileName = '') => saveAsset(data, customId, fileName, transaction)
}
