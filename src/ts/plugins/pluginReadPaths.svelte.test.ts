import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync('src/ts/plugins/plugins.svelte.ts', 'utf8')
const snapshot = (value: any) => $state.snapshot(value)
// The whole getItem body: upstream 0.9.100+ reads the one key in two statements, the fork one-liner in one.
const compileRead = (name: string) => {
    const head = `${name}: (key: string) => {`
    const start = source.indexOf(head)
    const end = source.indexOf('\n            },', start)
    if (start < 0 || end < 0) throw new Error(`Missing ${name} implementation`)
    return new Function('getDatabase', 'get', 'selectedCharID', '$state', 'key', source.slice(start + head.length, end))
}
// `?? null` (upstream 0.9.96+ and the fork adapters) keeps a stored '', 0 or false; the 0.9.71 base body used `|| null`.
const nullOnly = source.includes('pluginCustomStorage ?? {})[key]) ?? null') || source.includes('$state.snapshot(value)')
// The one-liner defaults a missing storage object to {} and so still reads inherited keys; the upstream body reads null.
const defaultsStorage = source.includes('pluginCustomStorage ?? {})[key]')

describe('narrow plugin snapshots', () => {
    it.each(['normal', 'empty', 'zero', 'false', 'missing', 'object', 'toString', '__proto__'])('snapshots just storage key %s with old falsy/prototype behavior', (key) => {
        const read = compileRead('getItem')
        const pluginCustomStorage = $state({ normal: 'hello', empty: '', zero: 0, false: false, object: { data: [1] } } as any)
        const db = { pluginCustomStorage }
        Object.defineProperty(db, 'unrelated', { get() { throw new Error('whole DB read') }, enumerable: true })
        const result = read(() => db, () => 0, {}, { snapshot }, key)
        const expected = nullOnly ? snapshot(db.pluginCustomStorage)[key] ?? null : snapshot(db.pluginCustomStorage)[key] || null
        expect(result).toEqual(expected)
        if (key === 'object') {
            result.data.push(2)
            expect(db.pluginCustomStorage.object.data).toEqual([1])
        }
        expect(read(() => ({}), () => 0, {}, { snapshot }, key)).toEqual(defaultsStorage ? ({} as any)[key] || null : null)
    })
})
