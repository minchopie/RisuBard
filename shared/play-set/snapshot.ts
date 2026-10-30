import { isGalleryChatPointer, isPainterInlayPointer, bardFiles, canonical, encodeRecordKeys, encodeRecordPointer, validateManifest, validateRecords, validateMemoryPreset, hashBytes, hashJson, recordItem, remapRecord, revisionOf, type Item, type Json, type Kind, type Manifest, type Reference } from './protocol.ts';

type ObjectRecord = { [key: string]: Json };
export interface BinarySource { readonly size: number; readonly type: string; slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> }; arrayBuffer(): Promise<ArrayBuffer> }
export interface SnapshotSource {
  database: ObjectRecord;
  origin: string;
  /** Reads local cold storage only. No account/server fallback or original DB mutation. */
  cold(key: string): Promise<Json | null>;
  asset(path: string): Promise<BinarySource | null>;
  digestBlob?(blob: BinarySource): Promise<string>;
  lazyAssets?: boolean;
  /** Raw inlay entry; don't use getInlayAssetBlob (it migrates the original). */
  inlay(id: string): Promise<{ metadata: ObjectRecord; data: BinarySource | string } | null>;
  /** Selected Bard workspace and slot contents, one bounded record at a time. */
  chatMaterials?(characterId: string, chatId: string): AsyncIterable<{ label: string; value: Json }>;
}
export interface SnapshotSelection { characterId: string; chatIds: string[]; primaryChatId: string; setId: string; omitMissingModuleIcons?: boolean; characterChatsOnly?: boolean }
export interface Issue { path: string; reason: string; optional?: 'module-icon' }
export interface SnapshotResult {
  manifest: Manifest; records: Map<string, Json>; blobs: Map<string, BinarySource>;
  blobLoaders?: Map<string, () => Promise<BinarySource>>;
  missing: Issue[]; external: Issue[]; excluded: Issue[];
  /** Local-only provenance, never placed inside the archive. */
  localIds: Map<string, string>; localStateHash?: string;
  lineage?: { previous?: Manifest; history: Manifest[] };
}
const coldHeader = '\uEF01COLDSTORAGE\uEF01';
const object = (v: Json | undefined): ObjectRecord => v && !Array.isArray(v) && typeof v === 'object' ? v : {};
const array = (v: Json | undefined): Json[] => Array.isArray(v) ? v : [];
// Match the pinned app save codec's JSON projection (optional undefined properties are omitted).
const clone = <T extends Json>(v: T): T => {
  const encoded = JSON.stringify(v);
  if (encoded === undefined) throw new Error('Missing snapshot record');
  const result = JSON.parse(encoded); canonical(result, true); return result;
};
const own = (object: ObjectRecord, key: string, value: Json) => Object.defineProperty(object, key, { value, enumerable: true, writable: true, configurable: true });
const escapePointer = (v: string) => v.replace(/~/g, '~0').replace(/\//g, '~1');

/** Transport credentials and connection selection stay on the receiving device. */
export const connectionFields = new Set([
  'apiType', 'aiModel', 'subModel', 'openAIKey', 'proxyKey', 'currentPluginProvider',
  'textgenWebUIStreamURL', 'textgenWebUIBlockingURL', 'forceReplaceUrl', 'koboldURL',
  'proxyRequestModel', 'openrouterRequestModel', 'customProxyRequestModel', 'openrouterProvider',
  'customAPIFormat', 'reverseProxyOobaArgs', 'seperateModels', 'seperateModelsForAxModels',
  'fallbackModels', 'localNetworkMode', 'localNetworkTimeoutSec', 'supaMemoryKey', 'hypaMemoryKey', 'hypaCustomSettings', 'supaModelType', 'hypaModel',
]);
// Derived from the pinned upstream saveCurrentPreset mapping. Explicit allowlist prevents full DB export.
export const presetFields = ('mainPrompt jailbreak globalNote temperature maxContext maxResponse frequencyPenalty PresensePenalty formatingOrder promptPreprocess bias ooba ainconfig promptTemplate NAIadventure NAIappendName localStopStrings autoSuggestPrompt top_p promptSettings repetition_penalty min_p top_a useInstructPrompt customPromptTemplateToggle templateDefaultVariables top_k instructChatTemplate JinjaTemplate jsonSchemaEnabled jsonSchema strictJsonSchema extractJson groupOtherBotRole groupTemplate seperateParametersEnabled seperateParameters systemContentReplacement systemRoleReplacement customFlags enableCustomFlags thinkingTokens thinkingType deepseekThinkingType adaptiveThinkingEffort deepseekReasoningEffort outputImageModal modelTools fallbackWhenBlankResponse verbosity dynamicOutput').split(' ');
export const memoryFields = ('supaMemoryPrompt hypaMemory hypav2 hypaV3 memoryAlgorithmType hypaAllocatedTokens hypaChunkSize hanuraiEnable hanuraiSplit hanuraiTokens').split(' ');

export function effectiveTransferGlobals(local: ObjectRecord, global: ObjectRecord): ObjectRecord {
  const result = clone(global);
  for (const [key, value] of Object.entries(local)) if (value && value !== 'null' || !Object.hasOwn(global, key)) own(result, key, clone(value));
  return result;
}

function project(db: ObjectRecord, keys: string[]): ObjectRecord {
  const out: ObjectRecord = {};
  for (const key of keys) if (Object.hasOwn(db, key) && db[key] !== undefined) out[key] = clone(db[key]);
  return out;
}

/** Operates on a copy. Requests and live jobs do not belong to portable gameplay state. */
export function sanitizeTransferMessages(messages: Json | undefined, path: string, excluded: Issue[]): void {
  for (const [index, message] of array(messages).entries()) {
    const prompt = object(object(message).promptInfo);
    if (Object.hasOwn(prompt, 'promptText')) {
      delete prompt.promptText;
      excluded.push({ path: path + `/${index}/promptInfo/promptText`, reason: 'Recorded request prompt' });
    }
  }
}
export function selectTransferGallery(record: ObjectRecord, chatIds: ReadonlySet<string>, path: string, excluded: Issue[], legacyOwner?: string): void {
  const gallery = object(record.risuBardGallery);
  if (!Array.isArray(gallery.slots)) return;
  gallery.slots = gallery.slots.filter((value, index) => {
    const slot = object(value), owner = slot.sourceChatId ?? legacyOwner;
    const location = path + `/risuBardGallery/slots/${index}`;
    if (typeof owner !== 'string' || !chatIds.has(owner)) {
      excluded.push({ path: location, reason: 'Gallery entry is outside the selected chats or has no known chat owner' });
      return false;
    }
    slot.sourceChatId = owner;
    sanitizeTransferMessages(slot.messages, location + '/messages', excluded);
    return true;
  });
  const usedCategories = new Set(gallery.slots.map(value => object(value).categoryId));
  if (Array.isArray(gallery.categories)) gallery.categories = gallery.categories.filter((value, index) => {
    if (usedCategories.has(object(value).id)) return true;
    excluded.push({ path: path + `/risuBardGallery/categories/${index}`, reason: 'Gallery category has no selected entries' });
    return false;
  });
}
export function sanitizeTransferChat(chat: ObjectRecord, path: string, excluded: Issue[], frozen = false): void {
  if (chat._placeholder || chat._stub) throw new Error('Chat body is not loaded: ' + path);
  if (frozen) {
    for (const key of ['isStreaming', 'risuBardWikiReboot']) if (chat[key]) {
      excluded.push({ path: path + '/' + key, reason: 'Inactive job captured in a saved slot' });
      delete chat[key];
    }
    for (const [index, value] of array(object(chat.bardPainter).results).entries()) {
      const result = object(value);
      if (result.compressionPending) {
        excluded.push({ path: path + `/bardPainter/results/${index}/compressionPending`, reason: 'Inactive saved-slot job; stored image retained' });
        delete result.compressionPending;
      }
    }
  }
  if (chat.isStreaming) throw new Error('Wait for chat generation and loading to finish');
  if (chat.risuBardWikiReboot) throw new Error('Finish or cancel the pending BardWiki rebuild before exporting');
  if (array(object(chat.bardPainter).results).some(result => object(result).compressionPending)) throw new Error('Wait for BardPainter image processing to finish');
  if (Object.hasOwn(chat, 'activeStreamingDisplayOptimizationMode')) excluded.push({ path: path + '/activeStreamingDisplayOptimizationMode', reason: 'Transient display optimization state' });
  delete chat.isStreaming; delete chat.activeStreamingDisplayOptimizationMode; delete chat._placeholder;
  sanitizeTransferMessages(chat.message, path + '/message', excluded);
}
export async function snapshotPlaySet(source: SnapshotSource, selection: SnapshotSelection, previous?: Manifest): Promise<SnapshotResult> {
  const db = source.database;
  const selectedLocal = array(db.characters).map(object).find(c => c.chaId === selection.characterId);
  const selectedLocalChat = array(selectedLocal?.chats).map(object).find(c => c.id === selection.primaryChatId);
  const scope = object(selectedLocalChat?.risuPlayContext ?? selectedLocalChat?.risuTransferMedia ?? selectedLocal?.risuTransferMedia ?? selectedLocal?.risuPlayDefaults);
  const history = array(object(db.risuPlaySets).generations).map(object);
  const provenance = history.filter(g => object(g.ids)[String(object(g.manifest).primaryCharacter)] === selection.characterId && (g.instanceId === scope.instanceId || (g.exported === true || g.characterChats === true) && Object.values(object(g.ids)).includes(selection.primaryChatId))).at(-1);
  if (provenance) {
    previous = provenance.manifest as unknown as Manifest;
    selection = { ...selection, setId: previous.setId };
  }
  const originalIds = object(provenance?.ids);
  const previousManifest = previous;
  const contextUseCount = new Map<string, number>();
  const legacyContext = previousManifest?.items.find(i => i.kind === 'context')?.id;
  for (const chat of previousManifest?.items.filter(i => i.kind === 'chat') ?? []) {
    const id = chat.references.find(r => r.pointer === '/playContext')?.target ?? legacyContext;
    if (id) contextUseCount.set(id, (contextUseCount.get(id) ?? 0) + 1);
  }
  const currentCharacters = array(db.characters).map(object);
  const liveCharacters = new Set(currentCharacters.map(c => String(c.chaId)));
  const liveChats = new Set(currentCharacters.flatMap(c => array(c.chats).map(ch => object(ch).id)).filter(id => typeof id === 'string'));
  const coldCharacters = new Set(currentCharacters.filter(c => c.coldstorage).map(c => String(c.chaId)));
  // Cold character placeholders omit chat IDs; keep their recorded identities until hydrated.
  if (selection.characterChatsOnly && coldCharacters.size) for (const generation of history) {
    const ids = object(generation.ids);
    for (const value of array(object(generation.manifest).items)) {
      const item = object(value);
      if (item.kind !== 'character' || !coldCharacters.has(String(ids[String(item.id)]))) continue;
      for (const ref of array(item.references).map(object)) if (/^\/chats\/\d+$/.test(String(ref.pointer)) && typeof ids[String(ref.target)] === 'string') liveChats.add(ids[String(ref.target)] as string);
    }
  }
  const inherited = new Map<string, string>();
  const inheritedOwners = new Map<string, string>();
  const inherit = (kind: Kind, local: string, id: string) => {
    const key = kind + ':' + local;
    if (selection.characterChatsOnly && (kind === 'character' && !liveCharacters.has(local) || kind === 'chat' && !liveChats.has(local))) return;
    if (inherited.has(key) || inheritedOwners.has(id) && inheritedOwners.get(id) !== key) return;
    inherited.set(key, id); inheritedOwners.set(id, key);
  };
  const inheritedInlayAssets = new Map<string, string>();
  if (selection.characterChatsOnly) for (const generation of history) {
    const ids = object(generation.ids);
    for (const item of array(object(generation.manifest).items) as unknown as Item[]) {
      if (!item || typeof item.id !== 'string') continue;
      const local = ids[item.id];
      if (typeof local === 'string' && ['character', 'chat', 'asset', 'inlay'].includes(item.kind) && !inherited.has(item.kind + ':' + local)) inherit(item.kind, local, item.id);
      const blob = item.kind === 'inlay' && (Array.isArray(item.references) ? item.references : []).find(r => r?.pointer === '/data');
      if (blob && typeof local === 'string' && typeof ids[blob.target] === 'string') inheritedInlayAssets.set(String(local), String(ids[blob.target]));
    }
  }
  // Earliest receipts own portable IDs regardless of which chat is selected as primary.
  for (const item of previousManifest?.items ?? []) {
    const local = originalIds[item.id];
    if (typeof local === 'string') inherit(item.kind, local, item.id);
  }
  let activeScope = scope;
  let aliases: ObjectRecord = {};
  let inlays: ObjectRecord = {};
  if (!selection.chatIds.length || !selection.chatIds.includes(selection.primaryChatId)) throw new Error('Select a primary chat');
  const records = new Map<string, Json>(), blobs = new Map<string, BinarySource>();
  const blobLoaders = new Map<string, () => Promise<BinarySource>>();
  const loadAssetSource = source.asset, loadInlaySource = source.inlay;
  const missing: Issue[] = [], external: Issue[] = [], excluded: Issue[] = [];
  const resolvedModuleIcons = new Set<string>();
  const items: Item[] = [];
  const added = new Map<string, string>();
  const raw = new Map<string, { kind: Exclude<Kind, 'asset'>; value: ObjectRecord; refs: Reference[] }>();
  const localIds = new Map<string, string>();
  const portableId = async (kind: Kind, local: string) => {
    if (kind === 'chat') local = JSON.parse(local)[1];
    const known = inherited.get(kind + ':' + local);
    if (known) return known;
    const key = kind + ':' + local;
    let id = `${source.origin}.${kind}.${await hashJson(local)}`;
    let copyIndex = 0;
    while (inheritedOwners.has(id) && inheritedOwners.get(id) !== key) id = `${source.origin}.${kind}.${await hashJson([local, 'transfer-copy', ++copyIndex])}`;
    inheritedOwners.set(id, key);
    return id;
  };
  const stableId = async (kind: Kind, local: string) => {
    const id = await portableId(kind, local);
    localIds.set(id, kind === 'chat' ? JSON.parse(local)[1] : local);
    return id;
  };
  const prior = new Map(previous?.items.map(i => [i.id, i]) ?? []);

  async function addBlob(key: string, data: BinarySource, reload?: () => Promise<BinarySource>): Promise<string> {
    const id = await stableId('asset', key);
    if (added.has(id)) return id;
    // Read one blob at a time. Native archive output is incremental; never assemble an archive buffer.
    const hash = source.digestBlob ? await source.digestBlob(data) : await hashBytes(new Uint8Array(await data.arrayBuffer()));
    const entry = `blobs/${hash}`;
    if (source.lazyAssets && reload) blobLoaders.set(entry, reload); else blobs.set(entry, data);
    added.set(id, id);
    const old = prior.get(id);
    items.push({ id, kind: 'asset', hash, parent: old?.hash === hash ? old.parent : old?.hash ?? null, entry, bytes: data.size, references: [], media: old?.media ?? { name: key.split('/').at(-1)!.replace(/[:\\]/g, '_'), mime: data.type } });
    return id;
  }
  async function asset(path: string, location: string, embedded = false, literal = false, moduleIcon = false): Promise<string | null> {
    if (!path || /^data:/i.test(path)) return null; // Embedded data remains verbatim in its record.
    if (/^https?:\/\//i.test(path)) { external.push({ path: location, reason: path }); return null; }
    if (!/^assets\/[^/\\]+$/.test(path)) { missing.push({ path: location, reason: 'Unrecognized local asset: ' + path }); return null; }
    try {
      const mapped = object(activeScope.resolvedAssets)[path] ?? object(activeScope.assets)[path];
      const bytes = await source.asset(typeof mapped === 'string' ? mapped : path);
      if (!bytes) {
        const issue: Issue = { path: location, reason: 'Missing local asset: ' + path, ...(moduleIcon ? { optional: 'module-icon' as const } : {}) };
        missing.push(issue);
        return null;
      }
      const actualPath = typeof mapped === 'string' ? mapped : path;
      const target = await addBlob(actualPath, bytes, async () => { const result = await loadAssetSource(actualPath); if (!result) throw new Error('Asset no longer exists: ' + actualPath); return result; });
      if (moduleIcon) resolvedModuleIcons.add(location);
      if (embedded) {
        const originalAliases = Object.entries(object(activeScope.assets)).filter(([, local]) => local === actualPath).map(([alias]) => alias);
        for (const alias of originalAliases.length ? originalAliases : [path]) own(aliases, alias, target);
      }
      if (literal) own(aliases, path, target); // Literal text is not structurally remapped on import.
      return target;
    } catch { missing.push({ path: location, reason: 'Missing local asset: ' + path }); return null; }
  }
  async function inlay(localId: string, location: string): Promise<string | null> {
    const mapped = object(activeScope.inlays)[localId];
    const actualId = typeof mapped === 'string' ? mapped : localId;
    const id = await stableId('inlay', actualId);

    if (added.has(id)) { if (raw.has(id)) own(inlays, localId, id); return raw.has(id) ? id : null; }
    added.set(id, id);
    const value = await source.inlay(actualId);
    if (!value) { missing.push({ path: location, reason: 'Missing inlay: ' + localId }); return null; }
    own(inlays, localId, id);
    const originalId = object(activeScope.inlayOrigins)[actualId];
    const record: ObjectRecord = { ...clone(value.metadata), originalId: typeof originalId === 'string' ? originalId : localId, data: '' };
    const refs: Reference[] = [];
    if (typeof value.data === 'string') record.data = value.data;
    else { record.data = await addBlob(inheritedInlayAssets.get(actualId) ?? (typeof originalIds[prior.get(id)?.references.find(r => r.pointer === '/data')?.target ?? ''] === 'string' ? String(originalIds[prior.get(id)!.references.find(r => r.pointer === '/data')!.target]) : 'inlay:' + actualId), value.data, async () => { const result = await loadInlaySource(actualId); if (!result || typeof result.data === 'string') throw new Error('Inlay changed during export'); return result.data; }); refs.push({ pointer: '/data', target: String(record.data) }); record.mime = value.data.type; }
    raw.set(id, { kind: 'inlay', value: record, refs });
    return id;
  }
  async function scan(value: Json, owner: string, refs: Reference[], pointer = '', aliasesOnly = false, recordKind?: Kind): Promise<void> {
    if (!value || typeof value !== 'object') return;
    for (const [key, field] of Object.entries(value)) {
      const p = pointer + '/' + escapePointer(key);
      if (typeof field === 'string') {
        if (!aliasesOnly && ['character', 'chat'].includes(recordKind ?? '') && isGalleryChatPointer(p)) {
          refs.push({ pointer: p, target: await stableId('chat', JSON.stringify(['', field])) });
        }
        if (field && recordKind === 'chat' && isPainterInlayPointer(aliasesOnly ? p.replace(/^\/value(?=\/bardPainter\/)/, '') : p)) {
          const target = await inlay(field, owner + p);
          if (target && !aliasesOnly) refs.push({ pointer: p, target });
        }
        const assetField = ['image', 'icon', 'uri'].includes(key) || /^\/(?:additionalAssets|emotionImages)\/\d+\/1$/.test(p) || recordKind === 'module' && /^\/assets\/\d+\/1$/.test(p);
        const wholeAsset = /^assets\/[^/\\\s]+$/.test(field) || (assetField && (field.startsWith('assets/') || /^(?:https?:\/\/|data:)/i.test(field)));
        if (wholeAsset) {
          const moduleIcon = recordKind === 'module' && p === '/icon';
          const target = await asset(field, owner + p, true, false, moduleIcon);
          if (target && !aliasesOnly) refs.push({ pointer: p, target });
        }
        if (!wholeAsset && /assets\/[A-Za-z0-9_.-]+/.test(field)) {
          const localText = field.replace(/(?<![A-Za-z0-9_+.-])(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|data:|blob:|file:)[^\s<>"']+/gi, url => {
            if (!/^data:/i.test(url) && /assets\/[A-Za-z0-9_.-]+/.test(url)) external.push({ path: owner + p, reason: url });
            return ' ';
          });
          for (const match of localText.matchAll(/assets\/[A-Za-z0-9_.-]+/g)) await asset(match[0], owner + p, true, true);
        }
        for (const match of field.matchAll(/\{\{(?:inlay|inlayed|inlayeddata)::([^{}]+)\}\}/g)) await inlay(match[1], owner + p);
      } else await scan(field, owner, refs, p, aliasesOnly, recordKind);
    }
  }
  async function addRecord(kind: Exclude<Kind, 'asset'>, localId: string, value: ObjectRecord, refs: Reference[] = []): Promise<string> {
    const id = await stableId(kind, localId);
    if (added.has(id)) { await scan(value, id, [], '', true, kind); return id; }
    added.set(id, id);
    if (kind === 'character') value.chaId = id;
    if (['chat', 'persona', 'module'].includes(kind)) value.id = id;
    raw.set(id, { kind, value, refs });
    await scan(value, id, refs, '', false, kind);
    return id;
  }
  async function module(localId: string): Promise<string | null> {
    if (selection.characterChatsOnly) return null;
    const modules = [...array(db.modules), ...array(db.personas).map(p => object(p).embeddedModule).filter(Boolean)];
    const candidates = modules.map(object).filter(m => m.id === localId || m.namespace === localId);
    if (!candidates.length) { missing.push({ path: 'modules', reason: 'Missing module: ' + localId }); return null; }
    const value = clone(candidates.find(m => m.id === localId) ?? candidates[0]);
    if (typeof value.id !== 'string' || !value.id) throw new Error('Module has no stable ID: ' + localId);
    return addRecord('module', String(value.id), value);
  }
  function expandModules(ids: Json[]): string[] {
    if (selection.characterChatsOnly) return [];
    const all = [...array(db.modules), ...array(db.personas).map(p => object(p).embeddedModule).filter(Boolean)].map(object);
    const result: string[] = [];
    for (const id of ids.map(String)) {
      const found = all.filter(m => m.id === id || m.namespace === id);
      if (!found.length) missing.push({ path: 'modules', reason: 'Missing module: ' + id });
      for (const m of found) if (!result.includes(String(m.id))) result.push(String(m.id));
    }
    return result;
  }
  async function persona(chat: ObjectRecord): Promise<string> {
    if (selection.characterChatsOnly) return addRecord('persona', 'character-chat-placeholder', { name: '', personaPrompt: '', icon: '' });
    let value: ObjectRecord;
    let localId: string;
    if (chat.bindedPersona) {
      const found = array(db.personas).map(object).find(p => p.id === chat.bindedPersona);
      if (!found) { missing.push({ path: 'persona', reason: 'Missing bound persona: ' + chat.bindedPersona }); value = {}; }
      else value = clone(found);
      localId = String(chat.bindedPersona);
    } else {
      // Effective unsaved global persona may differ from the selected saved persona.
      value = { name: db.username ?? 'User', personaPrompt: db.personaPrompt ?? '', icon: db.userIcon ?? '', largePortrait: db.largePortrait ?? false };
      localId = 'current-effective-persona';
    }
    const refs: Reference[] = [];
    if (value.embeddedModule) {
      const embedded = object(value.embeddedModule);
      if (typeof embedded.id !== 'string' || !embedded.id) throw new Error('Embedded module has no stable ID');
      const target = await addRecord('module', String(embedded.id), clone(embedded));
      value.embeddedModule = target; refs.push({ pointer: '/embeddedModule', target });
    }
    return addRecord('persona', localId, value, refs);
  }
  async function addContext(chatLocalId: string): Promise<string> {
  if (selection.characterChatsOnly) {
    // Empty compatibility records keep the existing archive validators/transports usable.
    // No provider, preset, persona or module settings are exported in this mode.
    const preset = await addRecord('preset', 'character-chat-placeholder', { requiresCharacterChatReceiver: true });
    const contextId = await stableId('context', 'character-chat:' + chatLocalId);
    const refs: Reference[] = [{ pointer: '/preset', target: preset }];
    for (const [key, value] of Object.entries(aliases)) refs.push({ pointer: '/assets/' + escapePointer(key), target: String(value) });
    for (const [key, value] of Object.entries(inlays)) refs.push({ pointer: '/inlays/' + escapePointer(key), target: String(value) });
    raw.set(contextId, { kind: 'context', value: { preset, assets: aliases, inlays }, refs });
    return contextId;
  }
  const storedPreset = typeof activeScope.presetId === 'string' ? array(db.botPresets).map(object).find(p => p.risuPlayId === activeScope.presetId) : undefined;
  if (typeof activeScope.presetId === 'string' && !storedPreset) missing.push({ path: chatLocalId + '/preset', reason: 'Missing received preset: ' + activeScope.presetId });
  const useStored = !!storedPreset && (db.risuPlayActive !== activeScope.instanceId || object(array(db.botPresets)[Number(db.botPresetsId)]).risuPlayId !== activeScope.presetId);
  const preset = typeof activeScope.presetId === 'string' && !storedPreset ? {} : useStored ? project(storedPreset!, [...presetFields, 'name', 'image', 'NAISettings', 'regex', 'reasonEffort']) : project(db, presetFields);
  for (const [out, field] of [['NAISettings', 'NAIsettings'], ['regex', 'presetRegex'], ['reasonEffort', 'reasoningEffort']]) if (!useStored && !(typeof activeScope.presetId === 'string' && !storedPreset) && Object.hasOwn(db, field)) preset[out] = clone(db[field]);
  const selectedPreset = object(array(db.botPresets)[Number(db.botPresetsId)]);
  if (!useStored && !(typeof activeScope.presetId === 'string' && !storedPreset)) { preset.name = selectedPreset.name ?? '받은 플레이 프리셋'; preset.image = selectedPreset.image ?? ''; }
  const presetId = await addRecord('preset', String(activeScope.presetId ?? selection.setId), preset);
  const liveMemoryChanged = activeScope.pendingActivation && canonical(project(db, memoryFields), true) !== canonical(activeScope.pendingLiveMemory ?? {}, true);
  const liveChat = (!activeScope.pendingActivation || liveMemoryChanged) && !useStored && db.risuPlayActiveChat === chatLocalId;
  const context = project(activeScope.instanceId && !liveChat ? object(activeScope.context) : db, memoryFields);
  context.globalChatVariables = clone(activeScope.instanceId ? object(activeScope.context).globalChatVariables ?? {} : db.globalChatVariables ?? {});
  // db.loreBook is the editor library, not the active prompt lore. Character/chat/module lore is already included.
  const hypaPreset = array(db.hypaV3Presets)[Number(db.hypaV3PresetId)];
  if (activeScope.instanceId && object(activeScope.context).hypaV3Preset) context.hypaV3Preset = clone(array(db.hypaV3Presets).find(p => activeScope.hypaV3PresetKey && object(p).risuPlayMemoryId === activeScope.hypaV3PresetKey) ?? object(activeScope.context).hypaV3Preset);
  else if (!activeScope.instanceId && hypaPreset) context.hypaV3Preset = clone(hypaPreset);
  if (context.hypaV3Preset) {
    delete object(context.hypaV3Preset).risuPlayMemoryId;
    try { validateMemoryPreset(context.hypaV3Preset, chatLocalId + '/hypaV3Preset'); } catch (error) { missing.push({ path: chatLocalId + '/hypaV3Preset', reason: '기억 설정에서 최대 요약 대화 수·동시 요청 수는 1 이상의 정수, 분당 요청 수는 0보다 큰 수, 검색 대화 수는 0 이상의 정수로 설정한 뒤 다시 보내 주세요. 원본 설정은 변경하지 않았습니다. ' + String(error) }); }
  }
  // Scan gameplay context before freezing aliases: variables and memory prompts can contain tokens too.
  context.preset = presetId;
  const contextRefs: Reference[] = [{ pointer: '/preset', target: presetId }];
  await scan(context, 'context', contextRefs);
  context.assets = aliases; context.inlays = inlays;
  const aliasRefs: Reference[] = [], inlayRefs: Reference[] = [];
  for (const [key, value] of Object.entries(aliases)) aliasRefs.push({ pointer: '/assets/' + escapePointer(key), target: String(value) });
  for (const [key, value] of Object.entries(inlays)) inlayRefs.push({ pointer: '/inlays/' + escapePointer(key), target: String(value) });
  const inheritedChat = inherited.get('chat:' + chatLocalId);
  const priorChat = inheritedChat ? prior.get(inheritedChat) : undefined;
  const inheritedContext = priorChat?.references.find(r => r.pointer === '/playContext')?.target ?? (priorChat ? legacyContext : undefined);
  let contextLocal = inheritedContext && typeof originalIds[inheritedContext] === 'string' ? String(originalIds[inheritedContext]) : selection.setId + ':' + chatLocalId;
  if (inheritedContext && (contextUseCount.get(inheritedContext) ?? 0) > 1) {
    // Legacy/shared contexts become independent, deterministic records before either chat can overwrite the other.
    contextLocal += ':' + inheritedChat;
  }
  const contextId = await stableId('context', contextLocal);
  raw.set(contextId, { kind: 'context', value: context, refs: [...contextRefs, ...aliasRefs, ...inlayRefs] });
  return contextId;
  }
  const allCharacters = array(db.characters).map(object);
  const selected = allCharacters.find(c => c.chaId === selection.characterId);
  if (!selected) throw new Error('Selected character not found');
  const processed = new Set<string>();
  async function character(input: ObjectRecord, selectedChats: string[] | null): Promise<string> {
    const localId = String(input.chaId);
    const id = await stableId('character', localId);
    if (processed.has(localId)) return id;
    processed.add(localId);
    let c = clone(input);
    if (c.coldstorage) {
      const cold = object(await source.cold(String(c.coldstorage)) ?? null);
      if (!cold.character) { missing.push({ path: localId, reason: 'Missing cold character' }); return id; }
      c = clone(object(cold.character));
    }
    if (selection.characterChatsOnly) { c.risuCharacterTransfer = true; c.risuTransferOriginalId = localId; }
    selectTransferGallery(c, new Set(selectedChats ?? []), localId, excluded);
    const refs: Reference[] = [];
    const defaults = c.risuPlayDefaults ?? c.risuTransferMedia;
    delete c.risuPlayDefaults; delete c.risuTransferMedia;
    const chats = array(c.chats).map(object);
    const characterModuleIds = expandModules(array(c.modules));
    c.chats = [];
    delete c.coldstorage; delete c.coldStoragedChats;
    const loreSettings = object(c.loreSettings);
    if (loreSettings.scanDepth === undefined && typeof db.loreBookDepth === 'number') loreSettings.scanDepth = db.loreBookDepth;
    if (loreSettings.tokenBudget === undefined && typeof db.loreBookToken === 'number') loreSettings.tokenBudget = db.loreBookToken;
    if (Object.keys(loreSettings).length) c.loreSettings = loreSettings;
    // Per-character credentials exist outside the main DB API configuration.
    if (object(c.oaiTTSConfig).apiKey) { delete object(c.oaiTTSConfig).apiKey; excluded.push({ path: localId + '/oaiTTSConfig/apiKey', reason: 'Provider credential' }); }
    c.modules = [];
    for (const moduleId of characterModuleIds) {
      const target = await module(moduleId);
      if (target) { refs.push({ pointer: `/modules/${array(c.modules).length}`, target }); array(c.modules).push(target); }
    }
    if (c.type === 'group') {
      for (const [i, memberId] of array(c.characters).entries()) {
        const member = allCharacters.find(x => x.chaId === memberId);
        if (!member) { missing.push({ path: localId, reason: 'Missing group member: ' + memberId }); continue; }
        const target = await character(member, null);
        refs.push({ pointer: `/characters/${i}`, target });
      }
    }
    for (const selectedId of selectedChats ?? []) {
      const original = chats.find(ch => ch.id === selectedId);
      if (!original) { missing.push({ path: localId, reason: 'Missing chat: ' + selectedId }); continue; }
      const ch = clone(original);
      // A matching receiving card is retained, so carry its selected gallery scenes with the chat too.
      if (c.risuBardGallery && !ch.risuTransferMedia) {
        const legacy = object(ch.risuBardGallery), gallery = clone(object(c.risuBardGallery));
        gallery.slots = [...array(gallery.slots), ...array(legacy.slots)];
        gallery.categories = [...array(gallery.categories), ...array(legacy.categories).filter(category => !array(gallery.categories).some(existing => object(existing).id === object(category).id))];
        ch.risuBardGallery = gallery;
        selectTransferGallery(ch, new Set([selectedId]), selectedId, excluded, selectedId);
      }

      if (ch.isStreaming) throw new Error('Wait for response generation to finish');
      const first = object(array(ch.message)[0]).data;
      if (typeof first === 'string' && first.startsWith(coldHeader)) {
        const cold = await source.cold(first.slice(coldHeader.length));
        if (!cold) { missing.push({ path: selectedId, reason: 'Missing cold chat' }); continue; }
        if (Array.isArray(cold)) ch.message = clone(cold);
        else for (const [key, value] of Object.entries(clone(object(cold)))) own(ch, key, value);
      }
      const chatScope = object(ch.risuPlayContext ?? ch.risuTransferMedia ?? defaults);
      selectTransferGallery(ch, new Set(selectedChats ?? []), selectedId, excluded, selectedId);
      activeScope = chatScope; aliases = {}; inlays = {};
      // Character scripts and inline media execute in each selected chat's scope.
      await scan({ ...c, chats: [] }, id, [], '', true);
      // Group members and their modules execute in the owning group's chat scope too.
      const visited = new Set<string>();
      const scanDependency = async (target: string): Promise<void> => {
        if (visited.has(target)) return;
        visited.add(target);
        const dependency = raw.get(target);
        if (!dependency) return;
        await scan(dependency.value, target, [], '', true, dependency.kind);
        for (const ref of dependency.refs) await scanDependency(ref.target);
      };
      for (const ref of refs) if (!ref.pointer.startsWith('/chats/')) await scanDependency(ref.target);
      const frozenGlobals = Boolean(ch.risuTransferMedia);
      delete ch.risuPlayContext; delete ch.risuTransferMedia; delete ch.risuTransferSource;
      sanitizeTransferChat(ch, selectedId, excluded);
      const chatRefs: Reference[] = [];
      if (!ch.bindedPersona && !original.risuPlayContext && chatScope.personaId) ch.bindedPersona = chatScope.personaId;
      const pid = await persona(ch);
      ch.bindedPersona = pid; chatRefs.push({ pointer: '/bindedPersona', target: pid });
      const moduleIds = chatScope.instanceId ? expandModules(array(original.risuPlayContext ? ch.modules ?? chatScope.modules : chatScope.modules)) : expandModules([...array(db.enabledModules), ...characterModuleIds, ...array(ch.modules), ...String(db.moduleIntergration ?? '').split(',').map(s => s.trim()).filter(Boolean)]);
      const per = raw.get(pid)?.value;
      if (typeof per?.embeddedModule === 'string') {
        const embeddedId = per.embeddedModule;
        ch.modules = [embeddedId]; chatRefs.push({ pointer: '/modules/0', target: embeddedId });
      } else ch.modules = [];
      for (const moduleId of new Set(moduleIds.map(String))) {
        const target = await module(moduleId);
        if (!target || array(ch.modules).includes(target)) continue;
        chatRefs.push({ pointer: `/modules/${array(ch.modules).length}`, target }); array(ch.modules).push(target);
      }
      if (selection.characterChatsOnly) {
        ch.GLGlobalVariables = frozenGlobals ? clone(object(ch.GLGlobalVariables)) : effectiveTransferGlobals(object(ch.GLGlobalVariables), object(activeScope.instanceId ? object(activeScope.context).globalChatVariables : db.globalChatVariables));
        ch.useLocallySetGlobalVariables = true;
      }
      await scan(ch, selectedId, chatRefs, '', false, 'chat');
      if (source.chatMaterials) for await (const material of source.chatMaterials(localId, selectedId)) {
        await scan({ value: material.value }, selectedId + '/' + material.label, [], '', true, 'chat');
      }
      ch.playContext = await addContext(selectedId);
      chatRefs.push({ pointer: '/playContext', target: String(ch.playContext) });
      const chatId = await stableId('chat', JSON.stringify([localId, selectedId]));
      ch.id = chatId; added.set(chatId, chatId); raw.set(chatId, { kind: 'chat', value: ch, refs: chatRefs });
      refs.push({ pointer: `/chats/${array(c.chats).length}`, target: chatId }); array(c.chats).push(chatId);
    }
    c.chatPage = selectedChats ? Math.max(0, array(c.chats).indexOf(await stableId('chat', JSON.stringify([localId, selection.primaryChatId])))) : 0;
    activeScope = scope; aliases = {}; inlays = {};
    return addRecord('character', localId, c, refs);
  }
  const primaryCharacter = await character(selected, selection.chatIds);
  const primaryChat = await stableId('chat', JSON.stringify([selection.characterId, selection.primaryChatId]));
  // Decide only after every selected chat's asset mapping has been read. Mixed
  // availability or an I/O failure must remain blocking, never erase a real icon.
  const blockedIcons = new Set(missing.filter(issue => !issue.optional).map(issue => issue.path));
  for (let index = missing.length - 1; index >= 0; index--) {
    const issue = missing[index];
    if (issue.optional !== 'module-icon') continue;
    if (resolvedModuleIcons.has(issue.path) || blockedIcons.has(issue.path)) { delete issue.optional; continue; }
    if (!selection.omitMissingModuleIcons) continue;
    const record = raw.get(issue.path.slice(0, -'/icon'.length));
    if (record?.kind !== 'module') continue;
    delete record.value.icon; excluded.push(issue); missing.splice(index, 1);
  }
  const portableIds = new Map([...items.map(i => i.id), ...raw.keys()].map(k => [k, k] as [string, string]));
  for (const [id, { kind, value, refs }] of raw) {
    // Normalize structural references to portable IDs before hashing; local allocation must not create a new revision.
    const encodedRefs = refs.map(ref => ({ ...ref, pointer: encodeRecordPointer(ref.pointer) }));
    const portable = remapRecord(encodeRecordKeys(value), encodedRefs, portableIds);
    const item = await recordItem(id, kind, portable, encodedRefs, prior.get(id));
    items.push(item); records.set(item.entry, portable);
  }
  const manifest: Manifest = { format: 'risuplay', version: 1, recordEncoding: 'escaped-keys-v1', setId: selection.setId, origin: previous?.origin ?? source.origin,
    primaryCharacter, primaryChat, parent: previous?.revision ?? null, revision: '', items,
    ancestors: previous ? [previous.revision, ...previous.ancestors] : [] };
  const unique = (issues: Issue[]) => [...new Map(issues.map(issue => [JSON.stringify([issue.path, issue.reason]), issue])).values()];
  const result = { manifest, records, blobs, blobLoaders, missing: unique(missing), external: unique(external), excluded: unique(excluded), localIds,
    lineage: { previous, history: history.map(g => g.manifest as unknown as Manifest) } };
  await finalizeSnapshotLineage(result);
  return result;
}

/** Finalize only after all versioned content, including Bard files, has been attached. */
export async function finalizeSnapshotLineage(snapshot: SnapshotResult): Promise<void> {
  const { manifest, records, blobs, blobLoaders } = snapshot;
  const { previous, history = [] } = snapshot.lineage ?? {};
  const priorItems = new Map(previous?.items.map(item => [item.id, item]) ?? []);
  for (const item of manifest.items) {
    const prior = priorItems.get(item.id);
    item.parent = prior?.hash === item.hash ? prior.parent : prior?.hash ?? null;
  }
  manifest.parent = previous?.revision ?? null;
  manifest.ancestors = previous ? [previous.revision, ...previous.ancestors] : [];
  manifest.revision = await revisionOf(manifest);
  if (manifest.revision === previous?.revision) { manifest.parent = previous.parent; manifest.ancestors = previous.ancestors; }
  if (manifest.ancestors.includes(manifest.revision)) {
    const known = history.find(m => m?.setId === manifest.setId && m.revision === manifest.revision);
    let reusable = false;
    if (known) try {
      validateManifest(known); validateRecords(known, records);
      reusable = await revisionOf(known) === manifest.revision && [...known.items.filter(i => i.kind === 'asset'), ...bardFiles(known)].every(i => blobs.has(i.entry) || blobLoaders?.has(i.entry));
    } catch { /* Invalid local history cannot replace the freshly collected graph. */ }
    if (reusable) Object.assign(manifest, clone(known as unknown as Json));
    else { manifest.parent = null; manifest.ancestors = []; }
  }
}
