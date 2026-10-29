import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { expect, it } from 'vitest'
import { createGenerationScope } from './generationTarget'

it('cancels the stream reader even if A disappeared before the first chunk', async () => {
    const source = readFileSync('src/ts/process/index.svelte.ts', 'utf8')
    const start = source.indexOf("if(req.type === 'fail'){")
    const end = source.indexOf('    let needsAutoContinue', start)
    const code = ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
    let cancellations = 0
    const req = {type:'streaming',result:{getReader:()=>({cancel:async()=>{cancellations++}})}}
    const generationScope = createGenerationScope(()=>[],{characterId:'bot',chatId:'A'})
    const run = new Function('req','generationScope',`return async function(){${code}}`)(req,generationScope)
    await expect(run()).rejects.toThrow('identity mismatch')
    expect(cancellations).toBe(1)
})

it('auto-continues A using the same target and settings while B is visible', async () => {
    const source = readFileSync('src/ts/process/index.svelte.ts', 'utf8')
    const start = source.indexOf('    if(needsAutoContinue){')
    const end = source.indexOf('    const igp =', start)
    const code = ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
    let captured:any
    const target = {characterId:'bot',chatId:'A'}
    const requestSettings = {aiModel:'A model'}
    const deps = {target,requestSettings,needsAutoContinue:true,genKey:'A',chatProcessIndex:-1,arg:{},abortSignal:new AbortController().signal,resultTokens:12,endGeneration:()=>{},sendChat:async (_:number,args:unknown)=>{captured=args;return true}}
    const run = new Function(...Object.keys(deps),`return async function(){${code}}`)(...Object.values(deps))
    expect(await run()).toBe(true)
    expect(captured).toMatchObject({target,requestSettings,continue:true})
})

it('cancels the stream reader even if A disappeared before the first chunk', async () => {
    const source = readFileSync('src/ts/process/index.svelte.ts', 'utf8')
    const start = source.indexOf("if(req.type === 'fail'){")
    const end = source.indexOf('    let needsAutoContinue', start)
    const code = ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
    let cancellations = 0
    const req = {type:'streaming',result:{getReader:()=>({cancel:async()=>{cancellations++}})}}
    const generationScope = createGenerationScope(()=>[],{characterId:'bot',chatId:'A'})
    const run = new Function('req','generationScope',`return async function(){${code}}`)(req,generationScope)
    await expect(run()).rejects.toThrow('identity mismatch')
    expect(cancellations).toBe(1)
})

it('auto-continues A using the same target and settings while B is visible', async () => {
    const source = readFileSync('src/ts/process/index.svelte.ts', 'utf8')
    const start = source.indexOf('    if(needsAutoContinue){')
    const end = source.indexOf('    const igp =', start)
    const code = ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
    let captured:any
    const target = {characterId:'bot',chatId:'A'}
    const requestSettings = {aiModel:'A model'}
    const deps = {target,requestSettings,needsAutoContinue:true,genKey:'A',chatProcessIndex:-1,arg:{},abortSignal:new AbortController().signal,resultTokens:12,endGeneration:()=>{},sendChat:async (_:number,args:unknown)=>{captured=args;return true}}
    const run = new Function(...Object.keys(deps),`return async function(){${code}}`)(...Object.values(deps))
    expect(await run()).toBe(true)
    expect(captured).toMatchObject({target,requestSettings,continue:true})
})

it('commits a delayed start trigger to A while B is selected', async () => {
    const source = readFileSync('src/ts/process/index.svelte.ts', 'utf8')
    const start = source.indexOf("const triggerResult = await runTrigger(currentChar, 'start'")
    const end = source.indexOf('narrativeContextObservation.availableHistoryMessages', start)
    const code = ts.transpileModule(source.slice(start, end), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
    const a = { id:'A', message:[{data:'original A'}] }
    const b = { id:'B', message:[{data:'original B'}] }
    const character = {chatPage:0, chats:[a,b]}
    let finish!: (value: unknown) => void
    const pending = new Promise(resolve => { finish = resolve })
    const scope = { get chat(){ return character.chats.find(c=>c.id==='A')! }, set chat(value){ character.chats[character.chats.findIndex(c=>c.id==='A')] = value } }
    const deps = {runTrigger:()=>pending, currentChar:character, setCurrentChat:(chat:typeof a)=>{character.chats[character.chatPage]=chat}, generationScope:scope, normalizeChat:(chat:typeof a)=>chat, makeMs:()=>[], endGeneration:()=>{}}
    const run = new Function(...Object.keys(deps), `return async function(){let currentChat = currentChar.chats[0], ms=[], currentTokens=0; ${code}}`)(...Object.values(deps))
    const task = run()
    character.chatPage = 1
    finish({chat:{...a,message:[{data:'updated A'}]},tokens:0})
    await task
    expect(character.chats.map(c=>c.id)).toEqual(['A','B'])
    expect(character.chats[0].message[0].data).toBe('updated A')
    expect(character.chats[1]).toEqual(b)
})


it.each(['success', 'off', 'balanced', 'strong'])('keeps %s response and streaming writes in A while B is selected', async (mode) => {
    const source = readFileSync('src/ts/process/index.svelte.ts', 'utf8')
    const start = source.indexOf("if(req.type === 'fail'){")
    const end = source.indexOf('    let needsAutoContinue', start)
    const code = ts.transpileModule(source.slice(start, end), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText
    const a = {id:'A', message:[{role:'user', data:'hello A',chatId:'user-A'}]}
    const b = {id:'B', message:[{role:'user', data:'hello B',chatId:'user-B'}]}
    const character = {chaId:'bot',chatPage:0,chats:[a,b],reloadKeys:0}
    const generationScope = createGenerationScope(()=>[character] as any,{characterId:'bot',chatId:'A'})
    const chunks = [{ '0':'partial A' }, {'0':'complete A'}]
    let step = 0
    const req = mode === 'success' ? {type:'success',result:'complete A'} : {
        type:'streaming', result:{getReader:()=>({
            read:async()=> {
                character.chatPage=1
                if(step===0) character.chats.reverse()
                return step < chunks.length ? {done:false,value:chunks[step++]} : {done:true}
            }, cancel:async()=>{},
        })},
    }
    let hookCalled = false
    const dependencies = {
        req, generationScope, requestSettings:{characters:[character],streamingDisplayOptimizationMode:mode}, DBState:{db:{characters:[character],streamingDisplayOptimizationMode:mode}},
        selectedChar:0,selectedChat:0,currentChar:character,nowChatroom:character,
        arg:{},abortSignal:new AbortController().signal,generationId:'response-A',genKey:'A',realChatId:'A',
        generationInfo:{},promptInfo:{},reformatContent:(text:string)=>text,
        processGenerationScriptFull:async (_:unknown,text:string)=>{
            if(mode==='success' && !hookCalled) { character.chatPage=1;character.chats.reverse() }
            hookCalled=true
            await Promise.resolve()
            return {data:text,emoChanged:false}
        },
        runCurrentChatFunction:(chat:unknown)=>chat,normalizeChat:(chat:unknown)=>chat,
        runTrigger:async (_:unknown,_mode:unknown,{chat}:any)=>{ await Promise.resolve(); return {chat:structuredClone(chat)} },
        runInlayScreen:(_:unknown,text:string)=>({text}),
        dispatchCommittedChatOutput:async()=>{},pluginV2:{chatOutput:[]},
        findMessageIndexByChatId:(chat:any,id:string)=>chat.message.findIndex((m:any)=>m.chatId===id),
        attachOutputScriptstateCheckpoint:()=>{},
        endGeneration:()=>{},throwError:()=>{},getPartialPresetStreamText:()=>undefined,
        setTimeout,clearTimeout,requestAnimationFrame:(fn:()=>void)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,
    }
    const run = new Function(...Object.keys(dependencies), `return async function(){let currentChat=generationScope.chat,result='',emoChanged=false,resendChat=false,outputMessageId; ${code};return result}`)(...Object.values(dependencies))
    expect(await run()).toBe('complete A')
    expect(generationScope.chat.message.map(m=>m.data)).toEqual(['hello A','complete A'])
    expect(character.chats.find(c=>c.id==='B')).toEqual(b)
    expect(generationScope.chat.isStreaming).not.toBe(true)
    expect(new Set(character.chats.map(c=>c.id)).size).toBe(2)
})
