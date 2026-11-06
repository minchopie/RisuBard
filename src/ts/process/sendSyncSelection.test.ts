import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { waitForSendSync } from './sendPreparation'
import { captureGenerationTarget, createGenerationScope } from './generationTarget'

it('keeps the captured send target when selection changes during synchronization', async () => {
    const source = readFileSync('src/ts/process/index.svelte.ts', 'utf8')
    const parsed = ts.createSourceFile('process.ts', source, ts.ScriptTarget.Latest, true)
    const send = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'sendChat') as ts.FunctionDeclaration
    const statements = send.body!.statements
    const end = statements.findIndex(node => node.getText(parsed).startsWith('chatProcessStage.set('))
    expect(end).toBeGreaterThan(0)
    const code = ts.transpileModule(`async function preflight(arg = {}) {
        ${statements.slice(0, end).map(node => node.getText(parsed)).join('\n')}
        return true;
    }`, { compilerOptions: {target: ts.ScriptTarget.ES2022} }).outputText
    let finish!: () => void
    const sync = new Promise<void>(resolve => { finish = resolve })
    const character = {chaId:'character', chatPage:0, chats:[{id:'first'}, {id:'second'}]}
    const errors: string[] = []
    const dependencies = {
        DBState: {db:{characters:[character]}}, get:()=>0, selectedCharID:{}, transferBusy:{}, syncSaveHold:{}, // the NAS sync hold gate reads these stores through `get`
        refreshLiveFiles:()=>sync, waitForSendSync, captureGenerationTarget, createGenerationScope,
        language:{chatSendSelectionChanged:'selection changed'}, notifyError:(error:string)=>errors.push(error),
    }
    const preflight = new Function(...Object.keys(dependencies), `${code}; return preflight`)(...Object.values(dependencies))
    const pending = preflight()
    character.chatPage = 1
    finish()
    expect(await pending).toBe(true)
    expect(errors).toEqual([])
    expect(await preflight()).toBe(true)
})
