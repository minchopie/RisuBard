'use strict';

require('sucrase/register/ts');
const fs = require('node:fs/promises');
const { createReadStream, openAsBlob } = require('node:fs');
const { createHash } = require('node:crypto');
const { dirname, basename, join, relative, resolve, isAbsolute, sep, toNamespacedPath } = require('node:path');
// fs.mkdtemp lacks Node's Windows long-path handling (>260 chars): create through the namespaced prefix, return the plain path.
const mkdtempLong = async prefix => join(dirname(prefix), basename(await fs.mkdtemp(toNamespacedPath(prefix))));
const { resolveMemoryWorkspace } = require('../risubard-memory-workspace.ts');
const { resolveLegacySourceSnapshotWorkspace } = require('../risubard-source-workspace.ts');
const { memorySaveWorkspaceId, parseMemorySaveManifest } = require('../risubard-memory-save.ts');
const { SAVE_FILES, parseSavedFiles, saveStoreDirectory } = require('../risubard-memory-save-store.ts');
const { workspacePath, validateRecords, MANIFEST_BYTE_LIMIT, DEFAULT_RECORD_BYTE_BUDGET } = require('../../../shared/play-set/protocol.ts');
const { sanitizeTransferChat, selectTransferGallery, finalizeSnapshotLineage } = require('../../../shared/play-set/snapshot.ts');
const { encodeMemorySaveChat, decodeMemorySaveChat } = require('../../../src/ts/risubard/memorySaveCodec.ts');

// Resolve every parent, not just the final file: a linked workspace must not export unrelated data.
async function safeStatus(root, path) {
    const rel = relative(root, path);
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Bard file escapes user data: ' + rel);
    let current = root, status = await fs.lstat(current);
    if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('Unsafe Bard storage root: ' + rel);
    for (const segment of rel.split(sep).filter(Boolean)) {
        if (!status.isDirectory()) throw new Error('Unsafe Bard parent directory: ' + rel);
        current = join(current, segment); status = await fs.lstat(current);
        if (status.isSymbolicLink()) throw new Error('Bard storage contains a symbolic link: ' + rel);
    }
    return status;
}
async function exists(root, path) {
    try { return await safeStatus(root, path); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function metadata(root, path) {
    const status = await safeStatus(root, path);
    if (!status.isFile() || status.size > MANIFEST_BYTE_LIMIT) throw new Error('Invalid Bard metadata file: ' + relative(root, path));
    const bytes = await fs.readFile(path);
    if (bytes.length > MANIFEST_BYTE_LIMIT) throw new Error('Bard metadata exceeds memory budget: ' + relative(root, path));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
const stamp = status => `${status.size}:${status.mtimeMs}:${status.ctimeMs}:${status.ino}`;

/** Caller holds the existing memory service's chat and save-store read lanes until this returns. */
async function capturePlaySetMemory({ userDataDirectory, characterId, chatIds, temporaryDirectory }) {
    const root = await fs.realpath(resolve(userDataDirectory));
    if (!Array.isArray(chatIds) || !chatIds.length || new Set(chatIds).size !== chatIds.length) throw new Error('Select unique chats');
    const directory = await mkdtempLong(join(temporaryDirectory, 'play-memory-'));
    const blocks = new Map(), workspaces = [], excluded = [];
    const cleanup = () => fs.rm(directory, { recursive: true, force: true });
    const capture = async (path, relativePath, expected) => {
        try { workspacePath(relativePath); }
        catch (error) { throw new Error(`${relative(root, path)}: ${error.message}`, { cause: error }); }
        const before = await safeStatus(root, path);
        if (!before.isFile() || !Number.isSafeInteger(before.size)) throw new Error('Invalid Bard file: ' + relativePath);
        const space = await fs.statfs(directory, { bigint: true });
        if (space.bavail * space.bsize < BigInt(before.size) * 2n) throw new Error('Not enough storage space for Bard snapshot: ' + relativePath);
        const staged = join(directory, String(blocks.size) + '.part');
        await fs.copyFile(path, staged, 1);
        const hash = createHash('sha256'); let bytes = 0;
        for await (const chunk of createReadStream(staged)) { bytes += chunk.length; hash.update(chunk); }
        const digest = hash.digest('hex');
        if (bytes !== before.size || stamp(before) !== stamp(await safeStatus(root, path))) throw new Error('Bard file changed while exporting: ' + relativePath);
        if (expected && (expected.hash !== digest || expected.size !== bytes)) throw new Error('Memory save page is damaged: ' + relativePath);
        const entry = `blobs/${digest}`;
        if (blocks.has(entry)) await fs.rm(staged);
        else { const target = join(directory, digest); await fs.rename(staged, target); blocks.set(entry, target); }
        return { path: relativePath, hash: digest, entry, bytes };
    };
    const walk = async (source, prefix = '') => {
        const status = await exists(root, source);
        if (!status) return [];
        if (!status.isDirectory()) throw new Error('Invalid Bard workspace: ' + relative(root, source));
        const files = [];
        for (const item of (await fs.readdir(source, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
            if (['.play-transfer-owner.json', '.play-transfer-owner.json.sha256', '.play-transfer-owner.json.bak', '.play-transfer-owner.json.bak.sha256'].includes(item.name)) continue;
            const path = join(source, item.name), name = prefix + item.name;
            const info = await safeStatus(root, path);
            if (item.name === '.risubard-fork.json') throw new Error('Finish pending Bard import before exporting: ' + name);
            if (item.name === '.risubard-recovery' || item.name === '.risubard-snapshots') {
                if (!info.isDirectory() || (await fs.readdir(path)).length) throw new Error('Finish pending Bard recovery before exporting: ' + name);
                continue;
            }
            if (info.isDirectory()) files.push(...await walk(path, name + '/'));
            else files.push(await capture(path, name));
        }
        return files;
    };
    try {
        for (const chatId of chatIds) {
            const files = await walk(resolveMemoryWorkspace(root, characterId, chatId).directory);
            const legacy = resolveLegacySourceSnapshotWorkspace(root, characterId, chatId);
            for (const [name, path] of [['source-snapshot.json', legacy.sourceSnapshotFile], ['baseline-summary.txt', legacy.baselineFile]]) {
                if (!files.some(file => file.path === name) && await exists(root, path)) files.push(await capture(path, name));
            }
            workspaces.push({ sourceCharacterId: characterId, sourceChatId: chatId, files, slots: [] });
        }
        const byChat = new Map(workspaces.map(workspace => [workspace.sourceChatId, workspace]));
        const chatsDirectory = dirname(resolveMemoryWorkspace(root, characterId, chatIds[0]).directory);
        if (await exists(root, chatsDirectory)) for (const item of await fs.readdir(chatsDirectory, { withFileTypes: true })) {
            if (!item.name.startsWith('id-')) continue;
            const slotId = Buffer.from(item.name.slice(3), 'base64url').toString('utf8');
            if (!slotId.startsWith('save-slot:')) continue;
            // Temporary/backup names are not canonical workspace names and must finish recovery first.
            if ('id-' + Buffer.from(slotId).toString('base64url') !== item.name) {
                if (item.name.includes('.fork-complete-') && item.isFile()) continue;
                throw new Error('Finish pending memory save operation before exporting: ' + item.name);
            }
            const slotDirectory = resolveMemoryWorkspace(root, characterId, slotId).directory;
            let manifest;
            try { manifest = parseMemorySaveManifest(JSON.parse(await metadata(root, join(slotDirectory, 'risubard-save.json')))); }
            catch (error) { throw new Error(`Invalid memory save ${slotId}: ${error.message}`, { cause: error }); }
            if (slotId !== memorySaveWorkspaceId(manifest.saveId)) throw new Error('Memory save identity does not match its directory: ' + slotId);
            const workspace = byChat.get(manifest.sourceChatId);
            if (!workspace) continue;
            try {
                const files = await walk(slotDirectory);
                if (!files.some(file => file.path === 'chat.bin')) throw new Error('Missing memory save chat.bin');
                const chatBlock = files.find(file => file.path === 'chat.bin');
                if (chatBlock.bytes > DEFAULT_RECORD_BYTE_BUDGET) throw new Error('Memory save chat exceeds decode memory budget');
                const chat = decodeMemorySaveChat(await fs.readFile(blocks.get(chatBlock.entry)));
                if (!chat || typeof chat !== 'object' || Array.isArray(chat) || !Array.isArray(chat.message)
                    || typeof chat.name !== 'string' || chat.characters || chat.botPresets) throw new Error('Invalid memory save chat snapshot');
                const omitted = [];
                selectTransferGallery(chat, new Set(chatIds), manifest.saveId + '/chat.bin', omitted, manifest.sourceChatId);
                sanitizeTransferChat(chat, manifest.saveId + '/chat.bin', omitted, true);
                // Only the export copy changes; the saved slot and its original bytes remain untouched.
                {
                    const bytes = encodeMemorySaveChat(chat), hash = createHash('sha256').update(bytes).digest('hex');
                    const entry = `blobs/${hash}`;
                    if (!blocks.has(entry)) { const target = join(directory, hash); await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); blocks.set(entry, target); }
                    Object.assign(chatBlock, { hash, entry, bytes: bytes.length });
                    excluded.push(...omitted);
                }
                const pages = [];
                if (manifest.schemaVersion === 2) {
                    const savedFiles = parseSavedFiles(await metadata(root, join(slotDirectory, SAVE_FILES)));
                    const seen = new Set();
                    for (const saved of savedFiles) {
                        try { workspacePath(saved.path); }
                        catch (error) { throw new Error(`${saved.path}: ${error.message}`, { cause: error }); }
                        if (seen.has(saved.hash)) {
                            if (pages.find(page => page.hash === saved.hash).bytes !== saved.size) throw new Error(`${saved.path}: Conflicting memory save page size (${saved.hash})`);
                            continue;
                        }
                        seen.add(saved.hash);
                        const page = saved.hash.slice(0, 2) + '/' + saved.hash;
                        try { pages.push(await capture(join(saveStoreDirectory(slotDirectory), page), page, saved)); }
                        catch (error) { throw new Error(`${saved.path}: ${error.message}`, { cause: error }); }
                    }
                }
                workspace.slots.push({ sourceId: manifest.saveId, files, pages });
            } catch (error) {
                throw new Error(`Memory save ${manifest.saveId}: ${error.message}`, { cause: error });
            }
        }
        return { directory, workspaces, blocks, excluded, scannedChats: new Set(), cleanup };
    } catch (error) { await cleanup(); throw error; }
}

/** The capture owns immutable local copies until archive output has completed. */
async function attachPlaySetMemory(snapshot, capture) {
    for (const workspace of capture.workspaces) if (!capture.scannedChats?.has(JSON.stringify([workspace.sourceCharacterId, workspace.sourceChatId]))) {
        throw new Error('Scan Bard workspace and slot materials before attaching the snapshot');
    }
    const itemId = (kind, local) => {
        const item = snapshot.manifest.items.find(item => item.kind === kind && snapshot.localIds.get(item.id) === local);
        if (!item) throw new Error('Bard workspace has no selected chat or character');
        return item.id;
    };
    const bard = capture.workspaces.map(workspace => ({ ...workspace,
        character: itemId('character', workspace.sourceCharacterId), chat: itemId('chat', workspace.sourceChatId) }));
    const manifest = { ...snapshot.manifest, items: snapshot.manifest.items.map(item => ({ ...item })), version: 2, bard };
    const blobLoaders = new Map(snapshot.blobLoaders);
    // fs.openAsBlob lacks Node's Windows long-path handling (>260 chars): pass the namespaced form; no-op elsewhere.
    for (const [entry, path] of capture.blocks) blobLoaders.set(entry, () => openAsBlob(toNamespacedPath(path)));
    const result = { ...snapshot, manifest, blobLoaders, excluded: [...snapshot.excluded, ...capture.excluded] };
    await finalizeSnapshotLineage(result);
    validateRecords(manifest, snapshot.records);
    return result;
}

/** Feeds the existing asset/inlay scanner; no alternate media matching rules. */
async function* playSetMemoryMaterials(capture, characterId, chatId) {
    const workspace = capture.workspaces.find(workspace => workspace.sourceCharacterId === characterId && workspace.sourceChatId === chatId);
    if (!workspace) throw new Error('Bard capture is missing the selected chat');
    const text = async (block, label = block.path) => {
        if (block.bytes > DEFAULT_RECORD_BYTE_BUDGET) throw new Error('Bard text exceeds scan memory budget: ' + label);
        try { return new TextDecoder('utf-8', { fatal: true }).decode(await fs.readFile(capture.blocks.get(block.entry))); }
        catch (error) { throw new Error(`Bard text ${label}: ${error.message}`, { cause: error }); }
    };
    for (const file of workspace.files) if (/\.(?:jsonl?|md|txt)$/i.test(file.path)) yield { label: file.path, value: await text(file) };
    for (const slot of workspace.slots) {
        const chat = slot.files.find(file => file.path === 'chat.bin');
        let decoded;
        try { decoded = decodeMemorySaveChat(await fs.readFile(capture.blocks.get(chat.entry))); }
        catch (error) { throw new Error(`${slot.sourceId}/chat.bin: ${error.message}`, { cause: error }); }
        yield { label: slot.sourceId + '/chat.bin', value: decoded };
        for (const file of slot.files) if (/\.(?:jsonl?|md|txt)$/i.test(file.path)) yield { label: slot.sourceId + '/' + file.path, value: await text(file, slot.sourceId + '/' + file.path) };
        const list = slot.files.find(file => file.path === SAVE_FILES);
        if (list) for (const file of parseSavedFiles(await text(list, slot.sourceId + '/' + list.path))) {
            if (!/\.(?:jsonl?|md|txt)$/i.test(file.path)) continue;
            const page = slot.pages.find(page => page.hash === file.hash);
            if (!page || page.bytes !== file.size) throw new Error('Missing memory save page: ' + slot.sourceId + '/' + file.path);
            yield { label: slot.sourceId + '/' + file.path, value: await text(page, slot.sourceId + '/' + file.path) };
        }
    }
    capture.scannedChats.add(JSON.stringify([characterId, chatId]));
}

module.exports = { capturePlaySetMemory, attachPlaySetMemory, playSetMemoryMaterials };
