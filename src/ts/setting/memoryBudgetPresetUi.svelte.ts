import { detectMemoryBudgetPreset } from '../risubard/memoryBudgetPreset'
import { resolveRisuBardChatSettings } from '../risubard/risuBardSettings'
import { normalizeRisuBardWikiSettingsView } from '../risubard/wikiScalePreset'
import type { SettingContext } from './types'

/**
 * Page-session UI state of the global memory budget preset. Choosing 커스텀 keeps the six individual entries
 * visible without changing any value, so the flag is shared by the preset control and the entries' conditions.
 */
export const memoryBudgetPresetUi = $state({ customOpen: false })

/** Detailed BardWiki entries appear only in the advanced settings view. */
export function showAdvancedWikiSettings({ db }: SettingContext): boolean {
    return normalizeRisuBardWikiSettingsView(db.risuBardWikiSettingsView) === 'advanced'
}

/** The six individual entries are visible for 커스텀 (chosen explicitly or derived from non-tier values) in the advanced view. */
export function showMemoryBudgetFields(ctx: SettingContext): boolean {
    return showAdvancedWikiSettings(ctx) && (memoryBudgetPresetUi.customOpen
        || detectMemoryBudgetPreset(resolveRisuBardChatSettings(ctx.db)) === 'custom')
}
