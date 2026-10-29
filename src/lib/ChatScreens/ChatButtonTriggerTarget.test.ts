import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'
import { captureGenerationTarget, createGenerationScope } from 'src/ts/process/generationTarget'
import { mergeTriggerChat } from './triggerResultMerge'

function loadActivateButtonTrigger(deps: Record<string, unknown>) {
    const source = readFileSync('src/lib/ChatScreens/Chat.svelte', 'utf8')
    const start = source.indexOf('async function activateButtonTrigger')
    const end = source.indexOf('const buttonTriggerActivation', start)
    const code = ts.transpileModule(source.slice(start, end), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText
    return new Function(...Object.keys(deps), `${code}; return activateButtonTrigger`)(
        ...Object.values(deps)
    ) as (origin: { getAttribute(name: string): string | null }) => Promise<void>
}

function setup(switchTo: (db: { characters: any[] }, bot: any) => void) {
    const a = { id: 'A', message: [{ data: 'original A' }] }
    const b = { id: 'B', message: [{ data: 'original B' }] }
    const bot = { chaId: 'bot', chatPage: 0, chats: [a, b] }
    const other = { chaId: 'other', chatPage: 0, chats: [{ id: 'C', message: [{ data: 'original C' }] }] }
    const db = { characters: [bot, other] as any[] }
    let selected = 0
    let finish!: (value: unknown) => void
    const pending = new Promise(resolve => { finish = resolve })
    const deps = {
        readOnly: false,
        idx: 0,
        getCurrentCharacter: () => db.characters[selected],
        // The pre-fix code wrote to whatever chat was open at completion.
        getCurrentChat: () => db.characters[selected].chats[db.characters[selected].chatPage],
        setCurrentChat: (chat: unknown) => {
            const character = db.characters[selected]
            character.chats[character.chatPage] = chat
        },
        captureGenerationTarget,
        createGenerationScope,
        DBState: { db },
        runTrigger: vi.fn(),
        runLuaButtonTrigger: vi.fn(() => pending),
        normalizeChat: (chat: unknown) => chat,
        ReloadChatPointer: { update: vi.fn() },
        trackChatForSave: vi.fn(),
        requestImmediateSave: vi.fn(async () => {}),
        CurrentTriggerIdStore: { set: vi.fn() },
        mergeTriggerChat,
        getChatVar: () => 'null',
        debugTiming: { click() {}, stage() {}, afterPaint() {} },
    }
    const activate = loadActivateButtonTrigger(deps)
    const origin = { getAttribute: (name: string) => name === 'risu-btn' ? 'lb-reroll__lb-mini' : null }
    return {
        a, b, bot, other, db, deps,
        async run() {
            const task = activate(origin)
            await Promise.resolve()
            switchTo(db, bot)
            if (bot.chatPage === -1) {
                bot.chatPage = 0
                selected = 1
            }
            finish({ chat: { ...a, message: [{ data: 'rerolled A' }] } })
            await task
        },
    }
}

it('writes a slow button trigger result to the chat it started in, not the chat opened later', async () => {
    const t = setup((_, bot) => { bot.chatPage = 1 })
    await t.run()
    expect(t.deps.runLuaButtonTrigger).toHaveBeenCalledWith(t.bot, 'lb-reroll__lb-mini', t.a)
    expect(t.bot.chats.map(chat => chat.id)).toEqual(['A', 'B'])
    expect(t.bot.chats[0].message[0].data).toBe('rerolled A')
    expect(t.bot.chats[1]).toBe(t.b)
    // The written chat is off screen, so it is queued for saving explicitly.
    expect(t.deps.trackChatForSave).toHaveBeenCalledWith('bot', 'A')
    expect(t.deps.requestImmediateSave).toHaveBeenCalled()
})

it('does not queue the chat separately when it is still open', async () => {
    const t = setup(() => {})
    await t.run()
    expect(t.bot.chats[0].message[0].data).toBe('rerolled A')
    expect(t.deps.trackChatForSave).not.toHaveBeenCalled()
})

it('leaves another bot untouched when the user switched bots during the trigger', async () => {
    const t = setup((_, bot) => { bot.chatPage = -1 })
    await t.run()
    expect(t.other.chats[0].message[0].data).toBe('original C')
    expect(t.bot.chats[0].message[0].data).toBe('rerolled A')
})

it('drops the result when the source chat was deleted during the trigger', async () => {
    const t = setup((_, bot) => { bot.chats.splice(0, 1) })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await t.run()
    expect(t.bot.chats).toEqual([t.b])
    expect(t.b.message[0].data).toBe('original B')
    expect(t.deps.trackChatForSave).not.toHaveBeenCalled()
    warn.mockRestore()
})
