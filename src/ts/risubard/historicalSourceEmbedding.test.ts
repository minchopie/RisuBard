import { describe, expect, it, vi } from 'vitest'
import { HistoricalSourceEmbeddingIndex, mergeHistoricalSourceMatches, shareQueryEmbeddings } from './historicalSourceEmbedding'

const messages = [
    {role:'char',chatId:'old',data:'비밀 장부를 적에게 넘겼다. 은색 반지를 끼고 있었다.'},
    {role:'user',chatId:'recent-user',data:'현재 대화'},
    {role:'char',chatId:'recent',data:'현재 장면'},
]
const cache = () => { const values = new Map<string,number[]>(); return {read:async(key:string)=>values.get(key),write:async(key:string,value:number[])=>{values.set(key,value)}} }
const options = {ignoreOocTurns:true,excludeRecentMessages:1,maximumMatches:8}

describe('historical source semantic retrieval',()=>{
    it('recovers an original detail absent from event summaries and rejects edited, disabled and recent sources',async()=>{
        const index = new HistoricalSourceEmbeddingIndex({identity:'test',embed:async texts=>texts.map(()=>[1,0])},cache())
        await index.refresh(messages,true)
        const found = await index.search('배신자의 소지품','',messages,options)
        expect(found.map(item=>item.messageId)).toEqual(['old'])
        expect(found[0].content).toContain('은색 반지')
        expect(await index.search('배신','',messages.map(m=>m.chatId==='old'?{...m,data:'수정됨'}:m),options)).toEqual([])
        expect(await index.search('배신','',messages.map(m=>m.chatId==='old'?{...m,disabled:true}:m),options)).toEqual([])
        expect(await index.search('배신','',messages,{...options,maximumMatches:0})).toEqual([])
        index.dispose()
    })
    it('excludes OOC pairs and allBefore boundary and reuses unchanged document vectors',async()=>{
        const embed = vi.fn(async (texts:string[])=>texts.map(()=>[1,0]))
        const index = new HistoricalSourceEmbeddingIndex({identity:'test',embed},cache())
        const input = [...messages,{role:'char',chatId:'boundary',data:'경계',disabled:'allBefore'},
            {role:'user',chatId:'ooc-user',data:'집필 상담'}, {role:'char',chatId:'ooc',data:'<!-- OOC_turn --> 집필 상담'},
            {role:'char',chatId:'new',data:'새로운 약속'}]
        await index.refresh(input,true)
        expect(embed.mock.calls.flatMap(call=>call[0]).join('\n')).not.toContain('장부')
        expect(embed.mock.calls.flatMap(call=>call[0]).join('\n')).not.toContain('집필 상담')
        expect(embed).toHaveBeenCalledOnce()
        await index.refresh(input,true)
        expect(embed).toHaveBeenCalledOnce()
        index.dispose()
    })
    it('reuses a successful query embedding between wiki and original-source indexes',async()=>{
        const embed = vi.fn(async (texts:string[])=>texts.map(()=>[1,0]))
        const provider = shareQueryEmbeddings({identity:'test',embed})
        await provider.embed(['question'],'query')
        await provider.embed(['question'],'query')
        expect(embed).toHaveBeenCalledOnce()
        await provider.embed(['question'],'document')
        expect(embed).toHaveBeenCalledTimes(2)
    })
    it('filters recent matches before semantic ranking and keeps the lexical excerpt and score on duplicate IDs',async()=>{
        const old = {role:'char',chatId:'old',data:'과거의 은빛 증표'}
        const recent = Array.from({length:40},(_,i)=>({role:'char',chatId:`recent-${i}`,data:`최근 대화 ${i}`}))
        const index = new HistoricalSourceEmbeddingIndex({identity:'ranking',embed:async(texts,purpose)=>texts.map(text=>
            purpose==='query'||text.includes('최근')?[1,0]:[0.9,0.3])},cache())
        await index.refresh([old,...recent],true)
        const result = await index.search('증표','',[old,...recent],{...options,excludeRecentMessages:40})
        expect(result.map(item=>item.messageId)).toEqual(['old'])
        // The lexical excerpt is centred on the asked words; in the 45-turn measurement the semantic chunk lost answers.
        const lexical = {messageId:'old',role:'assistant' as const,occurredAt:0,score:5,content:'앞부분의 일반적인 언급'}
        expect(mergeHistoricalSourceMatches([lexical],result,8)[0]).toMatchObject({content:'앞부분의 일반적인 언급',score:5})
        expect(mergeHistoricalSourceMatches([],result,8)[0].content).toContain('은빛 증표')
        index.dispose()
    })
    it('merges distinct lexical and semantic sources without inflating the source quota',()=>{
        const source = {messageId:'a',role:'assistant' as const,content:'사실',score:2,occurredAt:0}
        const result = mergeHistoricalSourceMatches([source],[{...source,messageId:'b'},{...source,score:0.9}],2)
        expect(result.map(item=>item.messageId).sort()).toEqual(['a','b'])
        expect(mergeHistoricalSourceMatches([source],[source],0)).toEqual([])
    })
})
