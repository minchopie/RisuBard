import { expect, test, vi } from 'vitest'
import { processScriptFull } from './scripts'
import { runLuaEditTrigger } from './scriptings'
import { getCurrentCharacter, type character } from '../storage/database.svelte'

vi.mock('../stores.svelte', () => ({ CharEmotion: {}, selectedCharID: {} }))
vi.mock('../storage/database.svelte', () => ({
    getDatabase: () => ({ presetRegex: [] }),
    getCurrentCharacter: vi.fn(),
    getCurrentChat: vi.fn(),
}))
vi.mock('../globalApi.svelte', () => ({ downloadFile: vi.fn() }))
vi.mock('../alert', () => ({ alertError: vi.fn(), notifySuccess: vi.fn() }))
vi.mock('src/lang', () => ({ language: {} }))
vi.mock('../util', () => ({ selectSingleFile: vi.fn() }))
vi.mock('../parser/parser.svelte', () => ({ risuChatParser: (data: string) => data }))
vi.mock('./modules', () => ({ getModuleAssets: () => [], getModuleRegexScripts: () => [] }))
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
