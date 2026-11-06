import { canonical, decodeRecordKeys, hashLocalJson, validateRecords, remapRecord, type Json, type Manifest } from './protocol.ts';
import { decideImport, type Generation, type ImportMode } from './importer.ts';
import { connectionFields, presetFields, memoryFields, type SnapshotResult } from './snapshot.ts';

type RecordValue = { [key: string]: Json };
export interface AppGeneration extends Generation { characterIds: string[]; moduleIds: string[]; personaIds: string[]; presetId: string; presetIds?: string[]; syntheticChatIds?: string[]; exported?: boolean; characterChats?: boolean; bardFingerprints?: Record<string, string> }
interface Registry { generations: AppGeneration[]; transactions: Record<string, string> }
const obj = (v: Json | undefined): RecordValue => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const arr = (v: Json | undefined): Json[] => Array.isArray(v) ? v : [];
const copy = <T>(v: T): T => v === undefined ? v : JSON.parse(JSON.stringify(v));

function registry(db: RecordValue): Registry {
  const value = obj(db.risuPlaySets);
  return { generations: (Array.isArray(value.generations) ? value.generations : []) as unknown as AppGeneration[], transactions: obj(value.transactions) as Record<string, string> };
}
function liveMemory(db: RecordValue): RecordValue {
  return Object.fromEntries(memoryFields.filter(k => db[k] !== undefined).map(k => [k, copy(db[k])]));
}
function canCaptureMemory(db: RecordValue, scope: RecordValue): boolean {
  return !scope.pendingActivation || canonical(liveMemory(db), true) !== canonical(scope.pendingLiveMemory ?? {}, true);
}
function portableMemoryPreset(value: Json | undefined): Json { const p = copy(obj(value)); delete p.risuPlayMemoryId; return p; }
export function generationContents(db: RecordValue, g: AppGeneration): Json {
  const livePreset = obj(arr(db.botPresets)[Number(db.botPresetsId)]).risuPlayId;
  const portablePreset = (g.presetIds ?? [g.presetId]).map(id => {
    const preset = copy(obj(arr(db.botPresets).find(p => obj(p).risuPlayId === id)));
    if (db.risuPlayActive === g.instanceId && livePreset === id) {
      for (const key of presetFields) if (Object.hasOwn(db, key)) preset[key] = copy(db[key]);
      for (const [to, from] of [['NAISettings', 'NAIsettings'], ['regex', 'presetRegex'], ['reasonEffort', 'reasoningEffort']]) if (Object.hasOwn(db, from)) preset[to] = copy(db[from]);
    }
    return Object.fromEntries(Object.entries(preset).filter(([key]) => !connectionFields.has(key)));
  });
  return {
    characters: g.characterIds.map(id => arr(db.characters).find(c => obj(c).chaId === id) ?? null).map(c => {
      const character = copy(obj(c)); delete character.chatPage;
      for (const chat of arr(character.chats)) {
        const scope = obj(obj(chat).risuPlayContext);
        if (canCaptureMemory(db, scope) && db.risuPlayActive === scope.instanceId && db.risuPlayActiveChat === obj(chat).id && livePreset === scope.presetId) {
          for (const key of memoryFields) { if (Object.hasOwn(db, key)) obj(scope.context)[key] = copy(db[key]); else delete obj(scope.context)[key]; }
        }
        delete scope.pendingActivation; delete scope.pendingLiveMemory;
        if (scope.hypaV3PresetKey !== undefined) {
          const context = obj(scope.context);
          context.hypaV3Preset = copy(arr(db.hypaV3Presets).find(p => obj(p).risuPlayMemoryId === scope.hypaV3PresetKey) ?? context.hypaV3Preset ?? null);
          delete obj(context.hypaV3Preset).risuPlayMemoryId; delete scope.hypaV3PresetKey; delete scope.hypaV3PresetId;
        }
      }
      delete obj(character.risuPlayDefaults).pendingActivation; delete obj(character.risuPlayDefaults).pendingLiveMemory;
      return character;
    }),
    modules: g.moduleIds.map(id => arr(db.modules).find(m => obj(m).id === id) ?? null),
    personas: g.personaIds.map(id => arr(db.personas).find(p => obj(p).id === id) ?? null),
    preset: g.characterChats ? null : g.exported ? Object.fromEntries([...presetFields, 'NAIsettings', 'presetRegex', 'reasoningEffort'].filter(k => !connectionFields.has(k) && Object.hasOwn(db, k)).map(k => [k, db[k]])) : portablePreset,
    originContext: g.characterChats ? (g.exported ? { globalChatVariables: db.globalChatVariables ?? {} } : null) : g.exported ? { hypaV3Preset: portableMemoryPreset(arr(db.hypaV3Presets)[Number(db.hypaV3PresetId)]), ...Object.fromEntries([...memoryFields, 'globalChatVariables', ...(g.personaIds.includes('current-effective-persona') ? ['username', 'personaPrompt', 'userIcon', 'largePortrait'] : [])].filter(k => Object.hasOwn(db, k)).map(k => [k, db[k]])) } : null,
  };
}
export interface ApplyResult { database: RecordValue; instanceId: string; mode: ImportMode; generation?: AppGeneration }
/**
 * Pure application mutation planner. The host stages assets and journals before publishing its result,
 * then invokes the app's save barrier. It never changes selection, provider configuration or global modules.
 */
export async function applyPlaySet(
  database: RecordValue, manifest: Manifest, records: ReadonlyMap<string, Json>,
  assetIds: ReadonlyMap<string, string>, transaction: string, journaledBardPlan = false,
): Promise<ApplyResult> {
  validateRecords(manifest, records);
  if (manifest.version === 2 && !journaledBardPlan) throw new Error('Bard v2 import requires the journaled memory receiver');
  const oldRegistry = registry(database);
  const decision = await decideImport(manifest, oldRegistry.generations.filter(g => !g.characterChats), async g => generationContents(database, g as AppGeneration));
  if (decision.mode === 'update' && decision.previous) {
    const prior = decision.previous as AppGeneration;
    const includedChats = new Set(manifest.items.filter(i => i.kind === 'chat').map(i => prior.ids[i.id]).filter(Boolean));
    for (const id of prior.syntheticChatIds ?? []) includedChats.add(id);
    if (arr(database.characters).some(c => prior.characterIds.includes(String(obj(c).chaId)) && arr(obj(c).chats).some(ch => !includedChats.has(String(obj(ch).id))))) {
      decision.mode = 'branch'; delete decision.previous;
    }
  }
  const db = copy(database), metadata = registry(db);
  if (decision.mode === 'duplicate') {
    const previous = metadata.generations.find(g => g.setId === manifest.setId && g.revision === manifest.revision)!;
    metadata.transactions[transaction] = previous.instanceId; db.risuPlaySets = metadata as unknown as Json;
    return { database: db, instanceId: previous.instanceId, mode: 'duplicate' };
  }
  const previous = decision.previous as AppGeneration | undefined;
  const instanceId = previous?.instanceId ?? crypto.randomUUID();
  const ids = new Map<string, string>(assetIds);
  for (const item of manifest.items) {
    if (item.kind === 'asset') {
      if (!ids.has(item.id)) throw new Error('Unstaged asset: ' + item.id);
    } else {
      // Changed dependency generations get separate IDs; old copies remain recoverable.
      const oldItem = previous?.manifest.items.find(old => old.id === item.id);
      const oldId = oldItem?.kind === item.kind ? previous?.ids[item.id] : undefined;
      ids.set(item.id, oldId && (['character', 'chat'].includes(item.kind) || item.kind !== 'inlay' && oldItem?.hash === item.hash && item.references.length === 0) ? oldId : crypto.randomUUID());
    }
  }
  // Reuse unchanged dependency copies only when every resolved target also stays identical.
  if (previous) for (let pass = 0; pass < manifest.items.length; pass++) {
    let changed = false;
    for (const item of manifest.items.filter(i => !['asset', 'character', 'chat'].includes(i.kind))) {
      const old = previous.manifest.items.find(i => i.id === item.id);
      const oldId = previous.ids[item.id];
      if (old?.kind === item.kind && old.hash === item.hash && oldId && ids.get(item.id) !== oldId && item.references.every(r => ids.get(r.target) === previous.ids[r.target])) {
        ids.set(item.id, oldId); changed = true;
      }
    }
    if (!changed) break;
  }
  const values = new Map<string, RecordValue>();
  for (const item of manifest.items.filter(i => i.kind !== 'asset')) {
    const raw = records.get(item.entry);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Missing object record: ' + item.id);
    const mapped = remapRecord(raw, item.references, ids);
    values.set(item.id, obj(manifest.recordEncoding === 'escaped-keys-v1' ? decodeRecordKeys(mapped) : mapped));
  }
  // Inlay original token IDs are resolved in the imported chat context, never by rewriting scripts.
  const inlayMap: RecordValue = {};
  const inlayOrigins: RecordValue = {};
  for (const item of manifest.items.filter(i => i.kind === 'inlay')) {
    const value = values.get(item.id)!;
    Object.defineProperty(inlayMap, String(value.originalId), { value: ids.get(item.id)!, enumerable: true, configurable: true, writable: true });
    inlayOrigins[ids.get(item.id)!] = value.originalId;
  }
  const presetIds: string[] = [];
  const allowedPreset = new Set([...presetFields, 'name', 'image', 'NAISettings', 'regex', 'reasonEffort']);
  for (const presetItem of manifest.items.filter(i => i.kind === 'preset')) {
    const preset = values.get(presetItem.id)!;
    for (const key of Object.keys(preset)) if (!allowedPreset.has(key) && !connectionFields.has(key)) throw new Error('Unsupported preset field: ' + key);
    for (const key of connectionFields) delete preset[key];
    const presetId = ids.get(presetItem.id)!; preset.risuPlayId = presetId; presetIds.push(presetId);
    if (!arr(db.botPresets).some(p => obj(p).risuPlayId === presetId)) db.botPresets = [...arr(db.botPresets), preset];
  }
  const moduleIds: string[] = [], personaIds: string[] = [], characterIds: string[] = [], syntheticChatIds: string[] = [];
  for (const item of manifest.items.filter(i => i.kind === 'module')) {
    const m = values.get(item.id)!; m.id = ids.get(item.id)!; moduleIds.push(String(m.id));
    if (!arr(db.modules).some(old => obj(old).id === m.id)) db.modules = [...arr(db.modules), m];
  }
  for (const item of manifest.items.filter(i => i.kind === 'persona')) {
    const p = values.get(item.id)!; p.id = ids.get(item.id)!;
    const embedded = item.references.find(r => r.pointer === '/embeddedModule');
    if (embedded) p.embeddedModule = copy(values.get(embedded.target)!);
    personaIds.push(String(p.id)); if (!arr(db.personas).some(old => obj(old).id === p.id)) db.personas = [...arr(db.personas), p];
  }
  for (const item of manifest.items.filter(i => i.kind === 'chat')) {
    const chat = values.get(item.id)!; chat.id = ids.get(item.id)!;
    const contextItem = manifest.items.find(i => i.id === item.references.find(r => r.pointer === '/playContext')?.target) ?? manifest.items.find(i => i.kind === 'context')!;
    const context = copy(values.get(contextItem.id)!);
    const presetId = String(context.preset ?? presetIds[0]); delete context.preset; delete chat.playContext;
    const resolvedAssets: RecordValue = {};
    for (const other of manifest.items.filter(i => i.kind === 'context')) for (const [alias, path] of Object.entries(obj(values.get(other.id)!.assets))) {
      if (typeof path === 'string' && typeof obj(context.assets)[alias] === 'string') resolvedAssets[path] = obj(context.assets)[alias];
    }
    chat.risuPlayContext = { ...(previous && db.risuPlayActive === instanceId && db.risuPlayActiveChat === chat.id ? { pendingActivation: true, pendingLiveMemory: liveMemory(db) } : {}), instanceId, presetId, personaId: chat.bindedPersona ?? null, contextId: ids.get(contextItem.id)!, context, modules: copy(chat.modules ?? []), inlays: context.inlays ?? inlayMap, inlayOrigins, assets: context.assets ?? {}, resolvedAssets };
  }
  for (const item of manifest.items.filter(i => i.kind === 'character')) {
    const c = values.get(item.id)!; c.chaId = ids.get(item.id)!;
    const chatRefs = item.references.filter(r => /^\/chats\/\d+$/.test(r.pointer)).sort((a, b) => Number(a.pointer.split('/')[2]) - Number(b.pointer.split('/')[2]));
    c.chats = chatRefs.map(r => values.get(r.target)!);
    // Group member cards can legitimately have no selected history; give them an empty playable chat.
    if (!arr(c.chats).length) {
      const old = obj(arr(db.characters).find(old => obj(old).chaId === c.chaId));
      const placeholder = arr(old.chats).find(ch => previous?.syntheticChatIds?.includes(String(obj(ch).id)));
      const chat = placeholder ? copy(placeholder) : { id: crypto.randomUUID(), message: [], note: '', localLore: [] };
      c.chats = [chat]; syntheticChatIds.push(String(obj(chat).id)); c.chatPage = 0;
    }
    const defaultChat = obj(arr(c.chats)[Number(c.chatPage)]);
    if (defaultChat.risuPlayContext) c.risuPlayDefaults = copy(defaultChat.risuPlayContext);
    else {
      // Unselected group members still need their owning set's media when opened directly.
      const ownerScope = obj(values.get(manifest.primaryChat)?.risuPlayContext);
      c.risuPlayDefaults = { ...copy(ownerScope), modules: [...new Set([...arr(ownerScope.modules), ...arr(c.modules)])] };
    }
    delete obj(c.oaiTTSConfig).apiKey;
    characterIds.push(String(c.chaId));
    const index = arr(db.characters).findIndex(old => obj(old).chaId === c.chaId);
    if (index < 0) db.characters = [...arr(db.characters), c];
    else {
      const old = obj(arr(db.characters)[index]);
      const openChat = obj(arr(old.chats)[Number(old.chatPage)]).id;
      const preservedPage = arr(c.chats).findIndex(ch => obj(ch).id === openChat);
      if (preservedPage >= 0) c.chatPage = preservedPage;
      arr(db.characters)[index] = c;
    }
  }
  const presetId = String(obj(values.get(manifest.primaryChat)?.risuPlayContext).presetId);
  const generation: AppGeneration = {
    setId: manifest.setId, revision: manifest.revision, parent: manifest.parent, instanceId, manifest: copy(manifest),
    ids: Object.fromEntries(ids), appliedHash: '', characterIds, moduleIds, personaIds, presetId, presetIds, syntheticChatIds, exported: false,
  };
  generation.appliedHash = await hashLocalJson(generationContents(db, generation));
  // Historical generation metadata is retained; host keeps a durable scoped prior-state snapshot too.
  metadata.generations.push(generation); metadata.transactions[transaction] = instanceId;
  db.risuPlaySets = metadata as unknown as Json;
  return { database: db, instanceId, mode: decision.mode, generation };
}

const originFields = [...presetFields, ...memoryFields, 'NAIsettings', 'presetRegex', 'reasoningEffort', 'hypaV3PresetId'];
function saveLivePreset(db: RecordValue): void {
  const previous = obj(arr(db.botPresets)[Number(db.botPresetsId)]);
  if (!Object.keys(previous).length) return;
  for (const key of [...presetFields, ...connectionFields]) if (Object.hasOwn(db, key)) previous[key] = copy(db[key]);
  for (const [to, from] of [['NAISettings', 'NAIsettings'], ['regex', 'presetRegex'], ['reasonEffort', 'reasoningEffort']]) if (Object.hasOwn(db, from)) previous[to] = copy(db[from]);
}
function rememberOriginConfiguration(db: RecordValue): void {
  const preset = obj(arr(db.botPresets)[Number(db.botPresetsId)]);
  const rawPreset = arr(db.botPresets)[Number(db.botPresetsId)];
  const hasPreset = !!rawPreset && typeof rawPreset === 'object' && !Array.isArray(rawPreset);
  if (hasPreset && !preset.risuPlayId) preset.risuPlayId = crypto.randomUUID();
  const memoryPreset = obj(arr(db.hypaV3Presets)[Number(db.hypaV3PresetId)]);
  if (Object.keys(memoryPreset).length && !memoryPreset.risuPlayMemoryId) memoryPreset.risuPlayMemoryId = crypto.randomUUID();
  db.risuPlayOrigin = {
    values: Object.fromEntries(originFields.filter(k => Object.hasOwn(db, k)).map(k => [k, copy(db[k])])),
    memoryPreset: copy(arr(db.hypaV3Presets)[Number(db.hypaV3PresetId)] ?? null),
    preset: hasPreset ? Object.fromEntries(Object.entries(preset).filter(([k]) => !connectionFields.has(k)).map(([k,v]) => [k,copy(v)])) : null,
  };
}
function restoreOriginConfiguration(db: RecordValue): void {
  const origin = obj(db.risuPlayOrigin);
  if (db.risuPlayActive && !Object.keys(origin).length) throw new Error('원래 플레이 설정의 복구 기록을 찾을 수 없습니다. 현재 상태를 보존했습니다.');
  if (Object.keys(origin).length) {
    const values = obj(origin.values), preset = obj(origin.preset);
    for (const key of originFields) { if (Object.hasOwn(values, key)) db[key] = copy(values[key]); else delete db[key]; }
    if (origin.preset === null) db.botPresetsId = -1;
    else {
      let index = arr(db.botPresets).findIndex(p => obj(p).risuPlayId === preset.risuPlayId);
      if (index < 0) { db.botPresets = [...arr(db.botPresets), copy(preset)]; index = arr(db.botPresets).length - 1; }
      const selected = obj(arr(db.botPresets)[index]);
      // Receiver connection choices may have changed while playing another set; keep those current.
      for (const key of connectionFields) if (Object.hasOwn(db, key)) selected[key] = copy(db[key]);
      db.botPresetsId = index;
    }
    if (origin.memoryPreset) {
      const memoryKey = obj(origin.memoryPreset).risuPlayMemoryId;
      let memoryIndex = arr(db.hypaV3Presets).findIndex(p => memoryKey ? obj(p).risuPlayMemoryId === memoryKey : canonical(p, true) === canonical(origin.memoryPreset, true));
      if (memoryIndex < 0) { db.hypaV3Presets = [...arr(db.hypaV3Presets), copy(origin.memoryPreset)]; memoryIndex = arr(db.hypaV3Presets).length - 1; }
      db.hypaV3PresetId = memoryIndex;
    }
  }
  delete db.risuPlayActive; delete db.risuPlayActiveChat; delete db.risuPlayOrigin;
}

/** Called only by an explicit "continue playing" action, never by receipt/automatic import. */
export function continuePlaySet(database: RecordValue, instanceId: string, chatId?: string, currentChatId?: string | null): { database: RecordValue; characterIndex: number; chatIndex: number } {
  const db = copy(database);
  captureActivePlayContext(db, currentChatId);
  const generation = registry(db).generations.filter(g => g.instanceId === instanceId).at(-1);
  if (!generation) throw new Error('Play set not found');
  const id = generation.ids[generation.manifest.primaryCharacter];
  const characterIndex = arr(db.characters).findIndex(c => obj(c).chaId === id);
  if (characterIndex < 0) throw new Error('Received character no longer exists');
  const character = obj(arr(db.characters)[characterIndex]);
  const chatIndex = arr(character.chats).findIndex(c => obj(c).id === (chatId ?? generation.ids[generation.manifest.primaryChat]));
  if (chatIndex < 0) throw new Error('Received chat no longer exists');
  const chat = obj(arr(character.chats)[chatIndex]); character.chatPage = chatIndex;
  const scope = obj(chat.risuPlayContext);
  saveLivePreset(db);
  if (generation.exported && !scope.instanceId) {
    restoreOriginConfiguration(db);
    return { database: db, characterIndex, chatIndex };
  }
  // Preserve the local global play configuration before the first explicit received-set activation.
  if (!db.risuPlayActive) rememberOriginConfiguration(db);
  const selectedPresetId = typeof scope.presetId === 'string' ? scope.presetId : generation.presetId;
  const preset = arr(db.botPresets).find(p => obj(p).risuPlayId === selectedPresetId);
  if (!preset) throw new Error('Received preset no longer exists');
  const receivedIndex = arr(db.botPresets).findIndex(p => obj(p).risuPlayId === selectedPresetId);
  const p = obj(preset);
  // Opening a received preset must not replace the receiver's provider on a later ordinary preset switch.
  for (const key of connectionFields) if (Object.hasOwn(db, key)) p[key] = copy(db[key]);
  db.botPresetsId = receivedIndex;
  for (const key of presetFields) if (!connectionFields.has(key)) {
    if (Object.hasOwn(p, key)) db[key] = copy(p[key]); else delete db[key];
  }
  for (const [from, to] of [['NAISettings', 'NAIsettings'], ['regex', 'presetRegex'], ['reasonEffort', 'reasoningEffort']]) {
    if (Object.hasOwn(p, from)) db[to] = copy(p[from]); else delete db[to];
  }
  db.risuPlayActive = instanceId; db.risuPlayActiveChat = chat.id;
  delete scope.pendingActivation; delete scope.pendingLiveMemory;
  const context = obj(scope.context);
  for (const key of memoryFields) { if (Object.hasOwn(context, key)) db[key] = copy(context[key]); else delete db[key]; }
  if (context.hypaV3Preset) {
    let memoryIndex = arr(db.hypaV3Presets).findIndex(p => scope.hypaV3PresetKey && obj(p).risuPlayMemoryId === scope.hypaV3PresetKey);
    if (memoryIndex < 0) {
      scope.hypaV3PresetKey = crypto.randomUUID();
      db.hypaV3Presets = [...arr(db.hypaV3Presets), { ...copy(obj(context.hypaV3Preset)), risuPlayMemoryId: scope.hypaV3PresetKey }];
      memoryIndex = arr(db.hypaV3Presets).length - 1;
    }
    scope.hypaV3PresetId = memoryIndex; db.hypaV3PresetId = memoryIndex;
  }
  // API keys, selected provider/model, moduleIntergration and enabledModules remain receiver-owned.
  return { database: db, characterIndex, chatIndex };
}

/** Persist after a successful archive write, so the origin can recognize a returning successor. */
function exportGeneration(db: RecordValue, snapshot: SnapshotResult): AppGeneration {
  const metadata = registry(db), manifest = snapshot.manifest;
  const existing = metadata.generations.filter(g => g.setId === manifest.setId && g.characterIds.includes(snapshot.localIds.get(manifest.primaryCharacter)!)).at(-1);
  const ids = Object.fromEntries(snapshot.localIds);
  const characterChats = obj(snapshot.records.get(manifest.items.find(i => i.id === manifest.primaryCharacter)!.entry)).risuCharacterTransfer === true;
  const ofKind = (kind: string) => manifest.items.filter(i => i.kind === kind).map(i => ids[i.id]);
  return { setId: manifest.setId, revision: manifest.revision, parent: manifest.parent, instanceId: existing?.instanceId ?? crypto.randomUUID(),
    manifest: copy(manifest), ids, characterChats, appliedHash: '', characterIds: ofKind('character'), moduleIds: ofKind('module'), personaIds: ofKind('persona'), presetId: existing?.presetId ?? '', presetIds: existing?.presetIds ?? [], syntheticChatIds: existing?.syntheticChatIds ?? [], exported: characterChats || (existing ? existing.exported === true : true) };
}
export async function exportStateHash(database: RecordValue, snapshot: SnapshotResult): Promise<string> {
  return hashLocalJson(generationContents(database, exportGeneration(database, snapshot)));
}
export async function recordExport(database: RecordValue, snapshot: SnapshotResult): Promise<RecordValue> {
  const db = copy(database), metadata = registry(db), manifest = snapshot.manifest;
  if (metadata.generations.some(g => g.setId === manifest.setId && g.revision === manifest.revision)) return db;
  const generation = exportGeneration(db, snapshot);
  generation.appliedHash = await hashLocalJson(generationContents(db, generation));
  metadata.generations.push(generation); db.risuPlaySets = metadata as unknown as Json;
  return db;
}

/** Save only the active set's editable memory options before switching presets/sets. */
export function captureActivePlayContext(db: RecordValue, currentChatId?: string | null): void {
  if (!db.risuPlayActive || currentChatId !== undefined && currentChatId !== db.risuPlayActiveChat) return;
  const preset = obj(arr(db.botPresets)[Number(db.botPresetsId)]);
  for (const character of arr(db.characters)) for (const chat of arr(obj(character).chats)) {
    const scope = obj(obj(chat).risuPlayContext);
    if (!canCaptureMemory(db, scope) || scope.instanceId !== db.risuPlayActive || obj(chat).id !== db.risuPlayActiveChat || scope.presetId !== preset.risuPlayId) continue;
    delete scope.pendingActivation; delete scope.pendingLiveMemory;
    const context = obj(scope.context);
    for (const key of memoryFields) { if (Object.hasOwn(db, key)) context[key] = copy(db[key]); else delete context[key]; }
  }
}


export function leavePlaySet(database: RecordValue, currentChatId?: string | null): RecordValue {
  const db = copy(database);
  captureActivePlayContext(db, currentChatId); saveLivePreset(db); restoreOriginConfiguration(db);
  return db;
}


/** Called by explicit memory-preset controls; array reorder alone must not repoint a received chat. */
export function selectPlaySetMemoryPreset(db: RecordValue, characterId: string | undefined, index: number): void {
  const preset = arr(db.hypaV3Presets)[index];
  if (!Number.isInteger(index) || index < 0 || !preset || typeof preset !== 'object' || Array.isArray(preset)) throw new Error('Memory preset not found');
  db.hypaV3PresetId = index;
  const character = obj(arr(db.characters).find(c => obj(c).chaId === characterId));
  const chat = obj(arr(character.chats)[Number(character.chatPage)]);
  const scope = obj(chat.risuPlayContext ?? character.risuPlayDefaults);
  if (!scope.instanceId) return;
  if (!preset.risuPlayMemoryId) preset.risuPlayMemoryId = crypto.randomUUID();
  scope.hypaV3PresetKey = preset.risuPlayMemoryId; scope.hypaV3PresetId = index;
  scope.context = { ...obj(scope.context), hypaV3Preset: portableMemoryPreset(preset) };
}

/** Same row for engine and settings UI; an absent scoped preset uses the local runtime default. */
export function resolvePlaySetMemoryPreset(db: RecordValue, characterId?: string, chatId?: string | null): RecordValue | undefined {
  const character = obj(arr(db.characters).find(c => obj(c).chaId === characterId));
  const chat = chatId === undefined ? arr(character.chats)[Number(character.chatPage)] : arr(character.chats).find(c => obj(c).id === chatId);
  const scope = obj(obj(chat).risuPlayContext ?? character.risuPlayDefaults);
  const value = (scope.hypaV3PresetKey ? arr(db.hypaV3Presets).find(p => obj(p).risuPlayMemoryId === scope.hypaV3PresetKey) : undefined)
    ?? obj(scope.context).hypaV3Preset ?? arr(db.hypaV3Presets)[Number(db.hypaV3PresetId)];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}
