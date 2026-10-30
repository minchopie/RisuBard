import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotPlaySet, type SnapshotSource } from './snapshot.ts';
import { applyPlaySet, continuePlaySet, leavePlaySet, selectPlaySetMemoryPreset, resolvePlaySetMemoryPreset, captureActivePlayContext, generationContents, recordExport } from './apply.ts';
import { canonical, decodeRecordKeys, encodeRecordKeys, validateRecords, recordItem, revisionOf, type Json } from './protocol.ts';

const selection = { characterId: 'card', chatIds: ['chat'], primaryChatId: 'chat', setId: 'origin.set' };
test('explicit missing-icon export survives import, JSON reload, duplicate receipt and re-export', async () => {
  const { source, db } = sender();
  (db.modules[0] as Record<string, Json>).icon = 'assets/absent.png';
  const original = canonical(db);
  const snap = await snapshotPlaySet(source, { ...selection, omitMissingModuleIcons: true });
  assert.deepEqual(snap.missing, []);
  const recorded = await recordExport(db, snap);
  assert.equal((recorded.modules as any[])[0].icon, 'assets/absent.png');
  assert.equal(canonical(db), original);
  const repeat = await snapshotPlaySet({ ...source, database: recorded }, { ...selection, omitMissingModuleIcons: true });
  assert.equal(repeat.manifest.revision, snap.manifest.revision);
  const received = await applyPlaySet(receiver(), snap.manifest, snap.records, new Map(), 'icon-test');
  const reloaded = JSON.parse(JSON.stringify(received.database));
  const card = reloaded.characters.find((c: any) => c.chaId === received.generation!.ids[snap.manifest.primaryCharacter]);
  assert.deepEqual(card.chats[0].message, db.characters[0].chats[0].message);
  assert.deepEqual(card.chats[0].scriptstate, db.characters[0].chats[0].scriptstate);
  assert.equal(reloaded.modules[0].trigger[0].code, 'receiver-original');
  assert.equal(reloaded.modules[1].trigger[0].code, 'literal-source');
  assert.equal(reloaded.modules[1].icon, undefined);
  const again = await applyPlaySet(reloaded, snap.manifest, snap.records, new Map(), 'icon-repeat');
  assert.equal((again.database.characters as any[]).length, reloaded.characters.length);
  const output = await snapshotPlaySet({ ...source, database: reloaded }, { ...selection, characterId: card.chaId, chatIds: [card.chats[0].id], primaryChatId: card.chats[0].id });
  assert.deepEqual(output.missing, []);
  validateRecords(output.manifest, output.records);
});
test('selected chats preserve independent imported presets, memory, variables and colliding media aliases', async () => {
  const { source } = sender(); const db: any = source.database;
  db.botPresets = [{ risuPlayId: 'preset-a', name: 'A', mainPrompt: 'prompt A' }, { risuPlayId: 'preset-b', name: 'B', mainPrompt: 'prompt B' }];
  db.characters[0].chats = ['a', 'b'].map(key => ({ id: key, message: [{ data: '<img src="assets/same.png"> {{inlay::same}}' }], modules: [], risuPlayContext: {
    instanceId: 'set-' + key, presetId: 'preset-' + key, contextId: 'context-' + key, modules: [],
    context: { globalChatVariables: { scene: key }, memoryAlgorithmType: key }, assets: { 'assets/same.png': 'assets/' + key + '.png' }, inlays: { same: 'inlay-' + key }
  } }));
  source.asset = async path => new Blob([path]); source.inlay = async id => ({ metadata: { type: 'image' }, data: new Blob([id]) });
  const snapshot = await snapshotPlaySet(source, { ...selection, chatIds: ['a', 'b'], primaryChatId: 'a' });
  assert.deepEqual(snapshot.missing, []);
  assert.equal(snapshot.manifest.items.filter(i => i.kind === 'context').length, 2);
  const assets = new Map(snapshot.manifest.items.filter(i => i.kind === 'asset').map((i, n) => [i.id, `assets/received${n}.png`]));
  const result = await applyPlaySet(receiver(), snapshot.manifest, snapshot.records, assets, 'tx-contexts');
  const chats = (result.database.characters as any[])[1].chats;
  assert.deepEqual(chats.map(c => c.risuPlayContext.context.globalChatVariables.scene), ['a', 'b']);
  assert.deepEqual(chats.map(c => c.risuPlayContext.context.memoryAlgorithmType), ['a', 'b']);
  assert.notEqual(chats[0].risuPlayContext.assets['assets/same.png'], chats[1].risuPlayContext.assets['assets/same.png']);
  assert.notEqual(chats[0].risuPlayContext.inlays.same, chats[1].risuPlayContext.inlays.same);
  assert.deepEqual(chats.map(c => (result.database.botPresets as any[]).find(p => p.risuPlayId === c.risuPlayContext.presetId).mainPrompt), ['prompt A', 'prompt B']);
  const activeB = continuePlaySet(result.database, result.instanceId, chats[1].id);
  assert.equal(activeB.database.mainPrompt, 'prompt B'); assert.equal(activeB.database.memoryAlgorithmType, 'b'); assert.equal(activeB.chatIndex, 1);
  const g = result.generation!;
  const again = await snapshotPlaySet({ ...source, database: result.database }, { ...selection, characterId: g.ids[snapshot.manifest.primaryCharacter], chatIds: chats.map(c => c.id), primaryChatId: chats[0].id });
  assert.deepEqual(again.missing, []);
  // Native asset contents have to be read by their remapped local IDs on re-export.
  assert.equal(again.manifest.items.filter(i => i.kind === 'context').length, 2);
});
function sender() {
  const db = { characters: [{ chaId: 'card', name: '이름', chats: [{ id: 'chat', name: '선택', message: [{ role: 'char', data: '기록' }], scriptstate: { count: 1 }, localLore: [] }], chatPage: 0, scriptstate: { day: 1 }, modules: ['life'] }],
    personas: [], modules: [{ id: 'life', name: 'Life', trigger: [{ code: 'literal-source' }] }], botPresets: [{ name: '프리셋' }], botPresetsId: 0,
    mainPrompt: '받은 프롬프트', username: '이름', personaPrompt: '설정', openAIKey: 'source-key', aiModel: 'source-model', globalChatVariables: { toggle: 'on' } };
  const source: SnapshotSource = { origin: 'origin', database: db, asset: async () => null, cold: async () => null, inlay: async () => null };
  return { source, db };
}
function receiver(): Record<string, Json> {
  return { characters: [{ chaId: 'existing', name: '이름', chats: [{ id: 'old', message: [{ data: '기존 기록' }] }] }],
    modules: [{ id: 'life', name: '동일 이름', trigger: [{ code: 'receiver-original' }] }], enabledModules: ['life'], moduleIntergration: 'life',
    personas: [{ id: 'existing-persona', name: '기존', personaPrompt: '보존' }], botPresets: [{ name: '기존 프리셋' }],
    openAIKey: 'receiver-key', aiModel: 'receiver-model', mainPrompt: '현재 프롬프트', proxyKey: 'receiver-proxy', customProxyRequestModel: 'receiver-route',
    selectedPersona: 0, botPresetsId: 0, globalChatVariables: { untouched: 'yes' }, };
}
test('Claude H1/H2: new chats retain media/persona defaults and background updates preserve the viewed chat', async () => {
  const { source } = sender(); const db: any = source.database;
  db.characters[0].description = '<img src="assets/inline.png"> {{inlay::drawing}}';
  db.characters[0].chats.push({ id: 'second', message: [{ data: 'second chat' }] });
  source.asset = async () => new Blob(['image']); source.inlay = async () => ({ metadata: { type: 'image' }, data: 'data:image/png;base64,eA==' });
  const sel = { ...selection, chatIds: ['chat', 'second'] };
  const first = await snapshotPlaySet(source, sel);
  const assets = new Map(first.manifest.items.filter(i => i.kind === 'asset').map(i => [i.id, 'assets/local.png']));
  const initial = await applyPlaySet(receiver(), first.manifest, first.records, assets, 'initial');
  const local: any = initial.database; local.characters[1].chatPage = 1;
  db.characters[0].chats[0].message.push({ data: 'new turn' });
  const second = await snapshotPlaySet(source, sel, first.manifest);
  const updated = await applyPlaySet(local, second.manifest, second.records, assets, 'update');
  assert.equal(updated.mode, 'update'); const character = (updated.database.characters as any[])[1]; assert.equal(character.chatPage, 1);
  character.chats.push({ id: 'new-chat', message: [{ data: 'new game' }] });
  const exported = await snapshotPlaySet({ ...source, database: updated.database }, { ...selection, characterId: character.chaId, chatIds: ['new-chat'], primaryChatId: 'new-chat' });
  assert.deepEqual(exported.missing, []); validateRecords(exported.manifest, exported.records);
  assert.ok(exported.manifest.items.some(i => i.kind === 'inlay'));
});

test('Claude M4: unchanged referenced dependencies retain IDs and do not add duplicate rows', async () => {
  const { source } = sender(); const db: any = source.database;
  db.modules[0].icon = 'assets/module.png'; db.botPresets[0].image = 'assets/preset.png';
  db.personas = [{ id: 'p', name: 'P', icon: 'assets/persona.png' }]; db.characters[0].chats[0].bindedPersona = 'p';
  source.asset = async () => new Blob(['image']);
  const one = await snapshotPlaySet(source, selection);
  const assets = new Map(one.manifest.items.filter(i => i.kind === 'asset').map((i, n) => [i.id, `assets/native-${n}.png`]));
  const first = await applyPlaySet(receiver(), one.manifest, one.records, assets, 'one');
  db.characters[0].chats[0].message.push({ data: 'successor' });
  const two = await snapshotPlaySet(source, selection, one.manifest);
  const second = await applyPlaySet(first.database, two.manifest, two.records, assets, 'two');
  for (const field of ['modules', 'personas', 'botPresets']) assert.deepEqual(second.database[field], first.database[field]);
  assert.equal(second.generation!.presetId, first.generation!.presetId);
});

test('Claude M1: direct media on a shared module remains reachable in differing chat scopes', async () => {
  const { source } = sender(); const db: any = source.database;
  db.modules[0].icon = 'assets/same.png';
  db.characters[0].chats = ['a', 'b'].map(key => ({ id: key, message: [{ data: key }], modules: ['life'], risuPlayContext: { instanceId: key, modules: ['life'], assets: { 'assets/same.png': `assets/${key}.png` } } }));
  source.asset = async path => new Blob([path]);
  const snapshot = await snapshotPlaySet(source, { ...selection, chatIds: ['a', 'b'], primaryChatId: 'a' });
  validateRecords(snapshot.manifest, snapshot.records); assert.deepEqual(snapshot.missing, []);
  const assets = new Map(snapshot.manifest.items.filter(i => i.kind === 'asset').map((i, n) => [i.id, `assets/staged-${n}.png`]));
  const result = await applyPlaySet(receiver(), snapshot.manifest, snapshot.records, assets, 'media');
  const card = (result.database.characters as any[])[1];
  const icon = (result.database.modules as any[]).find(m => m.id === card.chats[0].modules[0]).icon;
  for (const [n, ch] of card.chats.entries()) {
    const assetItem = snapshot.manifest.items.find(i => i.kind === 'asset' && snapshot.localIds.get(i.id) === `assets/${['a', 'b'][n]}.png`)!;
    assert.equal(ch.risuPlayContext.resolvedAssets[icon], assets.get(assetItem.id));
  }
});
test('apply preserves unrelated data and configuration; continue applies only play fields', async () => {
  const { source } = sender(), original = receiver();
  const before = canonical(original), snapshot = await snapshotPlaySet(source, selection);
  const result = await applyPlaySet(original, snapshot.manifest, snapshot.records, new Map(), 'tx');
  assert.equal(canonical(original), before);
  assert.equal(result.mode, 'new');
  const out = result.database;
  for (const key of ['openAIKey', 'proxyKey', 'aiModel', 'mainPrompt', 'enabledModules', 'moduleIntergration', 'selectedPersona', 'botPresetsId', 'globalChatVariables']) assert.deepEqual(out[key], original[key]);
  assert.deepEqual((out.characters as Json[])[0], (original.characters as Json[])[0]);
  assert.deepEqual((out.modules as Json[])[0], (original.modules as Json[])[0]);
  const continued = continuePlaySet(out, result.instanceId);
  assert.equal(continued.database.mainPrompt, '받은 프롬프트');
  for (const key of ['openAIKey', 'proxyKey', 'aiModel', 'customProxyRequestModel', 'enabledModules', 'moduleIntergration']) assert.deepEqual(continued.database[key], original[key]);
  assert.equal(continued.characterIndex, 1); assert.equal(continued.chatIndex, 0);
});
test('receive again is idempotent; successor updates; actual local edit branches and preserves both', async () => {
  const { source, db } = sender();
  const one = await snapshotPlaySet(source, selection);
  const first = await applyPlaySet(receiver(), one.manifest, one.records, new Map(), 'tx1');
  const again = await applyPlaySet(first.database, one.manifest, one.records, new Map(), 'tx2');
  assert.equal(again.mode, 'duplicate'); assert.equal((again.database.characters as Json[]).length, 2);
  db.characters[0].chats[0].scriptstate.count = 2;
  const two = await snapshotPlaySet(source, selection, one.manifest);
  const linear = await applyPlaySet(first.database, two.manifest, two.records, new Map(), 'tx3');
  assert.equal(linear.mode, 'update'); assert.equal(linear.instanceId, first.instanceId);
  assert.equal((linear.database.characters as Json[]).length, 2);
  const changed = JSON.parse(JSON.stringify(first.database)); changed.characters[1].chats[0].scriptstate.count = 9;
  const fork = await applyPlaySet(changed, two.manifest, two.records, new Map(), 'tx4');
  assert.equal(fork.mode, 'branch'); assert.equal((fork.database.characters as Json[]).length, 3);
  assert.equal((fork.database.characters as any[])[1].chats[0].scriptstate.count, 9);
  assert.equal((fork.database.characters as any[])[2].chats[0].scriptstate.count, 2);
});


test('Android hotfix review: changed inlay bytes in a linear update receive a fresh local ID', async () => {
  const { source, db } = sender();
  (db.characters[0] as any).description = '{{inlay::drawing}}';
  let contents = 'original-image';
  source.inlay = async () => ({ metadata: { type: 'image', name: 'drawing' }, data: new Blob([contents]) });
  const one = await snapshotPlaySet(source, selection);
  const assets = (snapshot: typeof one) => new Map(snapshot.manifest.items.filter(i => i.kind === 'asset').map(i => [i.id, 'assets/' + i.hash + '.png']));
  const first = await applyPlaySet(receiver(), one.manifest, one.records, assets(one), 'before');
  contents = 'changed-image';
  const two = await snapshotPlaySet(source, selection, one.manifest);
  const next = await applyPlaySet(first.database, two.manifest, two.records, assets(two), 'after');
  assert.equal(next.mode, 'update');
  const oldInlay = one.manifest.items.find(i => i.kind === 'inlay')!;
  const newInlay = two.manifest.items.find(i => i.kind === 'inlay')!;
  assert.ok(oldInlay && newInlay);
  assert.notEqual(first.generation!.ids[oldInlay.id], next.generation!.ids[newInlay.id]);
});

test('A -> B -> export preserves portable identity; B edit is a successor, not a new set', async () => {
  const { source } = sender();
  const one = await snapshotPlaySet(source, selection);
  const received = await applyPlaySet(receiver(), one.manifest, one.records, new Map(), 'tx');
  const g = received.generation!;
  const b = { ...source, origin: 'deviceB', database: received.database };
  const sel = { characterId: g.ids[one.manifest.primaryCharacter], chatIds: [g.ids[one.manifest.primaryChat]], primaryChatId: g.ids[one.manifest.primaryChat], setId: 'ignored.local' };
  const two = await snapshotPlaySet(b, sel);
  assert.deepEqual(two.missing, []);
  assert.deepEqual([...two.manifest.items].sort((a,b) => a.id.localeCompare(b.id)), [...one.manifest.items].sort((a,b) => a.id.localeCompare(b.id)));
  assert.equal(two.manifest.revision, one.manifest.revision);
  (b.database.characters as any[])[1].chats[0].scriptstate.count++;
  const edited = await snapshotPlaySet(b, sel);
  assert.equal(edited.manifest.setId, one.manifest.setId);
  assert.equal(edited.manifest.parent, one.manifest.revision);
  assert.notEqual(edited.manifest.revision, one.manifest.revision);
});


test('cross-device asset/inlay aliases and namespace modules preserve content without script rewriting', async () => {
  const { source } = sender();
  const db: any = source.database;
  db.characters[0].image = 'assets/original.png';
  db.characters[0].description = '<img src="assets/inline.png"> {{inlay::drawing}}';
  db.modules = [{ id: 'm1', namespace: 'both', trigger: [{ code: 'assets/inline.png' }] }, { id: 'm2', namespace: 'both' }];
  db.characters[0].modules = ['both'];
  const image = new Blob(['image'], { type: 'image/png' });
  source.asset = async () => image;
  source.inlay = async () => ({ metadata: { type: 'image', name: 'drawing', ext: 'png' }, data: image });
  const one = await snapshotPlaySet(source, selection);
  assert.deepEqual(one.missing, []);
  assert.equal(one.manifest.items.filter(i => i.kind === 'module').length, 2);
  const assets = new Map(one.manifest.items.filter(i => i.kind === 'asset').map((i, n) => [i.id, `assets/new-${n}.png`]));
  const received = await applyPlaySet(receiver(), one.manifest, one.records, assets, 'tx');
  const g = received.generation!;
  const b = { ...source, origin: 'deviceB', database: received.database };
  const two = await snapshotPlaySet(b, { characterId: g.ids[one.manifest.primaryCharacter], chatIds: [g.ids[one.manifest.primaryChat]], primaryChatId: g.ids[one.manifest.primaryChat], setId: 'ignored' });
  assert.deepEqual(two.missing, []);
  assert.deepEqual([...two.manifest.items].sort((a,b) => a.id.localeCompare(b.id)), [...one.manifest.items].sort((a,b) => a.id.localeCompare(b.id)));
  assert.equal(two.manifest.revision, one.manifest.revision);
});


test('Claude P1: reference discovery order and context-only assets do not break roundtrip', async () => {
  const { source } = sender(); const db: any = source.database;
  db.characters[0].image = 'assets/main.png';
  db.characters[0].additionalAssets = [['other', 'assets/other.png', 'png']];
  db.globalChatVariables.picture = '{{inlay::invar}}';
  db.supaMemoryPrompt = '<img src="assets/memory.png">';
  source.asset = async () => new Blob(['image']);
  source.inlay = async () => ({ metadata: { type: 'image', ext: 'png', name: 'x' }, data: new Blob(['inlay']) });
  const one = await snapshotPlaySet(source, selection);
  const { validateRecords } = await import('./protocol.ts'); validateRecords(one.manifest, one.records);
  const assets = new Map(one.manifest.items.filter(i => i.kind === 'asset').map((item, i) => [item.id, `assets/b-${i}.png`]));
  const applied = await applyPlaySet(receiver(), one.manifest, one.records, assets, 'tx'); const g = applied.generation!;
  const again = await snapshotPlaySet({ ...source, origin: 'B', database: applied.database }, { ...selection, characterId: g.ids[one.manifest.primaryCharacter], primaryChatId: g.ids[one.manifest.primaryChat], chatIds: [g.ids[one.manifest.primaryChat]] });
  validateRecords(again.manifest, again.records);
  assert.equal(again.manifest.revision, one.manifest.revision);
});

test('Claude P1: continue preserves unsaved local preset, selects received preset, and update preserves character positions', async () => {
  const { source, db } = sender(); const one = await snapshotPlaySet(source, selection);
  const first = await applyPlaySet(receiver(), one.manifest, one.records, new Map(), 'tx');
  const before = continuePlaySet(first.database, first.instanceId).database as any;
  assert.equal(before.botPresets[0].mainPrompt, '현재 프롬프트');
  assert.equal(before.botPresets[before.botPresetsId].risuPlayId, first.generation!.presetId);
  before.characters.push({ chaId: 'last', chats: [{ id: 'lastchat', message: [] }] });
  db.characters[0].chats[0].scriptstate.count++;
  const two = await snapshotPlaySet(source, selection, one.manifest);
  const result = await applyPlaySet(before, two.manifest, two.records, new Map(), 'tx2');
  assert.equal(result.mode, 'update');
  assert.deepEqual((result.database.characters as any[]).map(c => c.chaId), before.characters.map((c: any) => c.chaId));
});

test('origin records exported ancestry; B edits return as a linear update to A', async () => {
  const { source } = sender(); const one = await snapshotPlaySet(source, selection);
  const a = await recordExport(source.database, one);
  const b = await applyPlaySet(receiver(), one.manifest, one.records, new Map(), 'tx'); const g = b.generation!;
  (b.database.characters as any[])[1].chats[0].scriptstate.count = 77;
  const two = await snapshotPlaySet({ ...source, origin: 'B', database: b.database }, { ...selection, characterId: g.ids[one.manifest.primaryCharacter], primaryChatId: g.ids[one.manifest.primaryChat], chatIds: [g.ids[one.manifest.primaryChat]] });
  const result = await applyPlaySet(a, two.manifest, two.records, new Map(), 'return');
  assert.equal(result.mode, 'update');
  assert.equal((result.database.characters as any[])[0].chats[0].scriptstate.count, 77);
});

test('explicit continue does not inherit absent sender play fields from a receiver preset', async () => {
  const { source } = sender(); const snapshot = await snapshotPlaySet(source, selection);
  const before = receiver(); before.customFlags = { stale: 'receiver' }; before.hanuraiEnable = true;
  const result = await applyPlaySet(before, snapshot.manifest, snapshot.records, new Map(), 'unset');
  assert.equal(result.database.hanuraiEnable, true);
  const active = continuePlaySet(result.database, result.instanceId).database;
  assert.equal(Object.hasOwn(active, 'customFlags'), false); assert.equal(Object.hasOwn(active, 'hanuraiEnable'), false);
  assert.equal(active.openAIKey, 'receiver-key');
});

test('partial successor preserves omitted chats in a separate playable set', async () => {
  const { source } = sender(); const db: any = source.database;
  db.characters[0].chats.push({ id: 'second', message: [{ data: 'keep this chat' }] });
  const first = await snapshotPlaySet(source, { ...selection, chatIds: ['chat', 'second'] });
  const local = await applyPlaySet(receiver(), first.manifest, first.records, new Map(), 'all');
  db.characters[0].chats[0].message.push({ data: 'new message' });
  const partial = await snapshotPlaySet(source, selection, first.manifest);
  const result = await applyPlaySet(local.database, partial.manifest, partial.records, new Map(), 'partial');
  assert.equal(result.mode, 'branch'); assert.deepEqual((result.database.characters as any[])[1], (local.database.characters as any[])[1]);
  assert.equal((result.database.characters as any[]).length, 3);
});
test('returning an unchanged export to its origin is continuable without a received preset row', async () => {
  const { source } = sender(); const first = await snapshotPlaySet(source, selection);
  const origin = await recordExport(source.database, first);
  const result = await applyPlaySet(origin, first.manifest, first.records, new Map(), 'return');
  assert.equal(result.mode, 'duplicate'); const opened = continuePlaySet(result.database, result.instanceId);
  assert.equal(opened.chatIndex, 0); assert.equal(opened.database.mainPrompt, source.database.mainPrompt);
});

test('returning a selected-chat successor never removes an origin chat excluded from the original export', async () => {
  const { source } = sender(); const db: any = source.database;
  db.characters[0].chats.push({ id: 'never-exported', message: [{ data: 'keep private' }] });
  const first = await snapshotPlaySet(source, selection); const origin = await recordExport(db, first);
  const other = await applyPlaySet(receiver(), first.manifest, first.records, new Map(), 'receive');
  const card = (other.database.characters as any[])[1]; card.chats[0].message.push({ data: 'returning turn' });
  const second = await snapshotPlaySet({ ...source, database: other.database }, { ...selection, characterId: card.chaId, chatIds: [card.chats[0].id], primaryChatId: card.chats[0].id });
  const result = await applyPlaySet(origin, second.manifest, second.records, new Map(), 'return');
  assert.equal(result.mode, 'branch'); assert.deepEqual((result.database.characters as any[])[0], (origin.characters as any[])[0]);
});


test('integrated7: same-preset chats keep separate memory settings through capture, fingerprint, continue and export', async () => {
  const { source } = sender(); const db: any = source.database;
  db.botPresets = [{ risuPlayId: 'shared-preset', name: 'Shared', mainPrompt: 'shared' }];
  db.characters[0].chats = ['a', 'b'].map(key => ({ id: key, message: [{ data: key }], modules: [], risuPlayContext: {
    instanceId: 'shared-set', presetId: 'shared-preset', contextId: key, modules: [], context: { memoryAlgorithmType: key, hypaAllocatedTokens: key === 'a' ? 100 : 200 }
  } }));
  const snap = await snapshotPlaySet(source, { ...selection, chatIds: ['a', 'b'], primaryChatId: 'a' });
  const result = await applyPlaySet(receiver(), snap.manifest, snap.records, new Map(), 'memory');
  const chats = (result.database.characters as any[])[1].chats;
  const a: any = continuePlaySet(result.database, result.instanceId, chats[0].id).database;
  a.memoryAlgorithmType = 'edited-a'; delete a.hypaAllocatedTokens;
  captureActivePlayContext(a);
  assert.equal(a.characters[1].chats[1].risuPlayContext.context.memoryAlgorithmType, 'b');
  assert.equal(a.characters[1].chats[1].risuPlayContext.context.hypaAllocatedTokens, 200);
  const contents: any = generationContents(a, result.generation!);
  assert.equal(contents.characters[0].chats[1].risuPlayContext.context.memoryAlgorithmType, 'b');
  assert.equal(Object.hasOwn(contents.characters[0].chats[0].risuPlayContext.context, 'hypaAllocatedTokens'), false);
  const again = await snapshotPlaySet({ ...source, database: a }, { ...selection, characterId: a.characters[1].chaId, chatIds: chats.map(c => c.id), primaryChatId: chats[0].id });
  const contexts = again.manifest.items.filter(i => i.kind === 'context').map(i => again.records.get(i.entry) as any);
  assert.deepEqual(contexts.map(c => c.memoryAlgorithmType), ['edited-a', 'b']);
  const b = continuePlaySet(a, result.instanceId, chats[1].id).database;
  assert.equal(b.memoryAlgorithmType, 'b'); assert.equal(b.hypaAllocatedTokens, 200);
  const restored = continuePlaySet(b, result.instanceId, chats[0].id).database;
  assert.equal(restored.memoryAlgorithmType, 'edited-a'); assert.equal(Object.hasOwn(restored, 'hypaAllocatedTokens'), false);
});


test('missing received preset is reported instead of silently exporting the local preset', async () => {
  const { source } = sender(); const first = await snapshotPlaySet(source, selection);
  const local = await applyPlaySet(receiver(), first.manifest, first.records, new Map(), 'preset');
  const card = (local.database.characters as any[])[1]; local.database.botPresets = [];
  const exported = await snapshotPlaySet({ ...source, database: local.database }, { ...selection, characterId: card.chaId, chatIds: [card.chats[0].id], primaryChatId: card.chats[0].id });
  assert.ok(exported.missing.some(i => i.reason.startsWith('Missing received preset:')));
});


test('integrated8: a received set remains scoped after export and accepts an unchanged linear successor', async () => {
  const { source } = sender(); const one = await snapshotPlaySet(source, selection);
  const b = await applyPlaySet(receiver(), one.manifest, one.records, new Map(), 'receive');
  const card = (b.database.characters as any[])[1]; card.chats[0].message.push({ data: 'B edit' });
  const sel = { ...selection, characterId: card.chaId, chatIds: [card.chats[0].id], primaryChatId: card.chats[0].id };
  const two = await snapshotPlaySet({ ...source, database: b.database }, sel);
  const recorded: any = await recordExport(b.database, two);
  assert.equal(recorded.risuPlaySets.generations.at(-1).exported, false);
  const nextDb = JSON.parse(JSON.stringify(recorded)); nextDb.characters[1].chats[0].message.push({ data: 'A successor' });
  const three = await snapshotPlaySet({ ...source, database: nextDb }, sel);
  recorded.botPresetsId = 0; recorded.mainPrompt = 'unrelated local preset'; recorded.memoryAlgorithmType = 'unrelated memory';
  const returned = await applyPlaySet(recorded, three.manifest, three.records, new Map(), 'return');
  assert.equal(returned.mode, 'update'); assert.equal((returned.database.characters as any[]).length, 2);
});

test('integrated8: returning to an origin chat restores local configuration and cannot capture into another set', async () => {
  const { source } = sender(); const own = await snapshotPlaySet(source, selection);
  const origin: any = await recordExport(source.database, own);
  origin.memoryAlgorithmType = 'original-memory'; origin.hypaAllocatedTokens = 321;
  const otherSource = sender().source; (otherSource.database as any).mainPrompt = 'other-prompt'; (otherSource.database as any).memoryAlgorithmType = 'other-memory';
  const other = await snapshotPlaySet(otherSource, { ...selection, setId: 'other-set' });
  const imported = await applyPlaySet(origin, other.manifest, other.records, new Map(), 'other');
  let active: any = continuePlaySet(imported.database, imported.instanceId).database;
  active.memoryAlgorithmType = 'edited-other'; active.openAIKey = 'current-receiver-key';
  const returned = await applyPlaySet(active, own.manifest, own.records, new Map(), 'original-return');
  active = continuePlaySet(returned.database, returned.instanceId).database;
  assert.equal(active.mainPrompt, '받은 프롬프트'); assert.equal(active.memoryAlgorithmType, 'original-memory'); assert.equal(active.hypaAllocatedTokens, 321);
  assert.equal(active.openAIKey, 'current-receiver-key'); assert.equal(active.risuPlayActive, undefined); assert.equal(active.risuPlayActiveChat, undefined);
  const scope = active.characters[1].chats[0].risuPlayContext;
  assert.equal(scope.context.memoryAlgorithmType, 'edited-other');
  active.memoryAlgorithmType = 'new-original-memory'; captureActivePlayContext(active);
  assert.equal(scope.context.memoryAlgorithmType, 'edited-other');
  const round = continuePlaySet(active, imported.instanceId).database;
  assert.equal(round.memoryAlgorithmType, 'edited-other');
});


test('followup9: group successors reuse untouched member placeholders and preserve edited member chats as branches', async () => {
  const { source } = sender(); const db: any = source.database;
  db.characters.push({ chaId: 'member', name: 'member', chats: [{ id: 'private', message: [{ data: 'not exported' }] }] });
  db.characters[0].type = 'group'; db.characters[0].characters = ['member'];
  const first = await snapshotPlaySet(source, selection);
  const received = await applyPlaySet(receiver(), first.manifest, first.records, new Map(), 'group1');
  const member = (received.database.characters as any[]).find(c => c.name === 'member');
  const placeholder = member.chats[0].id;
  db.characters[0].chats[0].message.push({ data: 'group update' });
  const second = await snapshotPlaySet(source, selection, first.manifest);
  const updated = await applyPlaySet(received.database, second.manifest, second.records, new Map(), 'group2');
  assert.equal(updated.mode, 'update'); assert.equal((updated.database.characters as any[]).length, 3);
  assert.equal((updated.database.characters as any[]).find(c => c.name === 'member').chats[0].id, placeholder);
  member.chats[0].message.push({ data: 'private member play' });
  const branched = await applyPlaySet(received.database, second.manifest, second.records, new Map(), 'group3');
  assert.equal(branched.mode, 'branch'); assert.equal((branched.database.characters as any[]).find(c => c.chaId === member.chaId).chats[0].message[0].data, 'private member play');
});

test('followup9: memory preset reorder does not repoint the set or change its fingerprint', async () => {
  const { source } = sender(); const db: any = source.database;
  db.hypaV3Presets = [{ name: 'source-memory', settings: { summarizationPrompt: 'preserve' } }]; db.hypaV3PresetId = 0;
  const first = await snapshotPlaySet(source, selection);
  const target = receiver(); target.hypaV3Presets = [{ name: 'receiver-memory', settings: {} }]; target.hypaV3PresetId = 0;
  const received = await applyPlaySet(target, first.manifest, first.records, new Map(), 'memory1');
  const active: any = continuePlaySet(received.database, received.instanceId).database;
  const before = canonical(generationContents(active, received.generation!), true);
  active.hypaV3Presets.reverse();
  assert.equal(canonical(generationContents(active, received.generation!), true), before);
  const resumed: any = continuePlaySet(active, received.instanceId).database;
  assert.equal(resumed.hypaV3Presets[resumed.hypaV3PresetId].name, 'source-memory');
  const own: any = leavePlaySet(resumed);
  assert.equal(own.hypaV3Presets[own.hypaV3PresetId].name, 'receiver-memory');
});

test('followup9: unrelated local reserved JSON keys cannot prevent import, continue or local restore', async () => {
  const { source } = sender(); const first = await snapshotPlaySet(source, selection);
  const target: any = receiver(); target.characters[0].scriptstate = JSON.parse('{"constructor":"local","__proto__":{"test":true}}');
  const received = await applyPlaySet(target, first.manifest, first.records, new Map(), 'reserved');
  const active = continuePlaySet(received.database, received.instanceId).database;
  const restored: any = leavePlaySet(active);
  assert.deepEqual(restored.characters[0].scriptstate, target.characters[0].scriptstate);
  assert.equal(({} as any).test, undefined);
});


test('round10: no selected preset is restored without fabricating a preset row', async () => {
  const { source } = sender(); const first = await snapshotPlaySet(source, selection);
  const target: any = receiver(); target.botPresetsId = -1;
  const received = await applyPlaySet(target, first.manifest, first.records, new Map(), 'no-preset');
  const count = (received.database.botPresets as any[]).length;
  const restored: any = leavePlaySet(continuePlaySet(received.database, received.instanceId).database);
  assert.equal(restored.botPresetsId, -1); assert.equal(restored.botPresets.length, count);
  assert.equal(restored.mainPrompt, target.mainPrompt); assert.equal(restored.openAIKey, target.openAIKey);
});
test('round10: live optional undefined memory values do not break ordinary preset save capture', async () => {
  const { source } = sender(); const first = await snapshotPlaySet(source, selection);
  const received = await applyPlaySet(receiver(), first.manifest, first.records, new Map(), 'undefined');
  const active: any = continuePlaySet(received.database, received.instanceId).database;
  active.hypaAllocatedTokens = undefined;
  assert.doesNotThrow(() => captureActivePlayContext(active, active.risuPlayActiveChat));
  const saved = JSON.parse(JSON.stringify(active));
  assert.equal(Object.hasOwn(saved.characters[1].chats[0].risuPlayContext.context, 'hypaAllocatedTokens'), false);
});


test('round11: per-chat literal staged media keeps its own aliases after the final character scan', async () => {
  const { source } = sender(); const db: any = source.database;
  db.characters[0].description = '<img src="assets/staged.png">';
  db.botPresets = [{ risuPlayId: 'p', name: 'p', mainPrompt: 'p' }];
  db.characters[0].chats = ['a','b'].map(k => ({id:k, message:[], risuPlayContext: {
    instanceId:'set',presetId:'p',context:{},modules:[],
    assets:{['assets/'+k+'.png']:'assets/local-'+k+'.png'}, resolvedAssets:{'assets/staged.png':'assets/local-'+k+'.png'}
  }}));
  source.asset = async path => new Blob([path]);
  const snap = await snapshotPlaySet(source,{...selection,chatIds:['a','b'],primaryChatId:'a'});
  const contexts = snap.manifest.items.filter(i=>i.kind==='context').map(i=>snap.records.get(i.entry) as any);
  assert.deepEqual(Object.keys(contexts[1].assets).sort(), ['assets/b.png','assets/staged.png']);
  const assets = new Map(snap.manifest.items.filter(i=>i.kind==='asset').map((i,n)=>[i.id,'assets/received-'+n+'.png']));
  const imported = await applyPlaySet(receiver(),snap.manifest,snap.records,assets,'literal');
  const chats = (imported.database.characters as any[])[1].chats;
  assert.notEqual(chats[0].risuPlayContext.assets['assets/staged.png'],chats[1].risuPlayContext.assets['assets/staged.png']);
  for (const chat of chats) assert.ok(String(chat.risuPlayContext.assets['assets/staged.png']).startsWith('assets/received-'));
});

test('round11: directly opened group members retain media/inlay defaults and their module IDs', async () => {
  const { source } = sender(); const db: any = source.database;
  db.characters[0].type = 'group'; db.characters[0].characters = ['member'];
  db.characters.push({ chaId:'member', name:'member', description:'<img src="assets/member.png"> {{inlay::member}}', modules:['member-module'], chats:[] });
  db.modules.push({id:'member-module',name:'member module'});
  source.asset=async path=>new Blob([path]); source.inlay=async id=>({metadata:{type:'image'},data:new Blob([id])});
  const snap=await snapshotPlaySet(source,selection);
  const assets=new Map(snap.manifest.items.filter(i=>i.kind==='asset').map((i,n)=>[i.id,'assets/imported-'+n+'.png']));
  const received=await applyPlaySet(receiver(),snap.manifest,snap.records,assets,'member-media');
  const member=(received.database.characters as any[]).find(c=>c.name==='member');
  assert.ok(member.risuPlayDefaults.assets['assets/member.png'].startsWith('assets/imported-'));
  assert.ok(member.risuPlayDefaults.inlays.member);
  assert.ok(member.risuPlayDefaults.modules.includes(member.modules[0]));
});

test('round11: an existing empty preset slot is retained across received-set activation', async () => {
  const { source }=sender();const snap=await snapshotPlaySet(source,selection);const db:any=receiver();db.botPresets=[{}];db.botPresetsId=0;
  const received=await applyPlaySet(db,snap.manifest,snap.records,new Map(),'empty-preset');
  const resumed:any=leavePlaySet(continuePlaySet(received.database,received.instanceId).database);
  assert.equal(resumed.botPresetsId,0);assert.equal(resumed.botPresets.length,2);
});


test('round12: shared scoped and legacy contexts split without losing either chat on re-export', async () => {
  for (const legacy of [false,true]) {
    const { source }=sender(); const db:any=source.database;
    db.characters[0].chats.push({id:'second',message:[{data:'second'}]});
    const snap=await snapshotPlaySet(source,{...selection,chatIds:['chat','second']});
    const contexts=snap.manifest.items.filter(i=>i.kind==='context');
    snap.manifest.items=snap.manifest.items.filter(i=>i.kind!=='context'||i.id===contexts[0].id);
    for (const item of [...snap.manifest.items.filter(i=>i.kind==='chat')]) {
      const value:any=structuredClone(snap.records.get(item.entry));
      const refs=item.references.filter(r=>r.pointer!=='/playContext');
      if (legacy) delete value.playContext; else {value.playContext=contexts[0].id;refs.push({pointer:'/playContext',target:contexts[0].id});}
      const replacement=await recordItem(item.id,'chat',value,refs);
      snap.manifest.items[snap.manifest.items.indexOf(item)]=replacement;snap.records.set(replacement.entry,value);
    }
    snap.manifest.revision=await revisionOf(snap.manifest);
    const received=await applyPlaySet(receiver(),snap.manifest,snap.records,new Map(),'shared-'+legacy);
    const card=(received.database.characters as any[])[1];
    assert.equal(card.chats[0].risuPlayContext.contextId,card.chats[1].risuPlayContext.contextId);
    card.chats[0].risuPlayContext.context.globalChatVariables={value:'A'};
    card.chats[1].risuPlayContext.context.globalChatVariables={value:'B'};
    card.chats[0].risuPlayContext.context.hypaAllocatedTokens=100;
    card.chats[1].risuPlayContext.context.hypaAllocatedTokens=200;
    const sel={...selection,characterId:card.chaId,chatIds:card.chats.map(c=>c.id),primaryChatId:card.chats[0].id};
    const next=await snapshotPlaySet({...source,database:received.database},sel);
    assert.equal(next.manifest.items.filter(i=>i.kind==='context').length,2);
    validateRecords(next.manifest,next.records);
    const imported=await applyPlaySet(receiver(),next.manifest,next.records,new Map(),'split-'+legacy);
    const chats=(imported.database.characters as any[])[1].chats;
    assert.deepEqual(chats.map(c=>c.risuPlayContext.context.globalChatVariables.value),['A','B']);
    assert.deepEqual(chats.map(c=>c.risuPlayContext.context.hypaAllocatedTokens),[100,200]);
    const recorded=await recordExport(received.database,next);
    const unchanged=await snapshotPlaySet({...source,database:recorded},sel);
    assert.equal(unchanged.manifest.revision,next.manifest.revision);
    const reversed=await snapshotPlaySet({...source,database:received.database},{...sel,chatIds:[...sel.chatIds].reverse()});
    assert.deepEqual(next.manifest.items.filter(i=>i.kind==='context').map(i=>i.id).sort(),reversed.manifest.items.filter(i=>i.kind==='context').map(i=>i.id).sort());
  }
});

test('round12: a scoped set without memory preset never adopts an unrelated global preset', async () => {
  const {source}=sender();const snap=await snapshotPlaySet(source,selection);
  const received=await applyPlaySet(receiver(),snap.manifest,snap.records,new Map(),'no-memory-preset');
  received.database.hypaV3Presets=[{name:'unrelated',settings:{prompt:'local only'}}];received.database.hypaV3PresetId=0;
  const card=(received.database.characters as any[])[1];
  const again=await snapshotPlaySet({...source,database:received.database},{...selection,characterId:card.chaId,chatIds:[card.chats[0].id],primaryChatId:card.chats[0].id});
  for(const item of again.manifest.items.filter(i=>i.kind==='context'))assert.equal(Object.hasOwn(again.records.get(item.entry)!,'hypaV3Preset'),false);
});

test('round12: a group member sent alone starts its own set and then reuses its own provenance', async () => {
  const {source}=sender();const db:any=source.database;db.characters[0].type='group';db.characters[0].characters=['member'];
  db.characters.push({chaId:'member',name:'member',chats:[]});
  const group=await snapshotPlaySet(source,selection);const received=await applyPlaySet(receiver(),group.manifest,group.records,new Map(),'group');
  const member=(received.database.characters as any[]).find(c=>c.name==='member');
  const sel={characterId:member.chaId,chatIds:[member.chats[0].id],primaryChatId:member.chats[0].id,setId:'independent-member'};
  const first=await snapshotPlaySet({...source,database:received.database},sel);
  assert.equal(first.manifest.setId,'independent-member');assert.equal(first.manifest.parent,null);
  const recorded=await recordExport(received.database,first);
  const second=await snapshotPlaySet({...source,database:recorded},{...sel,setId:'new-random-request-id'});
  assert.equal(second.manifest.setId,'independent-member');assert.equal(second.manifest.revision,first.manifest.revision);
});


test('explicit memory picker updates received scope, survives reorder, exports choice and leaves other scopes alone', async () => {
  const {source}=sender();const db:any=source.database;
  db.hypaV3Presets=[{name:'sender-memory',settings:{summarizationPrompt:'sender'}}];db.hypaV3PresetId=0;
  const snapshot=await snapshotPlaySet(source,selection);const target:any=receiver();
  target.hypaV3Presets=[{name:'chosen-local-memory',settings:{summarizationPrompt:'chosen'}}];target.hypaV3PresetId=0;
  const imported=await applyPlaySet(target,snapshot.manifest,snapshot.records,new Map(),'picker');
  const active:any=continuePlaySet(imported.database,imported.instanceId).database;const card=active.characters[1];
  selectPlaySetMemoryPreset(active,card.chaId,0);
  const scope=card.chats[0].risuPlayContext;
  assert.equal(active.hypaV3Presets.find(p=>p.risuPlayMemoryId===scope.hypaV3PresetKey).name,'chosen-local-memory');
  active.hypaV3Presets.reverse();
  const resumed:any=continuePlaySet(active,imported.instanceId).database;
  assert.equal(resumed.hypaV3Presets[resumed.hypaV3PresetId].name,'chosen-local-memory');
  const output=await snapshotPlaySet({...source,database:resumed},{...selection,characterId:card.chaId,chatIds:[card.chats[0].id],primaryChatId:card.chats[0].id});
  const context:any=output.records.get(output.manifest.items.find(i=>i.kind==='context')!.entry);
  assert.equal(context.hypaV3Preset.name,'chosen-local-memory');
  const before=canonical(scope.context);
  selectPlaySetMemoryPreset(active,active.characters[0].chaId,0);
  assert.equal(canonical(scope.context),before);
});

test('explicit memory selection can initialize a received scope with no memory preset', async () => {
  const {source}=sender();const snap=await snapshotPlaySet(source,selection);const target:any=receiver();
  target.hypaV3Presets=[{name:'explicit-choice',settings:{}}];target.hypaV3PresetId=0;
  const result=await applyPlaySet(target,snap.manifest,snap.records,new Map(),'memory-enable');
  const db:any=result.database;const card=db.characters[1];
  assert.equal(card.chats[0].risuPlayContext.context.hypaV3Preset,undefined);
  selectPlaySetMemoryPreset(db,card.chaId,0);
  assert.equal(card.chats[0].risuPlayContext.context.hypaV3Preset.name,'explicit-choice');
});

test('round13: local exports use live prompt after received-set activation with several presets', async () => {
  const {source}=sender();const snap=await snapshotPlaySet(source,selection);const target:any=receiver();
  target.botPresets.push({name:'never-selected',mainPrompt:'wrong'});
  const imported=await applyPlaySet(target,snap.manifest,snap.records,new Map(),'preset-origin');
  const active:any=continuePlaySet(imported.database,imported.instanceId).database;
  const local:any=leavePlaySet(active);local.mainPrompt='local-live';
  const exported=await snapshotPlaySet({...source,database:local},{characterId:'existing',chatIds:['old'],primaryChatId:'old',setId:'own-local'});
  const preset:any=exported.records.get(exported.manifest.items.find(i=>i.kind==='preset')!.entry);
  assert.equal(preset.mainPrompt,'local-live');assert.equal(preset.name,'기존 프리셋');
});

test('round13: active linear update retains received memory until explicit continue without switching live settings', async () => {
  const {source}=sender();const db:any=source.database;db.memoryAlgorithmType='old';db.hypaAllocatedTokens=100;
  const first=await snapshotPlaySet(source,selection);const received=await applyPlaySet(receiver(),first.manifest,first.records,new Map(),'memory-old');
  const active:any=continuePlaySet(received.database,received.instanceId).database;
  db.memoryAlgorithmType='new';db.hypaAllocatedTokens=200;
  const second=await snapshotPlaySet(source,selection,first.manifest);
  const updated=await applyPlaySet(active,second.manifest,second.records,new Map(),'memory-new');assert.equal(updated.mode,'update');
  const result:any=updated.database;assert.equal(result.memoryAlgorithmType,'old');
  captureActivePlayContext(result);
  const card=result.characters[1],scope=card.chats[0].risuPlayContext;
  assert.equal(scope.context.memoryAlgorithmType,'new');assert.equal(scope.context.hypaAllocatedTokens,200);
  const output=await snapshotPlaySet({...source,database:result},{...selection,characterId:card.chaId,chatIds:[card.chats[0].id],primaryChatId:card.chats[0].id});
  const context:any=output.records.get(output.manifest.items.find(i=>i.kind==='context')!.entry);assert.equal(context.memoryAlgorithmType,'new');
  const resumed:any=continuePlaySet(result,updated.instanceId).database;
  assert.equal(resumed.memoryAlgorithmType,'new');assert.equal(resumed.hypaAllocatedTokens,200);
  db.hypaAllocatedTokens=300;const third=await snapshotPlaySet(source,selection,second.manifest);
  assert.equal((await applyPlaySet(resumed,third.manifest,third.records,new Map(),'memory-third')).mode,'update');
});

test('round13: returning to local memory preset reuses stable identity after edits and reorder', async () => {
  const {source}=sender();const snap=await snapshotPlaySet(source,selection);const target:any=receiver();
  target.hypaV3Presets=[{name:'own-memory',settings:{prompt:'before'}}];target.hypaV3PresetId=0;
  const received=await applyPlaySet(target,snap.manifest,snap.records,new Map(),'memory-origin');
  const active:any=continuePlaySet(received.database,received.instanceId).database;
  active.hypaV3Presets[0].settings.prompt='edited';active.hypaV3Presets.unshift({name:'other',settings:{}});
  const restored:any=leavePlaySet(active);assert.equal(restored.hypaV3Presets.length,2);
  assert.equal(restored.hypaV3Presets[restored.hypaV3PresetId].settings.prompt,'edited');
});

test('round13: character IDs containing colon retain actual chat identity on export', async () => {
  const {source}=sender();const db:any=source.database;db.characters[0].chaId='imported:card';db.characters[0].chats[0].id='chat:part';
  const sel={...selection,characterId:'imported:card',chatIds:['chat:part'],primaryChatId:'chat:part'};
  const snap=await snapshotPlaySet(source,sel);assert.equal(snap.localIds.get(snap.manifest.primaryChat),'chat:part');
  const recorded=await recordExport(db,snap);const again=await snapshotPlaySet({...source,database:recorded},sel);
  assert.equal(again.manifest.revision,snap.manifest.revision);
});

test('round14: content revert restores known ancestry and remains importable duplicate', async () => {
 const {source}=sender();const first=await snapshotPlaySet(source,selection);source.database=await recordExport(source.database,first);
 const db:any=source.database;db.characters[0].chats[0].message.push({data:'temporary edit'});
 const second=await snapshotPlaySet(source,selection);source.database=await recordExport(source.database,second);
 (source.database.characters as any[])[0].chats[0].message.pop();const reverted=await snapshotPlaySet(source,selection);
 assert.equal(reverted.manifest.revision,first.manifest.revision);assert.deepEqual(reverted.manifest,first.manifest);validateRecords(reverted.manifest,reverted.records);
 const received=await applyPlaySet(receiver(),first.manifest,first.records,new Map(),'first-revert');
 assert.equal((await applyPlaySet(received.database,reverted.manifest,reverted.records,new Map(),'reverted')).mode,'duplicate');
});

test('round14: editing live memory after pending update survives capture and branches a subsequent arrival', async () => {
 const {source}=sender();const db:any=source.database;db.hypaAllocatedTokens=100;
 const first=await snapshotPlaySet(source,selection);const initial=await applyPlaySet(receiver(),first.manifest,first.records,new Map(),'pending-a');
 const active=continuePlaySet(initial.database,initial.instanceId).database;
 db.hypaAllocatedTokens=200;const second=await snapshotPlaySet(source,selection,first.manifest);
 const updated=await applyPlaySet(active,second.manifest,second.records,new Map(),'pending-b');assert.equal(updated.mode,'update');
 updated.database.hypaAllocatedTokens=450;
 db.hypaAllocatedTokens=300;const third=await snapshotPlaySet(source,selection,second.manifest);
 assert.equal((await applyPlaySet(updated.database,third.manifest,third.records,new Map(),'pending-c')).mode,'branch');
 captureActivePlayContext(updated.database);assert.equal((updated.database.characters as any[])[1].chats[0].risuPlayContext.context.hypaAllocatedTokens,450);
 assert.equal(continuePlaySet(updated.database,updated.instanceId).database.hypaAllocatedTokens,450);
});

test('round14: engine and settings resolve scoped row after global selection changes; absent preset uses runtime default', async () => {
 const {source}=sender();const snap=await snapshotPlaySet(source,selection);const local:any=receiver();local.hypaV3Presets=[{name:'local',settings:{}},{name:'chosen',settings:{}}];local.hypaV3PresetId=0;
 const received=await applyPlaySet(local,snap.manifest,snap.records,new Map(),'resolver');const db:any=received.database,card=db.characters[1];
 assert.equal(resolvePlaySetMemoryPreset(db,card.chaId)?.name,'local');
 selectPlaySetMemoryPreset(db,card.chaId,1);db.hypaV3PresetId=0;
 const actual=resolvePlaySetMemoryPreset(db,card.chaId)!;assert.equal(actual.name,'chosen');actual.name='edited-chosen';
 assert.equal(db.hypaV3Presets[1].name,'edited-chosen');assert.equal(db.hypaV3Presets[0].name,'local');
});

test('round15: damaged historical manifest cannot replace a valid freshly collected reverted graph', async () => {
 const {source}=sender();const first=await snapshotPlaySet(source,selection);source.database=await recordExport(source.database,first);
 (source.database.characters as any[])[0].chats[0].message.push({data:'temporary'});
 const second=await snapshotPlaySet(source,selection);source.database=await recordExport(source.database,second);
 (source.database.characters as any[])[0].chats[0].message.pop();
 const history:any=(source.database.risuPlaySets as any).generations;history[0].manifest.items=[];
 const reverted=await snapshotPlaySet(source,selection);assert.equal(reverted.manifest.revision,first.manifest.revision);assert.equal(reverted.manifest.parent,null);validateRecords(reverted.manifest,reverted.records);
});

test('round17: activation never stamps the caller shared template object', async()=>{
 const {source}=sender();const snap=await snapshotPlaySet(source,selection);const template={name:'shared-default'};const local:any=receiver();local.botPresets=[template];
 const received=await applyPlaySet(local,snap.manifest,snap.records,new Map(),'shared-template');received.database.botPresets=[template,...(received.database.botPresets as any[]).slice(1)];
 const active:any=continuePlaySet(received.database,received.instanceId).database;
 assert.equal((template as any).risuPlayId,undefined);assert.notEqual(active.botPresets[0],template);assert.equal(typeof active.botPresets[0].risuPlayId,'string');
});

test('round17: explicit chat identity resolves memory independently of viewed chat',()=>{
 const db:any={characters:[{chaId:'card',chatPage:1,chats:[{id:'running',risuPlayContext:{context:{hypaV3Preset:{name:'running-memory'}}}},{id:'viewed',risuPlayContext:{context:{hypaV3Preset:{name:'viewed-memory'}}}}]}]};
 assert.equal(resolvePlaySetMemoryPreset(db,'card','running')?.name,'running-memory');assert.equal(resolvePlaySetMemoryPreset(db,'card')?.name,'viewed-memory');
});

test('round18: invalid memory batch settings are reported before export and rejected before import', async()=>{
 const {source}=sender();const db:any=source.database;
 for(const preset of [{name:'bad'},{name:'bad',settings:{maxChatsPerSummary:0}},{name:'bad',settings:{maxChatsPerSummary:-1}},{name:'bad',settings:{maxChatsPerSummary:0.5}}]){
  db.hypaV3Presets=[preset];db.hypaV3PresetId=0;
  const snap=await snapshotPlaySet(source,selection);assert.ok(snap.missing.some(x=>x.path.includes('hypaV3Preset')));
  await assert.rejects(applyPlaySet(receiver(),snap.manifest,snap.records,new Map(),'malformed-memory'),/Invalid.*settings/);
 }
});



test('reserved and escape-prefix keys roundtrip without prototype setters or state loss', async()=>{
 const {source}=sender();const db:any=source.database;
 const state=JSON.parse('{"__proto__":{"polluted":"no"},"constructor":{"image":"assets/test.png"},"prototype":"kept","$risu$key:prototype":"literal prefix"}');
 db.characters[0].chats[0].scriptstate=state;db.globalChatVariables=JSON.parse('{"prototype":"global kept"}');source.asset=async()=>new Blob(['image']);
 const before=JSON.stringify(db);const snap=await snapshotPlaySet(source,selection);assert.deepEqual(snap.missing,[]);assert.equal(snap.manifest.recordEncoding,'escaped-keys-v1');
 validateRecords(snap.manifest,snap.records);for(const value of snap.records.values())canonical(value);
 assert.ok(snap.manifest.items.some(i=>i.references.some(r=>r.pointer.includes('$risu$key:constructor'))));
 const assets=new Map(snap.manifest.items.filter(i=>i.kind==='asset').map(i=>[i.id,'assets/local.png']));
 const received=await applyPlaySet(receiver(),snap.manifest,snap.records,assets,'escaped');const card=(received.database.characters as any[])[1];
 const result=card.chats[0].scriptstate;assert.equal(result.__proto__.polluted,'no');assert.equal(Object.getPrototypeOf(result),Object.prototype);assert.equal(({} as any).polluted,undefined);assert.equal(result.constructor.image,'assets/local.png');assert.equal(result.prototype,'kept');assert.equal(result['$risu$key:prototype'],'literal prefix');
 assert.equal(card.chats[0].risuPlayContext.context.globalChatVariables.prototype,'global kept');assert.equal(JSON.stringify(db),before);
 const again=await snapshotPlaySet({...source,database:received.database},{...selection,characterId:card.chaId,chatIds:[card.chats[0].id],primaryChatId:card.chats[0].id});validateRecords(again.manifest,again.records);
 assert.deepEqual(decodeRecordKeys(encodeRecordKeys(state)),state);
 assert.throws(()=>decodeRecordKeys({'$risu$key:ordinary':'ambiguous'}),/Invalid escaped/);
 assert.throws(()=>canonical(JSON.parse('{"__proto__":1}')),/Unsafe JSON/);
});

test('an explicitly id-less running chat never borrows a different viewed received chat memory scope',()=>{
 const db:any={characters:[{chaId:'c',chatPage:1,chats:[{message:[]},{id:'viewed',risuPlayContext:{instanceId:'received',hypaV3PresetKey:'received-key',context:{}}}]}],hypaV3Presets:[{name:'local',settings:{}},{name:'received',risuPlayMemoryId:'received-key',settings:{}}],hypaV3PresetId:0};
 assert.equal(resolvePlaySetMemoryPreset(db,'c',null)?.name,'local');
 assert.equal(resolvePlaySetMemoryPreset(db,'c')?.name,'received');
});
