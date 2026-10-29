import { describe, expect, test } from 'vitest'
import { installApprovedPlugins } from './pluginDbProxy'

describe('installApprovedPlugins', () => {
    const p = (name: string, script = `//@name ${name}`) => ({ name, script })
    const approveAll = async <T>(plugins: T[]) => plugins
    const holder = <T>(initial: T[]) => {
        const state = { plugins: initial }
        return { state, list: { get: () => state.plugins, set: (plugins: T[]) => { state.plugins = plugins } } }
    }

    test('a round-trip of the installed list keeps every plugin', async () => {
        const installed = [p('a'), p('b')]
        const { state, list } = holder(installed)
        // handlePluginInstallViaPlugin skips plugins that are already installed.
        await installApprovedPlugins(installed, async () => [], list)
        expect(state.plugins).toEqual(installed)
    })

    test('approved plugins are appended, or replace an installed one of the same name in place', async () => {
        const installed = [p('a'), p('b'), p('c')]
        const { state, list } = holder(installed)
        await installApprovedPlugins([p('b', 'new code'), p('d')], approveAll, list)
        expect(state.plugins).toEqual([p('a'), p('b', 'new code'), p('c'), p('d')])
        expect(installed).toEqual([p('a'), p('b'), p('c')])
    })

    test('overlapping installs both survive, whether answered one by one or by the same click', async () => {
        for (const sameTick of [false, true]) {
            const { state, list } = holder([p('base')])
            const answers: Array<() => void> = []
            const approveLater = <T>(plugins: T[]) => new Promise<T[]>((resolve) => answers.push(() => resolve(plugins)))

            const first = installApprovedPlugins([p('B')], approveLater, list)
            const second = installApprovedPlugins([p('C')], approveLater, list)
            if (sameTick) {
                answers[0]()
                answers[1]()
            } else {
                answers[0]()
                await first
                answers[1]()
            }
            await Promise.all([first, second])

            expect(state.plugins.map((plugin) => plugin.name)).toEqual(['base', 'B', 'C'])
        }
    })
})
