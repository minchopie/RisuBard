import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

const source = readFileSync('src/ts/plugins/plugins.svelte.ts', 'utf8')
const snapshot = (value: any) => $state.snapshot(value)
const compileRead = (name: string) => {
    const start = source.indexOf(`${name}: (`)
    const returnAt = source.indexOf('return ', start)
    if (start < 0 || returnAt < 0) throw new Error(`Missing ${name} implementation`)
    const body = source.slice(returnAt, source.indexOf('\n', returnAt))
    return new Function('getDatabase', 'get', 'selectedCharID', '$state', 'key', body)
}

describe('narrow plugin snapshots', () => {
    it.each(['normal', 'empty', 'zero', 'false', 'missing', 'object', 'toString', '__proto__'])('snapshots just storage key %s with old falsy/prototype behavior', (key) => {
        const read = compileRead('getItem')
        const pluginCustomStorage = $state({ normal: 'hello', empty: '', zero: 0, false: false, object: { data: [1] } } as any)
        const db = { pluginCustomStorage }
        Object.defineProperty(db, 'unrelated', { get() { throw new Error('whole DB read') }, enumerable: true })
        const result = read(() => db, () => 0, {}, { snapshot }, key)
        const expected = source.includes('pluginCustomStorage ?? {})[key]) ?? null') ? snapshot(db.pluginCustomStorage)[key] ?? null : snapshot(db.pluginCustomStorage)[key] || null
        expect(result).toEqual(expected)
        if (key === 'object') {
            result.data.push(2)
            expect(db.pluginCustomStorage.object.data).toEqual([1])
        }
        expect(read(() => ({}), () => 0, {}, { snapshot }, key)).toEqual(({} as any)[key] || null)
    })
})
