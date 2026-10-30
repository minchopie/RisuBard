'use strict';
require('sucrase/register/ts');
const { createHash } = require('node:crypto');
const { canonical, decodeRecordKeys, DEFAULT_RECORD_BYTE_BUDGET } = require('../../../shared/play-set/protocol.ts');
const { remapBardRecord, remapBardChat, remapBardMarkdown, remapBardMedia } = require('../../../shared/play-set/bardIdentity.ts');
const { sourceIdentityMap } = require('./play-set-relink.cjs');
const { decodeMemorySaveChat } = require('../../../src/ts/risubard/memorySaveCodec.ts');
const { parseSavedFiles, SAVE_FILES } = require('../risubard-memory-save-store.ts');
const hash = (value, encoding = 'hex') => createHash('sha256').update(value).digest(encoding);

/** Local receipts use verified contents, not sender-asserted hashes, to ignore only relocated identities. */
async function bardFingerprints(manifest, records, readBlock) {
    const result = {};
    const record = item => manifest.recordEncoding ? decodeRecordKeys(records.get(item.entry)) : records.get(item.entry);
    for (const workspace of manifest.bard ?? []) {
        const map = { characters: new Map(), chats: new Map(), slots: new Map(), sources: new Map(), inlays: new Map(), assets: new Map(), hashes: new Map() };
        for (const owner of manifest.bard) {
            map.characters.set(owner.sourceCharacterId, owner.character); map.chats.set(owner.sourceChatId, owner.chat);
            for (const slot of owner.slots) map.slots.set(slot.sourceId, 'portable-save-slot');
        }
        for (const item of manifest.items) {
            if (item.kind === 'context') {
                const context = record(item);
                for (const kind of ['assets', 'inlays']) for (const [alias, target] of Object.entries(context[kind] ?? {})) {
                    const material = manifest.items.find(item => item.id === target);
                    if (material) map[kind].set(alias, kind === 'assets' ? `assets/${material.hash}` : `inlay-hash-${material.hash}`);
                }
            }
            if (item.kind === 'character') {
                const c = record(item), chats = item.references.filter(ref => /^\/chats\/\d+$/.test(ref.pointer)).map(ref => {
                    const chat = record(manifest.items.find(item => item.id === ref.target));
                    return { ...chat, id: manifest.bard.find(owner => owner.chat === ref.target)?.sourceChatId ?? chat.id };
                });
                sourceIdentityMap({ ...c, chaId: c.risuTransferOriginalId }, chats, item.id, map);
            }
        }
        const media = value => typeof value === 'string' ? remapBardMedia(value, map) : Array.isArray(value) ? value.map(media)
            : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, media(child)])) : value;
        const read = async block => {
            if (block.bytes > DEFAULT_RECORD_BYTE_BUDGET) throw new Error('Bard record exceeds fingerprint memory budget: ' + block.path);
            return readBlock(block);
        };
        const normalized = async (block, path, identities) => {
            if (!/\.(?:jsonl?|md|txt)$/.test(path) && path !== 'chat.bin') return block.hash;
            const bytes = await read(block);
            let value;
            if (path === 'chat.bin') {
                value = remapBardChat(decodeMemorySaveChat(bytes), identities);
                delete value.risuTransferMedia; delete value.risuTransferSource;
                return hash(canonical(media(value), true));
            }
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            if (path.endsWith('.json')) value = canonical(media(remapBardRecord(JSON.parse(text), identities)), true);
            else if (path.endsWith('.jsonl')) {
                const lines = text.split('\n');
                value = lines.map((line, index) => {
                    if (!line.trim()) return line;
                    let parsed;
                    try { parsed = JSON.parse(line); } catch (error) { if (index === lines.length - 1) return line; throw error; }
                    return canonical(media(remapBardRecord(parsed, identities)), true);
                }).join('\n');
            } else value = path.endsWith('.md') ? remapBardMarkdown(text, identities) : remapBardMedia(text, identities);
            identities.hashes.set(hash(bytes, 'base64url'), hash(value, 'base64url'));
            return hash(value);
        };
        const files = async (blocks, identities) => {
            const result = [];
            for (const block of [...blocks].sort((a, b) => Number(!a.path.endsWith('.md')) - Number(!b.path.endsWith('.md'))))
                result.push([block.path, await normalized(block, block.path, identities)]);
            return result.sort((a, b) => a[0].localeCompare(b[0], 'en'));
        };
        const current = await files(workspace.files, map), slots = [];
        for (const slot of workspace.slots) {
            const identities = { ...map, hashes: new Map(map.hashes) }, list = slot.files.find(file => file.path === SAVE_FILES);
            const pages = [];
            if (list) for (const saved of parseSavedFiles(new TextDecoder('utf-8', { fatal: true }).decode(await read(list)))
                .sort((a, b) => Number(!a.path.endsWith('.md')) - Number(!b.path.endsWith('.md')))) {
                const block = slot.pages.find(page => page.hash === saved.hash);
                if (!block || block.bytes !== saved.size) throw new Error('Missing saved page: ' + saved.path);
                pages.push([saved.path, await normalized(block, saved.path, identities)]);
            }
            slots.push(hash(canonical({ files: await files(slot.files.filter(file => file.path !== SAVE_FILES), identities), pages: pages.sort((a, b) => a[0].localeCompare(b[0], 'en')) }, true)));
        }
        result[workspace.chat] = hash(canonical({ current, slots: slots.sort() }, true));
    }
    return result;
}
module.exports = { bardFingerprints };
