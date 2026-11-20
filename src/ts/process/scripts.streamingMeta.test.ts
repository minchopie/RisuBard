import { expect, test, vi } from 'vitest'
import { writable } from 'svelte/store'
import { processScriptFull, resetScriptCache } from './scripts'
import { runLuaEditTrigger } from './scriptings'
import { getCurrentCharacter, type character } from '../storage/database.svelte'

const state = vi.hoisted(() => ({ db: { characters: [] as character[], presetRegex: [] } }))
vi.mock('../stores.svelte', () => ({
    DBState: { db: state.db }, CharEmotion: {}, selectedCharID: writable(0), selIdState: { selId: 0 },
}))
vi.mock('../storage/database.svelte', () => ({
    appVer: '0.9.103',
    getDatabase: () => state.db,
    getCurrentCharacter: vi.fn(),
    getCurrentChat: vi.fn(),
}))
vi.mock('../globalApi.svelte', () => ({ downloadFile: vi.fn() }))
vi.mock('../alert', () => ({ alertError: vi.fn(), notifySuccess: vi.fn() }))
vi.mock('src/lang', () => ({ language: {} }))
vi.mock('../util', () => ({ selectSingleFile: vi.fn(), getUserName: () => 'QA', getPersonaPrompt: () => '', pickHashRand: vi.fn() }))
vi.mock('./infunctions', () => ({ calcString: vi.fn() }))
vi.mock('./files/inlays', () => ({ getInlayInfosBatch: vi.fn() }))
vi.mock('./modules', () => ({ getModuleAssets: () => [], getModuleRegexScripts: () => [], getModuleLorebooks: () => [], getModules: () => [] }))
vi.mock('./memory/hypamemory', () => ({ HypaProcesser: vi.fn() }))
vi.mock('./scriptings', () => ({ runLuaEditTrigger: vi.fn(async (_char, _mode, data) => data) }))
vi.mock('../plugins/plugins.svelte', () => ({
    pluginV2: { editinput: new Set(), editoutput: new Set(), editprocess: new Set(), editdisplay: new Set() },
}))
vi.mock('./triggers', () => ({ runTrigger: vi.fn(async () => undefined) }))

test('passes the streaming flag only for display of the selected chat’s last message, including cache hits', async () => {
    const chat = { message: [{}, {}], isStreaming: true }
    const current = { chaId: 'current', chatPage: 1, chats: [{ message: [] }, chat], customscript: [] } as unknown as character
    const other = { ...current, chaId: 'other' }
    const renderChar = { ...current, type: 'simple' as const }
    vi.mocked(getCurrentCharacter).mockReturnValue(current)

    await processScriptFull(renderChar, 'same text', 'editdisplay', 1)
    await processScriptFull(renderChar, 'same text', 'editdisplay', 0)
    await processScriptFull(renderChar, 'same text', 'editdisplay', -1)
    await processScriptFull(other, 'same text', 'editdisplay', 1)
    chat.isStreaming = false
    await processScriptFull(renderChar, 'same text', 'editdisplay', 1)
    chat.isStreaming = true
    for (const mode of ['editinput', 'editoutput', 'editprocess'] as const) {
        await processScriptFull(renderChar, 'same text', mode, 1)
    }

    expect(vi.mocked(runLuaEditTrigger).mock.calls.map(([, mode, , meta]) => [mode, meta])).toEqual([
        ['editdisplay', { index: 1, streaming: true }],
        ['editdisplay', { index: 0, streaming: false }],
        ['editdisplay', { index: -1, streaming: false }],
        ['editdisplay', { index: 1, streaming: false }],
        ['editdisplay', { index: 1, streaming: false }],
        ['editinput', { index: 1 }],
        ['editoutput', { index: 1 }],
        ['editprocess', { index: 1 }],
    ])
})

test('updates a cached display replacement with the real last-message CBS after appending', async () => {
    resetScriptCache()
    const chat = { message: [{ role: 'char', data: 'HUD' }] }
    const char = {
        type: 'character', chaId: 'cache-test', chatPage: 0, chats: [chat],
        customscript: [
            { type: 'editdisplay', in: 'HUD', out: 'Last={{lastmessageid}}' },
            { type: 'editoutput', in: 'HUD', out: 'Last={{lastmessageid}}' },
        ],
    } as unknown as character
    state.db.characters[0] = char
    vi.mocked(getCurrentCharacter).mockReturnValue(char)
    const display = () => processScriptFull(char, 'HUD', 'editdisplay', 0)
    const request = () => processScriptFull(char, 'HUD', 'editoutput', 0)
    expect((await display()).data).toBe('Last=0')
    expect((await request()).data).toBe('Last=0')
    chat.message.push({ role: 'user', data: 'new message' })
    expect((await display()).data).toBe('Last=1')
    expect((await request()).data).toBe('Last=0')
})
