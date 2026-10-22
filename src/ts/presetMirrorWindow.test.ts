// The REAL root $effect of the save runtime (globalApi.svelte.ts), run against stubs: while a NAS sync apply holds saves, the
// active-preset mirrors must not rewrite the planned entries (the server verifies saved bytes against the plan); once the hold is
// released ordinary behaviour returns (mirrors run, a mirrored bot preset is tracked, the autosave is scheduled).
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { expect, test, vi } from 'vitest'
import { get, writable } from 'svelte/store'

const source = readFileSync(resolve(process.cwd(), 'src/ts/globalApi.svelte.ts'), 'utf8')
const start = source.indexOf('        $effect(() => {\n            for (const key in DBState.db)')
const end = source.indexOf('        $effect(() => {\n            DBState.db.botPresetsId', start)
expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start)
const effect = ts.transpile(source.slice(start, end).replace('$effect(() => {', 'rootEffect = (() => {').replace(/\}\)\s*$/, '})'), { target: ts.ScriptTarget.ES2022 })

function harness(hold: boolean, botMirrorResult = true) {
    const syncSaveHold = writable(hold)
    const bot = vi.fn(() => botMirrorResult), theme = vi.fn(() => false), schedule = vi.fn()
    const changeTracker = { root: false, botPreset: false }
    const run = new Function('DBState', 'deepTouch', 'get', 'syncSaveHold', 'syncActiveBotPresetFromMirror', 'syncActiveThemePresetFromMirror', 'changeTracker', 'saveTimeoutExecute', `
        let didInitRootEffect = true, rootEffect;
        ${effect}
        rootEffect();
    `)
    run({ db: { aiModel: 'x', themePresets: [{ name: 't' }] } }, () => {}, get, syncSaveHold, bot, theme, changeTracker, schedule)
    return { bot, theme, schedule, changeTracker }
}

test('inside the sync apply window (hold on) the mirrors are skipped while root changes are still tracked and the save is still scheduled', () => {
    const h = harness(true)
    expect(h.bot).not.toHaveBeenCalled(); expect(h.theme).not.toHaveBeenCalled()
    expect(h.changeTracker.root).toBe(true); expect(h.changeTracker.botPreset).toBe(false); expect(h.schedule).toHaveBeenCalledTimes(1)
})

test('with the hold released the original behaviour is unchanged: both mirrors run, a rewritten bot preset is tracked, the save is scheduled', () => {
    const h = harness(false)
    expect(h.bot).toHaveBeenCalledTimes(1); expect(h.theme).toHaveBeenCalledTimes(1)
    expect(h.changeTracker.root).toBe(true); expect(h.changeTracker.botPreset).toBe(true); expect(h.schedule).toHaveBeenCalledTimes(1)
    const untouched = harness(false, false)
    expect(untouched.changeTracker.botPreset).toBe(false)
})
