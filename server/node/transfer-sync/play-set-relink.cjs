'use strict';
require('sucrase/register/ts');
const fs = require('node:fs/promises');
const { join, dirname } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { remapBardChat, remapBardRecord, remapBardMarkdown, remapBardMedia } = require('../../../shared/play-set/bardIdentity.ts');
const { DEFAULT_RECORD_BYTE_BUDGET, workspacePath } = require('../../../shared/play-set/protocol.ts');
const { decodeMemorySaveChat, encodeMemorySaveChat } = require('../../../src/ts/risubard/memorySaveCodec.ts');
const { parseSavedFiles, serializeSavedFiles, SAVE_FILES } = require('../risubard-memory-save-store.ts');
const { projectLegacyNarrativeSources } = require('../../../src/ts/risubard/sourceProjection.ts');

const hash = (bytes, encoding = 'hex') => createHash('sha256').update(bytes).digest(encoding);

function sourceIdentityMap(character, chats, target, identities) {
    const groups = [{ scopeId: `character:${character.chaId}`, entries: character.globalLore ?? [] },
        ...chats.map(chat => ({ scopeId: `chat:${chat.id}`, entries: chat.localLore ?? [] }))];
    const old = projectLegacyNarrativeSources({ characterId: character.chaId, description: character.desc, loreGroups: groups });
    const mapped = projectLegacyNarrativeSources({ characterId: target, description: character.desc,
        loreGroups: groups.map(group => ({ ...group, scopeId: group.scopeId.startsWith('character:')
            ? `character:${target}` : `chat:${identities.chats.get(group.scopeId.slice(5)) ?? group.scopeId.slice(5)}` })) });
    old.sources.forEach((source, index) => identities.sources.set(source.sourceId, mapped.sources[index].sourceId));
}

/** Build private copies only. The transaction host publishes them after the app's durable chat save. */
async function relinkWorkspace({ archive, workspace, directory, identities, destinationChatId, media }) {
    await fs.mkdir(directory, { recursive: true });
    const rewrite = async (block, path, map = identities) => {
        workspacePath(path);
        const raw = join(directory, `${randomUUID()}.raw`);
        await archive.copyEntry(block.entry, raw);
        try {
            if (!/\.(?:jsonl?|md|txt)$/.test(path) && path !== 'chat.bin') return await fs.readFile(raw);
            if (block.bytes > DEFAULT_RECORD_BYTE_BUDGET) throw new Error('Bard record exceeds decode memory budget: ' + path);
            const bytes = await fs.readFile(raw);
            if (path === 'chat.bin') {
                const chat = remapBardChat(decodeMemorySaveChat(bytes), map);
                if (media) chat.risuTransferMedia = media;
                return Buffer.from(encodeMemorySaveChat(chat));
            }
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            let result;
            if (path.endsWith('.json')) result = JSON.stringify(remapBardRecord(JSON.parse(text), map));
            else if (path.endsWith('.jsonl')) {
                // The existing memory reader tolerates an incomplete final line; preserve it verbatim.
                const lines = text.split('\n');
                result = lines.map((line, index) => {
                    if (!line.trim()) return line;
                    let parsed;
                    try { parsed = JSON.parse(line); }
                    catch (error) { if (index === lines.length - 1) return line; throw error; }
                    return JSON.stringify(remapBardRecord(parsed, map));
                }).join('\n');
            } else if (path.endsWith('.md')) result = remapBardMarkdown(text, map);
            else result = remapBardMedia(text, map);
            if (result !== text) map.hashes.set(hash(bytes, 'base64url'), hash(result, 'base64url'));
            return Buffer.from(result);
        } finally { await fs.rm(raw, { force: true }); }
    };
    const save = async (destination, bytes) => {
        await fs.mkdir(dirname(destination), { recursive: true });
        const handle = await fs.open(destination, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    };
    const copyFiles = async (files, destination, map) => {
        // Markdown revisions establish the old/new content hash pairs used by JSON receipts.
        for (const block of [...files].sort((a, b) => Number(!a.path.endsWith('.md')) - Number(!b.path.endsWith('.md')))) {
            workspacePath(block.path);
            const target = join(destination, block.path);
            if (!/\.(?:jsonl?|md|txt)$/.test(block.path) && block.path !== 'chat.bin') {
                await fs.mkdir(dirname(target), { recursive: true });
                await archive.copyEntry(block.entry, target);
            } else await save(target, await rewrite(block, block.path, map));
        }
    };
    const current = join(directory, 'current');
    await fs.mkdir(current);
    await copyFiles(workspace.files, current, identities);
    const slots = [];
    for (const slot of workspace.slots) {
        const saveId = identities.slots.get(slot.sourceId);
        if (!saveId) throw new Error('Missing destination save ID');
        const slotDirectory = join(directory, 'slots', saveId);
        await fs.mkdir(slotDirectory, { recursive: true });
        // Snapshot receipts refer to the revisions in this slot, not later current-workspace files.
        const map = { ...identities, hashes: new Map(identities.hashes) };
        const fileList = slot.files.find(file => file.path === SAVE_FILES);
        const pages = [];
        if (fileList) {
            const decoded = parseSavedFiles((await rewrite(fileList, fileList.path, map)).toString());
            for (const file of [...decoded].sort((a, b) => Number(!a.path.endsWith('.md')) - Number(!b.path.endsWith('.md')))) {
                const block = slot.pages.find(page => page.hash === file.hash);
                if (!block || block.bytes !== file.size) throw new Error('Missing save page: ' + file.path);
                if (!/\.(?:jsonl?|md|txt)$/.test(file.path)) {
                    const target = join(directory, 'pages', file.hash.slice(0, 2), file.hash);
                    await fs.mkdir(dirname(target), { recursive: true });
                    try { await archive.copyEntry(block.entry, target); } catch (error) { if (error.code !== 'EEXIST') throw error; }
                    pages.push(file); continue;
                }
                const bytes = await rewrite(block, file.path, map);
                const digest = hash(bytes), target = join(directory, 'pages', digest.slice(0, 2), digest);
                try { await save(target, bytes); } catch (error) { if (error.code !== 'EEXIST') throw error; }
                pages.push({ path: file.path, hash: digest, size: bytes.length });
            }
        }
        await copyFiles(slot.files.filter(file => file.path !== SAVE_FILES), slotDirectory, map);
        if (fileList) await save(join(slotDirectory, SAVE_FILES), Buffer.from(serializeSavedFiles(pages)));
        const manifestPath = join(slotDirectory, 'risubard-save.json');
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        if (manifest.sourceChatId !== destinationChatId || manifest.saveId !== saveId) throw new Error('Relinked save identity mismatch');
        slots.push({ saveId, directory: slotDirectory, pages });
    }
    return { current, slots, chat: chat => remapBardChat(chat, identities) };
}

module.exports = { sourceIdentityMap, relinkWorkspace, hash };
