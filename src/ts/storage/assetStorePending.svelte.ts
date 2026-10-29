import { isNodeServer } from '../platform'

// How many assets still wait for the asset store transition. The sidebar home
// button uses it to draw attention; the transition panel keeps it current.
export const assetStorePending = $state({ convertible: 0 })

export function setAssetStoreConvertible(convertible: number) {
    assetStorePending.convertible = Number.isFinite(convertible) && convertible > 0 ? convertible : 0
}

let loading: Promise<void> | null = null

export function refreshAssetStorePending(): Promise<void> {
    if (!isNodeServer) return Promise.resolve()
    loading ??= (async () => {
        // Imported lazily: globalApi pulls in most of the app.
        const { forageStorage } = await import('../globalApi.svelte')
        await forageStorage.Init()
        const storage = forageStorage.realStorage as unknown as {
            assetStoreTransition?: (action: 'status') => Promise<{ convertible: number }>
        }
        if (!storage.assetStoreTransition) return
        setAssetStoreConvertible((await storage.assetStoreTransition('status')).convertible)
    })().catch(() => {}).finally(() => { loading = null })
    return loading
}
