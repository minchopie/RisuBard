'use strict';
require('sucrase/register/ts');
const fs = require('node:fs/promises');
const { createReadStream, createWriteStream, openAsBlob, existsSync, readdirSync, readFileSync } = require('node:fs');
const { join, dirname, relative, isAbsolute, sep } = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Transform } = require('node:stream');
const { atomicWriteJson } = require('../file-store.cjs');
const { snapshotPlaySet, sanitizeTransferChat, selectTransferGallery } = require('../../../shared/play-set/snapshot.ts');
const { applyCharacterChats, incomingCharacters, matchingCharacters } = require('../../../shared/play-set/characterChats.ts');
const { canonical, decodeRecordKeys, remapRecord } = require('../../../shared/play-set/protocol.ts');
const { recordExport } = require('../../../shared/play-set/apply.ts');
const { writePlaySetArchive, openPlaySetArchive } = require('./play-set-archive.cjs');
const { attachPlaySetMemory, playSetMemoryMaterials } = require('./play-set-memory.cjs');
const { relinkWorkspace, sourceIdentityMap, hash } = require('./play-set-relink.cjs');
const { resolveMemoryWorkspace } = require('../risubard-memory-workspace.ts');
const { saveStoreDirectory } = require('../risubard-memory-save-store.ts');
const { memorySaveWorkspaceId } = require('../risubard-memory-save.ts');
const { bardFingerprints } = require('./play-set-fingerprint.cjs');

const id = value => { if (typeof value !== 'string' || !/^[a-f0-9-]{36}$/i.test(value)) throw new Error('Invalid transfer handle'); return value; };
const clone = value => JSON.parse(JSON.stringify(value));
async function syncDir(path) {
    let fd;
    try { fd = await fs.open(path, 'r'); await fd.sync(); }
    catch (error) { if (process.platform !== 'win32') throw error; }
    finally { await fd?.close(); }
}

function createPlaySetService({ dataRoot, readDatabase, memory, storage, readInlay, installInlay, removeInlay, nativeInbox, foreignArchive = null }) {
    const root = join(dataRoot, 'play-transfer');
    const directory = key => join(root, id(key));
    let activeTransaction;
    let activeRecord;
    if (existsSync(root)) for (const name of readdirSync(root)) if (/^[a-f0-9-]{36}$/i.test(name)) {
        const path = join(root, name, 'state.json');
        if (existsSync(path)) {
            const record = JSON.parse(readFileSync(path, 'utf8'));
            if (record.state === 'receiving') {
                record.state = 'failed'; record.error = '받는 도중 앱이 종료됐어요. 파일을 다시 보내거나 이 항목을 취소해 주세요.';
                atomicWriteJson(root, `${name}/state.json`, record);
            }
            if (record.plan) { activeTransaction = record.plan.transaction; activeRecord = record.id; }
        }
    }
    let operating = false;
    let lane = Promise.resolve();
    const exclusive = operation => { const next = lane.then(async () => { operating = true; try { return await operation(); } finally { operating = false; } }); lane = next.catch(() => {}); return next; };
    const write = record => {
        atomicWriteJson(root, `${id(record.id)}/state.json`, record);
        if (record.plan) { activeTransaction = record.plan.transaction; activeRecord = record.id; }
        else if (record.id === activeRecord) { activeTransaction = undefined; activeRecord = undefined; }
    };
    const assertWrite = req => {
        if (req.path.startsWith('/api/play-transfer')) return;
        const token = req.headers['x-play-transfer-id'];
        if (token ? token !== activeTransaction : activeTransaction || operating) {
            const error = new Error('Transfer recovery must finish before saving'); error.status = 423; error.code = 'TRANSFER_BUSY'; throw error;
        }
    };
    const read = async key => JSON.parse(await fs.readFile(join(directory(key), 'state.json'), 'utf8'));
    async function list() {
        await fs.mkdir(root, { recursive: true, mode: 0o700 });
        const result = [];
        for (const name of await fs.readdir(root)) if (/^[a-f0-9-]{36}$/i.test(name)) {
            try { result.push(await read(name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        return result.sort((a, b) => b.createdAt - a.createdAt);
    }
    const publicState = record => ({ id: record.id, direction: record.direction, state: record.state, createdAt: record.createdAt,
        name: record.name, bytes: record.bytes, sha256: record.sha256, error: record.error, trusted: !!record.trusted, nativeId: record.nativeId, progress: record.progress, ...(record.kind ? { kind: record.kind } : {}) });
    async function ingest(source, { name = '대화 자료.risuplay', trusted = false, nativeId } = {}) {
        const key = randomUUID(), dir = directory(key);
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const record = { id: key, direction: 'receive', state: 'receiving', createdAt: Date.now(), name: String(name).slice(0, 200), trusted, ...(nativeId ? { nativeId } : {}) };
        write(record);
        let bytes = 0, checked = 0;
        const digest = createHash('sha256');
        const meter = new Transform({ transform(chunk, _encoding, done) {
            bytes += chunk.length; digest.update(chunk);
            if (bytes - checked < 8 * 1024 * 1024) return done(null, chunk);
            checked = bytes;
            fs.statfs(dir, { bigint: true }).then(space => {
                if (space.bavail * space.bsize < BigInt(chunk.length + 1024 * 1024)) throw new Error('Not enough storage space');
                done(null, chunk);
            }, done).catch(done);
        } });
        try {
            const partial = join(dir, 'incoming.part');
            await pipeline(source, meter, createWriteStream(partial, { flags: 'wx', mode: 0o600 }));
            const fd = await fs.open(partial, 'r+'); try { await fd.sync(); } finally { await fd.close(); }
            const archive = await openPlaySetArchive(partial, dir); await archive.close();
            await fs.rename(partial, join(dir, 'incoming.risuplay')); await syncDir(dir);
            Object.assign(record, { state: 'waiting', bytes, sha256: digest.digest('hex') }); write(record);
            return publicState(record);
        } catch (error) { record.state = 'failed'; record.error = String(error.message); write(record); throw error; }
    }
    async function exportSet(selection) {
        if ((await list()).some(item => item.plan && item.state === 'applying')) throw new Error('Finish pending import first');
        const key = randomUUID(), dir = directory(key);
        const database = await readDatabase();
        const character = database?.characters?.find(c => c.chaId === selection.characterId);
        if (!character || !selection.chatIds?.length || selection.chatIds.some(ch => !character.chats?.some(c => c.id === ch))) throw new Error('Select existing chats');
        if (character.chats.some(c => selection.chatIds.includes(c.id) && (c.isStreaming || c.risuBardWikiReboot))) throw new Error('Wait for generation and Wiki work to finish');
        const selectedHash = hash(canonical(character, true));
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const work = await fs.mkdtemp(join(dir, 'export-work-'));
        let capture, recorded = false;
        try {
            capture = await memory.capturePlaySetMemory({ characterId: character.chaId, chatIds: selection.chatIds, temporaryDirectory: work });
            const binary = async key => {
                const path = join(work, randomUUID());
                return await storage.kvExportFile(key, path) ? openAsBlob(path) : null;
            };
            const originFile = join(root, 'origin.json');
            let origin;
            try { origin = JSON.parse(await fs.readFile(originFile, 'utf8')); }
            catch (error) { if (error.code !== 'ENOENT') throw error; origin = randomUUID(); atomicWriteJson(root, 'origin.json', origin); }
            let snapshot = await snapshotPlaySet({ database, origin, cold: async () => { throw new Error('Hydrate cold storage before exporting'); },
                asset: binary, lazyAssets: true, digestBlob: async blob => {
                    const digest = createHash('sha256'); for await (const chunk of blob.stream()) digest.update(chunk); return digest.digest('hex');
                }, inlay: readInlay, chatMaterials: (c, ch) => playSetMemoryMaterials(capture, c, ch) },
                { ...selection, setId: selection.setId || randomUUID(), characterChatsOnly: true });
            if (!selection.compatibility) snapshot = await attachPlaySetMemory(snapshot, capture);
            else if (capture.workspaces.some(w => w.files.length || w.slots.length)) snapshot.excluded.push({ path: 'BardWiki/저장 슬롯', reason: '구 앱 호환 v1에는 Bard 기억과 슬롯이 포함되지 않습니다.' });
            if (snapshot.missing.length) return { missing: snapshot.missing, external: snapshot.external, excluded: snapshot.excluded };
            if (hash(canonical((await readDatabase()).characters.find(c => c.chaId === character.chaId), true)) !== selectedHash) throw new Error('Chat changed while exporting; retry after saving');
            const archive = await writePlaySetArchive(snapshot, work);
            await fs.rename(archive, join(dir, 'export.risuplay'));
            const digest = createHash('sha256'); for await (const chunk of createReadStream(join(dir, 'export.risuplay'))) digest.update(chunk);
            const record = { id: key, direction: 'send', state: 'ready', createdAt: Date.now(), name: `${character.name}.risuplay`,
                backupKey: hash(snapshot.manifest.primaryChat),
                bytes: (await fs.stat(join(dir, 'export.risuplay'))).size, sha256: digest.digest('hex') };
            const exported = await recordExport(database, snapshot);
            const generation = exported.risuPlaySets.generations.find(g => g.setId === snapshot.manifest.setId && g.revision === snapshot.manifest.revision);
            generation.bardFingerprints = await bardFingerprints(snapshot.manifest, snapshot.records, block => fs.readFile(capture.blocks.get(block.entry)));
            write(record); recorded = true;
            return { ...publicState(record), missing: [], external: snapshot.external, excluded: snapshot.excluded, registry: exported.risuPlaySets };
        } finally { await fs.rm(recorded ? work : dir, { recursive: true, force: true }); }
    }
    async function legacyChat(selection) {
        const database = await readDatabase();
        const character = database?.characters?.find(c => c.chaId === selection.characterId);
        const original = character?.chats?.find(c => c.id === selection.chatId);
        if (!original) throw new Error('보낼 캐릭터와 대화를 먼저 선택해 주세요.');
        const chat = clone(original), excluded = [];
        sanitizeTransferChat(chat, 'chat', excluded);
        selectTransferGallery(chat, new Set([chat.id]), 'chat', excluded, chat.id);
        return { type: 'risuChat', ver: 2, sourceCharacterId: character.chaId, data: chat,
            folders: (character.chatFolders ?? []).filter(folder => folder.id === chat.folderId),
            privateMobileChatSync: { characterId: character.chaId, characterName: character.name, exportedAt: Date.now() } };
    }
    async function inspect(key) {
        const record = await read(key);
        const archive = await openPlaySetArchive(join(directory(key), 'incoming.risuplay'), directory(key));
        try {
            const db = await readDatabase();
            return { ...publicState(record), characters: incomingCharacters(archive.manifest, archive.records).map(c => ({ ...c,
                candidates: matchingCharacters(db, c.name, c.id, c.originalId).map(local => ({ id: local.chaId, name: local.name })) })) };
        } finally { await archive.close(); }
    }
    async function prepare(key, targets = {}) {
        const all = await list();
        if (all.some(item => item.plan && item.state === 'applying')) throw new Error('Another import requires recovery');
        const record = await read(key);
        if (!['waiting', 'failed'].includes(record.state)) throw new Error('This transfer cannot be imported');
        const db = await readDatabase(), transaction = randomUUID();
        const dir = directory(key), staging = join(dir, transaction);
        await fs.mkdir(staging, { mode: 0o700 });
        let archive;
        try {
            archive = await openPlaySetArchive(join(dir, 'incoming.risuplay'), dir);
            const assets = new Map(archive.manifest.items.filter(i => i.kind === 'asset').map(i => [i.id, `assets/${randomUUID()}.${(i.media?.name?.split('.').at(-1) || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 12) || 'bin'}`]));
            const fingerprints = await bardFingerprints(archive.manifest, archive.records, async block => {
                const path = join(staging, randomUUID());
                try { await archive.copyEntry(block.entry, path); return await fs.readFile(path); }
                finally { await fs.rm(path, { force: true }); }
            });
            const result = await applyCharacterChats(db, archive.manifest, archive.records, assets, transaction, targets, true, fingerprints);
            const before = new Set(db.characters.flatMap(c => (c.chats ?? []).map(ch => ch.id)));
            const added = result.database.characters.flatMap(c => c.chats.filter(ch => !before.has(ch.id)).map(chat => ({ characterId: c.chaId, chat })));
            const newCharacters = result.database.characters.filter(c => !db.characters.some(old => old.chaId === c.chaId)).map(c => ({ ...c, chats: [] }));
            const plan = { transaction, staging: transaction, phase: 'preparing', added, newCharacters, registry: result.database.risuPlaySets,
                assetKeys: [], inlayIds: [], workspaces: [], pages: [], result: result.instanceId };
            record.plan = plan; record.state = 'applying'; delete record.error; write(record);
            if (result.generation) {
                const ids = result.generation.ids;
                const identities = { characters: new Map(), chats: new Map(), slots: new Map(), sources: new Map(), assets: new Map(), inlays: new Map(), hashes: new Map() };
                for (const workspace of archive.manifest.bard ?? []) {
                    identities.characters.set(workspace.sourceCharacterId, ids[workspace.character]);
                    identities.chats.set(workspace.sourceChatId, ids[workspace.chat]);
                    for (const slot of workspace.slots) identities.slots.set(slot.sourceId, randomUUID());
                }
                for (const item of archive.manifest.items.filter(i => i.kind === 'context' || i.kind === 'inlay')) {
                    const raw = archive.records.get(item.entry), decoded = archive.manifest.recordEncoding ? decodeRecordKeys(raw) : raw;
                    if (item.kind === 'context') {
                        for (const [alias, origin] of Object.entries(decoded.assets ?? {})) identities.assets.set(alias, ids[origin]);
                        for (const [alias, origin] of Object.entries(decoded.inlays ?? {})) identities.inlays.set(alias, ids[origin]);
                    } else identities.inlays.set(decoded.originalId, ids[item.id]);
                }
                for (const item of archive.manifest.items.filter(i => i.kind === 'character')) {
                    const raw = archive.records.get(item.entry), c = archive.manifest.recordEncoding ? decodeRecordKeys(raw) : raw;
                    const chats = item.references.filter(ref => /^\/chats\/\d+$/.test(ref.pointer)).map(ref => {
                        const chatItem = archive.manifest.items.find(candidate => candidate.id === ref.target);
                        const raw = archive.records.get(chatItem.entry);
                        const chat = archive.manifest.recordEncoding ? decodeRecordKeys(raw) : raw;
                        return { ...chat, id: (archive.manifest.bard ?? []).find(workspace => workspace.chat === ref.target)?.sourceChatId ?? chat.id };
                    });
                    sourceIdentityMap({ ...c, chaId: c.risuTransferOriginalId }, chats, ids[item.id], identities);
                }
                for (const item of archive.manifest.items.filter(i => i.kind === 'asset')) {
                    const name = randomUUID(), path = join(staging, name); await archive.copyEntry(item.entry, path);
                    plan.assetKeys.push({ key: assets.get(item.id), file: name });
                }
                for (const item of archive.manifest.items.filter(i => i.kind === 'inlay')) {
                    const mapped = remapRecord(archive.records.get(item.entry), item.references, new Map(Object.entries(ids)));
                    const value = archive.manifest.recordEncoding ? decodeRecordKeys(mapped) : mapped;
                    const asset = plan.assetKeys.find(asset => asset.key === value.data);
                    plan.inlayIds.push({ id: ids[item.id], metadata: value, file: asset?.file, text: asset ? undefined : value.data });
                }
                for (const workspace of archive.manifest.bard ?? []) {
                    const target = added.find(c => c.chat.id === ids[workspace.chat]); if (!target) continue;
                    const rel = `memory-${randomUUID()}`, mapped = await relinkWorkspace({ archive, workspace, directory: join(staging, rel), identities, destinationChatId: target.chat.id, media: target.chat.risuTransferMedia });
                    target.chat = mapped.chat(target.chat);
                    plan.workspaces.push({ characterId: target.characterId, chatId: target.chat.id, source: `${rel}/current` });
                    for (const slot of mapped.slots) {
                        plan.workspaces.push({ characterId: target.characterId, chatId: memorySaveWorkspaceId(slot.saveId), source: `${rel}/slots/${slot.saveId}` });
                        for (const page of slot.pages) plan.pages.push({ characterId: target.characterId, hash: page.hash, source: `${rel}/pages/${page.hash.slice(0, 2)}/${page.hash}` });
                    }
                }
            }
            plan.phase = 'prepared'; write(record);
            return { transaction, added: plan.added, newCharacters: plan.newCharacters, registry: plan.registry, duplicate: result.mode === 'duplicate' };
        } catch (error) {
            // No client has received a plan yet; leave the archive retryable after a preparation error.
            await finish(key);
            await fs.rm(staging, { recursive: true, force: true });
            throw error;
        } finally { await archive?.close(); }
    }
    async function arm(key, transaction, added) {
        const record = await read(key), plan = record.plan;
        if (plan?.transaction !== transaction || plan.phase !== 'prepared') throw new Error('Import preparation expired');
        if (!Array.isArray(added) || added.length !== plan.added.length || added.some((r, i) => r.characterId !== plan.added[i].characterId || r.chat?.id !== plan.added[i].chat.id)) throw new Error('Import identity changed');
        plan.expected = added.map(row => ({ characterId: row.characterId, chatId: row.chat.id, fields: Object.keys(row.chat), hash: hash(canonical(row.chat, true)) }));
        plan.phase = 'armed'; write(record);
        // Assets are immutable unique keys. The saved chat cannot refer to absent media after a crash.
        for (const inlay of plan.inlayIds) await installInlay(inlay, join(directory(key), plan.staging));
        for (const asset of plan.assetKeys) {
            const sourcePath = join(directory(key), plan.staging, asset.file);
            if (storage.kvGetUpdatedAt(asset.key) !== null) throw new Error('Transfer asset identity already exists');
            await storage.kvReplacePrefixesFromFilesAsync([{ key: asset.key, sourcePath }], []);
        }
        plan.phase = 'saving'; write(record);
        return { ready: true };
    }
    async function finish(key, confirmed = false) {
        const record = await read(key), plan = record.plan;
        if (!plan) {
            if (confirmed && record.state !== 'applied') throw new Error('Import has not been saved');
            return publicState(record);
        }
        const db = await readDatabase();
        const marker = db?.risuPlaySets?.transactions?.[plan.transaction];
        if (marker) {
            if (!plan.expected || marker !== plan.result || plan.expected.some(expected => {
                const chat = db.characters.find(c => c.chaId === expected.characterId)?.chats.find(c => c.id === expected.chatId);
                return !chat || expected.fields.some(field => chat[field] === undefined) || hash(canonical(Object.fromEntries(expected.fields.map(field => [field, chat[field]])), true)) !== expected.hash;
            })) throw new Error('Saved chat does not match the prepared import; recovery retained');
            plan.phase = 'committed'; write(record);
            const staging = join(directory(key), plan.staging);
            for (const page of plan.pages) {
                const store = saveStoreDirectory(resolveMemoryWorkspace(dataRoot, page.characterId, 'placeholder').directory);
                const target = join(store, page.hash.slice(0, 2), page.hash);
                await safeParents(dataRoot, dirname(target));
                try { await fs.copyFile(join(staging, page.source), target, 1); }
                catch (error) { if (error.code !== 'EEXIST' || hash(await fs.readFile(target)) !== page.hash) throw error; }
                const fd = await fs.open(target, 'r+'); try { await fd.sync(); } finally { await fd.close(); }
                await syncDir(dirname(target));
            }
            for (const workspace of plan.workspaces) {
                const target = resolveMemoryWorkspace(dataRoot, workspace.characterId, workspace.chatId).directory;
                await safeParents(dataRoot, dirname(target));
                const markerFile = join(target, '.play-transfer-owner.json');
                try { const owner = JSON.parse(await fs.readFile(markerFile, 'utf8')); if (owner.transaction !== plan.transaction) throw new Error('Workspace belongs to another import'); }
                catch (error) {
                    if (error.code !== 'ENOENT') throw error;
                    const source = join(staging, workspace.source);
                    atomicWriteJson(source, '.play-transfer-owner.json', { transaction: plan.transaction });
                    // rename on POSIX could replace an empty existing directory; explicitly reject it.
                    try { await fs.lstat(target); throw new Error('Memory workspace already exists'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
                    await fs.rename(source, target); await syncDir(dirname(target));
                }
            }
            record.state = 'applied';
        } else {
            if (confirmed || plan.added.some(row => db.characters.some(c => c.chaId === row.characterId && c.chats?.some(ch => ch.id === row.chat.id)))) throw new Error('Application save has not completed; recovery retained');
            // No DB rollback: the client published nothing durable. Remove only this plan's unique media.
            for (const asset of plan.assetKeys) storage.kvDel(asset.key);
            for (const inlay of plan.inlayIds) await removeInlay(inlay.id);
            record.state = 'waiting';
        }
        delete record.plan; write(record);
        if (record.state === 'applied') for (const workspace of plan.workspaces) {
            const marker = join(resolveMemoryWorkspace(dataRoot, workspace.characterId, workspace.chatId).directory, '.play-transfer-owner.json');
            for (const suffix of ['', '.sha256', '.bak', '.bak.sha256']) await fs.rm(marker + suffix, { force: true });
            memory.invalidateTransferCache(workspace.characterId, workspace.chatId);
        }
        // Keep the incoming archive until the user explicitly cancels/removes it.
        await fs.rm(join(directory(key), plan.staging), { recursive: true, force: true });
        return publicState(record);
    }
    async function cancel(key) {
        const record = await read(key);
        if (record.plan || ['receiving', 'applied'].includes(record.state)) throw new Error('Cannot cancel an active or completed import');
        record.state = 'cancelled'; write(record);
        for (const file of ['incoming.risuplay', 'incoming.part', 'export.risuplay']) await fs.rm(join(directory(key), file), { force: true });
        return publicState(record);
    }
    async function holdRecovery(key) {
        const record = await read(key);
        if (!record.plan) throw new Error('No pending import recovery');
        // Explicit recovery exit: preserve every byte, including partially published media and staging.
        record.retainedPlan = record.plan;
        delete record.plan;
        record.state = 'recovery-held'; record.error = '사용자가 복구를 보류했어요. 현재 대화·수신 원본·복구 자료는 그대로 보관돼요.';
        write(record);
        return publicState(record);
    }
    async function pending() { return (await list()).filter(record => record.plan).map(record => ({ id: record.id, transaction: record.plan.transaction, expected: record.plan.expected ?? [] })); }
    async function file(key) { const record = await read(key); return join(directory(key), record.direction === 'send' ? 'export.risuplay' : 'incoming.risuplay'); }
    /** A payload that is not a play set (currently: the NAS sync key share) is handed to its owner with the native inbox entry as
     *  the ONLY provenance: `trustedDevice` is written by the native transport (registered device id or `usb:adb`), never by the
     *  sender's bytes. Such payloads never enter the play-set queue. */
    async function foreign(file, entry) {
        if (!foreignArchive) return null;
        const kind = await foreignArchive.detect(file);
        return kind ? foreignArchive.receive(file, { kind, nativeId: entry.id, trustedDevice: typeof entry.trustedDevice === 'string' ? entry.trustedDevice : null }) : null;
    }
    async function importNative(key) {
        if (!nativeInbox) throw new Error('Native transfer is unavailable');
        id(key);
        const previous = (await list()).find(record => record.nativeId === key && ['waiting', 'applying', 'applied', 'cancelled', 'failed'].includes(record.state));
        if (previous) return publicState(previous);
        const inbox = JSON.parse(await fs.readFile(nativeInbox.state, 'utf8'));
        const entry = inbox.find(entry => entry.id === key);
        if (!entry) throw new Error('Native file is not in the inbox');
        const handle = id(entry.fileHandle), file = join(nativeInbox.archives, handle + '.risuplay');
        let stat;
        try { stat = await fs.lstat(file); }
        catch (error) { if (error.code === 'ENOENT' && foreignArchive) { const consumed = await foreignArchive.consumed(key); if (consumed) return consumed; } throw error; }
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid native archive');
        const digest = createHash('sha256'); for await (const chunk of createReadStream(file)) digest.update(chunk);
        if (entry.hash && digest.digest('hex') !== entry.hash) throw new Error('Native archive hash mismatch');
        const other = await foreign(file, entry); if (other) return other;
        return ingest(createReadStream(file), { nativeId: key, trusted: typeof entry.trustedDevice === 'string' && entry.trustedDevice !== 'usb:adb' });
    }
    /** Every native inbox archive that is a foreign payload, with its provenance (startup sweep: crash-before-import cleanup). */
    async function foreignInbox() {
        if (!nativeInbox || !foreignArchive) return [];
        let inbox; try { inbox = JSON.parse(await fs.readFile(nativeInbox.state, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
        const out = [];
        for (const entry of Array.isArray(inbox) ? inbox : []) {
            let file; try { file = join(nativeInbox.archives, id(entry.fileHandle) + '.risuplay'); const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) continue; } catch { continue; }
            const kind = await foreignArchive.detect(file).catch(() => null);
            if (kind) out.push({ file, kind, nativeId: entry.id, trustedDevice: typeof entry.trustedDevice === 'string' ? entry.trustedDevice : null });
        }
        return out;
    }
    /** A send record whose archive is built by the caller (used for the sync key share). The record is an ordinary `send` entry
     *  for the native `bard.export` handle flow; `transient` marks it for deletion by its owner. */
    async function stageSend({ name, kind, build }) {
        const key = randomUUID(), dir = directory(key);
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        try {
            await build(join(dir, 'export.risuplay'));
            const digest = createHash('sha256'); for await (const chunk of createReadStream(join(dir, 'export.risuplay'))) digest.update(chunk);
            const record = { id: key, direction: 'send', state: 'ready', createdAt: Date.now(), name: String(name).slice(0, 200), kind, transient: true, bytes: (await fs.stat(join(dir, 'export.risuplay'))).size, sha256: digest.digest('hex') };
            write(record);
            return publicState(record);
        } catch (error) { await fs.rm(dir, { recursive: true, force: true }); throw error; }
    }
    async function dropStaged(key) { id(key); await fs.rm(directory(key), { recursive: true, force: true }); }
    async function stagedSends(kind) { return (await list()).filter(r => r.direction === 'send' && r.kind === kind).map(publicState); }
    function registerRoutes(app, { auth, downloadAuth = auth, activeSession }) {
        const route = (method, path, handler) => app[method]('/api/play-transfer' + path, async (req, res) => {
            try {
                if (!await (path === '/:id/file' ? downloadAuth : auth)(req, res) || method !== 'get' && !activeSession(req, res)) return;
                await handler(req, res);
            } catch (error) { if (!res.headersSent) res.status(400).json({ error: error.message }); else res.destroy(error); }
        });
        route('get', '', async (_req, res) => res.json([...(await list()).map(publicState), ...(foreignArchive?.consumedAll ? await foreignArchive.consumedAll() : [])])); // + terminal sync-share outcomes for the native status path
        route('get', '/recovery', async (_req, res) => res.json(await pending()));
        route('post', '/native-import', async (req, res) => res.json(await exclusive(() => importNative(req.body.id))));
        route('post', '/incoming', async (req, res) => res.json(await ingest(req, { name: decodeURIComponent(req.headers['x-transfer-name'] ?? '대화 자료.risuplay') })));
        route('post', '/export', async (req, res) => res.json(await exclusive(() => exportSet(req.body))));
        route('get', '/:id/inspect', async (req, res) => res.json(await inspect(req.params.id)));
        route('get', '/:id/file', async (req, res) => res.download(await file(req.params.id), (await read(req.params.id)).name));
        route('post', '/:id/prepare', async (req, res) => res.json(await exclusive(() => prepare(req.params.id, req.body.targets))));
        route('post', '/:id/arm', async (req, res) => res.json(await exclusive(() => arm(req.params.id, req.body.transaction, req.body.added))));
        route('post', '/:id/finish', async (req, res) => res.json(await exclusive(() => finish(req.params.id, req.body.confirmed === true))));
        route('post', '/:id/hold-recovery', async (req, res) => { if (req.body.confirmed !== true) throw new Error('Recovery exit requires confirmation'); res.json(await exclusive(() => holdRecovery(req.params.id))); });
        route('post', '/:id/cancel', async (req, res) => res.json(await exclusive(() => cancel(req.params.id))));
    }
    return { assertWrite, list, ingest, exportSet, inspect, prepare: (...args) => exclusive(() => prepare(...args)), arm: (...args) => exclusive(() => arm(...args)),
        finish: (...args) => exclusive(() => finish(...args)), holdRecovery: (...args) => exclusive(() => holdRecovery(...args)), pending, cancel, file, legacyChat, stageSend, dropStaged, stagedSends, foreignInbox, importNative: key => exclusive(() => importNative(key)), registerRoutes };
}
async function safeParents(root, path) {
    const rel = relative(root, path);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw new Error('Transfer path escapes storage');
    let current = root;
    for (const part of rel.split(sep).filter(Boolean)) {
        current = join(current, part); await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') throw error; });
        const stat = await fs.lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe transfer directory');
    }
}
module.exports = { createPlaySetService };
