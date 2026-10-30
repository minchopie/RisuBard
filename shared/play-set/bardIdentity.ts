import type { Json } from './protocol.ts';

export interface BardIdentity {
  characters: ReadonlyMap<string, string>;
  chats: ReadonlyMap<string, string>;
  slots: ReadonlyMap<string, string>;
  sources: ReadonlyMap<string, string>;
  inlays: ReadonlyMap<string, string>;
  assets: ReadonlyMap<string, string>;
  hashes: ReadonlyMap<string, string>;
}

export function remapEvidenceId(value: string, map: BardIdentity): string {
  if (map.sources.has(value)) return map.sources.get(value)!;
  if (value.startsWith('first-message:')) {
    const end = value.lastIndexOf(':');
    const chat = value.slice('first-message:'.length, end);
    if (map.chats.has(chat)) return `first-message:${map.chats.get(chat)}${value.slice(end)}`;
  }
  if (value.startsWith('character-description:')) {
    const id = decodeURIComponent(value.slice('character-description:'.length));
    if (map.characters.has(id)) return 'character-description:' + encodeURIComponent(map.characters.get(id)!);
  }
  return value;
}

/** Only schema-owned identity fields are relinked. Prose, script state and graph node IDs are not IDs of chats. */
export function remapBardRecord(value: Json, map: BardIdentity, key = ''): Json {
  if (typeof value === 'string') {
    if (['characterId', 'storyId'].includes(key)) return map.characters.get(value) ?? value;
    if (['chatId', 'branchId', 'sourceChatId'].includes(key)) return map.chats.get(value) ?? value;
    if (key === 'saveId') return map.slots.get(value) ?? value;
    if (['messageId', 'latestMessageId', 'sourceMessageIds', 'source_messages', 'sourceId', 'sourceIds'].includes(key)) return remapEvidenceId(value, map);
    if (['afterHash', 'contentHash'].includes(key)) return map.hashes.get(value) ?? value;
    return value;
  }
  if (Array.isArray(value)) return value.map(child => remapBardRecord(child, map, key));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([field, child]) => [field, remapBardRecord(child, map, field)]));
}

/** Media aliases are exact references, never substitutions of bare IDs in narrative prose. */
export function remapBardMedia(text: string, map: BardIdentity): string {
  return text.replace(/\{\{(inlay|inlayed|inlayeddata)::([^{}]+)\}\}/g,
    (token, kind, id) => map.inlays.has(id) ? `{{${kind}::${map.inlays.get(id)}}}` : token)
    .replace(/assets\/[A-Za-z0-9_.-]+/g, path => map.assets.get(path) ?? path);
}

export function remapBardMarkdown(text: string, map: BardIdentity): string {
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return remapBardMedia(text, map);
  const end = text.indexOf('\n---', 4);
  if (end < 0) throw new Error('Invalid Bard Markdown frontmatter');
  // RisuBard writes list entries as JSON strings; leave authored Markdown untouched.
  const header = text.slice(0, end).replace(/(^source_messages:\r?\n)((?:[ \t]+- .*\r?\n?)+)/m, (_all, label, lines: string) =>
    label + lines.replace(/(^[ \t]+- )(".*")(\r?$)/gm, (_line, prefix, encoded, tail) =>
      prefix + JSON.stringify(remapEvidenceId(JSON.parse(encoded), map)) + tail));
  return remapBardMedia(header + text.slice(end), map);
}

export function remapBardChat<T extends Record<string, Json>>(chat: T, map: BardIdentity): T {
  const result = JSON.parse(JSON.stringify(chat)) as T;
  if (typeof result.id === 'string') (result as Record<string, Json>).id = map.chats.get(result.id) ?? result.id;
  // The remaining chat fields include arbitrary Lua variables; only these Bard structures own references.
  for (const key of ['bardPainter', 'risuBardGallery']) {
    if (result[key]) {
      const media = (value: Json, field = ''): Json => typeof value === 'string'
        ? ['assetId', 'referenceAssetId'].includes(field) ? map.inlays.get(value) ?? value : remapBardMedia(value, map)
        : Array.isArray(value) ? value.map(child => media(child))
        : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, media(v, k)])) : value;
      (result as Record<string, Json>)[key] = media(remapBardRecord(result[key], map));
    }
  }
  const messages = Array.isArray(result.message) ? result.message : [];
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) continue;
    if (message.risubardCanonicalReceipt) message.risubardCanonicalReceipt = remapBardRecord(message.risubardCanonicalReceipt, map);
    if (typeof message.saying === 'string') message.saying = map.characters.get(message.saying) ?? message.saying;
  }
  return result;
}
