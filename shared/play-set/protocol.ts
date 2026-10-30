/** RisuPlay v1/v2. Shared serialization and validation; no application DB or network access. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Kind = 'character' | 'chat' | 'persona' | 'module' | 'preset' | 'asset' | 'inlay' | 'context';
export interface Reference { pointer: string; target: string }
export interface Item {
  id: string; kind: Kind; hash: string; parent: string | null;
  entry: string; bytes: number; references: Reference[];
  media?: { name: string; mime: string };
}
export interface FileBlock { path: string; hash: string; entry: string; bytes: number }
export interface BardSlot { sourceId: string; files: FileBlock[]; pages: FileBlock[] }
export interface BardWorkspace {
  character: string; chat: string; sourceCharacterId: string; sourceChatId: string;
  files: FileBlock[]; slots: BardSlot[];
}
export interface Manifest {
  format: 'risuplay'; version: 1 | 2; recordEncoding?: 'escaped-keys-v1'; setId: string; revision: string; parent: string | null;
  origin: string; primaryCharacter: string; primaryChat: string; items: Item[];
  ancestors: string[];
  bard?: BardWorkspace[];
}
export interface Draft { manifest: Manifest; records: Map<string, Json> }
const kinds = new Set<Kind>(['character', 'chat', 'persona', 'module', 'preset', 'asset', 'inlay', 'context']);
const digest = /^[a-f0-9]{64}$/;
const identity = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export const MANIFEST_BYTE_LIMIT = 8 * 1024 * 1024;
// This is a JS JSON working-set guard, not a play-set/archive or binary-asset limit.
export const DEFAULT_RECORD_BYTE_BUDGET = 128 * 1024 * 1024;

export function canonical(value: Json, local = false, path = ''): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Non-finite JSON number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return '[' + value.map((v, i) => canonical(v, local, path + '/' + i)).join(',') + ']';
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('Non-JSON record');
  return '{' + Object.keys(value).sort().map(key => {
    const pointer = path + '/' + key.replace(/~/g, '~0').replace(/\//g, '~1');
    if (!local && forbidden.has(key)) throw new Error('Unsafe JSON property: ' + key + ' at ' + pointer + '. 인코딩되지 않은 예약 키가 있는 전송 파일입니다. 원본은 보존됩니다.');
    return JSON.stringify(key) + ':' + canonical(value[key], local, pointer);
  }).join(',') + '}';
}
const keyPrefix = '$risu$key:';
const escapeRecordKey = (key: string) => forbidden.has(key) || key.startsWith(keyPrefix) ? keyPrefix + key : key;
/** Wire keys stay strict; Object.fromEntries defines own data properties without prototype setters. */
export function encodeRecordKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(encodeRecordKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [escapeRecordKey(key), encodeRecordKeys(child)]));
}
export function decodeRecordKeys(value: Json): Json {
  if (Array.isArray(value)) return value.map(decodeRecordKeys);
  if (!value || typeof value !== 'object') return value;
  const entries = Object.entries(value).map(([wire, child]) => {
    const key = wire.startsWith(keyPrefix) ? wire.slice(keyPrefix.length) : wire;
    if (escapeRecordKey(key) !== wire) throw new Error('Invalid escaped record key');
    return [key, decodeRecordKeys(child)] as [string, Json];
  });
  if (new Set(entries.map(([key]) => key)).size !== entries.length) throw new Error('Duplicate decoded record key');
  return Object.fromEntries(entries);
}
export function encodeRecordPointer(pointer: string): string {
  if (!pointer.startsWith('/') || /~(?![01])/u.test(pointer)) throw new Error('Invalid local reference pointer');
  return '/' + pointer.slice(1).split('/').map(p => escapeRecordKey(p.replace(/~1/g, '/').replace(/~0/g, '~')).replace(/~/g, '~0').replace(/\//g, '~1')).join('/');
}
export async function hashBytes(bytes: Uint8Array): Promise<string> {
  const buffer = Uint8Array.from(bytes).buffer;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), b => b.toString(16).padStart(2, '0')).join('');
}
export async function hashJson(value: unknown): Promise<string> {
  return hashBytes(new TextEncoder().encode(canonical(value as Json)));
}
export async function hashLocalJson(value: unknown): Promise<string> { return hashBytes(new TextEncoder().encode(canonical(value as Json, true))); }
export function entryPath(path: string): string {
  if (!/^(records\/[a-f0-9]{64}\.json|blobs\/[a-f0-9]{64})$/.test(path)) throw new Error('Invalid archive entry: ' + path);
  return path;
}
/** Paths must be safe on both Android and Windows before any file is staged. */
export function workspacePath(path: string): string {
  if (typeof path !== 'string' || !path || /[\\:<>"|?*\x00-\x1f]/u.test(path)
    || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/u.test(part)
      || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) throw new Error('Unsafe Bard workspace path');
  return path;
}
export function bardFiles(m: Pick<Manifest, 'bard'>): FileBlock[] {
  return (m.bard ?? []).flatMap(workspace => [...workspace.files, ...workspace.slots.flatMap(slot => [...slot.files, ...slot.pages])]);
}
const compareText = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
export function orderedBardWorkspace(workspace: BardWorkspace): Omit<BardWorkspace, 'sourceCharacterId' | 'sourceChatId'> {
  // Sender-local IDs locate source files but do not identify portable content.
  return { character: workspace.character, chat: workspace.chat, files: [...workspace.files].sort((a, b) => compareText(a.path, b.path)),
    slots: [...workspace.slots].sort((a, b) => compareText(a.sourceId, b.sourceId)).map(slot => ({ ...slot,
      files: [...slot.files].sort((a, b) => compareText(a.path, b.path)), pages: [...slot.pages].sort((a, b) => compareText(a.path, b.path)) })) };
}
export function isPainterInlayPointer(pointer: string): boolean {
  return /^\/bardPainter\/(?:results\/\d+\/(?:assetId|settings\/context\/referenceAssetId)|settings\/context\/referenceAssetId)$/.test(pointer);
}
export function isGalleryChatPointer(pointer: string): boolean {
  return /^\/risuBardGallery\/slots\/\d+\/sourceChatId$/.test(pointer);
}
function validateBard(m: Manifest, ids: Map<string, Item>): void {
  if (m.version === 1) {
    if (m.bard !== undefined) throw new Error('Bard data requires RisuPlay v2');
    return;
  }
  if (!Array.isArray(m.bard)) throw new Error('Missing Bard workspace manifest');
  const seen = new Set<string>(), slots = new Set<string>();
  const validId = (id: unknown) => typeof id === 'string' && id.length > 0 && !id.includes('\0');
  const checkFiles = (files: FileBlock[], pages = false) => {
    if (!Array.isArray(files)) throw new Error('Missing Bard file list');
    const paths = new Set<string>();
    for (const file of files) {
      if (!file || !digest.test(file.hash) || file.entry !== `blobs/${file.hash}`
        || !Number.isSafeInteger(file.bytes) || file.bytes < 0) throw new Error('Invalid Bard file block');
      const path = workspacePath(file.path).normalize('NFC').toLocaleLowerCase('en-US');
      if (paths.has(path)) throw new Error('Duplicate Bard workspace path');
      paths.add(path);
      if (pages && file.path !== `${file.hash.slice(0, 2)}/${file.hash}`) throw new Error('Invalid Bard shared page path');
    }
    for (const path of paths) {
      const parts = path.split('/');
      for (let count = 1; count < parts.length; count++) if (paths.has(parts.slice(0, count).join('/'))) throw new Error('Conflicting Bard file and directory');
    }
  };
  for (const workspace of m.bard) {
    if (!workspace || ids.get(workspace.character)?.kind !== 'character' || ids.get(workspace.chat)?.kind !== 'chat'
      || !ids.get(workspace.character)!.references.some(r => /^\/chats\/\d+$/.test(r.pointer) && r.target === workspace.chat)
      || seen.has(workspace.chat) || !validId(workspace.sourceCharacterId) || !validId(workspace.sourceChatId)
      || !Array.isArray(workspace.slots)) throw new Error('Invalid Bard workspace owner');
    seen.add(workspace.chat); checkFiles(workspace.files);
    for (const slot of workspace.slots) {
      if (!slot || !validId(slot.sourceId)) throw new Error('Invalid Bard save slot');
      const key = JSON.stringify([workspace.character, slot.sourceId]);
      if (slots.has(key)) throw new Error('Duplicate Bard save slot');
      slots.add(key); checkFiles(slot.files); checkFiles(slot.pages, true);
      for (const required of ['chat.bin', 'risubard-save.json']) if (!slot.files.some(file => file.path === required)) throw new Error('Incomplete Bard save slot');
      if (slot.pages.length && !slot.files.some(file => file.path === 'risubard-save-files.json')) throw new Error('Missing Bard saved-page list');
    }
  }
  if (m.items.filter(item => item.kind === 'chat').some(item => !seen.has(item.id))) throw new Error('Missing chat Bard workspace');
  const sizes = new Map(m.items.map(item => [item.entry, item.bytes]));
  for (const file of bardFiles(m)) {
    if (sizes.has(file.entry) && sizes.get(file.entry) !== file.bytes) throw new Error('Conflicting Bard block size');
    sizes.set(file.entry, file.bytes);
  }
}
export function pointerParts(pointer: string): string[] {
  if (!pointer.startsWith('/') || /~(?![01])/u.test(pointer)) throw new Error('Invalid reference pointer');
  const parts = pointer.slice(1).split('/').map(p => p.replace(/~1/g, '/').replace(/~0/g, '~'));
  if (parts.some(p => forbidden.has(p))) throw new Error('Unsafe reference pointer');
  return parts;
}
function parentAt(value: Json, pointer: string): { parent: { [key: string]: Json }; key: string } {
  const parts = pointerParts(pointer);
  let parent = value;
  for (const part of parts.slice(0, -1)) {
    if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, part)) throw new Error('Reference does not exist: ' + pointer);
    parent = (parent as { [key: string]: Json })[part];
  }
  const key = parts.at(-1)!;
  if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) throw new Error('Reference does not exist: ' + pointer);
  return { parent: parent as { [key: string]: Json }, key };
}
/** Only declared structural pointers are rewritten. Script/source text is never searched/replaced. */
export function remapRecord(value: Json, references: Reference[], ids: ReadonlyMap<string, string>): Json {
  const result = JSON.parse(canonical(value)) as Json;
  for (const ref of references) {
    const target = ids.get(ref.target);
    if (!target) throw new Error('Missing mapped dependency: ' + ref.target);
    const { parent, key } = parentAt(result, ref.pointer);
    if (typeof parent[key] !== 'string') throw new Error('Reference is not a string: ' + ref.pointer);
    parent[key] = target;
  }
  return result;
}

export function validateManifest(input: unknown): Manifest {
  if (!input || typeof input !== 'object') throw new Error('Missing manifest');
  canonical(input as Json); // Reject prototype keys, unsupported values, before any application writes.
  const m = input as Manifest;
  if (m.recordEncoding !== undefined && m.recordEncoding !== 'escaped-keys-v1') throw new Error('Unsupported record encoding');
  if (m.format !== 'risuplay' || (m.version !== 1 && m.version !== 2)) throw new Error('Unsupported RisuPlay version');
  for (const id of [m.setId, m.origin, m.primaryCharacter, m.primaryChat]) if (typeof id !== 'string' || !identity.test(id)) throw new Error('Invalid identity');
  if (!digest.test(m.revision) || (m.parent !== null && !digest.test(m.parent))) throw new Error('Invalid set revision');
  if (!Array.isArray(m.ancestors) || m.ancestors.some(h => !digest.test(h)) || new Set(m.ancestors).size !== m.ancestors.length || m.ancestors.includes(m.revision) || (m.ancestors[0] ?? null) !== m.parent) throw new Error('Invalid revision ancestry');
  if (!Array.isArray(m.items) || m.items.length === 0) throw new Error('Empty item graph');
  const ids = new Map<string, Item>();
  const entries = new Map<string, Item>();
  for (const item of m.items) {
    if (!item || typeof item.id !== 'string' || !identity.test(item.id) || forbidden.has(item.id) || ids.has(item.id)) throw new Error('Duplicate or invalid item identity');
    if (!kinds.has(item.kind) || !digest.test(item.hash) || (item.parent !== null && !digest.test(item.parent))) throw new Error('Invalid item revision');
    entryPath(item.entry);
    if (!Number.isSafeInteger(item.bytes) || item.bytes < 0) throw new Error('Invalid expanded size');
    if (item.entry !== ((item.kind === 'asset') ? `blobs/${item.hash}` : `records/${item.hash}.json`)) throw new Error('Noncanonical content address');
    if (!Array.isArray(item.references)) throw new Error('Missing references');
    if (item.kind === 'asset' && item.media && (typeof item.media.name !== 'string' || /[/\\\x00]/.test(item.media.name) || typeof item.media.mime !== 'string')) throw new Error('Invalid asset metadata');
    const pointers = new Set<string>();
    for (const ref of item.references) {
      pointerParts(ref.pointer);
      if (pointers.has(ref.pointer)) throw new Error('Duplicate reference pointer');
      pointers.add(ref.pointer);
    }
    const prior = entries.get(item.entry);
    if (prior && (prior.hash !== item.hash || prior.bytes !== item.bytes)) throw new Error('Conflicting entry metadata');
    entries.set(item.entry, item); ids.set(item.id, item);
  }
  if (ids.get(m.primaryCharacter)?.kind !== 'character' || ids.get(m.primaryChat)?.kind !== 'chat') throw new Error('Invalid primary selection');
  for (const item of m.items) for (const ref of item.references) if (!ids.has(ref.target)) throw new Error('Missing dependency: ' + ref.target);
  for (const kind of ['preset', 'context']) if (!m.items.some(i => i.kind === kind)) throw new Error('Missing ' + kind);
  const scoped = m.items.some(i => i.kind === 'chat' && i.references.some(r => r.pointer === '/playContext'));
  if (!scoped && ['preset', 'context'].some(kind => m.items.filter(i => i.kind === kind).length !== 1)) throw new Error('Ambiguous legacy play context');
  const reached = new Set<string>();
  const walk = (id: string) => { if (reached.has(id)) return; reached.add(id); for (const ref of ids.get(id)!.references) walk(ref.target); };
  walk(m.primaryCharacter);
  if (!scoped) for (const root of m.items.filter(i => i.kind === 'preset' || i.kind === 'context')) walk(root.id);
  if (reached.size !== ids.size) throw new Error('Unreachable dependency');
  const primary = ids.get(m.primaryCharacter)!;
  if (!primary.references.some(r => /^\/chats\/\d+$/.test(r.pointer) && r.target === m.primaryChat)) throw new Error('Primary chat does not belong to primary character');
  for (const item of m.items) {
    for (const ref of item.references) {
      const target = ids.get(ref.target)!;
      let expected: Kind | undefined;
      if (item.kind === 'character' && /^\/chats\/\d+$/.test(ref.pointer)) expected = 'chat';
      if (item.kind === 'character' && /^\/characters\/\d+$/.test(ref.pointer)) expected = 'character';
      if (['character', 'chat'].includes(item.kind) && /^\/modules\/\d+$/.test(ref.pointer)) expected = 'module';
      if (item.kind === 'chat' && ref.pointer === '/bindedPersona') expected = 'persona';
      if (item.kind === 'chat' && ref.pointer === '/playContext') expected = 'context';
      if (item.kind === 'context' && ref.pointer === '/preset') expected = 'preset';
      if (item.kind === 'persona' && ref.pointer === '/embeddedModule') expected = 'module';
      if (item.kind === 'context' && ref.pointer.startsWith('/inlays/')) expected = 'inlay';
      if (item.kind === 'chat' && isPainterInlayPointer(ref.pointer)) expected = 'inlay';
      if (['character', 'chat'].includes(item.kind) && isGalleryChatPointer(ref.pointer)) expected = 'chat';
      if (target.kind !== (expected ?? 'asset')) throw new Error('Wrong dependency kind: ' + ref.pointer);
    }
    if (item.kind === 'asset' && item.references.length) throw new Error('Binary asset cannot contain references');
    if (scoped && item.kind === 'chat' && !item.references.some(r => r.pointer === '/playContext')) throw new Error('Missing chat play context');
    if (scoped && item.kind === 'context' && !item.references.some(r => r.pointer === '/preset')) throw new Error('Missing context preset');
    if (item.kind === 'chat' && m.items.filter(i => i.kind === 'character').flatMap(i => i.references).filter(r => /^\/chats\/\d+$/.test(r.pointer) && r.target === item.id).length !== 1) throw new Error('Chat must have one character owner');
  }
  validateBard(m, ids);
  return m;
}

/** Timestamps are outside revision identity. Re-exporting unchanged contents stays identical. */
export async function revisionOf(m: Omit<Manifest, 'revision' | 'parent'> | Manifest): Promise<string> {
  return hashJson({ format: m.format, version: m.version, ...(m.recordEncoding ? { recordEncoding: m.recordEncoding } : {}), setId: m.setId, origin: m.origin,
    primaryCharacter: m.primaryCharacter, primaryChat: m.primaryChat,
    ...(m.bard === undefined ? {} : { bard: [...m.bard].sort((a, b) => compareText(a.chat, b.chat)).map(orderedBardWorkspace) }),
    items: [...m.items].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(({ parent: _parent, ...item }) => ({ ...item, references: [...item.references].sort((a, b) => a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0) })) });
}
export async function recordItem(id: string, kind: Exclude<Kind, 'asset'>, value: Json, references: Reference[] = [], prior?: Item): Promise<Item> {
  const bytes = new TextEncoder().encode(canonical(value));
  const hash = await hashBytes(bytes);
  return { id, kind, hash, parent: prior?.hash === hash ? prior.parent : prior?.hash ?? null,
    entry: `records/${hash}.json`, bytes: bytes.byteLength, references: [...references].sort((a, b) => a.pointer < b.pointer ? -1 : a.pointer > b.pointer ? 1 : 0) };
}
export interface ArchiveReader {
  /** Must enumerate actual archive members, reject duplicates/symlinks and enforce real expanded bytes. */
  entries(): Promise<{ name: string; bytes: number }[]>;
  readRecord(entry: string): Promise<Uint8Array>;
  /** Streams/decompresses the complete entry and returns SHA-256. */
  digestEntry(entry: string, expectedBytes: number): Promise<string>;
  availableBytes(): Promise<number>;
  recordBudgetBytes?: number;
}
export async function verifyArchive(m: Manifest, archive: ArchiveReader): Promise<Map<string, Json>> {
  validateManifest(m);
  if (await revisionOf(m) !== m.revision) throw new Error('Set revision mismatch');
  const expected = new Map(m.items.map(i => [i.entry, i]));
  for (const file of bardFiles(m)) if (!expected.has(file.entry)) expected.set(file.entry, { ...file, id: file.entry, kind: 'asset', parent: null, references: [] });
  const actual = await archive.entries();
  const seen = new Set<string>();
  let expanded = 0, recordBytes = 0;
  for (const entry of actual) {
    if (seen.has(entry.name)) throw new Error('Duplicate ZIP entry');
    seen.add(entry.name);
    if (entry.name === 'manifest.json') {
      if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MANIFEST_BYTE_LIMIT) throw new Error('Manifest exceeds metadata memory budget');
      expanded += entry.bytes; continue;
    }
    entryPath(entry.name);
    const item = expected.get(entry.name);
    if (!item || entry.bytes !== item.bytes) throw new Error('Unexpected archive member or size');
    if (item.kind !== 'asset') {
      recordBytes += item.bytes;
      if (!Number.isSafeInteger(recordBytes) || recordBytes > (archive.recordBudgetBytes ?? DEFAULT_RECORD_BYTE_BUDGET)) throw new Error('Records exceed JSON memory budget; select fewer chats or split the play set');
    }
    expanded += item.bytes;
    if (!Number.isSafeInteger(expanded)) throw new Error('Expanded size overflow');
  }
  if (!seen.has('manifest.json') || [...expected.keys()].some(k => !seen.has(k))) throw new Error('Incomplete archive');
  // Reserve room for staged material and a recoverable prior generation, no fixed single-chat cap.
  const required = expanded * 2;
  if (!Number.isSafeInteger(required) || await archive.availableBytes() < required) throw new Error('Not enough storage space');
  const records = new Map<string, Json>();
  for (const [path, item] of expected) {
    if (await archive.digestEntry(path, item.bytes) !== item.hash) throw new Error('Damaged archive entry: ' + path);
    if (item.kind !== 'asset') {
      const bytes = await archive.readRecord(path);
      if (bytes.byteLength !== item.bytes || await hashBytes(bytes) !== item.hash) throw new Error('Record changed while reading');
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as Json;
      if (await hashJson(value) !== item.hash) throw new Error('Non-canonical record bytes');
      for (const ref of item.references) {
        const { parent, key } = parentAt(value, ref.pointer);
        if (typeof parent[key] !== 'string') throw new Error('Invalid referenced value');
      }
      records.set(path, value);
    }
  }
  validateRecords(m, records);
  return records;
}

/** Reject malformed memory settings before staging; valid partial settings use upstream runtime defaults. */
export function validateMemoryPreset(value: Json, path = '/hypaV3Preset'): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !value.settings || typeof value.settings !== 'object' || Array.isArray(value.settings)) throw new Error('Invalid memory settings at ' + path + '/settings');
  const settings = value.settings as Record<string, Json>;
  for (const key of ['maxChatsPerSummary', 'summarizationMaxConcurrent', 'embeddingMaxConcurrent']) {
    if (settings[key] !== undefined && (!Number.isInteger(settings[key]) || Number(settings[key]) < 1)) throw new Error('Invalid positive integer at ' + path + '/settings/' + key);
  }
  for (const key of ['summarizationRequestsPerMinute', 'embeddingRequestsPerMinute']) {
    if (settings[key] !== undefined && (typeof settings[key] !== 'number' || !Number.isFinite(settings[key]) || settings[key] <= 0)) throw new Error('Invalid positive number at ' + path + '/settings/' + key);
  }
  if (settings.queryChatCount !== undefined && (!Number.isInteger(settings.queryChatCount) || Number(settings.queryChatCount) < 0)) throw new Error('Invalid nonnegative integer at ' + path + '/settings/queryChatCount');
}
/** Validate the application-facing graph before any local resources or database records are staged. */
export function validateRecords(m: Manifest, records: ReadonlyMap<string, Json>): void {
  validateManifest(m);
  for (const item of m.items.filter(i => i.kind !== 'asset')) {
    const value = records.get(item.entry);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object record: ' + item.kind);
    canonical(value);
    if (m.recordEncoding === 'escaped-keys-v1') decodeRecordKeys(value);
    const record = value as Record<string, Json>;
    const requireRefs = (key: string) => {
      if (!Array.isArray(record[key])) throw new Error('Expected array: ' + item.kind + '/' + key);
      for (let index = 0; index < record[key].length; index++) {
        if (!item.references.some(r => r.pointer === '/' + key + '/' + index)) throw new Error('Undeclared dependency: ' + key);
      }
    };
    if (['character', 'chat', 'module', 'persona'].includes(item.kind) && record[item.kind === 'character' ? 'chaId' : 'id'] !== item.id) throw new Error('Nonportable record identity');
    if (item.kind === 'character') {
      requireRefs('chats'); requireRefs('modules');
      if (record.type === 'group') requireRefs('characters');
      if (!Number.isInteger(record.chatPage) || Number(record.chatPage) < 0 || Number(record.chatPage) >= Math.max(1, (record.chats as Json[]).length)) throw new Error('Invalid chat selection');
    }
    if (item.kind === 'chat') {
      if (!Array.isArray(record.message) || record.message.some(v => !v || typeof v !== 'object' || Array.isArray(v) || typeof v.data !== 'string')) throw new Error('Invalid chat messages');
      requireRefs('modules');
      if (!item.references.some(r => r.pointer === '/bindedPersona')) throw new Error('Missing bound persona');
      if ('risuPlayContext' in record || record.isStreaming) throw new Error('Nonportable live chat state');
    }
    if (item.kind === 'inlay' && (typeof record.originalId !== 'string' || !record.originalId || typeof record.data !== 'string')) throw new Error('Invalid inlay');
    if (item.kind === 'context' && record.hypaV3Preset !== undefined) validateMemoryPreset(record.hypaV3Preset, item.id + '/hypaV3Preset');
    if (item.kind === 'context') for (const key of ['assets', 'inlays']) {
      if (!record[key] || typeof record[key] !== 'object' || Array.isArray(record[key])) throw new Error('Invalid context aliases');
      for (const name of Object.keys(record[key])) {
        const pointer = '/' + key + '/' + name.replace(/~/g, '~0').replace(/\//g, '~1');
        if (!item.references.some(r => r.pointer === pointer)) throw new Error('Undeclared context alias');
      }
    }
    for (const ref of item.references) {
      const { parent, key } = parentAt(value, ref.pointer);
      if (parent[key] !== ref.target) throw new Error('Nonportable dependency value: ' + ref.pointer);
    }
  }
}

/** Theme-preset entry fields that the active-preset mirror (currentThemePresetFromMirror) copies from DEVICE-LOCAL root keys. They are
 *  never synchronized: stripped from the projected `themePresets`, kept from the local entry when a plan is applied. The list is the
 *  exact intersection of the mirror's root reads with the projection's DEVICE_LOCAL set (nas-sync-projection.test.ts checks parity). */
export const themePresetLocalFields = ('nodeOnlyStandardChatWidth waifuWidth waifuWidth2 zoomsize iconsize textAreaSize sideBarSize assetWidth animationSpeed settingsCloseButtonSize showFirstMessagePages hideAllImages hideMessagePageCount showFolderName showSavingIcon showPromptComparison').split(' ');
