// Plugin V3 permission decisions, bound to the plugin's code like upstream
// (69a560884, 016d423bb): a decision is stored under `<script hash>_<permission>`,
// so a plugin whose code changes — an update, or a different plugin installed
// under the same name — is asked again, while unchanged code is not.
//
// Kept from the previous RisuBard gate: decisions persist on the server,
// 'periodically' grants are reconfirmed after 3 days, denials of the other
// permissions are remembered, and dialogs are shown one at a time.

export type PluginPermission = 'fetchLogs' | 'db' | 'mainDom' | 'replacer' | 'provider' | 'sendChat' | 'inlay' | 'bardWikiWrite'

export const pluginPermissions: PluginPermission[] = ['fetchLogs', 'db', 'mainDom', 'replacer', 'provider', 'sendChat', 'inlay', 'bardWikiWrite']

const periodicReconfirmMs = 3 * 24 * 60 * 60 * 1000
const grantTimeSuffix = '_lastGrantTime'

type PluginScriptHasher = (data: Uint8Array) => Promise<string>

export function createPluginScriptHashGetter(script: string, hasher: PluginScriptHasher): () => Promise<string> {
    let scriptHash: Promise<string> | undefined

    return () => {
        scriptHash ??= hasher(new TextEncoder().encode(script))
        return scriptHash
    }
}

export function getPluginPermissionKey(scriptHash: string, permission: PluginPermission): string {
    return `${scriptHash}_${permission}`
}

export type PluginPermissionState = {
    // `<hash>_<permission>` → decision, `<hash>_<permission>_lastGrantTime` → ms.
    cache: [string, boolean | number][]
    // Written by older versions, when a decision was also kept per plugin name
    // and carried over to any code under that name. No longer read.
    given?: string[]
    denied?: string[]
}

export interface PluginPermissionGateDeps {
    read(): Promise<PluginPermissionState | null>
    write(state: PluginPermissionState): Promise<void>
    remove(): Promise<void>
    // Shows the consent dialog; resolves true when the user allows.
    confirm(pluginName: string, permission: PluginPermission): Promise<boolean>
    now?: () => number
}

export function createPluginPermissionGate(deps: PluginPermissionGateDeps) {
    const now = deps.now ?? Date.now
    const decisions = new Map<string, boolean>()
    const grantTimes = new Map<string, number>()
    let loaded: Promise<void> | null = null
    let writing: Promise<void> = Promise.resolve()
    // Serializes permission dialogs. Every plugin shares the single global
    // alertStore, so when several plugins request permission at boot they would
    // otherwise overwrite each other's dialog — only the last one stays clickable
    // and a single click resolves all of them. The chain makes each dialog wait
    // for the previous one to finish, showing them one at a time.
    let dialogChain: Promise<unknown> = Promise.resolve()

    const load = () => loaded ??= (async () => {
        const state = await deps.read()
        for (const [key, value] of state?.cache ?? []) {
            if (typeof value === 'boolean') {
                decisions.set(key, value)
            } else if (typeof value === 'number' && key.endsWith(grantTimeSuffix) && !key.startsWith('[')) {
                // Older versions keyed grant times by JSON-encoded plugin name
                // (`["name","db"]_lastGrantTime`); those are dropped on the next write.
                grantTimes.set(key.slice(0, -grantTimeSuffix.length), value)
            }
        }
    })()

    // Writes run in order and each sends the maps as they are when it runs, so
    // the last write always carries every decision.
    const persist = () => {
        writing = writing.catch(() => {}).then(() => deps.write({
            cache: [
                ...decisions,
                ...[...grantTimes].map(([key, time]): [string, number] => [key + grantTimeSuffix, time]),
            ],
        }))
        return writing
    }

    async function request(
        pluginName: string,
        scriptHash: string,
        permission: PluginPermission,
        reconfirm: boolean | 'periodically' = false,
    ): Promise<boolean> {
        // `requestPluginPermission` hands plugins this call with any string.
        if (!pluginPermissions.includes(permission)) return false
        await load()
        const key = getPluginPermissionKey(scriptHash, permission)

        // Recomputed (not captured) so a queued request sees a grant made while
        // it waited, including the refreshed time of a periodic grant.
        const known = () => {
            if (reconfirm === true) return undefined
            if (reconfirm === 'periodically') {
                const lastGrant = grantTimes.get(key)
                if (!lastGrant || now() - lastGrant > periodicReconfirmMs) return undefined
            }
            return decisions.get(key)
        }

        // Fast path: if the answer is already known, skip the serialization queue
        // entirely so cached/granted permissions never block on a pending dialog.
        const early = known()
        if (early !== undefined) return early

        const showDialog = async (): Promise<boolean> => {
            // Re-check under the lock: an earlier queued dialog for the same code
            // may have already answered while we were waiting our turn.
            const recheck = known()
            if (recheck !== undefined) return recheck
            const granted = await deps.confirm(pluginName, permission)
            decisions.set(key, granted)
            if (granted && reconfirm === 'periodically') grantTimes.set(key, now())
            await persist()
            return granted
        }

        // Append to the dialog chain so only one permission dialog is shown at a
        // time. The chain swallows rejections, so a single failure never
        // deadlocks every later permission request.
        const run = dialogChain.catch(() => {}).then(showDialog)
        dialogChain = run.catch(() => {})
        return run
    }

    // Clears every decision for one version of a plugin's code.
    async function resetScript(scriptHash: string) {
        await load()
        for (const permission of pluginPermissions) {
            const key = getPluginPermissionKey(scriptHash, permission)
            decisions.delete(key)
            grantTimes.delete(key)
        }
        await persist()
    }

    async function resetAll() {
        await load()
        decisions.clear()
        grantTimes.clear()
        writing = writing.catch(() => {}).then(() => deps.remove())
        await writing
    }

    return { request, resetScript, resetAll }
}
