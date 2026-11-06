import fs from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {writable} from 'svelte/store';
import {describe,it,expect,vi} from 'vitest';
const {state,sources}=vi.hoisted(()=>({state:{db:{} as any},sources:[] as any[]}));
vi.mock('../../../storage/database.svelte',()=>({appVer:'0.9.96',getCurrentCharacter:()=>state.db.characters[0],getDatabase:()=>state.db}));
vi.mock('../../../globalApi.svelte',()=>({aiWatermarkingLawApplies:()=>false,getFileSrc:()=>Promise.resolve('')}));
vi.mock('../../../stores.svelte',()=>({DBState:state,selIdState:{selId:0},selectedCharID:writable(0)}));
vi.mock('../../../tokenizer',()=>({tokenize:async(s:string)=>Math.ceil(s.length/4)}));
vi.mock('../../../process/modules',()=>({getModuleAssets:()=>[],getModules:()=>[],getModuleLorebooks:()=>sources.map(x=>x.entry),getModuleLorebooksWithSources:()=>sources}));
import {risuChatParser} from '../../parser.svelte';
import {loadLoreBookV3Prompt} from '../../../process/lorebook.svelte';
const fixtures=join(dirname(fileURLToPath(import.meta.url)),'../fixtures');
const a=JSON.parse(fs.readFileSync(join(fixtures,'lifestyle-a100.json'),'utf8')).module;
const b=JSON.parse(fs.readFileSync(join(fixtures,'lifestyle-b100.json'),'utf8')).module;
const names=['함건희(보어·용사지망)','함건희(보어)','함건희(보어·용사)','함건희(보어·용사·슬라임캐리어)'];
function init(name:string,bound?:string){
 const personas=names.map((name,i)=>({id:'p'+i,name,personaPrompt:''}));
 const chat={message:[],scriptstate:{},...(bound?{bindedPersona:personas.find(p=>p.name===bound)!.id}:{})};
 const char={chaId:'test',chatPage:0,chats:[chat],defaultVariables:'',personas:[],name:'test'};
 state.db={username:name,personas,characters:[char],selectedPersona:0,globalChatVariables:{},templateDefaultVariables:''};
 return {chara:char as any,chat:chat as any};
}
describe('Life lifestyle CBS — actual parser, CBS functions and getUserName',()=>{
 it.each(names)('A follows effective persona %s',name=>{
  const ctx=init(name),text=risuChatParser(a.lorebook[0].content,ctx);
  expect(text.includes('first days at the new house')).toBe(name===names[0]);
  if(name!==names[0])expect(text).toBe('');
  expect(text).not.toMatch(/\{\{(?:#if|equal|\/if)/);
 });
 it.each(['함건희','함건희(보어·용사지망) ','함건희(보어ㆍ용사지망)','함건희(보어·용사지망) 새 이름','Other',''])('unknown or renamed persona fails closed: %s',name=>{
  expect(risuChatParser(a.lorebook[0].content,init(name))).toBe('');
 });
 it('bound aspirant overrides another selected persona',()=>{
  expect(risuChatParser(a.lorebook[0].content,init(names[1],names[0]))).toContain('first days at the new house');
 });
 it('bound non-aspirant overrides selected aspirant',()=>{
  expect(risuChatParser(a.lorebook[0].content,init(names[0],names[1]))).toBe('');
 });
 it('persona switching on the same parser leaves no cached A body',()=>{
  expect(risuChatParser(a.lorebook[0].content,init(names[0]))).toContain('first days');
  expect(risuChatParser(a.lorebook[0].content,init(names[2]))).toBe('');
  expect(risuChatParser(a.lorebook[0].content,init(names[0]))).toContain('first days');
 });
 it.each(names)('B remains shared for %s',name=>{
  expect(risuChatParser(b.lorebook[0].content,init(name))).toBe(b.lorebook[0].content);
 });
});
describe('Life lifestyle portable parser/lore integration with synthetic core sentinels',()=>{
 it.each(names)('ON/OFF preserves both core sentinels for %s',async(name)=>{
  const ctx=init(name),char=state.db.characters[0];
  const metadata=JSON.parse(fs.readFileSync(join(fixtures,'core-sentinel.json'),'utf8'));
  char.globalLore=metadata.globalLore;char.loreSettings=metadata.loreSettings;
  ctx.chat.localLore=[];state.db.loreBookDepth=4;state.db.loreBookToken=64000;
  sources.length=0;
  const original=await loadLoreBookV3Prompt({character:char,chat:ctx.chat});
  const core=(result:any)=>result.actives.filter((x:any)=>!x.source.startsWith('Authored: MGE life pack'))
    .map((x:any)=>[x.source,risuChatParser(x.prompt,{...ctx})]);
  const offCore=core(original);
  expect(offCore).toHaveLength(metadata.globalLore.length);
  sources.push({scopeId:'module:'+a.id,entry:a.lorebook[0]},{scopeId:'module:'+b.id,entry:b.lorebook[0]});
  const on=await loadLoreBookV3Prompt({character:char,chat:ctx.chat});
  expect(core(on)).toEqual(offCore);
  const rendered=on.actives.map(x=>risuChatParser(x.prompt,{...ctx})).filter(x=>x.trim()!=='');
  expect(rendered.filter(x=>x.includes('first days at the new house'))).toHaveLength(name===names[0]?1:0);
  expect(rendered.filter(x=>x.includes('practical clothes and tools'))).toHaveLength(1);
  expect(rendered.join('')).not.toMatch(/\{\{(?:#if|equal|\/if)/);
  sources.length=0;
  const offAgain=await loadLoreBookV3Prompt({character:char,chat:ctx.chat});
  expect(core(offAgain)).toEqual(offCore);
  expect(offAgain.actives.map(x=>x.prompt).join('')).not.toContain('MGE life pack');
 });
});
