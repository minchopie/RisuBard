'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveInside, readVerifiedJson, atomicWriteJson, commitTransaction, recoverTransactions } = require('./file-store.cjs');
const { createCharacterDirectoryResolver } = require('./character-directories.cjs');
const INDEX = 'index/live-character-assets.json';
const IGNORED_FILES = /\.(?:sha256|bak|tmp|part|swp|crdownload)$/i;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
// This is a change hint, not an integrity proof: reuse only a previously hashed
// file with the same identity and timestamps. Content checks remain SHA-256.
const fileStamp = stat => `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;

function createLiveFileRecovery(root) {
    const active = 'trash/live-files-recovery/pending.json';
    return {
        load() {
            if (!fs.existsSync(resolveInside(root, active))) return null;
            const info = readVerifiedJson(root, active);
            return info ? { info, record: readVerifiedJson(root, info.path) } : null;
        },
        save(record) {
            const relative = `trash/live-files-recovery/${crypto.randomUUID()}.json`;
            atomicWriteJson(root, relative, { schemaVersion: 1, createdAt: new Date().toISOString(), ...record });
            const info = { path: relative, conflicts: record.conflicts.length };
            atomicWriteJson(root, active, info);
            return info;
        },
        complete() {
            if (fs.existsSync(resolveInside(root, active))) atomicWriteJson(root, active, null);
        },
    };
}

function metadataSnapshot(database) {
    return {
        characters: (database?.characters || []).map(({ chats, chatPage, ...metadata }) => structuredClone(metadata)),
        loreBook: structuredClone(database?.loreBook || []),
        chatMetadata: (database?.characters || []).flatMap(character => (character.chats || []).map(chat => {
            const { message, id, _stub, _placeholder, isStreaming, activeStreamingDisplayOptimizationMode, ...metadata } = chat;
            return { characterId: character.chaId, chatId: id, metadata: structuredClone(metadata) };
        })),
    };
}

function mergePendingLiveDatabase(pending, baseline, external, conflicts = []) {
    const merged = { ...pending };
    const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    merged.characters = pending.characters.map(local => {
        const before = baseline.characters.find(value => value.chaId === local.chaId);
        const after = external.characters.find(value => value.chaId === local.chaId);
        if (!before || !after) return local;
        const result = { ...local };
        for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
            if (['chats', 'chatPage', 'chaId'].includes(key) || equal(before[key], after[key])) continue;
            if (!equal(local[key], before[key]) && !equal(local[key], after[key])) {
                conflicts.push({ characterId: local.chaId, field: key, local: local[key], external: after[key], baseline: before[key] });
            }
            if (Object.hasOwn(after, key)) result[key] = after[key];
            else delete result[key];
        }
        result.chats = (local.chats || []).map(chat => {
            const prior = baseline.chatMetadata?.find(entry => entry.characterId === local.chaId && entry.chatId === chat.id)?.metadata;
            const incoming = after.chats?.find(value => value.id === chat.id);
            if (!prior || !incoming) return chat;
            const mergedChat = { ...chat };
            for (const key of new Set([...Object.keys(prior), ...Object.keys(incoming)])) {
                if (['message', 'id', '_stub', '_placeholder', 'isStreaming', 'activeStreamingDisplayOptimizationMode'].includes(key) || equal(prior[key], incoming[key])) continue;
                if (!equal(chat[key], prior[key]) && !equal(chat[key], incoming[key])) {
                    conflicts.push({ characterId: local.chaId, chatId: chat.id, field: key, local: chat[key], external: incoming[key], baseline: prior[key] });
                }
                if (Object.hasOwn(incoming, key)) mergedChat[key] = incoming[key];
                else delete mergedChat[key];
            }
            return mergedChat;
        });
        return result;
    });
    if (!equal(baseline.loreBook, external.loreBook)) {
        if (!equal(pending.loreBook, baseline.loreBook) && !equal(pending.loreBook, external.loreBook)) {
            conflicts.push({ field: 'loreBook', local: pending.loreBook, external: external.loreBook, baseline: baseline.loreBook });
        }
        merged.loreBook = external.loreBook;
    }
    return merged;
}

/** Files are inputs; never overwrite a partially saved editor buffer. */
function createLiveCharacterFiles(options) {
    let active;
    let initialized = false;
    function setEnabled(enabled) {
        if (enabled && !active) active = createActiveLiveCharacterFiles({ ...options, forceInitialReconcile: initialized });
        else if (!enabled && active) { active.close(); active = undefined; }
    }
    setEnabled(options.enabled !== false);
    initialized = true;
    return {
        isEnabled: () => Boolean(active),
        setEnabled,
        reconcile: options => active?.reconcile(options) ?? null,
        invalidate: () => active?.invalidate(),
        reset: () => active?.reset(),
        accept: (database, revision) => active?.accept(database, revision),
        close: () => setEnabled(false),
    };
}

function createActiveLiveCharacterFiles({ repository, writeAsset, writeAssets, reloadAssets = () => {}, watch = true, settleMs = 250, forceInitialReconcile = false, onChange = () => {}, onlyCharacterIds = null }) {
    const root = repository.dataRoot;
    const directories = createCharacterDirectoryResolver(root);
    let accepted = repository.getProjectionRevision();
    let baseline;
    let needsInitialReconcile = forceInitialReconcile;
    try { baseline = metadataSnapshot(repository.exportLegacyDatabase({ metadataOnly: true })); }
    catch { baseline = { characters: [], loreBook: [] }; needsInitialReconcile = true; }
    let dirty = true;
    // A one-shot scan (onlyCharacterIds) starts with just those asset folders;
    // other characters' folders are neither read nor adopted.
    const scope = onlyCharacterIds
        ? onlyCharacterIds.map(id => path.posix.basename(directories.characterDirectory(id).replaceAll('\\', '/')))
        : null;
    let assetsDirty = !scope;
    // Asset directories touched since the last scan. Our own atomic metadata
    // writes also report their parent directory; rescanning every character
    // for each save read all assets and metadata.
    const dirtyAssetDirectories = new Set(scope || []);
    let changedAt = 0;
    let watcher;
    let fallback = false;
    let lastScan = 0;
    const fingerprints = new Map();
    function safe(relative) {
        const target = resolveInside(root, relative);
        let current = root;
        for (const part of path.relative(root, target).split(path.sep)) {
            current = path.join(current, part);
            if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error(`External edit uses a symbolic link: ${relative}`);
        }
        return target;
    }
    function readIndex(relative, initial) {
        safe(relative);
        return fs.existsSync(resolveInside(root, relative)) ? readVerifiedJson(root, relative, { allowBackup: false }) : initial;
    }
    function invalidate(includeAssets = true, directory = '') {
        dirty = true;
        if (includeAssets && directory) dirtyAssetDirectories.add(directory);
        else assetsDirty ||= includeAssets;
        changedAt = Date.now();
    }
    // Asset listings (filename -> stamp) from the last successful scan, keyed by
    // the character's assets directory. A background sweep compares against them.
    const scannedListings = new Map();
    function rememberListings(plan) {
        for (const [relative, listing] of plan.listings || []) scannedListings.set(relative, listing);
    }
    let sweepTimer = null;
    let sweeping = false;
    let sweepAgain = false;
    function requestSweep() {
        if (sweeping) { sweepAgain = true; return; }
        if (sweepTimer) return;
        sweepTimer = setTimeout(() => { sweepTimer = null; void sweepAssets(); }, settleMs);
        sweepTimer.unref?.();
    }
    // A watcher overflow (an event without a filename) means events were lost,
    // not that every asset changed. Stat the asset files off the event loop and
    // mark only the directories that differ, instead of a blocking full rescan
    // of every asset file inside a save request.
    async function sweepAssets() {
        sweeping = true;
        try {
            directories.refresh();
            const changedDirectories = [];
            for (const id of directories.characterIds()) {
                const relative = directories.characterDirectory(id).replaceAll('\\', '/');
                const listing = scannedListings.get(`${relative}/assets`);
                if (!listing) { changedDirectories.push(path.posix.basename(relative)); continue; }
                let entries;
                try { entries = await fs.promises.readdir(resolveInside(root, `${relative}/assets`), { withFileTypes: true }); }
                catch (error) { if (error?.code !== 'ENOENT') throw error; entries = []; }
                const names = entries.map(entry => entry.name).filter(name => !name.startsWith('.') && !IGNORED_FILES.test(name));
                let changed = names.length !== listing.size;
                for (let index = 0; !changed && index < names.length; index += 64) {
                    const batch = names.slice(index, index + 64);
                    const stats = await Promise.all(batch.map(name => fs.promises
                        .lstat(resolveInside(root, `${relative}/assets/${name}`), { bigint: true }).catch(() => null)));
                    changed = stats.some((stat, position) => !stat || listing.get(batch[position]) !== fileStamp(stat));
                }
                if (changed) changedDirectories.push(path.posix.basename(relative));
            }
            for (const directory of changedDirectories) invalidate(true, directory);
            if (changedDirectories.length) onChange();
        } catch {
            invalidate();
            onChange();
        } finally {
            sweeping = false;
            if (sweepAgain) { sweepAgain = false; requestSweep(); }
        }
    }
    if (watch) {
        try {
            // libuv can abort on Windows 8.3 aliases; use its native long path.
            watcher = fs.watch(fs.realpathSync.native(root), { recursive: true }, (event, filename) => {
                const name = String(filename || '').replaceAll('\\', '/');
                if (!name) {
                    // Overflow: metadata is rechecked through the projection
                    // revision; assets are compared in the background.
                    invalidate(false);
                    requestSweep();
                    onChange();
                    return;
                }
                if (/^characters\/[^/]+(?:\/metadata\.json|\/assets(?:\/[^/]+)?)?$/.test(name)
                    || /^characters\/[^/]+\/chats\/[^/]+\/metadata\.json$/.test(name)
                    || /^lorebooks(?:\/[^/]+\.json)?$/.test(name)
                    || /^index\/(?:character-directories|character-asset-replicas)\.json$/.test(name)) {
                    // A character directory reports `change` whenever a file in it
                    // is replaced (every metadata save); only creating, removing or
                    // renaming the directory itself affects its assets.
                    const includeAssets = name.includes('/assets') || name.startsWith('index/')
                        || (event === 'rename' && /^characters\/[^/]+$/.test(name));
                    invalidate(includeAssets, /^characters\/([^/]+)/.exec(name)?.[1] || '');
                    onChange();
                }
            });
            watcher.on('error', () => { fallback = true; dirty = true; onChange(); });
            watcher.unref();
        } catch { fallback = true; }
    }
    function planAssets(onlyDirectories = null) {
        directories.refresh();
        const previous = readIndex(INDEX, { schemaVersion: 1, characters: {} });
        if (previous.schemaVersion !== 1 || !previous.characters || Array.isArray(previous.characters)) throw new Error('Invalid live asset index');
        const replicas = readIndex('index/character-asset-replicas.json', { characters: {} });
        let replicasChanged = false;
        const next = structuredClone(previous);
        const metadata = new Map();
        const originals = new Map();
        const pending = [];
        let contentChanged = false;
        const scannedDirectories = [];
        const listings = new Map();
        function assetStat(target) {
            const stat = fs.lstatSync(target, { bigint: true });
            if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Asset must be a regular file: ${path.basename(target)}`);
            return stat;
        }
        for (const id of directories.characterIds()) {
            const relative = directories.characterDirectory(id).replaceAll('\\', '/');
            if (onlyDirectories && !onlyDirectories.has(path.posix.basename(relative))) continue;
            const assetRoot = safe(`${relative}/assets`);
            const directoryStat = fs.existsSync(assetRoot) ? fs.lstatSync(assetRoot, { bigint: true }) : null;
            if (directoryStat && (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())) throw new Error(`Asset directory must be a regular directory: ${relative}`);
            scannedDirectories.push({ relative: `${relative}/assets`, stamp: directoryStat && fileStamp(directoryStat) });
            const old = { ...previous.characters[id], ...Object.fromEntries(
                (replicas.characters?.[id]?.enabled ? replicas.characters[id].entries || [] : [])
                    .map(entry => {
                        const filename = entry.filename || entry.hash;
                        const prior = previous.characters[id]?.[filename];
                        return [filename, { ...(prior?.key === entry.key && prior?.hash === entry.hash ? prior : {}), key: entry.key, hash: entry.hash }];
                    }),
            ) };
            const entries = directoryStat ? fs.readdirSync(assetRoot, { withFileTypes: true }) : [];
            const listing = new Map();
            listings.set(`${relative}/assets`, listing);
            if (!entries.length && !Object.keys(old).length) continue;
            const filenameSet = new Set();
            const values = Object.create(null);
            const metadataPath = `${relative}/metadata.json`;
            const original = fs.readFileSync(safe(metadataPath));
            const character = JSON.parse(original.toString('utf8'));
            let changed = false;
            function retireReplica(filename) {
                const record = replicas.characters?.[id];
                if (!record?.entries) return;
                const entries = record.entries.filter(entry => (entry.filename || entry.hash) !== filename);
                if (entries.length !== record.entries.length) {
                    record.entries = entries;
                    record.copied = entries.length;
                    replicasChanged = true;
                }
            }
            function replaceReference(from, to) {
                if (character.image === from) { character.image = to || ''; changed = true; }
                for (const field of ['additionalAssets', 'emotionImages']) {
                    if (!Array.isArray(character[field])) continue;
                    character[field] = character[field].flatMap(entry => {
                        if (entry?.[1] !== from) return [entry];
                        changed = true;
                        return to ? [[entry[0], to, ...entry.slice(2)]] : [];
                    });
                }
            }
            for (const entry of entries) {
                if (entry.name.startsWith('.') || IGNORED_FILES.test(entry.name)) continue;
                if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Asset must be a regular file: ${entry.name}`);
                // readdir names are single path components. Validate ancestry once
                // per directory and lstat each file, then recheck ancestry below.
                const target = path.join(assetRoot, entry.name);
                const stat = assetStat(target);
                if (stat.size > 64n * 1024n * 1024n) throw new Error(`Asset exceeds 64 MiB: ${entry.name}`);
                if (!stat.size) throw new Error(`Asset is still empty: ${entry.name}`);
                const stamp = fileStamp(stat);
                listing.set(entry.name, stamp);
                const prior = old[entry.name];
                const cached = fingerprints.get(target) || prior;
                let bytes;
                const digest = cached?.stamp === stamp && /^[a-f0-9]{64}$/.test(cached.hash)
                    ? cached.hash : hash(bytes = fs.readFileSync(target));
                if (bytes && fileStamp(assetStat(target)) !== stamp) throw new Error(`Asset changed while reading: ${entry.name}`);
                fingerprints.set(target, { stamp, hash: digest });
                filenameSet.add(entry.name);
                if (prior?.hash === digest) { values[entry.name] = { ...prior, stamp }; continue; }
                contentChanged = true;
                // A1 leaves unregistered historical copies behind. Their valid
                // sidecars identify app-created files, not newly dropped input.
                // Remember them without importing; a later external edit has a
                // different hash and will enter the ordinary import path.
                if (!prior && fs.existsSync(`${target}.sha256`)
                    && fs.readFileSync(`${target}.sha256`, 'utf8').trim() === digest) {
                    values[entry.name] = { hash: digest, ignored: true, stamp };
                    continue;
                }
                retireReplica(entry.name);
                bytes ||= fs.readFileSync(target);
                const after = assetStat(target);
                if (fileStamp(after) !== stamp || hash(bytes) !== digest) throw new Error(`Asset changed while reading: ${entry.name}`);
                const suffix = path.extname(entry.name).slice(1).toLowerCase();
                const extension = /^[a-z0-9]{1,16}$/.test(suffix) ? suffix : 'bin';
                const key = `assets/live-${hash(Buffer.from(`${id}\0${entry.name}`)).slice(0, 16)}-${digest}.${extension}`;
                pending.push({ key, bytes });
                values[entry.name] = { key, hash: digest, stamp };
                if (prior?.key) replaceReference(prior.key, key);
                else {
                    character.additionalAssets ||= [];
                    character.additionalAssets.push([path.basename(entry.name, path.extname(entry.name)), key, extension]);
                    changed = true;
                }
            }
            for (const [filename, entry] of Object.entries(old)) {
                if (!filenameSet.has(filename)) { contentChanged = true; if (entry.key) replaceReference(entry.key, null); retireReplica(filename); }
            }
            next.characters[id] = values;
            if (changed) { metadata.set(metadataPath, json(character)); originals.set(metadataPath, original); }
        }
        // Reject directory/ancestor swaps and concurrent directory changes before
        // publishing fingerprints, immutable objects, or reference changes.
        for (const { relative, stamp } of scannedDirectories) {
            const target = safe(relative);
            const after = fs.existsSync(target) ? fs.lstatSync(target, { bigint: true }) : null;
            if ((after && (!after.isDirectory() || after.isSymbolicLink())) || (after && fileStamp(after)) !== stamp) throw new Error(`Asset directory changed while scanning: ${relative}`);
        }
        const operations = JSON.stringify(previous) === JSON.stringify(next) ? [] : [{ path: INDEX, data: json(next) }];
        if (replicasChanged) operations.push({ path: 'index/character-asset-replicas.json', data: json(replicas) });
        return { metadata, originals, pending, operations, replicasChanged, cacheOnly: !contentChanged && !replicasChanged, assetIndex: next, listings };
    }
    function reconcile({ verifyMetadata = false } = {}) {
        if (fallback && Date.now() - lastScan >= 1000) { dirty = true; assetsDirty = true; }
        // Watch events may be lost after atomic file replacement. Explicit UI
        // polls still check canonical metadata without rescanning asset bodies.
        if (!dirty && verifyMetadata && repository.getProjectionRevision() !== accepted) dirty = true;
        if (!dirty) return null;
        // Our own canonical saves also raise metadata events. When no asset is
        // pending and the projection still matches what we accepted, nothing is
        // being edited externally, so there is nothing to wait for or adopt.
        if (!needsInitialReconcile && !assetsDirty && !dirtyAssetDirectories.size && !fallback
            && repository.getProjectionRevision() === accepted) {
            dirty = false;
            return null;
        }
        if (Date.now() - changedAt < settleMs) {
            const error = new Error('External files are being saved; retry in a moment');
            error.code = 'LIVE_FILES_SETTLING';
            throw error;
        }
        lastScan = Date.now();
        const plan = assetsDirty ? planAssets()
            : dirtyAssetDirectories.size ? planAssets(new Set(dirtyAssetDirectories))
                : { metadata: new Map(), pending: [], operations: [] };
        const revision = repository.getProjectionRevision();
        if (!needsInitialReconcile && revision === accepted && !plan.metadata.size && (!plan.operations.length || plan.cacheOnly)) {
            // Fingerprint maintenance is not a database edit. Avoid rebuilding the
            // sidebar and compatibility save just to upgrade an old cache entry.
            if (plan.operations.length) {
                try { commitTransaction(root, plan.operations); }
                catch (error) { recoverTransactions(root); throw error; }
            }
            rememberListings(plan);
            dirty = false; assetsDirty = false; dirtyAssetDirectories.clear(); return null;
        }
        // Immutable keys can be staged first: interruption leaves only an unused
        // KV object. Metadata and filename ownership are published in one journal.
        if (plan.pending.length && writeAssets) writeAssets(plan.pending.map(asset => ({ key: asset.key, value: asset.bytes })));
        else for (const asset of plan.pending) writeAsset(asset.key, asset.bytes);
        const result = repository.reconcileCanonicalProjection({
            externalEditing: true, externalMetadata: plan.metadata, externalOriginals: plan.originals, externalOperations: plan.operations,
        });
        if (plan.replicasChanged) reloadAssets();
        result.previous = baseline;
        accepted = result.revision;
        baseline = metadataSnapshot(result.database);
        needsInitialReconcile = false;
        rememberListings(plan);
        dirty = false;
        assetsDirty = false;
        dirtyAssetDirectories.clear();
        return result;
    }
    return {
        reconcile, invalidate,
        reset: () => {
            fingerprints.clear();
            directories.refresh();
            accepted = repository.getProjectionRevision();
            baseline = metadataSnapshot(repository.exportLegacyDatabase({ metadataOnly: true }));
            needsInitialReconcile = false;
            invalidate();
        },
        accept: (database, revision) => {
            accepted = revision || repository.getProjectionRevision();
            baseline = metadataSnapshot(database || repository.exportLegacyDatabase({ metadataOnly: true }));
        },
        close: () => { if (sweepTimer) clearTimeout(sweepTimer); watcher?.close(); },
    };
}

module.exports = { createLiveCharacterFiles, metadataSnapshot, mergePendingLiveDatabase, createLiveFileRecovery };
