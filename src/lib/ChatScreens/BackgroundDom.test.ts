import { expect, test, vi } from 'vitest'
import { mount, tick, unmount } from 'svelte'
import { SvelteMap } from 'svelte/reactivity'
import { writable } from 'svelte/store'
import BackgroundDom from './BackgroundDom.svelte'
import { ParseMarkdown, risuChatParser } from 'src/ts/parser/parser.svelte'
import { moduleBackgroundEmbedding, ReloadGUIPointer } from 'src/ts/stores.svelte'

const state = new SvelteMap<string, unknown>()
vi.mock('src/ts/stores.svelte', () => ({
    DBState: { get db() { return { characters: state.get('characters') } } },
    selIdState: { get selId() { return state.get('index') } },
    moduleBackgroundEmbedding: writable(''),
    ReloadGUIPointer: writable(0),
}))
vi.mock('src/ts/parser/parser.svelte', () => ({
    risuChatParser: vi.fn((value: string) => value),
    ParseMarkdown: vi.fn(),
}))

test('holds the current background across refreshes and commits only the latest request', async () => {
    const first = { chaId: 'first', backgroundHTML: 'first HTML' }
    const second = { chaId: 'second', backgroundHTML: 'second HTML' }
    state.set('index', 0)
    state.set('characters', [first, second])
    const jobs: { resolve: (html: string) => void, reject: (error: Error) => void }[] = []
    vi.mocked(ParseMarkdown).mockImplementation(() => new Promise<string>((resolve, reject) => {
        jobs.push({ resolve, reject })
    }))
    const target = document.createElement('div')
    document.body.append(target)
    const component = mount(BackgroundDom, { target })
    const rendered = () => target.querySelector('b')
    const commit = async (index: number, text: string) => {
        jobs[index].resolve(`<b>${text}</b>`)
        await tick(); await tick()
    }
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
        await tick()
        expect(ParseMarkdown).toHaveBeenCalledExactlyOnceWith('first HTML\n', first, 'back')
        await commit(0, 'Initial')
        const previous = rendered()
        expect(previous?.textContent).toBe('Initial')

        ReloadGUIPointer.update(value => value + 1)
        await tick()
        expect(rendered()).toBe(previous)
        expect(ParseMarkdown).toHaveBeenCalledTimes(2)
        await commit(1, 'Initial')
        expect(rendered()).toBe(previous)

        ReloadGUIPointer.update(value => value + 1)
        await tick()
        moduleBackgroundEmbedding.set('module HTML')
        await tick()
        expect(rendered()).toBe(previous)
        expect(ParseMarkdown).toHaveBeenCalledTimes(4)
        expect(ParseMarkdown).toHaveBeenLastCalledWith('first HTML\nmodule HTML', first, 'back')
        await commit(3, 'Newer')
        await commit(2, 'Stale')
        expect(rendered()?.textContent).toBe('Newer')

        ReloadGUIPointer.update(value => value + 1)
        await tick()
        state.set('index', 1)
        await tick()
        expect(rendered()).toBeNull()
        expect(ParseMarkdown).toHaveBeenCalledTimes(6)
        await commit(4, 'Old character')
        expect(rendered()).toBeNull()
        await commit(5, 'Second character')
        expect(rendered()?.textContent).toBe('Second character')

        const replacement = { ...second, chaId: 'replacement', backgroundHTML: 'replacement HTML' }
        state.set('characters', [first, replacement])
        await tick()
        expect(rendered()).toBeNull()
        expect(risuChatParser).toHaveBeenLastCalledWith('replacement HTML\nmodule HTML', { chara: replacement })
        await commit(6, 'Replacement')

        state.set('characters', [first, { ...replacement, backgroundHTML: 'edited HTML' }])
        await tick()
        expect(rendered()?.textContent).toBe('Replacement')
        jobs[7].reject(new Error('bad background'))
        await tick(); await tick()
        expect(rendered()).toBeNull()
        expect(ParseMarkdown).toHaveBeenCalledTimes(8)
        expect(risuChatParser).toHaveBeenCalledTimes(8)
        expect(error).toHaveBeenCalledOnce()
    } finally {
        await unmount(component)
        target.remove()
        error.mockRestore()
    }
})
