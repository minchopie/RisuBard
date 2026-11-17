import { describe, expect, it } from 'vitest'
import { flushSync } from 'svelte'
import { applyPluginCharacterUpdate, samePluginData } from './pluginData'
import { deepTouch } from '../gui/deepTouch.svelte'
import { readFileSync } from 'node:fs'
import { transform } from 'sucrase'
import { decorateBardWikiCharacterForPlugin, stripBardWikiVirtualMemoryFromCharacter } from '../risubard/pluginBardWiki'

const readSource = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

// Execute the current production setters/effect without starting the app's save runtime.
function compileBody(file: string, start: string, end: string, args: string[]) {
    const source = readSource(file)
    const offset = source.indexOf(start)
    if (offset < 0) throw new Error(`Missing production fragment: ${start}`)
    const finish = source.indexOf(end, offset + start.length)
    if (finish < 0) throw new Error(`Missing end of production fragment: ${start}`)
    const body = source.slice(offset + start.length, finish)
    return new Function(...args, transform(body, { transforms: ['typescript'] }).code)
}


describe('plugin character updates', () => {
    const make = () => ({ chaId: 'c', chatPage: 0, name: 'before', chats: [{ id: 'chat', message: [{ role: 'user', data: 'hello' }] }] })

    it('retains identical chats without invalidating the actual active-chat effect dependencies', () => {
        const state = $state({ characters: [make()] })
        const touched: string[] = []
        const stop = $effect.root(() => {
            $effect(() => {
                const character = state.characters[0]
                const chat = character.chats[character.chatPage]
                deepTouch(chat)
                touched.push(`${character.chaId}|${chat.id}`)
            })
        })
        flushSync()
        const initial = state.characters[0]
        const chats = initial.chats
        const incoming = $state.snapshot(initial)
        incoming.name = 'after'
        state.characters[0] = applyPluginCharacterUpdate(initial, incoming)
        flushSync()
        expect(state.characters[0]).toBe(initial)
        expect(state.characters[0].chats).toBe(chats)
        expect(state.characters[0].name).toBe('after')
        expect(JSON.stringify($state.snapshot(state.characters[0]))).toBe(JSON.stringify(incoming))
        expect(touched).toHaveLength(1)
        state.characters[0].chats[0].message[0].data = 'edited in place'
        flushSync()
        expect(touched).toHaveLength(2)
        const changed = $state.snapshot(state.characters[0])
        changed.chats[0].message[0].data = 'edited by plugin'
        state.characters[0] = applyPluginCharacterUpdate(state.characters[0], changed)
        flushSync()
        expect(touched).toHaveLength(3)
        expect(JSON.stringify($state.snapshot(state.characters[0]))).toBe(JSON.stringify(changed))
        const identity = $state.snapshot(state.characters[0])
        identity.chaId = 'new-id'
        state.characters[0] = applyPluginCharacterUpdate(state.characters[0], identity)
        flushSync()
        expect(touched.at(-1)).toBe('new-id|chat')
        stop()
    })

    it.each([
        [{ a: 1, b: 2 }, { b: 2, a: 1 }],
        [{ a: undefined }, {}],
        [[, 1], [undefined, 1]],
        [[1], [1, 2]],
        [new Date(0), new Date(0)],
        [new Uint8Array([1]), new Uint8Array([1])],
        [Object.create(null), Object.create(null)],
        [{ get x() { return 1 } }, { x: 1 }],
        [{ x: -0 }, { x: 0 }],
    ])('declines ambiguous or different data %#', (a, b) => {
        expect(samePluginData(a, b)).toBe(false)
        const current = { chats: [a], name: 'old' }
        const next = { chats: [b], name: 'new' }
        expect(applyPluginCharacterUpdate(current, next)).toBe(next)
    })

    it('preserves deletion and key-order semantics by falling back to replacement', () => {
        const current = make()
        const removed = { chaId: current.chaId, chatPage: 0, chats: structuredClone(current.chats) }
        expect(applyPluginCharacterUpdate<any>(current, removed)).toBe(removed)
        const reordered = { name: 'after', chaId: current.chaId, chatPage: 0, chats: structuredClone(current.chats) }
        expect(applyPluginCharacterUpdate(current, reordered)).toBe(reordered)
        const cyclic: any = {}; cyclic.self = cyclic
        expect(samePluginData(cyclic, cyclic)).toBe(false)
    })
})


it('falls back before writing when comparison encounters frozen or throwing objects', () => {
    const incoming = { name: 'new', chats: [] }
    const frozen = Object.freeze({ name: 'old', chats: [] })
    expect(applyPluginCharacterUpdate(frozen, incoming)).toBe(incoming)
    const trapped = new Proxy({ name: 'old', chats: [] }, { ownKeys() { throw new Error('opaque') } })
    expect(applyPluginCharacterUpdate(trapped, incoming)).toBe(incoming)
    const current = { name: 'old', chats: [new Proxy({}, { getPrototypeOf() { throw new Error('opaque chat') } })] }
    const next = { name: 'new', chats: [{}] }
    expect(applyPluginCharacterUpdate(current, next) === next).toBe(true)
    expect(current.name).toBe('old')
})


describe('real plugin read/write roundtrip', () => {
    const dbFunction = (name: string, args: string[]) => {
        const source = readSource('src/ts/storage/database.svelte.ts')
        const begin = source.indexOf(`export function ${name}(`)
        const finish = source.indexOf('\n}', begin) + 2
        if (begin < 0 || finish < begin) throw new Error(`Missing database function: ${name}`)
        return new Function(...args, transform(source.slice(begin, finish).replace('export ', '') + `; return ${name}`, { transforms: ['typescript'] }).code)
    }
    const makeDbRead = dbFunction('getDatabase', ['DBState', '$state'])
    const makeIndexedRead = dbFunction('getCharacterByIndex', ['DBState', 'getDatabase', '$state'])
    const makeCurrentRead = dbFunction('getCurrentCharacter', ['getDatabase', 'getCharacterByIndex', 'get', 'selectedCharID'])
    const makeDbWrite = dbFunction('setDatabaseLite', ['DBState'])
    const oldRead = compileBody('src/ts/plugins/plugins.svelte.ts', 'getChar: () => {', '\n        },', ['getCurrentCharacter'])
    const makeDecorate = compileBody('src/ts/plugins/apiV3/v3.svelte.ts', 'const decoratePluginCharacter = (character: any) => {', '\n    }',
        ['character', 'decorateBardWikiCharacterForPlugin', 'DBState', 'fetch', 'createBardWikiAuth', 'warnBardWikiCompatibilityFailure'])
    const oldSetter = compileBody('src/ts/plugins/plugins.svelte.ts', 'setChar: (char: any) => {', '\n        },',
        ['char', 'getDatabase', 'get', 'selectedCharID', 'setDatabaseLite', 'applyPluginCharacterUpdate'])
    const indexedSetter = compileBody('src/ts/plugins/apiV3/v3.svelte.ts', 'setCharacterToIndex: (index:number, char:any) => {', '\n        },',
        ['index', 'char', 'DBState', 'applyPluginCharacterUpdate', 'stripBardWikiVirtualMemoryFromCharacter'])
    // Keep the actual body, including the active-chat baseline variable, in a shared closure.
    const effectSource = readSource('src/ts/globalApi.svelte.ts')
    const begin = effectSource.indexOf('$effect(() => {\n            const activeChar =')
    const effectEnd = effectSource.indexOf('\n        })', begin)
    if (begin < 0 || effectEnd < begin) throw new Error('Missing active-chat effect')
    const effectBody = effectSource.slice(begin + '$effect(() => {'.length, effectEnd)
    const makeEffect = new Function('DBState', 'selIdState', 'deepTouch', 'isHydrating', 'changeTracker', 'saveTimeoutExecute',
        `let trackedActiveChatKey = ''; return () => {${effectBody}}`)

    it.each(['setChar', 'setCharacter', 'setCharacterToIndex'])('retains undefined-bearing identical chats with Wiki ON/OFF through %s and the production active-chat effect', async (method) => {
        for (const wiki of [false, true]) {
            const state = $state({ db: { characters: [{ chaId: 'c', chatPage: 0, name: 'old', chats: [{
                id: 'chat', message: [{ role: 'user' as const, data: 'hello', disabled: true, saying: undefined }],
                risuBardWikiReboot: undefined, activeStreamingDisplayOptimizationMode: undefined,
                savedToggleValues: undefined, GLGlobalVariables: undefined, togglePresetBaseline: undefined,
                localLore: [], lastDate: 0, score: NaN,
                hypaV3Data: { summaries: [] }, hypaV2Data: { mainChunks: [] }, supaMemoryData: '',
            }] }] } })
            const queued: { chat: string[][] } = { chat: [] }
            let saves = 0
            const run = makeEffect(state, 0, deepTouch, () => false, queued, () => { saves++ })
            const stop = $effect.root(() => { $effect(run) })
            flushSync()
            const before = state.db.characters[0]
            const chats = before.chats
            const snapshot = { snapshot: (value: any) => $state.snapshot(value) }
            const getDb = makeDbRead(state, snapshot)
            const getIndexed = makeIndexedRead(state, getDb, snapshot)
            const getCurrent = makeCurrentRead(getDb, getIndexed, () => 0, {})
            const setDb = makeDbWrite(state)
            const oldApis = {
                getChar: () => oldRead(getCurrent),
                setChar: (char: any) => oldSetter(char, getDb, () => 0, {}, setDb, applyPluginCharacterUpdate),
            }
            const decorate = (character: any) => makeDecorate(character,
                (input: any) => decorateBardWikiCharacterForPlugin(input, {
                    loadInquiry: async () => ({ sources: wiki ? [{ id: 'wiki', content: 'fact' }] : [], metrics: {} }) as any,
                }), state, fetch, async () => '', (error: unknown) => { throw error })
            const aliasSource = readSource('src/ts/plugins/apiV3/v3.svelte.ts')
            const aliasBegin = aliasSource.indexOf('    const getPluginCharacter =')
            const aliasEnd = aliasSource.indexOf('    const getCurrentBardWikiScope', aliasBegin)
            expect(aliasBegin).toBeGreaterThan(0)
            expect(aliasEnd).toBeGreaterThan(aliasBegin)
            const aliases = new Function('oldApis', 'decoratePluginCharacter', 'stripBardWikiVirtualMemoryFromCharacter',
                transform(aliasSource.slice(aliasBegin, aliasEnd) + '; return { getPluginCharacter, setPluginCharacter }', { transforms: ['typescript'] }).code)(oldApis, decorate, stripBardWikiVirtualMemoryFromCharacter)
            for (const name of ['getChar', 'getCharacter']) expect(aliasSource).toContain(`${name}: getPluginCharacter`)
            for (const name of ['setChar', 'setCharacter']) expect(aliasSource).toContain(`${name}: setPluginCharacter`)
            const fetched = await aliases.getPluginCharacter()
            expect(fetched.chats[0].supaMemoryData.includes('RISUBARD_BARDWIKI_PLUGIN_CONTEXT_START')).toBe(wiki)
            const guest = structuredClone(fetched)
            guest.name = 'new'
            const write = (character: typeof guest) => {
                if (method === 'setCharacterToIndex') indexedSetter(0, structuredClone(character), state, applyPluginCharacterUpdate, stripBardWikiVirtualMemoryFromCharacter)
                else aliases.setPluginCharacter(structuredClone(character))
                flushSync()
            }
            const cleaned = stripBardWikiVirtualMemoryFromCharacter(guest)
            expect(Object.hasOwn(cleaned.chats[0], 'risuBardWikiReboot')).toBe(true)
            expect(cleaned.chats).toEqual($state.snapshot(chats))
            write(guest)
            expect(state.db.characters[0]).toBe(before)
            expect(state.db.characters[0].chats).toBe(chats)
            expect(queued.chat).toEqual([])
            expect(saves).toBe(0)
            expect(JSON.stringify($state.snapshot(state.db.characters[0]))).toBe(JSON.stringify(cleaned))
            guest.chats[0].message[0].data = 'actually edited'
            write(guest)
            expect(queued.chat).toEqual([['c', 'chat']])
            expect(saves).toBe(1)
            expect(JSON.stringify($state.snapshot(state.db.characters[0]))).toBe(JSON.stringify(stripBardWikiVirtualMemoryFromCharacter(guest)))
            stop()
        }
    })

    it('compares present undefined, empty arrays, zero and NaN exactly, but distinguishes missing keys and sparse arrays', () => {
        expect(samePluginData({ value: undefined, list: [], zero: 0, nan: NaN }, structuredClone({ value: undefined, list: [], zero: 0, nan: NaN }))).toBe(true)
        expect(samePluginData({ value: undefined }, {})).toBe(false)
        expect(samePluginData([, 0], [, 0])).toBe(false)
        expect(samePluginData([undefined, 0], [undefined, 0])).toBe(true)
    })
})
