import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotPlaySet, type SnapshotSource } from './snapshot.ts';
import { canonical, validateManifest, validateRecords, type Json } from './protocol.ts';

function fixture() {
  const db = {
    openAIKey: 'never-export-provider-credential', access_token: 'never-export-token',
    characters: [
      { chaId: 'card', type: 'character', name: '표본', image: 'assets/icon.png', description: '설정', scriptstate: { day: 3 },
        globalLore: [{ key: '세계', content: '보존' }], customscript: [{ script: '원문' }], modules: ['life'],
        oaiTTSConfig: { voice: 'voice', apiKey: 'never-export-character-credential' },
        chats: [
          { id: 'chat', name: '현재', message: [{ role: 'char', data: '\uEF01COLDSTORAGE\uEF01cold-chat' }], bindedPersona: 'player', scriptstate: {} },
          { id: 'unselected', message: [{ data: 'never-export-unselected-chat' }] },
        ], chatPage: 0, chatFolders: [],
      },
      { chaId: 'unrelated', description: 'never-export-unrelated-character', chats: [] },
    ],
    modules: [{ id: 'life', name: 'Life', trigger: [{ code: 'return "literal"' }], assets: [['icon', 'assets/icon.png', 'png']] }],
    enabledModules: [], moduleIntergration: '', personas: [{ id: 'player', name: '플레이어', personaPrompt: '페르소나', icon: 'assets/icon.png' }],
    globalChatVariables: { flag: '1' }, loreBookPage: 0, loreBook: [{ name: '선택 로어', data: [{ key: 'x', content: 'y' }] }],
    hypaV3Presets: [{ name: '기억', settings: { memoryTokensRatio: 0.2 } }], hypaV3PresetId: 0, hypaV3: true,
    botPresets: [{ name: '현재 프리셋', openAIKey: 'never-export-saved-credential' }], botPresetsId: 0,
    mainPrompt: '프롬프트', temperature: 0.8,
  };
  const source: SnapshotSource = {
    database: db, origin: 'device1',
    cold: async () => ({ message: [{ role: 'char', data: '복원 본문 {{inlay::drawing}}' }], scriptstate: { stage: 7 }, hypaV3Data: { summaries: [{ text: '기억', chatMemos: ['memo'] }] }, localLore: [{ key: 'x', content: '로어' }] }),
    asset: async () => new Blob([new Uint8Array([1, 2, 3])]),
    inlay: async () => ({ metadata: { type: 'image', name: '그림', width: 10, height: 20, ext: 'png' }, data: new Blob([new Uint8Array([4, 5, 6])], { type: 'image/png' }) }),
  };
  return { db, source, selection: { characterId: 'card', chatIds: ['chat'], primaryChatId: 'chat', setId: 'device1.set' } };
}
test('real schema snapshot hydrates cold chat, memory, variables, inlay and dependencies without exporting DB/secrets', async () => {
  const { db, source, selection } = fixture();
  const before = canonical(db);
  const result = await snapshotPlaySet(source, selection);
  assert.deepEqual(result.missing, []); validateManifest(result.manifest);
  assert.equal(result.manifest.items.filter(i => i.kind === 'character').length, 1);
  assert.equal(result.manifest.items.filter(i => i.kind === 'chat').length, 1);
  assert.equal(result.manifest.items.filter(i => i.kind === 'module').length, 1);
  assert.equal(result.manifest.items.filter(i => i.kind === 'inlay').length, 1);
  const text = canonical(Object.fromEntries(result.records));
  assert.ok(!text.includes('never-export'));
  assert.ok(text.includes('복원 본문')); assert.ok(text.includes('chatMemos'));
  assert.equal(canonical(db), before, 'export must not mutate original DB');
  assert.equal((await snapshotPlaySet(source, selection, result.manifest)).manifest.revision, result.manifest.revision);
});
test('missing inlay or asset is reported; external image is reported without fetching', async () => {
  const { source, selection, db } = fixture();
  db.characters[0].image = 'https://example.invalid/image.png';
  source.asset = async () => null; source.inlay = async () => null;
  const result = await snapshotPlaySet(source, selection);
  assert.ok(result.missing.some(m => m.reason.includes('inlay')));
  assert.ok(result.missing.some(m => m.reason.includes('asset')));
  assert.ok(result.external.some(m => m.reason === 'https://example.invalid/image.png'));
});

test('structural asset URLs containing assets stay external and never become local paths', async () => {
 const {source,selection,db}=fixture();
 db.characters[0].image='https://example.invalid/assets/avatar.png';
 (db.characters[0] as Record<string,Json>).additionalAssets=[['remote','https://example.invalid/assets/additional.png','png']];
 db.modules[0].assets=[['remote','https://example.invalid/assets/module.png','png']];
 db.modules[0].assets.push(['inline','DATA:image/svg+xml,assets/inline.png','svg']);
 const requested:string[]=[];const load=source.asset;source.asset=async path=>{requested.push(path);return load(path)};
 const before=canonical(db);const result=await snapshotPlaySet(source,selection);
 assert.deepEqual(result.missing,[]);
 assert.ok(!requested.includes('assets/inline.png'));
 for(const name of ['avatar','additional','module']) {
  assert.ok(result.external.some(value=>value.reason==='https://example.invalid/assets/'+name+'.png'));
  assert.ok(!requested.includes('assets/'+name+'.png'));
 }
 assert.equal(canonical(db),before);
});

test('free-text external assets remain external while adjacent local assets are collected', async () => {
 const {source,selection,db}=fixture();
 db.characters[0].description='<img src="https://cdn.example.invalid/assets/remote.png"> local assets/actual.png';
 const requested:string[]=[];const load=source.asset;source.asset=async path=>{requested.push(path);return path==='assets/remote.png'?null:load(path)};
 const before=canonical(db);const result=await snapshotPlaySet(source,selection);
 assert.deepEqual(result.missing,[]);
 assert.equal(result.external.filter(value=>value.reason==='https://cdn.example.invalid/assets/remote.png').length,1);
 assert.ok(!requested.includes('assets/remote.png'));assert.ok(requested.includes('assets/actual.png'));
 assert.equal(canonical(db),before);
});

test('URI payloads do not become guessed local assets in free text', async () => {
 for (const uri of ['data:image/svg+xml,assets/inline.png', 'DATA:image/svg+xml,assets/inline.png', '//cdn.example.invalid/assets/inline.png', 'file:///assets/inline.png', 'blob:https://example.invalid/assets/inline.png']) {
  const {source,selection,db}=fixture();
  db.characters[0].description=`<img src="${uri}"> local assets/actual.png`;
  const requested:string[]=[];const load=source.asset;source.asset=async path=>{requested.push(path);return path==='assets/inline.png'?null:load(path)};
  const before=canonical(db);const result=await snapshotPlaySet(source,selection);
  assert.deepEqual(result.missing,[],uri);
  assert.ok(!requested.includes('assets/inline.png'),uri);assert.ok(requested.includes('assets/actual.png'),uri);
  if (!/^data:/i.test(uri)) assert.ok(result.external.some(value=>value.reason===uri),uri);
  assert.equal(canonical(db),before);
 }
});

test('URI scheme suffixes inside words do not hide local asset references', async () => {
 const {source,selection,db}=fixture();
 db.characters[0].description='profile:assets/one.png metadata:assets/two.png my_data:assets/three.png';
 const requested:string[]=[];const load=source.asset;source.asset=async path=>{requested.push(path);return load(path)};
 const result=await snapshotPlaySet(source,selection);
 assert.deepEqual(result.missing,[]);assert.deepEqual(result.external,[]);
 for (const path of ['assets/one.png','assets/two.png','assets/three.png']) assert.ok(requested.includes(path),path);
});

test('missing module icon blocks by default; explicit omission preserves gameplay and source', async () => {
  const { source, selection, db } = fixture();
  (db.modules[0] as Record<string, Json>).icon = 'assets/missing.png';
  const load = source.asset; source.asset = async path => path === 'assets/missing.png' ? null : load(path);
  const before = canonical(db);
  const blocked = await snapshotPlaySet(source, selection);
  assert.equal(blocked.missing.length, 1);
  assert.equal(blocked.missing[0].optional, 'module-icon');
  const result = await snapshotPlaySet(source, { ...selection, omitMissingModuleIcons: true });
  assert.deepEqual(result.missing, []);
  assert.equal(result.excluded.filter(x => x.optional === 'module-icon').length, 1);
  validateManifest(result.manifest); validateRecords(result.manifest, result.records);
  const moduleItem = result.manifest.items.find(i => i.kind === 'module')!;
  const module = result.records.get(moduleItem.entry) as Record<string, Json>;
  assert.equal(module.icon, undefined); assert.deepEqual(module.trigger, db.modules[0].trigger);
  for (const item of blocked.manifest.items.filter(i => i.kind !== 'module')) {
    assert.deepEqual(result.records.get(item.entry), blocked.records.get(item.entry));
  }
  assert.equal(canonical(db), before);
});

test('icon omission never skips gameplay references, existing icons, or storage errors', async () => {
  for (const scenario of ['gameplay', 'present', 'io-error', 'invalid', 'external']) {
    const { source, selection, db } = fixture();
    const module = db.modules[0] as Record<string, Json>;
    module.icon = scenario === 'invalid' ? 'assets/sub/icon.png' : scenario === 'external' ? 'https://example.invalid/icon.png' : 'assets/optional.png';
    if (scenario === 'gameplay') module.trigger = [{ code: 'load("assets/optional.png")' }];
    const load = source.asset;
    source.asset = async path => {
      if (path !== 'assets/optional.png' || scenario === 'present') return load(path);
      if (scenario === 'io-error') throw new Error('Storage unavailable');
      return null;
    };
    const result = await snapshotPlaySet(source, { ...selection, omitMissingModuleIcons: true });
    if (['gameplay', 'io-error', 'invalid'].includes(scenario)) assert.ok(result.missing.length > 0, scenario);
    else { assert.deepEqual(result.missing, []); assert.ok(!result.excluded.some(x => x.optional)); }
    if (scenario === 'present') assert.ok(result.manifest.items.find(i => i.kind === 'module')!.references.some(r => r.pointer === '/icon'));
    if (scenario === 'external') assert.ok(result.external.some(x => x.reason === module.icon));
  }
});
test('streaming cannot be snapshotted mid-response', async () => {
  const { source, selection, db } = fixture();
  (db.characters[0].chats[0] as Record<string, Json>).isStreaming = true;
  await assert.rejects(snapshotPlaySet(source, selection), /generation/);
});

test('an icon available in another selected chat is never discarded as globally absent', async () => {
  for (const reverse of [false, true]) {
    const { source, selection } = fixture(); const db: any = source.database;
    db.modules[0].icon = 'assets/scope-icon.png';
    db.characters[0].chats.push({ id: 'second', message: [{ data: 'second' }], risuPlayContext: { resolvedAssets: { 'assets/scope-icon.png': 'assets/existing.png' } } });
    const load = source.asset;
    source.asset = async path => path === 'assets/scope-icon.png' ? null : load(path);
    const before = canonical(db);
    const result = await snapshotPlaySet(source, { ...selection, chatIds: reverse ? ['second', 'chat'] : ['chat', 'second'], omitMissingModuleIcons: true });
    assert.ok(result.missing.length > 0);
    assert.ok(!result.missing.some(issue => issue.optional === 'module-icon'));
    assert.ok(!result.excluded.some(issue => issue.optional === 'module-icon'));
    const item = result.manifest.items.find(i => i.kind === 'module')!;
    assert.equal((result.records.get(item.entry) as any).icon, 'assets/scope-icon.png');
    assert.equal(canonical(db), before);
  }
});
test('optional undefined fields follow the actual JSON save representation', async () => {
  const { source, selection, db } = fixture();
  (db.characters[0] as any).optionalField = undefined;
  const snapshot = await snapshotPlaySet(source, selection);
  assert.deepEqual(snapshot.missing, []);
  assert.ok(!canonical(Object.fromEntries(snapshot.records)).includes('optionalField'));
});


test('round10: group member inline assets, inlays and module media reach every selected chat context', async () => {
  const { source, selection } = fixture(); const db: any = source.database;
  db.characters[0].type = 'group'; db.characters[0].characters = ['member'];
  db.characters[0].chats.push({ id: 'second', message: [{ data: 'second' }] });
  db.characters.push({ chaId: 'member', name: 'member', description: '<img src="assets/member.png"> {{inlay::member-image}}',
    modules: ['member-module'], chats: [{ id: 'private-member', message: [{ data: 'never-export-member-chat' }] }] });
  db.modules.push({ id: 'member-module', trigger: [{ code: 'render("assets/member-module.png")' }] });
  const result = await snapshotPlaySet(source, { ...selection, chatIds: ['chat', 'second'] });
  assert.deepEqual(result.missing, []); validateManifest(result.manifest);
  const contexts = result.manifest.items.filter(i => i.kind === 'context').map(i => result.records.get(i.entry) as any);
  assert.equal(contexts.length, 2);
  for (const context of contexts) {
    assert.ok(context.assets['assets/member.png']); assert.ok(context.assets['assets/member-module.png']); assert.ok(context.inlays['member-image']);
  }
  assert.ok(!canonical(Object.fromEntries(result.records)).includes('never-export-member-chat'));
});
