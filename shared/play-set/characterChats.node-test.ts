import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotPlaySet } from './snapshot.ts';
import { applyCharacterChats, matchingCharacters } from './characterChats.ts';
import { canonical, hashBytes, revisionOf, validateRecords } from './protocol.ts';

async function fixture() {
 const db:any={characters:[{chaId:'sender',name:'같은 이름',description:'sender card',modules:['m'],chats:[{id:'ch',name:'Chat',message:[{data:'hello'}],scriptstate:{day:9},hypaV3Data:{summaries:['memory']}}],chatPage:0}],modules:[{id:'m',icon:'assets/absent.png',trigger:[{code:'module'}]}],personas:[],botPresets:[{name:'private preset',mainPrompt:'do not send'}],botPresetsId:0,mainPrompt:'do not send',username:'private persona',personaPrompt:'do not send'};
 const source={database:db,origin:'sender',asset:async()=>null,cold:async()=>null,inlay:async()=>null};
 const selection={setId:'transfer',characterId:'sender',chatIds:['ch'],primaryChatId:'ch',characterChatsOnly:true};
 const snap=await snapshotPlaySet(source,selection);validateRecords(snap.manifest,snap.records);
 const receiver:any={characters:[{chaId:'local',name:'같은 이름',description:'keep different version',modules:['own'],chats:[{id:'old',message:[{data:'keep'}]}],chatPage:0}],modules:[{id:'own'}],personas:[{id:'p'}],botPresets:[{name:'keep'}],mainPrompt:'keep',enabledModules:['own'],openAIKey:'keep'};
 return {db,source,selection,snap,receiver};
}

for (const feature of ['painter','prompt','gallery']) test(`unchanged ${feature} chat deduplicates on repeat and a return from another device`,async()=>{
 const {db,source,selection}=await fixture();const {recordExport}=await import('./apply.ts');
 const chat=db.characters[0].chats[0];
 if(feature==='painter') chat.bardPainter={results:[{assetId:'picture'}],settings:{context:{referenceAssetId:'picture'}}};
 if(feature==='prompt') chat.message[0].promptInfo={promptText:'private request fixture',model:'label'};
 if(feature==='gallery') chat.risuBardGallery={slots:[{id:'excerpt',sourceChatId:'ch',categoryId:'c',messages:[{data:'excerpt',promptInfo:{promptText:'private excerpt request'}}]}],categories:[{id:'c'}]};
 const before=JSON.stringify(db);
 const input={...source,asset:async()=>new Blob(['picture bytes']),inlay:async()=>({metadata:{type:'image'},data:new Blob(['picture bytes'])})};
 const snap=await snapshotPlaySet(input,selection);const original=await recordExport(db,snap);
 const assets=new Map(snap.manifest.items.filter(i=>i.kind==='asset').map(i=>[i.id,'assets/'+i.hash+'.png']));
 const received=await applyCharacterChats({characters:[]},snap.manifest,snap.records,assets,'first');
 const repeat=await applyCharacterChats(received.database,snap.manifest,snap.records,assets,'second');
 assert.equal(repeat.mode,'duplicate');assert.equal((repeat.database.characters as any[])[0].chats.length,1);
 const card=(received.database.characters as any[])[0];const receivedChat=card.chats[0];
 if(feature==='gallery') assert.equal(receivedChat.risuBardGallery.slots[0].sourceChatId,receivedChat.id);
 const back=await snapshotPlaySet({...input,origin:'B',database:received.database},{...selection,characterId:card.chaId,chatIds:[receivedChat.id],primaryChatId:receivedChat.id});
 const result=await applyCharacterChats(original,back.manifest,back.records,assets,'back');
 assert.equal(result.mode,'duplicate');assert.equal((result.database.characters as any[])[0].chats.length,1);
 const third=await applyCharacterChats({characters:[]},back.manifest,back.records,assets,'third');
 const thirdCard=(third.database.characters as any[])[0];
 const thirdSnapshot=await snapshotPlaySet({...input,origin:'C',database:third.database},{...selection,characterId:thirdCard.chaId,chatIds:[thirdCard.chats[0].id],primaryChatId:thirdCard.chats[0].id});
 const returnThird=await applyCharacterChats(original,thirdSnapshot.manifest,thirdSnapshot.records,assets,'third-back');
 assert.equal(returnThird.mode,'duplicate');assert.equal((returnThird.database.characters as any[])[0].chats.length,1);
 assert.equal(JSON.stringify(db),before);
});

test('selected cross-chat gallery sources map to received chats through a repeat receipt',async()=>{
 const {db,source,selection}=await fixture();
 db.characters[0].chats.push({id:'ch2',name:'Second',message:[{data:'second'}]});
 db.characters[0].chats[0].risuBardGallery={slots:[{id:'cross',sourceChatId:'ch2',messages:[{data:'second excerpt'}]}]};
 const snap=await snapshotPlaySet(source,{...selection,chatIds:['ch','ch2']});
 validateRecords(snap.manifest,snap.records);
 const first=await applyCharacterChats({characters:[]},snap.manifest,snap.records,new Map(),'cross-first');
 const chats=(first.database.characters as any[])[0].chats;
 assert.equal(chats[0].risuBardGallery.slots[0].sourceChatId,chats[1].id);
 const repeat=await applyCharacterChats(first.database,snap.manifest,snap.records,new Map(),'cross-repeat');
 assert.equal(repeat.mode,'duplicate');assert.equal((repeat.database.characters as any[])[0].chats.length,2);
});

test('return of a wider export uses the matching generation instead of the oldest gallery projection',async()=>{
 const {db,source,selection}=await fixture();const {recordExport}=await import('./apply.ts');
 db.characters[0].chats.push({id:'ch2',name:'Second',message:[{data:'second'}]});
 db.characters[0].chats[0].risuBardGallery={slots:[{id:'cross',sourceChatId:'ch2',messages:[{data:'second excerpt'}]}]};
 const narrow=await snapshotPlaySet(source,selection);const origin=await recordExport(db,narrow);
 const wideSelection={...selection,chatIds:['ch','ch2']};
 const wide=await snapshotPlaySet({...source,database:origin},wideSelection);
 const originAfter=await recordExport(origin,wide);
 const received=await applyCharacterChats({characters:[]},wide.manifest,wide.records,new Map(),'wide');
 const card=(received.database.characters as any[])[0];
 const back=await snapshotPlaySet({...source,origin:'B',database:received.database},{...wideSelection,characterId:card.chaId,chatIds:card.chats.map((c:any)=>c.id),primaryChatId:card.chats[0].id});
 const returned=await applyCharacterChats(originAfter,back.manifest,back.records,new Map(),'return-wide');
 assert.equal(returned.mode,'duplicate');assert.equal((returned.database.characters as any[])[0].chats.length,2);
 const first=await applyCharacterChats({characters:[]},narrow.manifest,narrow.records,new Map(),'narrow');
 const richer=await applyCharacterChats(first.database,wide.manifest,wide.records,new Map(),'richer');
 assert.equal((richer.database.characters as any[])[0].chats.length,3);
 assert.equal((first.database.characters as any[])[0].chats.length,1);
});

test('unchanged narrow return deduplicates against an origin that only exported the wider gallery set',async()=>{
 const {db,source,selection}=await fixture();const {recordExport}=await import('./apply.ts');
 db.characters[0].chats.push({id:'ch2',name:'Second',message:[{data:'second'}]});
 db.characters[0].chats[0].risuBardGallery={slots:[{id:'cross',sourceChatId:'ch2',messages:[{data:'second excerpt'}]}]};
 const wide=await snapshotPlaySet(source,{...selection,chatIds:['ch','ch2']});
 const origin=await recordExport(db,wide);const before=JSON.stringify(origin);
 const received=await applyCharacterChats({characters:[]},wide.manifest,wide.records,new Map(),'wide-only');
 const card=(received.database.characters as any[])[0];
 const back=await snapshotPlaySet({...source,origin:'B',database:received.database},{...selection,characterId:card.chaId,chatIds:[card.chats[0].id],primaryChatId:card.chats[0].id});
 const returned=await applyCharacterChats(origin,back.manifest,back.records,new Map(),'narrow-return');
 assert.equal(returned.mode,'duplicate');assert.equal((returned.database.characters as any[])[0].chats.length,2);
 assert.deepEqual((returned.database.characters as any[])[0].chats,db.characters[0].chats);
 assert.equal(JSON.stringify(origin),before);
});

for(const stub of [false,true]) test(`id-less unrelated target chat does not match an absent generation ID: ${stub}`,async()=>{
 const {snap,receiver}=await fixture();
 receiver.characters[0].chats.unshift({name:'Legacy id-less chat',message:[{data:'preserve legacy'}],...(stub?{_stub:true}:{})});
 receiver.risuPlaySets={generations:[{ids:{}}]};
 const before=JSON.stringify(receiver);
 const received=await applyCharacterChats(receiver,snap.manifest,snap.records,new Map(),'id-less');
 const chats=(received.database.characters as any[])[0].chats;
 assert.equal(chats.length,3);assert.deepEqual(chats[0],receiver.characters[0].chats[0]);
 assert.equal(JSON.stringify(receiver),before);
});

test('Painter result and reference images are included and rebound through declared inlay references', async () => {
 const {db,source,selection,receiver}=await fixture();
 db.characters[0].chats[0].bardPainter={results:[{assetId:'painter-result'}],settings:{context:{referenceAssetId:'painter-reference'}}};
 const snap=await snapshotPlaySet({...source,inlay:async id=>({metadata:{name:id},data:new Blob([id])})},selection);
 validateRecords(snap.manifest,snap.records);
 assert.equal(snap.manifest.items.filter(i=>i.kind==='inlay').length,2);
 const assets=new Map(snap.manifest.items.filter(i=>i.kind==='asset').map(i=>[i.id,'assets/'+i.hash+'.webp']));
 const result=await applyCharacterChats(receiver,snap.manifest,snap.records,assets,'painter-copy');
 const chat=(result.database.characters as any[])[0].chats.at(-1);
 assert.equal(chat.bardPainter.results[0].assetId,chat.risuTransferMedia.inlays['painter-result']);
 assert.equal(chat.bardPainter.settings.context.referenceAssetId,chat.risuTransferMedia.inlays['painter-reference']);
 assert.equal(db.characters[0].chats[0].bardPainter.results[0].assetId,'painter-result');
});

test('selected gallery excerpts preserve their messages but exclude unrelated chats and embedded request logs', async () => {
 const {db,source,selection}=await fixture();
 const gallery={categories:[{id:'keep',name:'selected category'},{id:'omit',name:'unselected category'}],slots:[
   {id:'chosen',sourceChatId:'ch',categoryId:'keep',messages:[{role:'char',data:'selected gallery text',promptInfo:{promptText:'request secret',model:'label'}}]},
   {id:'other',sourceChatId:'another-chat',categoryId:'omit',messages:[{data:'unselected chat secret'}]},
   {id:'unknown',messages:[{data:'unknown chat secret'}]},
 ]};
 db.characters[0].risuBardGallery=gallery;
 db.characters[0].chats[0].risuBardGallery={slots:[{messages:[{data:'legacy selected excerpt',promptInfo:{promptText:'legacy request secret'}}]}]};
 const before=JSON.stringify(db);
 const result=await snapshotPlaySet(source,selection);
 const serialized=canonical(Object.fromEntries(result.records));
 for(const secret of ['request secret','unselected chat secret','unknown chat secret','unselected category','legacy request secret'])assert.ok(!serialized.includes(secret));
 assert.ok(serialized.includes('selected gallery text'));
 assert.ok(serialized.includes('legacy selected excerpt'));
 assert.ok(serialized.includes('selected category'));
 assert.equal(result.excluded.filter(issue=>issue.reason.startsWith('Gallery')).length,3);
 assert.equal(JSON.stringify(db),before);
});

test('text beginning with an asset reference collects each path without treating the whole paragraph as a file', async () => {
 const {db,source,selection}=await fixture();
 db.characters[0].chats[0].message[0].data='assets/first.png explanation\nassets/second.png';
 const requested:string[]=[];
 const snap=await snapshotPlaySet({...source,asset:async path=>{requested.push(path);return ['assets/first.png','assets/second.png'].includes(path)?new Blob([path]):null}},selection);
 assert.deepEqual(snap.missing,[]);
 assert.ok(requested.includes('assets/first.png'));
 assert.ok(requested.includes('assets/second.png'));
 validateRecords(snap.manifest,snap.records);
});

test('structural additional and emotion asset paths preserve spaces',async()=>{
 const {db,source,selection}=await fixture();
 db.characters[0].additionalAssets=[['drawing','assets/old drawing.png','png']];
 db.characters[0].emotionImages=[['smile','assets/old smile.png']];
 const requested:string[]=[];
 const snap=await snapshotPlaySet({...source,asset:async path=>{requested.push(path);return new Blob([path])}},selection);
 assert.deepEqual(snap.missing,[]);
 assert.ok(requested.includes('assets/old drawing.png'));assert.ok(requested.includes('assets/old smile.png'));
 assert.ok(!requested.includes('assets/old'));
 validateRecords(snap.manifest,snap.records);
});

test('arbitrary script fields named bardPainter do not create undeclared inlay dependencies', async () => {
 const {db,source,selection}=await fixture();
 db.characters[0].chats[0].scriptstate.bardPainter={assetId:'ordinary script variable'};
 db.characters[0].bardPainter={assetId:'ordinary card extension'};
 const snap=await snapshotPlaySet(source,selection);
 assert.deepEqual(snap.missing,[]);
 validateRecords(snap.manifest,snap.records);
 assert.ok(canonical(Object.fromEntries(snap.records)).includes('ordinary script variable'));
});

test('Bard v2 revisions preserve identity but cannot be acknowledged by a chat-only receiver', async () => {
 const {snap,receiver}=await fixture();
 const hash=await hashBytes(new TextEncoder().encode('wiki version one'));
 snap.manifest.version=2;
 snap.manifest.bard=[{character:snap.manifest.primaryCharacter,chat:snap.manifest.primaryChat,sourceCharacterId:'sender',sourceChatId:'ch',files:[{path:'wiki/current-scene.md',entry:`blobs/${hash}`,hash,bytes:16}],slots:[]}];
 snap.manifest.revision=await revisionOf(snap.manifest);
 const original=JSON.stringify(receiver);
 await assert.rejects(applyCharacterChats(receiver,snap.manifest,snap.records,new Map(),'bard1'),/journaled memory receiver/);
 const {applyPlaySet}=await import('./apply.ts');
 await assert.rejects(applyPlaySet(receiver,snap.manifest,snap.records,new Map(),'bard-direct'),/journaled memory receiver/);
 const relocated=structuredClone(snap.manifest);
 relocated.bard![0].sourceCharacterId='different-local-character';
 relocated.bard![0].sourceChatId='different-local-chat';
 relocated.revision=await revisionOf(relocated);
 assert.equal(relocated.revision,snap.manifest.revision);
 const next=structuredClone(snap.manifest), changed=await hashBytes(new TextEncoder().encode('wiki version two'));
 next.bard![0].files[0]={...next.bard![0].files[0],entry:`blobs/${changed}`,hash:changed};
 next.revision=await revisionOf(next);
 assert.notEqual(next.revision,snap.manifest.revision);
 assert.equal(JSON.stringify(receiver),original);
});

for(const coldMode of ['cold','stub','placeholder','character']) test(`unloaded ${coldMode} origin requires hydration before dedup without changing its stored representation`,async()=>{
 const {db,source,selection}=await fixture();const {recordExport}=await import('./apply.ts');
 const full=structuredClone(db.characters[0].chats[0]);
 if(coldMode==='cold') db.characters[0].chats[0].message=[{data:'\uEF01COLDSTORAGE\uEF01cold-key'}];
 const snap=await snapshotPlaySet({...source,cold:async()=>full},selection);
 const original=await recordExport(db,snap);
 if(coldMode==='stub') (original.characters as any[])[0].chats[0]={id:'ch',_stub:true};
 if(coldMode==='placeholder') (original.characters as any[])[0].chats[0]={id:'ch',_placeholder:true};
 if(coldMode==='character') (original.characters as any[])[0].coldstorage='character-cold';
 const before=JSON.stringify(original);
 await assert.rejects(applyCharacterChats(original,snap.manifest,snap.records,new Map(),'cold-return'),/Hydrate/);
 assert.equal(JSON.stringify(original),before);
 const hydrated=structuredClone(original);delete (hydrated.characters as any[])[0].coldstorage;(hydrated.characters as any[])[0].chats[0]=full;
 assert.equal((await applyCharacterChats(hydrated,snap.manifest,snap.records,new Map(),'hydrated-return')).mode,'duplicate');
});

test('module structural asset paths preserve whitespace',async()=>{
 const {db,source,selection}=await fixture();db.modules[0].icon='';db.modules[0].assets=[['asset','assets/module image.png','png']];
 const paths:string[]=[];
 const snap=await snapshotPlaySet({...source,asset:async path=>{paths.push(path);return new Blob([path])}},{...selection,characterChatsOnly:false});
 assert.deepEqual(snap.missing,[]);assert.ok(paths.includes('assets/module image.png'));assert.ok(!paths.includes('assets/module'));
 validateRecords(snap.manifest,snap.records);
});
test('character/chat export omits actual preset/persona/module data and missing module icons',async()=>{
 const {snap}=await fixture();assert.deepEqual(snap.missing,[]);assert.ok(!snap.manifest.items.some(i=>i.kind==='module'));assert.ok(!canonical(Object.fromEntries(snap.records)).includes('do not send'));
});
test('same name appends chat only, preserving different card version, settings and current page',async()=>{
 const {snap,receiver}=await fixture();const before=canonical(receiver);const result=await applyCharacterChats(receiver,snap.manifest,snap.records,new Map(),'t');const db:any=result.database;
 assert.equal(db.characters.length,1);assert.equal(db.characters[0].description,'keep different version');assert.deepEqual(db.characters[0].modules,['own']);assert.equal(db.characters[0].chatPage,0);assert.equal(db.characters[0].chats.length,2);assert.equal(db.characters[0].chats[1].scriptstate.day,9);assert.deepEqual(db.characters[0].chats[1].hypaV3Data,{summaries:['memory']});assert.equal(db.characters[0].chats[1].risuPlayContext,undefined);
 for(const k of ['modules','personas','botPresets','mainPrompt','enabledModules','openAIKey'])assert.deepEqual(db[k],receiver[k]);assert.equal(canonical(receiver),before);
 const again=await applyCharacterChats(JSON.parse(JSON.stringify(db)),snap.manifest,snap.records,new Map(),'t2');assert.equal(again.mode,'duplicate');assert.equal((again.database.characters as any[])[0].chats.length,2);
});
test('absent card creates ordinary card and chats without active preset or resume context',async()=>{
 const {snap,receiver}=await fixture();receiver.characters[0].name='other';const db:any=(await applyCharacterChats(receiver,snap.manifest,snap.records,new Map(),'t')).database;
 assert.equal(db.characters.length,2);assert.equal(db.characters[1].name,'같은 이름');assert.equal(db.characters[1].description,'sender card');assert.equal(db.characters[1].risuPlayDefaults,undefined);assert.equal(db.risuPlayActive,undefined);
});
test('ambiguous names require explicit target and reject stale choices',async()=>{
 const {snap,receiver}=await fixture();receiver.characters.push({...structuredClone(receiver.characters[0]),chaId:'second'});
 await assert.rejects(applyCharacterChats(receiver,snap.manifest,snap.records,new Map(),'t'),/여러 개/);
 const db:any=(await applyCharacterChats(receiver,snap.manifest,snap.records,new Map(),'t',{[snap.manifest.primaryCharacter]:'second'})).database;
 assert.equal(db.characters[0].chats.length,1);assert.equal(db.characters[1].chats.length,2);
 await assert.rejects(applyCharacterChats(receiver,snap.manifest,snap.records,new Map(),'t',{[snap.manifest.primaryCharacter]:'deleted'}),/바뀌었습니다/);
});
test('changed incoming chat is added without overwriting receiver edits',async()=>{
 const {snap,receiver,db,source,selection}=await fixture();const first:any=(await applyCharacterChats(receiver,snap.manifest,snap.records,new Map(),'t')).database;first.characters[0].chats[1].message[0].data='local edit';db.characters[0].chats[0].message.push({data:'new sender turn'});const next=await snapshotPlaySet(source,selection);const received:any=(await applyCharacterChats(first,next.manifest,next.records,new Map(),'t2')).database;
 assert.equal(received.characters[0].chats.length,3);assert.equal(received.characters[0].chats[1].message[0].data,'local edit');assert.equal(received.characters[0].chats[2].message.length,2);
});

test('chat media and inlays retain receiver mappings on re-export',async()=>{
 const {db,source,selection,receiver}=await fixture();db.characters[0].chats[0].message=[{data:'<img src="assets/drawing.png"> {{inlay::picture}}'}];
 const mediaSource={...source,asset:async()=>new Blob(['image']),inlay:async()=>({metadata:{type:'image'},data:new Blob(['inlay'])})};
 const snap=await snapshotPlaySet(mediaSource,selection);const assets=new Map(snap.manifest.items.filter(i=>i.kind==='asset').map((i,n)=>[i.id,`assets/received${n}.png`]));
 const result=await applyCharacterChats(receiver,snap.manifest,snap.records,assets,'media');const target:any=(result.database.characters as any[])[0];const chat=target.chats[1];
 assert.ok(chat.risuTransferMedia.assets['assets/drawing.png']);assert.ok(chat.risuTransferMedia.inlays.picture);assert.equal(chat.risuPlayContext,undefined);
 const again=await snapshotPlaySet({...mediaSource,database:result.database},{...selection,characterId:target.chaId,chatIds:[chat.id],primaryChatId:chat.id});assert.deepEqual(again.missing,[]);validateRecords(again.manifest,again.records);assert.equal(again.manifest.items.filter(i=>i.kind==='inlay').length,1);
});
test('group speakers point to matched receiver members and existing-card folders are not imported',async()=>{
 const {db,source,selection,receiver}=await fixture();db.characters[0].type='group';db.characters[0].characters=['member'];receiver.characters[0].type='group';receiver.characters[0].characters=['local-member'];db.characters[0].chats[0].message=[{data:'hi',saying:'member'}];db.characters[0].chats[0].folderId='sender-folder';db.characters.push({chaId:'member',name:'member',chats:[],chatPage:0});receiver.characters.push({chaId:'local-member',name:'member',chats:[{id:'member-chat',message:[]}]});
 const snap=await snapshotPlaySet(source,selection);const result:any=(await applyCharacterChats(receiver,snap.manifest,snap.records,new Map(),'group')).database;
 assert.equal(result.characters.length,2);assert.equal(result.characters[0].chats[1].message[0].saying,'local-member');assert.equal(result.characters[0].chats[1].folderId,undefined);assert.equal(result.characters[1].chats.length,1);
});

test('unchanged chats deduplicate across different set IDs, names and selection context',async()=>{
 const {source,selection,receiver,snap}=await fixture();const first=await applyCharacterChats(receiver,snap.manifest,snap.records,new Map(),'t');const again=await snapshotPlaySet(source,{...selection,setId:'different-set'});const second:any=(await applyCharacterChats(first.database,again.manifest,again.records,new Map(),'t2')).database;assert.equal(second.characters[0].chats.length,2);
});
test('variables are localized and legacy receiver rejects new mode before storing empty presets',async()=>{
 const {source,selection,db,receiver}=await fixture();db.globalChatVariables={flag:'source'};const snap=await snapshotPlaySet(source,selection);const {applyPlaySet}=await import('./apply.ts');await assert.rejects(applyPlaySet(receiver,snap.manifest,snap.records,new Map(),'old'),/Unsupported preset field/);const next:any=(await applyCharacterChats(receiver,snap.manifest,snap.records,new Map(),'new')).database;assert.deepEqual(next.characters[0].chats[1].GLGlobalVariables,{flag:'source'});assert.equal(next.characters[0].chats[1].useLocallySetGlobalVariables,true);assert.equal(next.globalChatVariables,undefined);
});
test('legacy receipt of the same text chat is recognized without a second copy',async()=>{
 const {source,selection}=await fixture();const {applyPlaySet}=await import('./apply.ts');const legacy=await snapshotPlaySet(source,{...selection,characterChatsOnly:false});
 // Give the legacy module its referenced icon, so the old full graph is valid.
 const full=await snapshotPlaySet({...source,asset:async()=>new Blob(['icon'])},{...selection,characterChatsOnly:false});
 const assets=new Map(full.manifest.items.filter(i=>i.kind==='asset').map(i=>[i.id,'assets/legacy.png']));const old=await applyPlaySet({characters:[],modules:[],personas:[],botPresets:[]},full.manifest,full.records,assets,'legacy');(old.database.characters as any[])[0].chats[0].isStreaming=false;const plain=await snapshotPlaySet(source,selection);const result:any=(await applyCharacterChats(old.database,plain.manifest,plain.records,new Map(),'plain')).database;assert.equal(result.characters.length,1);assert.equal(result.characters[0].chats.length,1);
});
test('unnamed cards reuse prior receipt identity; incompatible group kind is explicit and nonmutating',async()=>{
 const {db,source,selection,receiver}=await fixture();db.characters[0].name='';const snap=await snapshotPlaySet(source,selection);const first=await applyCharacterChats(receiver,snap.manifest,snap.records,new Map(),'t');const again:any=(await applyCharacterChats(first.database,snap.manifest,snap.records,new Map(),'t2')).database;assert.equal(again.characters.length,2);
 db.characters[0].name='같은 이름';db.characters[0].type='group';db.characters[0].characters=[];const group=await snapshotPlaySet(source,selection);await assert.rejects(applyCharacterChats(receiver,group.manifest,group.records,new Map(),'g'),/종류가 다릅니다/);assert.equal(receiver.characters[0].chats.length,1);
});

test('roundtrip and two-hop retain original identity, frozen globals and group speakers',async()=>{
 const {source,selection,db}=await fixture();db.globalChatVariables={flag:'source',fallback:'global'};db.characters[0].chats[0].GLGlobalVariables={fallback:'null'};
 db.characters[0].type='group';db.characters[0].characters=['member'];db.characters[0].chats[0].message=[{data:'hi',saying:'member'}];db.characters.push({chaId:'member',name:'Member',chats:[],chatPage:0});
 const {recordExport}=await import('./apply.ts');const snap=await snapshotPlaySet(source,selection);const original=await recordExport(db,snap);
 const b=await applyCharacterChats({characters:[],modules:[],personas:[],botPresets:[],globalChatVariables:{foreign:'receiver'}},snap.manifest,snap.records,new Map(),'b');
 const target:any=(b.database.characters as any[]).find(c=>c.type==='group');const ch=target.chats[0];assert.deepEqual(ch.GLGlobalVariables,{flag:'source',fallback:'global'});
 const back=await snapshotPlaySet({...source,origin:'B',database:b.database},{...selection,characterId:target.chaId,chatIds:[ch.id],primaryChatId:ch.id,setId:'back'});
 assert.equal(back.manifest.primaryChat,snap.manifest.primaryChat);
 const result:any=(await applyCharacterChats(original,back.manifest,back.records,new Map(),'back')).database;assert.equal(result.characters.find((c:any)=>c.type==='group').chats.length,1);
 const third=await applyCharacterChats({characters:[],modules:[],personas:[],botPresets:[]},snap.manifest,snap.records,new Map(),'third');
 const relay:any=(await applyCharacterChats(third.database,back.manifest,back.records,new Map(),'relay')).database;assert.equal(relay.characters.find((c:any)=>c.type==='group').chats.length,1);
});

test('distinct same-name group members stay distinct; wrong membership or collapsed choices reject',async()=>{
 const {db,source,selection}=await fixture();db.characters[0].type='group';db.characters[0].characters=['a','b'];db.characters.push({chaId:'a',name:'Twin',chats:[]},{chaId:'b',name:'Twin',chats:[]});
 const snap=await snapshotPlaySet(source,selection);const result:any=(await applyCharacterChats({characters:[],modules:[],personas:[],botPresets:[]},snap.manifest,snap.records,new Map(),'t')).database;
 const group=result.characters.find((c:any)=>c.type==='group');assert.equal(result.characters.length,3);assert.equal(new Set(group.characters).size,2);
 const entries=snap.manifest.items.filter(i=>i.kind==='character'&&i.id!==snap.manifest.primaryCharacter);
 // Known source identity now rejects the stale selection before group membership validation.
 await assert.rejects(applyCharacterChats(result,snap.manifest,snap.records,new Map(),'again',Object.fromEntries(entries.map(i=>[i.id,group.characters[0]]))),/바뀌었습니다/);
 result.characters.push({chaId:'outsider',name:'Twin',chats:[]});
 await assert.rejects(applyCharacterChats(result,snap.manifest,snap.records,new Map(),'wrong',{[entries[0].id]:'outsider',[entries[1].id]:group.characters[1]}),/바뀌었습니다/);
});

test('plain export ignores unrelated preset changes but detects inlay revision changes',async()=>{
 const {db,source,selection}=await fixture();const {exportStateHash}=await import('./apply.ts');const snap=await snapshotPlaySet(source,selection);const before=await exportStateHash(db,snap);db.temperature=9;assert.equal(await exportStateHash(db,snap),before);
 db.characters[0].chats[0].risuTransferMedia={assets:{},inlays:{},assetRevision:'new'};assert.notEqual(await exportStateHash(db,snap),before);
});

test('separately received chats retain all identities when re-exported together with media',async()=>{
 const {db,source,selection}=await fixture();db.characters[0].chats.push({...structuredClone(db.characters[0].chats[0]),id:'second'});
 for(const [i,ch] of db.characters[0].chats.entries())ch.message=[{data:`${i} <img src="assets/p${i}.png"> {{inlay::i${i}}}`}];
 const media={...source,asset:async()=>new Blob(['image']),inlay:async()=>({metadata:{type:'image'},data:new Blob(['inlay'])})};
 let receiver:any={characters:[],modules:[],personas:[],botPresets:[]};
 for(const id of ['ch','second']) { const snap=await snapshotPlaySet(media,{...selection,chatIds:[id],primaryChatId:id,setId:id});const assets=new Map(snap.manifest.items.filter(i=>i.kind==='asset').map((i,n)=>[i.id,`assets/${id}-${n}.png`]));receiver=(await applyCharacterChats(receiver,snap.manifest,snap.records,assets,id)).database; }
 const c=receiver.characters[0];const together=await snapshotPlaySet({...media,origin:'relay',database:receiver},{...selection,characterId:c.chaId,chatIds:c.chats.map((ch:any)=>ch.id),primaryChatId:c.chats[0].id,setId:'together'});
 assert.equal(together.missing.length,0);const assets=new Map(together.manifest.items.filter(i=>i.kind==='asset').map((i,n)=>[i.id,`assets/relay-${n}.png`]));
 const result:any=(await applyCharacterChats(receiver,together.manifest,together.records,assets,'relay')).database;assert.equal(result.characters[0].chats.length,2);
 const {generationContents}=await import('./apply.ts');const {hashLocalJson}=await import('./protocol.ts');for(const g of result.risuPlaySets.generations.slice(-1))assert.equal(g.appliedHash,await hashLocalJson(generationContents(result,g)));
});

test('new cards preserve selected primary chat and export guard watches new local chat globals',async()=>{
 const {db,source,selection}=await fixture();db.characters[0].chats.push({...structuredClone(db.characters[0].chats[0]),id:'second'});
 const snap=await snapshotPlaySet(source,{...selection,chatIds:['ch','second'],primaryChatId:'second'});const received:any=(await applyCharacterChats({characters:[],modules:[],personas:[],botPresets:[]},snap.manifest,snap.records,new Map(),'t')).database;
 assert.equal(received.characters[0].chatPage,1);const c=received.characters[0];c.chats.push({id:'local',message:[]});
 const next=await snapshotPlaySet({...source,database:received,origin:'B'},{...selection,characterId:c.chaId,chatIds:[c.chats[0].id,'local'],primaryChatId:c.chats[0].id});const {exportStateHash}=await import('./apply.ts');const before=await exportStateHash(received,next);received.globalChatVariables={changed:'yes'};assert.notEqual(await exportStateHash(received,next),before);
});

test('two received versions of one chat retain distinct chats, images and inlays in combined export',async()=>{
 const {db,source,selection}=await fixture();const localAssets=new Map<string,Blob>();const localInlays=new Map<string,any>();let receiver:any={characters:[],modules:[],personas:[],botPresets:[]};
 for(const version of [1,2]) {
  db.characters[0].chats[0].message=[{data:`version${version} <img src="assets/p.png"> {{inlay::pic}}`}];
  const snap=await snapshotPlaySet({...source,asset:async()=>new Blob(['image'+version]),inlay:async()=>({metadata:{type:'image'},data:new Blob(['inlay'+version],{type:'image/png'})})},selection);
  const assets=new Map(snap.manifest.items.filter(i=>i.kind==='asset').map((i,n)=>{const path=`assets/v${version}-${n}.png`;localAssets.set(path,snap.blobs.get(i.entry) as Blob);return [i.id,path];}));
  const result=await applyCharacterChats(receiver,snap.manifest,snap.records,assets,'v'+version);receiver=result.database;
  for(const i of snap.manifest.items.filter(i=>i.kind==='inlay'))localInlays.set(result.generation!.ids[i.id],{metadata:{type:'image'},data:new Blob(['inlay'+version],{type:'image/png'})});
 }
 const c=receiver.characters[0];assert.equal(c.chats.length,2);
 const firstLocal=c.chats[0].id;c.chats[0].id='ch';
 for(const g of receiver.risuPlaySets.generations)for(const [portable,local] of Object.entries(g.ids))if(local===firstLocal)g.ids[portable]='ch';
 const relays=new Map<string,any>();
 for(const origin of ['relay',source.origin])for(const primary of c.chats) {
  const both=await snapshotPlaySet({...source,origin,database:receiver,asset:async p=>localAssets.get(p)??null,inlay:async id=>localInlays.get(id)??null},{...selection,characterId:c.chaId,chatIds:c.chats.map((ch:any)=>ch.id),primaryChatId:primary.id,setId:'both'});
  assert.deepEqual(both.missing,[]);assert.equal(both.manifest.items.filter(i=>i.kind==='chat').length,2);assert.equal(both.manifest.items.filter(i=>i.kind==='inlay').length,2);assert.equal(both.manifest.items.filter(i=>i.kind==='asset').length,4);
  assert.deepEqual(new Set(await Promise.all([...both.blobs.values()].map(b=>(b as Blob).text()))),new Set(['image1','image2','inlay1','inlay2']));
  const mapped=new Map(both.manifest.items.filter(i=>i.kind==='asset').map((i,n)=>[i.id,`assets/final-${n}.png`]));const final:any=(await applyCharacterChats(relays.get(origin)??{characters:[],modules:[],personas:[],botPresets:[]},both.manifest,both.records,mapped,'final'+primary.id)).database;relays.set(origin,final);
  assert.equal(final.characters[0].chats.length,2);assert.ok(final.characters[0].chats[0].message[0].data.startsWith('version1'));assert.ok(final.characters[0].chats[1].message[0].data.startsWith('version2'));
 }
});

test('mixed legacy and ordinary received chats keep identities across primary changes',async()=>{
 const {db,source,selection}=await fixture();const {applyPlaySet}=await import('./apply.ts');const fullSource={...source,asset:async()=>new Blob(['icon'])};const legacy=await snapshotPlaySet(fullSource,{...selection,characterChatsOnly:false});
 const assets=new Map(legacy.manifest.items.filter(i=>i.kind==='asset').map(i=>[i.id,'assets/old.png']));let receiver:any=(await applyPlaySet({characters:[],modules:[],personas:[],botPresets:[]},legacy.manifest,legacy.records,assets,'legacy')).database;
 db.characters[0].chats.push({id:'new',message:[{data:'new ordinary chat'}]});const plain=await snapshotPlaySet(source,{...selection,chatIds:['new'],primaryChatId:'new',setId:'plain'});receiver=(await applyCharacterChats(receiver,plain.manifest,plain.records,new Map(),'plain')).database;
 const c=receiver.characters[0];c.name='';assert.equal(c.chats.length,2);receiver.risuPlaySets.generations.unshift({ids:{}},{manifest:{items:[null,{id:'invalid',references:null}]},ids:{}});let third:any={characters:[],modules:[],personas:[],botPresets:[]};
 for(const primary of c.chats) {
  const snap=await snapshotPlaySet({...fullSource,database:receiver,origin:'relay'},{...selection,characterId:c.chaId,chatIds:c.chats.map((ch:any)=>ch.id),primaryChatId:primary.id,setId:'mixed'});assert.deepEqual(snap.missing,[]);
  const staged=new Map(snap.manifest.items.filter(i=>i.kind==='asset').map(i=>[i.id,'assets/relay.png']));third=(await applyCharacterChats(third,snap.manifest,snap.records,staged,'mixed'+primary.id)).database;assert.equal(third.characters.length,1);assert.equal(third.characters[0].chats.length,2);
 }
});

test('deleted and reimported cards or chats do not leave dead owners blocking stable identity',async()=>{
 const {db,source,selection}=await fixture();db.characters[0].name='';const snap=await snapshotPlaySet(source,selection);
 for(const deleted of ['card','chat']) {
  const empty:any={characters:[],modules:[],personas:[],botPresets:[]};let b:any=(await applyCharacterChats(empty,snap.manifest,snap.records,new Map(),'b')).database;const c=await applyCharacterChats(empty,snap.manifest,snap.records,new Map(),'c');
  if(deleted==='card')b.characters=[];else b.characters[0].chats=[];
  b=(await applyCharacterChats(b,snap.manifest,snap.records,new Map(),'again')).database;const card=b.characters[0];const chat=card.chats[0];
  const back=await snapshotPlaySet({...source,database:b,origin:'B'},{...selection,characterId:card.chaId,chatIds:[chat.id],primaryChatId:chat.id});assert.equal(back.manifest.primaryCharacter,snap.manifest.primaryCharacter);assert.equal(back.manifest.primaryChat,snap.manifest.primaryChat);
  const result:any=(await applyCharacterChats(c.database,back.manifest,back.records,new Map(),'back')).database;assert.equal(result.characters.length,1);assert.equal(result.characters[0].chats.length,1);
 }
});

test('cold character placeholders retain recorded chat identity while dead owners are filtered',async()=>{
 const {source,selection,snap}=await fixture();const b:any=(await applyCharacterChats({characters:[],modules:[],personas:[],botPresets:[]},snap.manifest,snap.records,new Map(),'b')).database;const full=structuredClone(b.characters[0]);b.characters[0]={chaId:full.chaId,name:full.name,coldstorage:'cold',chats:[],chatPage:0};
 const cold=await snapshotPlaySet({...source,database:b,origin:'B',cold:async()=>({character:full})},{...selection,characterId:full.chaId,chatIds:[full.chats[0].id],primaryChatId:full.chats[0].id});assert.deepEqual(cold.missing,[]);assert.equal(cold.manifest.primaryChat,snap.manifest.primaryChat);
});


test('registered source identity survives receiver rename and wins over a same-name card', async () => {
 const {snap,receiver,source,selection,db}=await fixture();
 const first:any=(await applyCharacterChats(receiver,snap.manifest,snap.records,new Map(),'first')).database;
 first.characters[0].name='받는 쪽에서 바꾼 이름';
 first.characters.push({chaId:'same-name-other',name:'같은 이름',chats:[],chatPage:0});
 db.characters[0].chats[0].message.push({data:'new turn'});
 const next=await snapshotPlaySet(source,selection);
 const result:any=(await applyCharacterChats(first,next.manifest,next.records,new Map(),'second')).database;
 assert.equal(result.characters.length,2);assert.equal(result.characters[0].chats.length,3);
 assert.equal(result.characters[0].description,'keep different version');assert.equal(result.characters[1].chats.length,0);
});

test('stable original character ID takes precedence before name fallback',async()=>{
 const {snap,receiver}=await fixture();
 receiver.characters.push({chaId:'sender',name:'다른 표시 이름',description:'preserve stable card',chats:[],chatPage:0});
 const result:any=(await applyCharacterChats(receiver,snap.manifest,snap.records,new Map(),'stable')).database;
 assert.equal(result.characters[0].chats.length,1);assert.equal(result.characters[1].chats.length,1);
 assert.equal(result.characters[1].description,'preserve stable card');
});

test('ambiguous stable identities remain explicit candidates and a deleted mapping falls back',()=>{
 const db:any={characters:[{chaId:'a',name:'A',risuTransferOriginalId:'source'},{chaId:'b',name:'B',risuTransferOriginalId:'source'}],risuPlaySets:{generations:[{ids:{wire:'deleted'}}]}};
 assert.deepEqual(matchingCharacters(db,'A','wire','source').map(c=>c.chaId),['a','b']);
 db.risuPlaySets.generations.push({ids:{wire:'b'}});
 assert.deepEqual(matchingCharacters(db,'A','wire','source').map(c=>c.chaId),['b']);
});
