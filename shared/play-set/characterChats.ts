import { effectiveTransferGlobals, sanitizeTransferMessages, selectTransferGallery } from './snapshot.ts';
import { applyPlaySet, generationContents, type ApplyResult, type AppGeneration } from './apply.ts';
import { decodeRecordKeys, hashLocalJson, isGalleryChatPointer, isPainterInlayPointer, orderedBardWorkspace, validateRecords, type Json, type Manifest } from './protocol.ts';

type Row = Record<string, Json>;
const row = (v: Json | undefined): Row => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
const list = (v: Json | undefined): Json[] => Array.isArray(v) ? v : [];
const copy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
async function chatFingerprint(chat: Row, generation: AppGeneration, globals: Row = {}, speakerIds: ReadonlyMap<string, string> = new Map(), selection: Manifest = generation.manifest): Promise<string> {
  const value = copy(chat);
  sanitizeTransferMessages(value.message, '', []);
  selectTransferGallery(value, new Set(selection.items.filter(i => i.kind === 'chat').map(i => generation.ids[i.id])), '', [], String(chat.id));
  const scope = row(value.risuPlayContext ?? value.risuTransferMedia);
  value.GLGlobalVariables = chat.risuTransferMedia ? copy(row(value.GLGlobalVariables)) : effectiveTransferGlobals(row(value.GLGlobalVariables), { ...globals, ...row(row(scope.context).globalChatVariables) });
  for (const message of list(value.message).map(row)) {
    const speaker = String(message.saying ?? '');
    const original = speakerIds.get(speaker) ?? generation.manifest.items.find(i => i.kind === 'character' && generation.ids[i.id] === speaker)?.id;
    if (original) message.saying = 'character-origin:' + original;
  }
  value.useLocallySetGlobalVariables = true;
  for (const key of ['id', 'modules', 'bindedPersona', 'playContext', 'risuPlayContext', 'risuTransferMedia', 'risuTransferSource', 'folderId', 'isStreaming', 'activeStreamingDisplayOptimizationMode']) delete value[key];
  const assets = new Map(generation.manifest.items.filter(i => i.kind === 'asset').map(i => [generation.ids[i.id], i.hash]));
  const normalize = (v: Json, pointer = ''): Json => {
    if (typeof v === 'string' && (isPainterInlayPointer(pointer) || isGalleryChatPointer(pointer))) {
      const kind = isPainterInlayPointer(pointer) ? 'inlay' : 'chat';
      const item = generation.manifest.items.find(i => i.kind === kind && generation.ids[i.id] === v);
      if (item) return kind === 'inlay' ? 'inlay-sha256:' + item.hash : 'chat-origin:' + item.id;
    }
    if (typeof v === 'string') return v.replace(/assets\/[A-Za-z0-9_.-]+/g, path => {
      const local = String(row(scope.resolvedAssets)[path] ?? row(scope.assets)[path] ?? path);
      return assets.has(local) ? 'asset-sha256:' + assets.get(local) : path;
    }).replace(/\{\{(?:inlay|inlayed|inlayeddata)::([^{}]+)\}\}/g, (token, id: string) => {
      const local = row(scope.inlays)[id] ?? id;
      const item = generation.manifest.items.find(i => i.kind === 'inlay' && generation.ids[i.id] === local);
      return item ? '{{inlay-sha256:' + item.hash + '}}' : token;
    });
    if (Array.isArray(v)) return v.map((x, index) => normalize(x, pointer + '/' + index));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x, pointer + '/' + k.replace(/~/g, '~0').replace(/\//g, '~1'))]));
    return v;
  };
  const workspace = generation.manifest.bard?.find(workspace => generation.ids[workspace.chat] === chat.id);
  return hashLocalJson(workspace ? { chat: normalize(value), bard: generation.bardFingerprints?.[workspace.chat] ?? orderedBardWorkspace(workspace) } : normalize(value));
}
export function incomingCharacters(manifest: Manifest, records: ReadonlyMap<string, Json>): { id: string; originalId?: string; name: string; group: boolean }[] {
  return manifest.items.filter(i => i.kind === 'character').map(i => {
    const value = records.get(i.entry)!;
    const record = row(manifest.recordEncoding === 'escaped-keys-v1' ? decodeRecordKeys(value) : value);
    return { id: i.id, originalId: typeof record.risuTransferOriginalId === 'string' ? record.risuTransferOriginalId : undefined,
      name: String(record.name ?? '').trim(), group: record.type === 'group' };
  });
}
export function matchingCharacters(db: Row, name: string, sourceId?: string, originalId?: string): Row[] {
  const characters = list(db.characters).map(row);
  if (sourceId) {
    for (const previous of list(row(db.risuPlaySets).generations).map(row).reverse()) {
      const mapped = row(previous.ids)[sourceId];
      const matches = typeof mapped === 'string' ? characters.filter(c => c.chaId === mapped) : [];
      if (matches.length) return matches;
    }
  }
  if (originalId) {
    const matches = characters.filter(c => c.chaId === originalId || c.risuTransferOriginalId === originalId);
    if (matches.length) return matches;
  }
  return name ? characters.filter(c => String(c.name ?? '').trim() === name) : [];
}

/** Receive ordinary characters/chats. Never activate a received preset or replace an existing card. */
export async function applyCharacterChats(database: Row, manifest: Manifest, records: ReadonlyMap<string, Json>, assets: ReadonlyMap<string, string>, transaction: string, targets: Record<string, string> = {}, journaledBardPlan = false, bardFingerprints?: Record<string, string>): Promise<ApplyResult> {
  // Reuse graph validation/remapping, in an isolated database without the receiver's generations.
  validateRecords(manifest, records);
  const stagingRecords = new Map(records);
  for (const item of manifest.items.filter(i => i.kind === 'preset')) {
    const preset = copy(row(records.get(item.entry))); delete preset.requiresCharacterChatReceiver;
    stagingRecords.set(item.entry, preset);
  }
  const staged = await applyPlaySet({ characters: [], modules: [], personas: [], botPresets: [] }, manifest, stagingRecords, assets, transaction, journaledBardPlan);
  const generation = staged.generation!;
  if (bardFingerprints) generation.bardFingerprints = bardFingerprints;
  const stagedIds = { ...generation.ids };
  const imported: Row[] = [];
  const db = copy(database);
  const registry = row(db.risuPlaySets);
  const characters = list(db.characters).map(row);
  db.characters = characters;
  const incoming = incomingCharacters(manifest, records);
  const mapping = new Map<string, Row>();
  const affected: string[] = [];
  const speakers = new Map<string, string>();
  const speakerIds = new Map<string, string>();
  for (const entry of incoming) {
    const candidates = matchingCharacters(database, entry.name, entry.id, entry.originalId).map(c => characters.find(local => local.chaId === c.chaId)!);
    const chosen = targets[entry.id];
    if (chosen && !candidates.some(c => c.chaId === chosen)) throw new Error('대상 캐릭터가 바뀌었습니다. 다시 가져와 주세요.');
    if (!chosen && candidates.length > 1) throw new Error('같은 이름의 캐릭터가 여러 개입니다. 가져올 대상을 선택해 주세요.');
    const existing = chosen ? candidates.find(c => c.chaId === chosen) : candidates[0];
    if (existing?.coldstorage) throw new Error('Hydrate the target character before importing chats');
    const received = list(staged.database.characters).map(row).find(c => c.chaId === generation.ids[entry.id])!;
    if (existing && (existing.type === 'group') !== entry.group) throw new Error('같은 이름이지만 그룹과 단독 캐릭터 종류가 다릅니다. 캐릭터 이름을 구분한 뒤 다시 가져와 주세요.');
    const target = existing ?? copy(received);
    if (!existing) {
      imported.push(target);
      target.chats = [];
      const media = row(target.risuPlayDefaults);
      target.risuTransferMedia = { assets: media.assets ?? {}, resolvedAssets: media.resolvedAssets ?? {}, inlays: media.inlays ?? {}, inlayOrigins: media.inlayOrigins ?? {} };
      delete target.risuPlayDefaults;
      // Module definitions are not imported or selected by character/chat transfer.
      target.modules = [];
      characters.push(target);
    }
    if (typeof received.risuTransferOriginalId === 'string') { speakers.set(received.risuTransferOriginalId, String(target.chaId)); speakerIds.set(received.risuTransferOriginalId, entry.id); }
    mapping.set(entry.id, target);
    generation.ids[entry.id] = String(target.chaId);
  }
  let added = 0;
  for (const entry of incoming.filter(c => c.group)) {
    const target = mapping.get(entry.id)!;
    const owner = manifest.items.find(i => i.id === entry.id)!;
    const mappedMembers = owner.references.filter(r => /^\/characters\/\d+$/.test(r.pointer)).map(r => mapping.get(r.target)!.chaId);
    if (new Set(mappedMembers).size !== mappedMembers.length) throw new Error('그룹의 서로 다른 구성원이 같은 캐릭터로 연결됩니다. 이름이나 수신 대상을 구분해 주세요.');
    if (!list(database.characters).some(c => row(c).chaId === target.chaId)) continue;
    for (const ref of owner.references.filter(r => /^\/characters\/\d+$/.test(r.pointer))) {
      if (!list(target.characters).includes(mapping.get(ref.target)!.chaId)) throw new Error('선택한 캐릭터가 기존 그룹의 구성원이 아닙니다. 기존 그룹의 구성을 확인하거나 그룹 이름을 구분한 뒤 다시 가져와 주세요.');
    }
  }
  for (const entry of incoming) {
    const target = mapping.get(entry.id)!;
    const owner = manifest.items.find(i => i.id === entry.id)!;
    for (const ref of owner.references.filter(r => /^\/chats\/\d+$/.test(r.pointer)).sort((a,b) => Number(a.pointer.split('/')[2])-Number(b.pointer.split('/')[2]))) {
      const item = manifest.items.find(i => i.id === ref.target)!;
      const sourceChatId = generation.ids[item.id];
      const chat = copy(list(staged.database.characters).flatMap(c => list(row(c).chats)).map(row).find(c => c.id === sourceChatId)!);
      const fingerprint = await chatFingerprint(chat, { ...generation, ids: stagedIds }, {}, speakerIds);
      const existingChats = list(target.chats).map(row).filter(c => typeof c.id === 'string' && c.id.length > 0);
      let old = existingChats.find(c => row(c.risuTransferSource).id === item.id && row(c.risuTransferSource).hash === fingerprint);
      if (!old) for (const candidate of existingChats) {
        const generations = list(registry.generations).map(row).filter(g => row(g.ids)[item.id] === candidate.id).reverse();
        if (generations.length && (candidate._stub || candidate._placeholder || String(row(list(candidate.message)[0]).data ?? '').startsWith('\uEF01COLDSTORAGE\uEF01'))) throw new Error('Hydrate the matching chat before importing: ' + candidate.id);
        for (const legacy of generations) {
          if (await chatFingerprint(candidate, legacy as unknown as AppGeneration, legacy.exported && !candidate.risuTransferMedia && !candidate.risuPlayContext ? row(database.globalChatVariables) : {}, new Map(), manifest) === fingerprint) { old = candidate; break; }
        }
        if (old) break;
      }
      if (old) { generation.ids[item.id] = String(old.id); continue; }
      for (const message of list(chat.message).map(row)) if (typeof message.saying === 'string' && speakers.has(message.saying)) message.saying = speakers.get(message.saying)!;
      if (list(database.characters).some(c => row(c).chaId === target.chaId)) delete chat.folderId;
      const scope = row(chat.risuPlayContext);
      chat.risuTransferMedia = { assets: scope.assets ?? {}, resolvedAssets: scope.resolvedAssets ?? {}, inlays: scope.inlays ?? {}, inlayOrigins: scope.inlayOrigins ?? {} };
      delete chat.risuPlayContext; delete chat.bindedPersona;
      chat.modules = [];
      chat.risuTransferSource = { id: item.id, hash: fingerprint };
      target.chats = [...list(target.chats), chat];
      imported.push(chat);
      added++;
      if (!affected.includes(String(target.chaId))) affected.push(String(target.chaId));
    }
    // Group membership uses the receiving cards, never temporary IDs.
    if (!list(database.characters).some(c => row(c).chaId === target.chaId)) {
      target.characters = owner.references.filter(r => /^\/characters\/\d+$/.test(r.pointer)).sort((a,b) => Number(a.pointer.split('/')[2])-Number(b.pointer.split('/')[2])).map(r => String(mapping.get(r.target)!.chaId));
      if (target.type !== 'group') delete target.characters;
      if (!list(target.chats).length) target.chats = [{ id: crypto.randomUUID(), message: [], note: '', localLore: [] }];
      if (!affected.includes(String(target.chaId))) affected.push(String(target.chaId));
    }
  }
  for (const record of imported) for (const slot of list(row(record.risuBardGallery).slots).map(row)) {
    const item = manifest.items.find(i => i.kind === 'chat' && stagedIds[i.id] === slot.sourceChatId);
    if (item) slot.sourceChatId = generation.ids[item.id];
  }
  generation.characterIds = affected; generation.moduleIds = []; generation.personaIds = []; generation.presetId = ''; generation.presetIds = [];
  generation.characterChats = true;
  generation.appliedHash = await hashLocalJson(generationContents(db, generation));
  const previous = list(registry.generations).map(row).find(g => g.setId === manifest.setId && g.revision === manifest.revision && g.characterChats === true);
  const duplicate = !added && !affected.length;
  const instanceId = duplicate && previous ? String(previous.instanceId) : generation.instanceId;
  if (!duplicate) registry.generations = [...list(registry.generations), { ...generation, characterChats: true } as unknown as Json];
  registry.transactions = { ...row(registry.transactions), [transaction]: instanceId };
  db.risuPlaySets = registry;
  return { database: db, instanceId, mode: duplicate ? 'duplicate' : 'new', ...(duplicate ? {} : { generation }) };
}
