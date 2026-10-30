// The old import paths (src/ts/<name>) are re-export shims over src/ts/transfer-sync/<name>: both paths must yield the SAME module
// instance, otherwise stores (transferBusy, syncSaveHold) and the coordinator singleton would split between host and module code.
import { test, expect, vi } from 'vitest'
vi.mock('./globalApi.svelte', () => ({ forageStorage: { Init: async () => {}, realStorage: {} }, requestImmediateSave: vi.fn(), checkCharOrder: vi.fn(), pendingTrackedChanges: () => null }))
vi.mock('./storage/database.svelte', () => ({ getDatabase: () => ({ characters: [] }), getCurrentCharacter: () => null, newChatModelDefaults: () => ({}), normalizeChat: (c: any) => c, setDatabase: vi.fn() }))
vi.mock('./storage/chatStorage', () => ({ ensureChatHydrated: async (chats: any[], i: number) => chats[i] }))
vi.mock('./process/generationState', () => ({ doingChat: { subscribe: (fn: any) => { fn(false); return () => {} } }, isAnyGenerating: { subscribe: (fn: any) => { fn(false); return () => {} } } }))
vi.mock('./importSession', () => ({ importSession: { subscribe: (fn: any) => { fn({ phase: 'idle' }); return () => {} } } }))
vi.mock('./stores.svelte', () => ({ loadedStore: { subscribe: (fn: any) => { fn(true); return () => {} } }, alertStore: { subscribe: (fn: any) => { fn({ type: 'none' }); return () => {} } } }))
vi.mock('./alert', () => ({ alertSelect: vi.fn(), alertConfirm: vi.fn(), alertError: vi.fn(), alertNormal: vi.fn() }))
vi.mock('./risubard/memorySaveSlots', () => ({ applyMemorySavePromptSettings: vi.fn() }))
vi.mock('./platform', () => ({ isNodeServer: true, isTauri: false, isMobile: false }))
vi.mock('./transfer-sync/transferNative', () => ({ playNative: vi.fn(), playSetAvailable: () => false, androidTransferAvailable: () => false, sendNative: vi.fn(), nativeSend: vi.fn(), initializeNativeTransfers: vi.fn() }))
import * as oldState from './transferState'
import * as newState from './transfer-sync/transferState'
import * as oldCoordinator from './nasSyncCoordinator'
import * as newCoordinator from './transfer-sync/nasSyncCoordinator'
import * as oldSync from './nasSync'
import * as newSync from './transfer-sync/nasSync'
import * as oldTransfer from './playTransfer'
import * as newTransfer from './transfer-sync/playTransfer'
import * as oldUi from './nasSyncUi'
import * as newUi from './transfer-sync/nasSyncUi'
import * as oldNas from './transferNas'
import * as newNas from './transfer-sync/transferNas'
import * as oldAssets from './transferAssets'
import * as newAssets from './transfer-sync/transferAssets'
import { get } from 'svelte/store'

test('old and new import paths share one module instance: stores, coordinator singleton and every export are identical', () => {
    expect(oldState.transferBusy).toBe(newState.transferBusy); expect(oldState.syncSaveHold).toBe(newState.syncSaveHold); expect(oldState.transferStatus).toBe(newState.transferStatus)
    oldState.transferBusy.set(true); expect(get(newState.transferBusy)).toBe(true); newState.transferBusy.set(false); expect(get(oldState.transferBusy)).toBe(false)
    expect(oldCoordinator.syncCoordinator).toBe(newCoordinator.syncCoordinator); expect(oldCoordinator.coordinatorState).toBe(newCoordinator.coordinatorState)
    for (const [a, b] of [[oldSync, newSync], [oldTransfer, newTransfer], [oldUi, newUi], [oldNas, newNas], [oldAssets, newAssets], [oldCoordinator, newCoordinator], [oldState, newState]] as const) {
        expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort())
        for (const key of Object.keys(b)) expect((a as any)[key]).toBe((b as any)[key])
    }
})
