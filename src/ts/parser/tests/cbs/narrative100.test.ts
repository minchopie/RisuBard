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

const n=JSON.parse(fs.readFileSync(join(fixtures,'narrative100.json'),'utf8')).module;
describe('Narration100 portable parser/lore integration with synthetic core sentinels',()=>{
 it.each(names)('shared ON/OFF preserves core sentinels and A/B for %s',async(name)=>{
  const ctx=init(name),char=state.db.characters[0];
  const metadata=JSON.parse(fs.readFileSync(join(fixtures,'core-sentinel.json'),'utf8'));
  char.globalLore=metadata.globalLore;char.loreSettings=metadata.loreSettings;
  ctx.chat.localLore=[];state.db.loreBookDepth=4;state.db.loreBookToken=64000;
  sources.length=0;sources.push({scopeId:'module:'+a.id,entry:a.lorebook[0]},{scopeId:'module:'+b.id,entry:b.lorebook[0]});
  const render=(r:any)=>r.actives.map((x:any)=>[x.source,risuChatParser(x.prompt,{...ctx})]);
  const before=render(await loadLoreBookV3Prompt({character:char,chat:ctx.chat}));
  expect(before.filter(([source])=>source.startsWith('Fixture: core '))).toHaveLength(metadata.globalLore.length);
  sources.push({scopeId:'module:'+n.id,entry:n.lorebook[0]});
  const on=render(await loadLoreBookV3Prompt({character:char,chat:ctx.chat}));
  expect(on.filter((x:any)=>x[0]===n.lorebook[0].comment)).toEqual([[n.lorebook[0].comment,n.lorebook[0].content]]);
  expect(on.filter((x:any)=>x[0]!==n.lorebook[0].comment)).toEqual(before);
  sources.pop();expect(render(await loadLoreBookV3Prompt({character:char,chat:ctx.chat}))).toEqual(before);
 });
});
