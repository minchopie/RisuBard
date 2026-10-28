import {afterEach,beforeEach,expect,test,vi} from 'vitest'
const db=vi.hoisted(()=>({translatorType:'google',translator:'ko',translatorInputLanguage:'en',aiModel:'test',combineTranslation:false,globalRegexScript:[]}))
vi.mock('../storage/database.svelte',()=>({getDatabase:()=>db}))
vi.mock('../globalApi.svelte',()=>({globalFetch:vi.fn()}))
vi.mock('../alert',()=>({notifyError:vi.fn()}))
vi.mock('../process/request/request',()=>({requestChatData:vi.fn()}))
vi.mock('../process/index.svelte',()=>({doingChat:{subscribe:(fn:any)=>{fn(false);return ()=>{}}}}))
vi.mock('../parser/parser.svelte',()=>({applyMarkdownToNode:vi.fn()}))
vi.mock('../stores.svelte',()=>({selectedCharID:{}}))
vi.mock('../process/modules',()=>({getModuleRegexScripts:vi.fn(()=>[])}))
vi.mock('../util',()=>({getNodetextToSentence:vi.fn((node:Node)=>node.textContent),sleep:vi.fn()}))
vi.mock('../process/scripts',()=>({processScriptFull:vi.fn(async(_char:any,text:string)=>({data:text}))}))
vi.mock('../notificationSound',()=>({playNotificationSound:vi.fn()}))
vi.mock('./presets',()=>({defaultTranslatorPrompt:'',getCurrentTranslatorPresetFromState:vi.fn()}))
vi.mock('../parser/chatML',()=>({parseChatML:vi.fn()}))
vi.mock('../storage/persistentKv',()=>({}))
beforeEach(()=>{db.translatorType='google';db.combineTranslation=false;vi.clearAllMocks();vi.resetModules();vi.useFakeTimers();vi.setSystemTime(100000);vi.spyOn(navigator,'userAgent','get').mockReturnValue('RisuBardAndroid/test')})
afterEach(()=>{vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals()})

async function settled<T>(promise:Promise<T>):Promise<T> {
 let done=false
 promise.finally(()=>{done=true}).catch(()=>{})
 await vi.advanceTimersByTimeAsync(10_000)
 expect(done,'HTML translation must settle without waiting on its own unflushed batch').toBe(true)
 return promise
}
function googleResult(text:string) { return new Response(JSON.stringify([[[text]]])) }
test('twelve small text nodes flush before waiting for translation',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(input:string)=>googleResult(new URL(input).searchParams.get('q')!.replaceAll('source','translated'))))
 const {translateHTML}=await import('./translator')
 const html=Array.from({length:12},(_,i)=>'<span>source '+i+'</span>').join('')
 const result=await settled(translateHTML(html,false,'',0))
 expect(result.match(/translated/g)).toHaveLength(12)
})
test('combined paragraphs finish and reapply display scripts and markdown',async()=>{
 db.combineTranslation=true
 vi.stubGlobal('fetch',vi.fn(async()=>googleResult('번역문')))
 const {translateHTML}=await import('./translator')
 const result=await settled(translateHTML('<p>source</p>',false,'',7))
 expect(result).toContain('번역문')
 const {processScriptFull}=await import('../process/scripts')
 const {applyMarkdownToNode}=await import('../parser/parser.svelte')
 expect(processScriptFull).toHaveBeenCalledWith(expect.anything(),'번역문','editdisplay',7)
 expect(applyMarkdownToNode).toHaveBeenCalled()
})
test('offline translation preserves exact multiline source',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('offline')))
 const {translate,translateHTML}=await import('./translator')
 expect(await translate('  first\nsecond\n\nthird  ',false)).toBe('  first\nsecond\n\nthird  ')
 expect(await settled(translateHTML('<pre>first\nsecond</pre><span>other</span>',false,'',0))).toContain('<pre>first\nsecond</pre>')
})
test('extra translated separators retry individual nodes without unresolved promises',async()=>{
 const fetcher=vi.fn().mockResolvedValueOnce(googleResult('extra■boundary■parts')).mockResolvedValueOnce(googleResult('one')).mockResolvedValueOnce(googleResult('two'))
 vi.stubGlobal('fetch',fetcher)
 const {translateHTML}=await import('./translator')
 const result=await settled(translateHTML('<span>first</span><span>second</span>',false,'',0))
 expect(result).toContain('<span>one</span><span>two</span>')
 expect(fetcher).toHaveBeenCalledTimes(3)
})

test('large batches and a trailing short node all finish',async()=>{
 const fetcher=vi.fn(async(input:string)=>googleResult(new URL(input).searchParams.get('q')!.replaceAll('source','translated')))
 vi.stubGlobal('fetch',fetcher)
 const {translateHTML}=await import('./translator')
 const text='source '.repeat(400)
 const result=await settled(translateHTML('<span>'+text+'</span><span>'+text+'</span><span>last source</span>',false,'',0))
 expect(result).not.toContain('source')
 expect(result).toContain('last translated')
 expect(fetcher.mock.calls.length).toBeGreaterThan(1)
})

test('a failed shared batch rejects after settling queued nodes instead of hanging',async()=>{
 db.translatorType='deeplX'
 Object.assign(db,{deeplXOptions:{url:'http://localhost:1188',token:''},noWaitForTranslate:true})
 const {globalFetch}=await import('../globalApi.svelte')
 vi.mocked(globalFetch).mockRejectedValue(new Error('provider unavailable'))
 const {translateHTML}=await import('./translator')
 const attempt=translateHTML(Array.from({length:12},(_,i)=>'<span>source '+i+'</span>').join(''),false,'',0)
 await expect(settled(attempt)).rejects.toThrow('provider unavailable')
})
