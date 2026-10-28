import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, hashBytes, hashJson, recordItem, revisionOf, remapRecord, validateManifest, verifyArchive, workspacePath, type Manifest, type Json, type FileBlock } from './protocol.ts';
import { ImportQueue, ImportBusy, decideImport, type ImportStore, type ImportHost, type QueueEntry, type Journal, type Generation } from './importer.ts';

async function fixture() {
  const character = { chaId: 'origin.card', chats: ['origin.chat'], modules: [], chatPage: 0, name: '같은 이름', scriptstate: { day: 4 }, globalLore: [{ content: '원문' }], image: 'origin.image' };
  const chat = { id: 'origin.chat', message: [{ role: 'char', data: '본문 {{inlay::pic}}' }], scriptstate: { lua: 'return "card"', count: 9 }, hypaV3Data: { summaries: ['기억'] }, GLGlobalVariables: { clock: 55 }, modules: ['origin.module'], bindedPersona: 'origin.persona' };
  const module = { id: 'origin.module', name: 'Life', trigger: [{ code: 'return "card"' }] };
  const persona = { id: 'origin.persona', name: '플레이어', personaPrompt: '설정' };
  const image = new Uint8Array([137, 80, 78, 71, 0, 1, 255]);
  const imageHash = await hashBytes(image);
  const values = new Map<string, Json>([['origin.card', character], ['origin.chat', chat], ['origin.module', module], ['origin.persona', persona], ['origin.preset', {}], ['origin.context', { assets: {}, inlays: {} }]]);
  const items = await Promise.all([
    recordItem('origin.card', 'character', character, [{ pointer: '/image', target: 'origin.image' }, { pointer: '/chats/0', target: 'origin.chat' }]),
    recordItem('origin.chat', 'chat', chat, [{ pointer: '/modules/0', target: 'origin.module' }, { pointer: '/bindedPersona', target: 'origin.persona' }]),
    recordItem('origin.module', 'module', module), recordItem('origin.persona', 'persona', persona), recordItem('origin.preset', 'preset', {}), recordItem('origin.context', 'context', { assets: {}, inlays: {} }),
  ]);
  items.push({ id: 'origin.image', kind: 'asset', hash: imageHash, parent: null, entry: `blobs/${imageHash}`, bytes: image.length, references: [] });
  const manifest: Manifest = { format: 'risuplay', version: 1, origin: 'origin', setId: 'origin.set', revision: '', parent: null, primaryCharacter: 'origin.card', primaryChat: 'origin.chat', items, ancestors: [] };
  manifest.revision = await revisionOf(manifest);
  const bytes = new Map(items.map(item => [item.entry, item.kind === 'asset' ? image : new TextEncoder().encode(canonical(values.get(item.id)!))]));
  const archive = {
    entries: async () => [{ name: 'manifest.json', bytes: 1 }, ...items.map(i => ({ name: i.entry, bytes: i.bytes }))],
    readRecord: async (entry: string) => bytes.get(entry)!,
    digestEntry: async (entry: string) => hashBytes(bytes.get(entry)!),
    availableBytes: async () => 1_000_000_000,
  };
  return { manifest, archive, values, bytes };
}

test('record and binary roundtrip preserve nested gameplay fields and only remap declared refs', async () => {
  const { manifest, archive, values } = await fixture();
  const records = await verifyArchive(manifest, archive);
  for (const item of manifest.items.filter(i => i.kind !== 'asset')) assert.deepEqual(records.get(item.entry), values.get(item.id));
  const item = manifest.items[1];
  const output = remapRecord(records.get(item.entry)!, item.references, new Map([['origin.module', 'new-module'], ['origin.persona', 'new-persona']])) as Record<string, Json>;
  assert.deepEqual(output.modules, ['new-module']);
  assert.equal(output.bindedPersona, 'new-persona');
  assert.deepEqual(output.scriptstate, { lua: 'return "card"', count: 9 });
  assert.deepEqual(output.message, [{ role: 'char', data: '본문 {{inlay::pic}}' }]);
});
test('deterministic revision and previous revision are distinct', async () => {
  const { manifest } = await fixture();
  assert.equal(await revisionOf({ ...manifest, parent: 'a'.repeat(64) }), manifest.revision);
  assert.equal(await revisionOf({ ...manifest, items: manifest.items.toReversed() }), manifest.revision);
});

async function bardFixture() {
  const f = await fixture();
  const file = async (path: string, data: string): Promise<FileBlock> => {
    const bytes = new TextEncoder().encode(data), hash = await hashBytes(bytes), entry = `blobs/${hash}`;
    f.bytes.set(entry, bytes); return { path, hash, entry, bytes: bytes.length };
  };
  const wiki = await file('wiki/locations/test.md', '---\nsource_messages: ["message-1"]\n---\n기억 원문');
  const page = { ...wiki, path: `${wiki.hash.slice(0, 2)}/${wiki.hash}` };
  f.manifest.version = 2;
  f.manifest.bard = [{ character: 'origin.card', chat: 'origin.chat', sourceCharacterId: 'card', sourceChatId: 'chat',
    files: [wiki], slots: [{ sourceId: 'slot', files: [await file('chat.bin', 'binary chat'), await file('risubard-save.json', '{"schemaVersion":2}'), await file('risubard-save-files.json', JSON.stringify([{path:wiki.path,hash:wiki.hash,size:wiki.bytes}]))], pages: [page] }] }];
  f.manifest.revision = await revisionOf(f.manifest);
  f.archive.entries = async () => [{ name: 'manifest.json', bytes: 1 }, ...[...f.bytes].map(([name, bytes]) => ({ name, bytes: bytes.length }))];
  return f;
}

test('v2 verifies binary/wiki/slot pages once per content address and includes them in revision', async () => {
  const { manifest, archive, bytes } = await bardFixture();
  const records = await verifyArchive(manifest, archive);
  assert.equal(records.size, manifest.items.filter(item => item.kind !== 'asset').length);
  const reordered = structuredClone(manifest);
  reordered.bard![0].slots[0].files.reverse();
  assert.equal(await revisionOf(reordered), manifest.revision);
  const changed = structuredClone(manifest); changed.bard![0].slots[0].sourceId = 'another-slot';
  assert.notEqual(await revisionOf(changed), manifest.revision);
  const path = manifest.bard![0].files[0].entry;
  bytes.set(path, new TextEncoder().encode('corrupted wiki'));
  await assert.rejects(verifyArchive(manifest, archive), /size|Damaged/);
});

test('v2 rejects missing workspace owners, unsafe paths, conflicting aliases and incomplete slots before writes', async () => {
  const { manifest, archive } = await bardFixture();
  for (const change of [
    (m: Manifest) => { m.bard = []; },
    (m: Manifest) => { m.bard![0].character = 'origin.module'; },
    (m: Manifest) => { m.version = 1; },
    (m: Manifest) => { m.bard![0].slots[0].files.pop(); },
    (m: Manifest) => { m.bard![0].files.push({ ...m.bard![0].files[0], path: 'WIKI/locations/TEST.MD' }); },
    (m: Manifest) => { m.bard![0].files.push({ ...m.bard![0].files[0], path: 'wiki' }); },
    (m: Manifest) => { m.bard![0].slots[0].pages[0].bytes++; },
    (m: Manifest) => { m.bard![0].slots[0].pages[0].path = 'wrong-page'; },
  ]) { const value = structuredClone(manifest); change(value); assert.throws(() => validateManifest(value)); }
  for (const path of ['../a', '/absolute', 'C:/file', 'a\\b', 'a//b', 'x/CON.md', 'trailing.', 'a:b', 'a?.md']) assert.throws(() => workspacePath(path));
  assert.equal(workspacePath('wiki/locations/한글.md'), 'wiki/locations/한글.md');
  await assert.rejects(verifyArchive(manifest, { ...archive, availableBytes: async () => 0 }), /storage/);
  const missing = manifest.bard![0].slots[0].files[0].entry;
  await assert.rejects(verifyArchive(manifest, { ...archive, entries: async () => (await archive.entries()).filter(file => file.name !== missing) }), /Incomplete/);
});
test('reject missing dependencies, wrong selection, traversal, duplicate ids, bad pointers and unsafe JSON keys', async () => {
  const { manifest } = await fixture();
  for (const change of [
    (m: Manifest) => { m.items[0].references[0].target = 'missing'; },
    (m: Manifest) => { m.primaryChat = 'origin.image'; },
    (m: Manifest) => { m.items[0].entry = '../../database.bin'; },
    (m: Manifest) => { m.items[1].id = m.items[0].id; },
    (m: Manifest) => { m.items[0].references[0].pointer = '/__proto__/polluted'; },
  ]) { const copy = structuredClone(manifest); change(copy); assert.throws(() => validateManifest(copy)); }
  assert.throws(() => canonical(JSON.parse('{"__proto__":{"polluted":true}}')));
  assert.throws(() => canonical({ x: NaN }));
});
test('corruption, disk exhaustion, unexpected/missing ZIP member, digest mismatch fail before apply', async () => {
  const { manifest, archive } = await fixture();
  await assert.rejects(verifyArchive(manifest, { ...archive, availableBytes: async () => 0 }), /storage/);
  await assert.rejects(verifyArchive(manifest, { ...archive, digestEntry: async () => '0'.repeat(64) }), /Damaged/);
  await assert.rejects(verifyArchive(manifest, { ...archive, entries: async () => (await archive.entries()).slice(0, -1) }), /Incomplete/);
  await assert.rejects(verifyArchive(manifest, { ...archive, entries: async () => [...await archive.entries(), { name: 'extra', bytes: 1 }] }), /Invalid/);
  await assert.rejects(verifyArchive(manifest, { ...archive, entries: async () => [...await archive.entries(), (await archive.entries())[1]] }), /Duplicate/);
  await assert.rejects(verifyArchive({ ...manifest, revision: '0'.repeat(64) }, archive), /revision/);
});
test('repeat, linear successor, actual divergence and same-name unrelated resources', async () => {
  const { manifest, values } = await fixture();
  const current = Object.fromEntries(values);
  const g: Generation = { setId: manifest.setId, revision: manifest.revision, parent: null, instanceId: 'instance', appliedHash: await hashJson(current), manifest, ids: {} };
  assert.equal((await decideImport(manifest, [g], async () => ({ edited: true }))).mode, 'duplicate');
  const successor = { ...manifest, parent: manifest.revision, revision: 'b'.repeat(64), ancestors: [manifest.revision] };
  assert.equal((await decideImport(successor, [g], async () => current)).mode, 'update');
  assert.equal((await decideImport({ ...successor, parent: 'c'.repeat(64), ancestors: ['c'.repeat(64), manifest.revision] }, [g], async () => current)).mode, 'update');
  assert.equal((await decideImport(successor, [g], async () => ({ edited: true }))).mode, 'branch');
  assert.equal((await decideImport({ ...successor, setId: 'other.set' }, [g], async () => current)).mode, 'new');
});

async function diskStore() {
  const dir = await mkdtemp(join(tmpdir(), 'risuplay-test-'));
  const atomic = async (name: string, value: unknown) => { const path = join(dir, name); await writeFile(path + '.tmp', JSON.stringify(value)); await rename(path + '.tmp', path); };
  await atomic('queue.json', []); await atomic('journal.json', null);
  const store: ImportStore = {
    readQueue: async () => JSON.parse(await readFile(join(dir, 'queue.json'), 'utf8')),
    writeQueue: q => atomic('queue.json', q),
    readJournal: async () => JSON.parse(await readFile(join(dir, 'journal.json'), 'utf8')),
    writeJournal: j => atomic('journal.json', j),
  };
  return { store, atomic, dir };
}
const incoming = (id: string): QueueEntry => ({ id, fileHandle: id, state: 'received', receivedAt: 1, trustedDevice: 'paired' });
test('queue persists while generation is busy, new process imports once and confirms saved marker', async () => {
  const { store, atomic, dir } = await diskStore();
  let busy = true, applied = 0;
  const host: ImportHost = {
    busy: () => busy, prepare: async () => ({ restoreHandle: 'snapshot', duplicate: false }),
    apply: async (_file, tx) => { applied++; await atomic('db.json', { tx, result: 'instance' }); return 'instance'; },
    committed: async tx => { try { const d = JSON.parse(await readFile(join(dir, 'db.json'), 'utf8')); return d.tx === tx ? d.result : null; } catch { return null; } },
    restore: async () => {},
  };
  const first = new ImportQueue(store, host);
  await Promise.all([first.enqueue(incoming('a')), first.enqueue(incoming('b'))]);
  await first.drain(); assert.equal(applied, 0);
  busy = false;
  await new ImportQueue(store, host).drain();
  assert.equal(applied, 2); assert.ok((await store.readQueue()).every(q => q.state === 'applied'));
  await new ImportQueue(store, host).drain(); assert.equal(applied, 2);
});
test('crash before commit rolls back; crash after durable commit acknowledges without overwrite', async () => {
  for (const committed of [false, true]) {
    const { store } = await diskStore(); let restored = 0;
    await store.writeQueue([{ ...incoming('a'), state: 'applying' }]);
    const journal: Journal = { id: 'tx', queueId: 'a', phase: 'prepared', restoreHandle: 'prior' };
    await store.writeJournal(journal);
    const host: ImportHost = { busy: () => false, prepare: async () => { throw new Error(); }, apply: async () => { throw new Error(); }, committed: async () => committed ? 'instance' : null, restore: async () => { restored++; } };
    await new ImportQueue(store, host).recover();
    assert.equal((await store.readQueue())[0].state, committed ? 'applied' : 'waiting');
    assert.equal(restored, committed ? 0 : 1); assert.equal(await store.readJournal(), null);
  }
});
test('cancellation during verification remains cancelled and does not modify application', async () => {
  const { store } = await diskStore(); let applied = false;
  let queue: ImportQueue;
  const host: ImportHost = { busy: () => false,
    prepare: async () => { await queue.cancel('a'); return { restoreHandle: 'prior', duplicate: false }; },
    apply: async () => { applied = true; return 'x'; }, committed: async () => null, restore: async () => {},
  };
  queue = new ImportQueue(store, host); await queue.enqueue(incoming('a')); await queue.drain();
  assert.equal((await store.readQueue())[0].state, 'cancelled'); assert.equal(applied, false);
});

test('journal reconstructs a missing queue row and retains unresolved rollback evidence', async () => {
  const { store } = await diskStore();
  const journal: Journal = { id: 'tx', queueId: 'a', phase: 'committed', restoreHandle: 'prior', entry: incoming('a') };
  await store.writeJournal(journal); let fail = true;
  const host: ImportHost = { busy: () => false, prepare: async () => { throw new Error(); }, apply: async () => { throw new Error(); }, committed: async () => null, restore: async () => { if (fail) throw new Error('conflict'); } };
  const queue = new ImportQueue(store, host);
  await assert.rejects(queue.recover(), /conflict/); assert.deepEqual(await store.readJournal(), journal);
  assert.equal((await store.readQueue())[0].fileHandle, 'a'); fail = false;
  await queue.recover(); assert.equal((await store.readQueue())[0].state, 'waiting'); assert.equal(await store.readJournal(), null);
});

test('generation winning admission keeps a durable waiting item and recovers on the next safe poll', async () => {
  const { store } = await diskStore(); let first = true, committed: string | null = null, restores = 0;
  const host: ImportHost = { busy: () => false, prepare: async () => ({ restoreHandle: 'stage', duplicate: false }),
    apply: async () => { if (first) { first = false; throw new ImportBusy(); } committed = 'instance'; return committed; },
    committed: async () => committed, restore: async () => { restores++; } };
  const queue = new ImportQueue(store, host); await queue.enqueue(incoming('race')); await queue.drain();
  assert.equal((await store.readQueue())[0].state, 'waiting'); assert.ok(await store.readJournal()); assert.equal(restores, 0);
  await queue.drain(); assert.equal((await store.readQueue())[0].state, 'applied'); assert.equal(restores, 1); assert.equal(await store.readJournal(), null);
});

test('recovery journal prevents cancellation while a missing queue row is reconstructed', async () => {
 const {store}=await diskStore();const entry=incoming('reconstruct');await store.writeJournal({id:'tx',queueId:entry.id,phase:'committed',restoreHandle:'prior',entry});
 let queue:ImportQueue;const host:ImportHost={busy:()=>false,prepare:async()=>{throw new Error();},apply:async()=>{throw new Error();},restore:async()=>{},committed:async()=>{await assert.rejects(queue.cancel(entry.id),/Cannot cancel/);return 'instance';}};
 queue=new ImportQueue(store,host);await queue.recover();assert.equal((await store.readQueue())[0].state,'applied');
});

test('generation starting during recovery defers rollback without blocking recovery or dropping the journal', async()=>{
 const {store}=await diskStore();const entry=incoming('rollback-race');await store.writeQueue([entry]);await store.writeJournal({id:'tx',queueId:entry.id,phase:'prepared',restoreHandle:'prior',entry});
 let busy=false,pending=false,restores=0,prepares=0;const host:ImportHost={busy:()=>busy,recoveryState:value=>{pending=value;},prepare:async()=>{prepares++;return {restoreHandle:'prior',duplicate:false};},apply:async()=> 'instance',committed:async()=>null,restore:async()=>{restores++;busy=true;throw new ImportBusy();}};
 const queue=new ImportQueue(store,host);await queue.drain();assert.equal((await store.readQueue())[0].state,'waiting');assert.ok(await store.readJournal());assert.equal(pending,true);assert.equal(prepares,0);
 busy=false;host.restore=async()=>{restores++;};assert.equal(await queue.recover(),true);assert.equal(await store.readJournal(),null);assert.equal(pending,false);assert.equal(restores,2);
});

test('aggregate JSON working-set budget is checked before reading any record',async()=>{
 const {manifest,archive}=await fixture();const max=Math.max(...manifest.items.filter(i=>i.kind!=='asset').map(i=>i.bytes));let reads=0;
 await assert.rejects(verifyArchive(manifest,{...archive,recordBudgetBytes:max,readRecord:async(name)=>{reads++;return archive.readRecord(name);}}),/JSON memory budget/);assert.equal(reads,0);
});
