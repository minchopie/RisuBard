'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWriteFile, atomicWriteJson, readVerifiedJson, resolveInside, commitTransaction, recoverTransactions } = require('./file-store.cjs');
const { sanitizeSegment, allocateSegment, createSegmentAllocator } = require('./friendly-paths.cjs');
const { createCharacterDirectoryResolver } = require('./character-directories.cjs');
const INDEX = 'index/character-asset-replicas.json';
// Module asset folders (pilot): modules/<friendly name>/assets/, created only by an
// explicit per-module action. Module JSON files stay at modules/<id>.json.
const MODULE_INDEX = 'index/module-asset-replicas.json';
const MODULE_OWNER = id => `module:${id}`;
const { reportImportProgress } = require('./import-progress.cjs');
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const validFilename = value => typeof value === 'string' && value.length > 0 && sanitizeSegment(value) === value;
// Coarse filesystems (FAT/exFAT) keep 2-second timestamps. A file changed this
// recently can be edited again without a visible stat change, so it is hashed again.
const RACY_STAMP_MS = 5000;
const fileSignature = stat => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

function candidateNames(character) {
    const names = new Map();
    function add(key, label, extensionHint) {
        if (typeof key !== 'string' || !/^assets\/[A-Za-z0-9._-]+$/.test(key)) return;
        const basename = key.slice('assets/'.length);
        const extension = path.posix.extname(basename) || (/^[A-Za-z0-9]{1,16}$/.test(extensionHint || '') ? `.${extensionHint}` : '');
        let name = typeof label === 'string' && label.trim() ? label : basename;
        if (extension && !name.toLowerCase().endsWith(extension.toLowerCase())) name += extension;
        if (!names.has(key)) names.set(key, name);
    }
    // Preserve explicit asset labels where present; a hashed KV key cannot recover a lost upload filename.
    for (const asset of character.additionalAssets || []) add(asset?.[1], asset?.[0], asset?.[2]);
    for (const image of character.emotionImages || []) add(image?.[1], image?.[0]);
    add(character.image);
    return names;
}

function moduleCandidateNames(module) {
    const names = new Map();
    for (const asset of Array.isArray(module?.assets) ? module.assets : []) {
        const key = asset?.[1];
        if (typeof key !== 'string' || !/^assets\/[A-Za-z0-9._-]+$/.test(key) || names.has(key)) continue;
        const basename = key.slice('assets/'.length);
        const extension = path.posix.extname(basename) || (/^[A-Za-z0-9]{1,16}$/.test(asset?.[2] || '') ? `.${asset[2]}` : '');
        let name = typeof asset?.[0] === 'string' && asset[0].trim() ? asset[0] : basename;
        if (extension && !name.toLowerCase().endsWith(extension.toLowerCase())) name += extension;
        names.set(key, name);
    }
    return names;
}

// Collects every (overlapping) "assets/..." run once; lookup by prefix gives the
// same answer as text.includes(key) for asset keys without one scan per key.
function referenceIndex(text) {
    const references = [...new Set(Array.from(text.matchAll(/(?=(assets\/[A-Za-z0-9._-]+))/g), match => match[1]))].sort();
    return key => {
        let low = 0;
        let high = references.length;
        while (low < high) {
            const middle = (low + high) >> 1;
            if (references[middle] < key) low = middle + 1;
            else high = middle;
        }
        return low < references.length && references[low].startsWith(key);
    };
}

function createCharacterAssets({ dataRoot, sourceSize, readOriginal, sourceVersion, sourcePath,
    folderReads = process.env.RISUBARD_ASSET_FOLDER_READS !== '0' }) {
    let state = { schemaVersion: 1, characters: {} };
    let moduleState = { schemaVersion: 1, modules: {} };
    let routes = new Map();
    // Module copies route separately: character publications rebuild only `routes`,
    // module publications replace only their own module's entries.
    let moduleRoutes = new Map();
    let loadedModuleIndex = null;
    const directories = createCharacterDirectoryResolver(dataRoot);
    let routeMapping;
    const synced = new Map();
    const counters = { reads: 0, fallbacks: 0, verified: 0, rejected: 0, copied: 0, failed: 0 };
    // Per-session proof that a folder copy matched its KV digest at a stat signature.
    let stamps = new Map();
    function safePath(relative) {
        const target = resolveInside(dataRoot, relative);
        let current = dataRoot;
        for (const part of path.relative(dataRoot, target).split(path.sep)) {
            current = path.join(current, part);
            if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('Asset path uses a symbolic link');
        }
        return target;
    }
    function rebuild() {
        routes = new Map();
        routeMapping = directories.snapshot();
        for (const [id, record] of Object.entries(state.characters)) {
            if (!validId(id) || record?.enabled !== true || !Array.isArray(record.entries)) continue;
            let directory = null;
            if (folderReads) {
                try { directory = safePath(`${directories.characterDirectory(id)}/assets`); } catch { continue; }
            }
            for (const entry of record.entries) {
                // Live-edit copies may change before reconciliation and shared KV keys must
                // keep serving immutable originals. Folder reads therefore verify every copy
                // against the KV digest (see readVerified); without them, sync-managed
                // copies stay unread and KV serves the bytes.
                if (entry?.readFromKv === true && !folderReads) continue;
                if (entry && (entry.filename === undefined || validFilename(entry.filename)) && typeof entry.key === 'string' && entry.key.startsWith('assets/') && /^[a-f0-9]{64}$/.test(entry.hash) && Number.isSafeInteger(entry.size) && entry.size >= 0 && entry.size <= 64 * 1024 * 1024) {
                    try {
                        // One boundary check per character; per-file symlinks are rejected on verification.
                        const target = directory
                            ? path.join(directory, entry.filename ?? entry.hash)
                            : safePath(`${directories.characterDirectory(id)}/assets/${entry.filename ?? entry.hash}`);
                        if (directory && path.dirname(target) !== directory) continue;
                        routes.set(entry.key, { ...entry, id, target });
                    } catch { /* Validate path boundaries at publication/load, outside normal reads. */ }
                }
            }
        }
        pruneStamps();
    }
    function pruneStamps() {
        if (!stamps.size) return;
        const live = new Map();
        for (const map of [routes, moduleRoutes]) {
            for (const entry of map.values()) {
                const stampKey = `${entry.hash}\0${entry.target}`;
                if (stamps.has(stampKey)) live.set(stampKey, stamps.get(stampKey));
            }
        }
        stamps = live;
    }
    function moduleRouteEntries(id, record) {
        const result = [];
        if (!folderReads || !validId(id) || record?.enabled !== true || !validFilename(record.directory) || !Array.isArray(record.entries)) return result;
        let directory;
        try { directory = safePath(`modules/${record.directory}/assets`); } catch { return result; }
        for (const entry of record.entries) {
            if (!entry || !validFilename(entry.filename) || typeof entry.key !== 'string'
                || !entry.key.startsWith('assets/') || !/^[a-f0-9]{64}$/.test(entry.hash)
                || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 64 * 1024 * 1024) continue;
            const target = path.join(directory, entry.filename);
            if (path.dirname(target) === directory) result.push([entry.key, { ...entry, id: MODULE_OWNER(id), target }]);
        }
        return result;
    }
    function rebuildModules() {
        moduleRoutes = new Map();
        for (const [id, record] of Object.entries(moduleState.modules)) {
            for (const [key, route] of moduleRouteEntries(id, record)) if (!moduleRoutes.has(key)) moduleRoutes.set(key, route);
        }
        pruneStamps();
    }
    function refreshModuleRoutes(id) {
        const owner = MODULE_OWNER(id);
        for (const [key, route] of moduleRoutes) if (route.id === owner) moduleRoutes.delete(key);
        for (const [key, route] of moduleRouteEntries(id, moduleState.modules[id])) if (!moduleRoutes.has(key)) moduleRoutes.set(key, route);
        pruneStamps();
    }
    function reload() {
        synced.clear();
        stamps = new Map();
        state = { schemaVersion: 1, characters: {} };
        try {
            safePath(INDEX);
            const loaded = readVerifiedJson(dataRoot, INDEX);
            if (loaded?.schemaVersion === 1 && loaded.characters && typeof loaded.characters === 'object' && !Array.isArray(loaded.characters)) state = loaded;
        } catch { /* An optional replica index must never prevent startup. */ }
        rebuild();
        // The module index lists every copied file; parse it again only when it changed
        // (restore, another process). Character reloads after external edits skip it.
        const signature = moduleIndexSignature();
        if (signature === loadedModuleIndex) return;
        moduleState = { schemaVersion: 1, modules: {} };
        try {
            safePath(MODULE_INDEX);
            if (signature !== 'missing') {
                const loaded = readVerifiedJson(dataRoot, MODULE_INDEX);
                if (loaded?.schemaVersion === 1 && loaded.modules && typeof loaded.modules === 'object' && !Array.isArray(loaded.modules)) moduleState = loaded;
            }
        } catch { /* Same as above: module folders are an optional read path. */ }
        loadedModuleIndex = signature;
        rebuildModules();
    }
    function moduleIndexSignature() {
        try {
            const stat = fs.statSync(path.join(dataRoot, MODULE_INDEX), { bigint: true });
            return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        } catch { return 'missing'; }
    }
    reload();
    function publish(next) {
        safePath(INDEX);
        atomicWriteJson(dataRoot, INDEX, next);
        state = next;
        rebuild();
    }
    function status(id) {
        if (!validId(id)) throw new Error('Invalid character ID');
        const record = Object.hasOwn(state.characters, id) ? state.characters[id] : null;
        return record ? { enabled: record.enabled, copied: record.copied, skipped: record.skipped, failed: record.failed } : { enabled: false, copied: 0, skipped: 0, failed: 0 };
    }
    function migrate(database, id, readSource) {
        if (!validId(id)) throw new Error('Invalid character ID');
        const matches = database.characters?.filter(character => character.chaId === id);
        if (matches?.length !== 1 || matches[0].type === 'group') throw new Error('A unique character is required');
        if (!fs.existsSync(safePath(`${directories.characterDirectory(id)}/metadata.json`))) throw new Error('Canonical character is unavailable');
        const character = matches[0];
        const candidates = candidateNames(character);
        const directory = safePath(`${directories.characterDirectory(id)}/assets`);
        const filenames = createSegmentAllocator(fs.existsSync(directory) ? fs.readdirSync(directory) : []);
        const previous = state.characters[id]?.entries || [];
        // Conservative snapshot: any occurrence outside this character makes the asset shared.
        const otherData = JSON.stringify({ ...database, characters: database.characters.filter(value => value !== character) }).replace(/\\\\/g, '/');
        const record = { enabled: true, copied: 0, skipped: 0, failed: 0, entries: [] };
        for (const [key, sourceName] of candidates) {
            if (otherData.includes(key)) { record.skipped++; continue; }
            try {
                if (sourceSize(key) > 64 * 1024 * 1024) throw new Error('Oversized source');
                const bytes = (readOriginal || readSource)(key);
                if (!Buffer.isBuffer(bytes) || bytes.length > 64 * 1024 * 1024) throw new Error('Missing or oversized source');
                const digest = hash(bytes);
                const preferred = allocateSegment(sourceName, new Set(), true);
                const old = previous.find(entry => entry?.key === key && entry.hash === digest && entry.sourceName === preferred && validFilename(entry.filename));
                let filename;
                if (old) {
                    try {
                        const oldPath = safePath(`${directories.characterDirectory(id)}/assets/${old.filename}`);
                        if (fs.statSync(oldPath).size === bytes.length && hash(fs.readFileSync(oldPath)) === digest) filename = old.filename;
                    } catch { /* Keep a damaged old copy untouched; publish a new verified filename. */ }
                }
                const needsWrite = !filename;
                if (!filename) {
                    filename = filenames.allocate(preferred, true, ['.sha256', '.bak']);
                }
                const relative = `${directories.characterDirectory(id)}/assets/${filename}`;
                const target = safePath(relative);
                if (needsWrite) atomicWriteFile(dataRoot, relative, bytes);
                const verified = fs.readFileSync(target);
                if (verified.length !== bytes.length || hash(verified) !== digest) throw new Error('Replica verification failed');
                for (const name of [filename, `${filename}.sha256`, `${filename}.bak`]) filenames.reserve(name);
                record.entries.push({ key, filename, sourceName: preferred, hash: digest, size: bytes.length });
                record.copied++;
            } catch { record.failed++; }
        }
        // Only verified copies become readable. Interrupted copies are harmless and retryable.
        publish({ schemaVersion: 1, characters: { ...state.characters, [id]: record } });
        counters.copied += record.copied;
        counters.failed += record.failed;
        return status(id);
    }
    // Called inside the canonical writer queue, after external edits have been adopted.
    // Copies and both ownership indices publish together; retired bytes remain recoverable.
    // This is delta publication, not a whole-store integrity scrub. Immutable KV
    // objects are verified on read; retained copies are inspected by live-file
    // reconciliation. Files we replace/retire still require content preconditions.
    function reusableEntry(entry, key) {
        const version = sourceVersion?.(key);
        return entry?.readFromKv === true && entry.key === key
            && validFilename(entry.filename) && /^[a-f0-9]{64}$/.test(version || '')
            && entry.hash === version && Number.isSafeInteger(entry.size)
            && entry.size > 0 && entry.size <= 64 * 1024 * 1024
            && entry.size === sourceSize(key);
    }
    function sync(database) {
        const mapping = directories.snapshot();
        const mapped = new Set(mapping.characters.filter(entry => entry.packageVersion === 1).map(entry => entry.id));
        const changed = (database.characters || []).filter(character => {
            if (!mapped.has(character.chaId) || character.type === 'group') return false;
            const candidates = [...candidateNames(character)];
            const signature = JSON.stringify(candidates.map(([key, name]) => [key, name, sourceVersion?.(key)]));
            if (synced.get(character.chaId) === signature) return false;
            const record = state.characters[character.chaId];
            const entries = new Map((record?.entries || []).map(entry => [entry.key, entry]));
            // The checksummed, journal-published index survives process/cache restarts.
            // Never seed this from unverified file timestamps or a missing source version.
            if (record?.enabled && record.failed === 0 && record.entries.length === candidates.length
                && entries.size === candidates.length && candidates.every(([key, name]) => {
                    const entry = entries.get(key);
                    return reusableEntry(entry, key) && entry.sourceName === allocateSegment(name, new Set(), true);
                })) {
                synced.set(character.chaId, signature);
                return false;
            }
            return true;
        });
        if (!changed.length) return { changed: false };
        const livePath = 'index/live-character-assets.json';
        let live = { schemaVersion: 1, characters: {} };
        if (fs.existsSync(safePath(livePath))) live = readVerifiedJson(dataRoot, livePath);
        if (live?.schemaVersion !== 1 || !live.characters || Array.isArray(live.characters)) throw new Error('Invalid live asset index');
        const next = JSON.parse(JSON.stringify(state));
        const operations = [];
        const completed = new Map();
        const retirement = `trash/asset-sync-${crypto.randomUUID()}`;
        for (const character of changed) {
            const id = character.chaId;
            const relative = `${directories.characterDirectory(id)}/assets`;
            const directory = safePath(relative);
            const filenames = createSegmentAllocator(fs.existsSync(directory) ? fs.readdirSync(directory) : []);
            const candidates = candidateNames(character);
            const tracked = { ...(live.characters[id] || {}) };
            for (const entry of state.characters[id]?.entries || []) {
                const filename = entry.filename || entry.hash;
                if (tracked[filename]?.key !== entry.key || tracked[filename]?.hash !== entry.hash) {
                    tracked[filename] = { key: entry.key, hash: entry.hash };
                }
            }
            const byKey = new Map();
            for (const [filename, entry] of Object.entries(tracked)) {
                if (!byKey.has(entry.key)) byKey.set(entry.key, [filename, entry]);
            }
            const previousEntries = new Map((state.characters[id]?.entries || []).map(entry => [entry.key, entry]));
            const record = { enabled: true, copied: 0, skipped: 0, failed: 0, entries: [] };
            const kept = new Set();
            for (const [key, sourceName] of candidates) {
                reportImportProgress('character-assets', record.copied, candidates.size, sourceName);
                const existing = byKey.get(key);
                const previous = previousEntries.get(key);
                if (reusableEntry(previous, key) && existing?.[0] === previous.filename
                    && existing[1].hash === previous.hash) {
                    kept.add(previous.filename);
                    record.entries.push({ ...previous, sourceName: allocateSegment(sourceName, new Set(), true) });
                    record.copied++;
                    continue;
                }
                // A copy belongs to this folder; even shared KV originals remain untouched.
                if (sourceSize(key) > 64 * 1024 * 1024) throw new Error('Oversized source');
                const bytes = readOriginal(key);
                if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error('Missing or oversized source');
                const digest = hash(bytes);
                let filename = existing?.[1].hash === digest ? existing[0] : undefined;
                if (filename) {
                    const target = safePath(`${relative}/${filename}`);
                    if (!fs.existsSync(target) || hash(fs.readFileSync(target)) !== digest) {
                        const error = new Error(`Asset changed outside the app: ${filename}`);
                        error.code = 'CANONICAL_FILES_CHANGED';
                        throw error;
                    }
                } else {
                    filename = filenames.allocate(sourceName, true, ['.sha256', '.bak']);
                    safePath(`${relative}/${filename}`);
                    // Retain immutable source paths, not every asset's bytes, until
                    // transaction staging. The writer verifies the expected digest
                    // before copying and verifies staged bytes again before publish.
                    operations.push(sourcePath
                        ? { path: `${relative}/${filename}`, sourcePath: sourcePath(key, digest), expectedChecksum: digest }
                        : { path: `${relative}/${filename}`, data: bytes });
                }
                kept.add(filename);
                if (tracked[filename]?.key !== key || tracked[filename]?.hash !== digest) {
                    tracked[filename] = { key, hash: digest };
                }
                record.entries.push({ key, filename, sourceName: allocateSegment(sourceName, new Set(), true), hash: digest, size: bytes.length, readFromKv: true });
                record.copied++;
            }
            for (const [filename, entry] of Object.entries(tracked)) {
                if (!entry.key || kept.has(filename)) continue;
                const source = `${relative}/${filename}`;
                const target = safePath(source);
                if (fs.existsSync(target)) {
                    const bytes = fs.readFileSync(target);
                    if (hash(bytes) !== entry.hash) {
                        const error = new Error(`Asset changed outside the app: ${filename}`);
                        error.code = 'CANONICAL_FILES_CHANGED';
                        throw error;
                    }
                    // The unchanged write adds a hash precondition before the journal is prepared.
                    operations.push({ path: source, data: bytes });
                    operations.push({ path: source, moveTo: `${retirement}/${id}/${filename}` });
                    for (const suffix of ['.sha256', '.bak']) {
                        if (fs.existsSync(safePath(`${source}${suffix}`))) operations.push({ path: `${source}${suffix}`, moveTo: `${retirement}/${id}/${filename}${suffix}` });
                    }
                }
                delete tracked[filename];
            }
            next.characters[id] = record;
            live.characters[id] = tracked;
            completed.set(id, JSON.stringify([...candidates].map(([key, name]) => [key, name, sourceVersion?.(key)])));
        }
        operations.push({ path: INDEX, data: Buffer.from(JSON.stringify(next)) });
        operations.push({ path: livePath, data: Buffer.from(JSON.stringify(live)) });
        try { commitTransaction(dataRoot, operations); }
        catch (error) {
            recoverTransactions(dataRoot);
            reload();
            throw error;
        }
        state = next;
        rebuild();
        for (const [id, signature] of completed) synced.set(id, signature);
        return { changed: true };
    }
    // Serves a folder copy only when its bytes are proven to equal the KV object:
    // a full SHA-256 on first use, then an unchanged stat signature (device, inode,
    // size, modification and change times) for the rest of this server session.
    // Every doubt throws so the caller falls back to the immutable KV original.
    function readVerified(entry) {
        const stampKey = `${entry.hash}\0${entry.target}`;
        const stamp = stamps.get(stampKey);
        const fd = fs.openSync(entry.target, 'r');
        try {
            const before = fs.fstatSync(fd, { bigint: true });
            if (!before.isFile() || before.size !== BigInt(entry.size)) throw new Error('Invalid replica size');
            const signature = fileSignature(before);
            if (stamp?.rejected === signature) throw new Error('Replica content differs');
            const value = Buffer.allocUnsafe(entry.size);
            let offset = 0;
            while (offset < value.length) {
                const count = fs.readSync(fd, value, offset, value.length - offset, offset);
                if (count === 0) throw new Error('Replica truncated during read');
                offset += count;
            }
            if (fileSignature(fs.fstatSync(fd, { bigint: true })) !== signature) throw new Error('Replica changed during read');
            if (stamp?.signature === signature && stamp.trusted) return value;
            if (fs.lstatSync(entry.target).isSymbolicLink()) throw new Error('Asset path uses a symbolic link');
            if (hash(value) !== entry.hash) {
                stamps.set(stampKey, { rejected: signature });
                counters.rejected++;
                throw new Error('Replica content differs');
            }
            counters.verified++;
            const changedAt = Math.max(Number(before.mtimeMs), Number(before.ctimeMs));
            stamps.set(stampKey, { signature, trusted: Date.now() - changedAt > RACY_STAMP_MS });
            return value;
        } finally { fs.closeSync(fd); }
    }
    function read(key, currentEntry) {
        try {
            if (directories.snapshot() !== routeMapping) rebuild();
        } catch { counters.fallbacks++; return null; }
        // Character copies keep priority; either copy is digest-verified on use.
        const entry = routes.get(key) ?? moduleRoutes.get(key);
        if (!entry) return null;
        if (folderReads) {
            try {
                // KV remains authoritative: replacement, import and deletion invalidate old replicas.
                if (entry.hash !== currentEntry.object || entry.size !== currentEntry.size) throw new Error('Stale replica');
                const value = readVerified(entry);
                counters.reads++;
                return value;
            } catch { counters.fallbacks++; return null; }
        }
        try {
            // KV remains authoritative: replacement, import and deletion invalidate old replicas.
            if (entry.hash !== currentEntry.object || entry.size !== currentEntry.size) throw new Error('Stale replica');
            // SHA-256 verification belongs to migration/revalidation, not every image read.
            const value = fs.readFileSync(entry.target);
            if (value.length !== entry.size) throw new Error('Invalid replica size');
            counters.reads++;
            return value;
        } catch { counters.fallbacks++; return null; }
    }
    // Entries whose folder copy is proven equal to the KV object right now and whose
    // key no other owner or data references. Everything else stays in the manifest.
    function retirable(entries, directory, otherKeys, referencedBy) {
        const candidates = [];
        const sharedBy = {};
        let shared = 0;
        let unverified = 0;
        for (const entry of entries) {
            const place = typeof entry?.key !== 'string' ? 'other' : otherKeys.has(entry.key) ? 'replica' : referencedBy(entry.key);
            if (place) { shared++; sharedBy[place] = (sharedBy[place] || 0) + 1; continue; }
            try {
                if (!(entry.filename === undefined || validFilename(entry.filename)) || !/^[a-f0-9]{64}$/.test(entry.hash)) throw new Error('Invalid entry');
                const target = path.join(directory, entry.filename ?? entry.hash);
                if (path.dirname(target) !== directory || fs.lstatSync(target).isSymbolicLink()) throw new Error('Invalid replica path');
                const bytes = fs.readFileSync(target);
                if (bytes.length !== entry.size || hash(bytes) !== entry.hash) throw new Error('Replica differs');
                candidates.push({ key: entry.key, object: entry.hash, size: entry.size });
            } catch { unverified++; }
        }
        return { candidates, shared, unverified, sharedBy };
    }
    // Names the first place that also references a key, for the transition summary.
    // Together the parts cover exactly the data a whole-database search would cover.
    function referencePlaces(database, skipCharacter, skipModule) {
        const index = value => referenceIndex(JSON.stringify(value ?? null).replace(/\\\\/g, '/'));
        const places = [
            ['characters', index((database.characters || []).filter(value => value !== skipCharacter))],
            ['modules', index((database.modules || []).filter(value => value !== skipModule))],
            ['personas', index(database.personas)],
            ['plugins', index(database.pluginCustomStorage)],
            ['other', index({ ...database, characters: undefined, modules: undefined, personas: undefined, pluginCustomStorage: undefined })],
        ];
        return key => places.find(([, referenced]) => referenced(key))?.[0] ?? null;
    }
    // Copies recorded for characters or modules that no longer exist are not owners.
    function replicaKeys(database, skipCharacter, skipModule) {
        const characters = new Set((database.characters || []).map(character => character?.chaId));
        const modules = new Set((database.modules || []).map(module => module?.id));
        const keys = new Set();
        for (const [owner, record] of Object.entries(state.characters)) {
            if (owner !== skipCharacter && characters.has(owner) && Array.isArray(record?.entries)) for (const entry of record.entries) keys.add(entry?.key);
        }
        for (const [owner, record] of Object.entries(moduleState.modules)) {
            if (owner !== skipModule && modules.has(owner) && Array.isArray(record?.entries)) for (const entry of record.entries) keys.add(entry?.key);
        }
        return keys;
    }
    // V4 pilot: entries of one V3 character whose folder copy is proven equal to the
    // KV object right now and whose key nothing else references. Shared keys, keys
    // used by other replica owners and unverifiable copies stay in the manifest.
    function retirementCandidates(database, id) {
        if (!validId(id)) throw new Error('Invalid character ID');
        const matches = database.characters?.filter(character => character.chaId === id);
        if (matches?.length !== 1 || matches[0].type === 'group') throw new Error('A unique character is required');
        if (!directories.snapshot().characters.some(entry => entry.id === id && entry.packageVersion === 1)) {
            throw new Error('V3 character package is required');
        }
        const record = state.characters[id];
        if (record?.enabled !== true || !Array.isArray(record.entries)) throw new Error('Verified asset copies are required');
        const directory = safePath(`${directories.characterDirectory(id)}/assets`);
        return retirable(record.entries, directory, replicaKeys(database, id, null), referencePlaces(database, matches[0], null));
    }
    function uniqueModule(database, id) {
        if (!validId(id)) throw new Error('Invalid module ID');
        const matches = database.modules?.filter(module => module?.id === id);
        if (matches?.length !== 1) throw new Error('A unique module is required');
        return matches[0];
    }
    // Compact JSON: the index lists every copied file and is rewritten per module action.
    function publishModules(next, changedId) {
        safePath(MODULE_INDEX);
        atomicWriteFile(dataRoot, MODULE_INDEX, Buffer.from(JSON.stringify(next)));
        moduleState = next;
        loadedModuleIndex = moduleIndexSignature();
        if (changedId) refreshModuleRoutes(changedId);
        else rebuildModules();
    }
    function moduleStatus(id) {
        if (!validId(id)) throw new Error('Invalid module ID');
        const record = Object.hasOwn(moduleState.modules, id) ? moduleState.modules[id] : null;
        return record
            ? { enabled: record.enabled === true, directory: record.directory, copied: record.copied, failed: record.failed }
            : { enabled: false, directory: '', copied: 0, failed: 0 };
    }
    // Module copies run in three steps so a large module never holds the storage
    // queue or the event loop: plan (queued) -> copy (async, unqueued) -> publish (queued).
    // Copying is safe outside the queue: KV objects are immutable, the target folder
    // belongs to this job alone, and every copy is digest-verified again on read.
    const moduleJobs = new Set();
    function prepareModuleCopy(database, id) {
        return planModuleCopy(id, uniqueModule(database, id));
    }
    function planModuleCopy(id, module) {
        if (moduleJobs.has(id)) throw Object.assign(new Error('Module asset copy already running'), { code: 'MODULE_COPY_RUNNING' });
        const previous = moduleState.modules[id];
        let directoryName = validFilename(previous?.directory) ? previous.directory : '';
        if (!directoryName) {
            const occupied = fs.existsSync(path.join(dataRoot, 'modules')) ? fs.readdirSync(safePath('modules')) : [];
            for (const [owner, record] of Object.entries(moduleState.modules)) if (owner !== id && record?.directory) occupied.push(record.directory);
            directoryName = createSegmentAllocator(occupied).allocate(typeof module.name === 'string' && module.name.trim() ? module.name : id, false, ['.json']);
        }
        moduleJobs.add(id);
        return {
            id, directoryName, relativeDirectory: `modules/${directoryName}/assets`,
            candidates: [...moduleCandidateNames(module)],
            reusable: (previous?.entries || []).filter(entry => validFilename(entry?.filename)),
        };
    }
    async function writeReplica(directory, filename, bytes) {
        await fs.promises.mkdir(directory, { recursive: true });
        const target = path.join(directory, filename);
        const temp = path.join(directory, `.${filename}.${crypto.randomUUID()}.tmp`);
        const handle = await fs.promises.open(temp, 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); }
        finally { await handle.close(); }
        try { await fs.promises.rename(temp, target); }
        catch (error) { await fs.promises.rm(temp, { force: true }); throw error; }
        return target;
    }
    // verifyExisting re-hashes every kept copy (manual check). Background sync trusts
    // a kept copy whose size matches, because reads still verify the digest.
    async function copyModule(plan, { verifyExisting = true, onProgress } = {}) {
        const directory = safePath(plan.relativeDirectory);
        const filenames = createSegmentAllocator(fs.existsSync(directory) ? await fs.promises.readdir(directory) : []);
        const reusable = new Map(plan.reusable.map(entry => [entry.key, entry]));
        const record = { enabled: true, directory: plan.directoryName, copied: 0, failed: 0, entries: [] };
        for (const [key, sourceName] of plan.candidates) {
            onProgress?.(record.copied + record.failed, plan.candidates.length);
            try {
                if (sourceSize(key) > 64 * 1024 * 1024) throw new Error('Oversized source');
                const old = reusable.get(key);
                if (old && old.hash === sourceVersion?.(key)) {
                    const kept = path.join(directory, old.filename);
                    const usable = verifyExisting
                        ? await fs.promises.readFile(kept).then(existing => existing.length === old.size && hash(existing) === old.hash, () => false)
                        : await fs.promises.stat(kept).then(stat => stat.isFile() && stat.size === old.size, () => false);
                    if (usable) {
                        record.entries.push(old);
                        record.copied++;
                        continue;
                    }
                }
                const bytes = readOriginal(key);
                if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 64 * 1024 * 1024) throw new Error('Missing or oversized source');
                const digest = hash(bytes);
                // Fresh names never overwrite user files; the index digest replaces .sha256 sidecars.
                const filename = filenames.allocate(sourceName, true, ['.sha256', '.bak']);
                const target = await writeReplica(directory, filename, bytes);
                const verified = await fs.promises.readFile(target);
                if (verified.length !== bytes.length || hash(verified) !== digest) throw new Error('Replica verification failed');
                record.entries.push({ key, filename, hash: digest, size: bytes.length });
                record.copied++;
            } catch { record.failed++; }
            // Yield so saves and asset reads keep flowing during a long copy.
            if ((record.copied + record.failed) % 16 === 0) await new Promise(resolve => setImmediate(resolve));
        }
        return record;
    }
    // Files this app copied and no longer lists go to trash/module-assets-*, which
    // backups skip: the bytes stay in KV. Unknown files in the folder are never touched.
    function moveModuleFilesToTrash(directoryName, filenames) {
        if (!filenames.length) return;
        const trash = `trash/module-assets-${crypto.randomUUID()}/${directoryName}`;
        for (const filename of filenames) {
            try {
                const source = safePath(`modules/${directoryName}/assets/${filename}`);
                if (!fs.existsSync(source)) continue;
                const target = safePath(`${trash}/${filename}`);
                fs.mkdirSync(path.dirname(target), { recursive: true });
                fs.renameSync(source, target);
            } catch { /* A leftover copy is unread and harmless. */ }
        }
    }
    // Only verified copies become readable; an interrupted copy leaves unread files.
    function publishModuleCopy(plan, record) {
        const previous = moduleState.modules[plan.id];
        publishModules({ schemaVersion: 1, modules: { ...moduleState.modules, [plan.id]: record } }, plan.id);
        counters.copied += record.copied;
        counters.failed += record.failed;
        if (previous?.directory === record.directory && Array.isArray(previous.entries)) {
            const kept = new Set(record.entries.map(entry => entry.filename));
            moveModuleFilesToTrash(record.directory, previous.entries.map(entry => entry?.filename).filter(name => validFilename(name) && !kept.has(name)));
        }
        return moduleStatus(plan.id);
    }
    function releaseModuleCopy(plan) {
        if (plan) moduleJobs.delete(plan.id);
    }
    async function migrateModule(database, id) {
        const plan = prepareModuleCopy(database, id);
        try { return publishModuleCopy(plan, await copyModule(plan)); }
        finally { releaseModuleCopy(plan); }
    }
    function disableModule(id) {
        moduleStatus(id);
        if (Object.hasOwn(moduleState.modules, id)) publishModules({ schemaVersion: 1, modules: { ...moduleState.modules, [id]: { ...moduleState.modules[id], enabled: false } } }, id);
        return moduleStatus(id);
    }
    // After each save: new or removed module assets reach the folder in the background,
    // and folders of deleted modules move to trash. Neither delays nor fails the save.
    const modulePending = new Map();
    const moduleWork = new Set();
    function moduleInSync(module, record) {
        const candidates = moduleCandidateNames(module);
        let matched = 0;
        for (const entry of record.entries || []) {
            if (!candidates.has(entry?.key) || entry.hash !== sourceVersion?.(entry.key)) return false;
            matched++;
        }
        // Sources that failed to copy stay failed until a manual check retries them.
        return candidates.size - matched <= (record.failed || 0);
    }
    function retireDeletedModule(id) {
        const record = moduleState.modules[id];
        const modules = { ...moduleState.modules };
        delete modules[id];
        publishModules({ schemaVersion: 1, modules }, id);
        if (!validFilename(record?.directory)) return;
        try {
            const source = safePath(`modules/${record.directory}`);
            if (!fs.existsSync(source)) return;
            const target = safePath(`trash/module-assets-${crypto.randomUUID()}/${record.directory}`);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.renameSync(source, target);
        } catch { /* The folder is no longer routed; a later run or the user can remove it. */ }
    }
    function queueModuleSync(id, module) {
        if (moduleJobs.has(id)) { modulePending.set(id, module); return; }
        let plan;
        try { plan = planModuleCopy(id, module); } catch { return; }
        const work = (async () => {
            try {
                const record = await copyModule(plan, { verifyExisting: false });
                // A user may disable the folder while the copy runs; that choice wins.
                if (moduleState.modules[id]?.enabled === true) publishModuleCopy(plan, record);
            } catch { /* Reads keep using KV; the next save retries. */ }
            finally {
                releaseModuleCopy(plan);
                const next = modulePending.get(id);
                modulePending.delete(id);
                if (next && moduleState.modules[id]?.enabled === true && !moduleInSync(next, moduleState.modules[id])) queueModuleSync(id, next);
            }
        })();
        moduleWork.add(work);
        work.finally(() => moduleWork.delete(work));
    }
    function checkModules(modules) {
        const present = new Map(modules.filter(module => validId(module?.id)).map(module => [module.id, module]));
        for (const [id, record] of Object.entries(moduleState.modules)) {
            if (!validId(id)) continue;
            const module = present.get(id);
            if (!module) {
                // Both the saved data and the canonical file must agree the module is gone.
                if (!moduleJobs.has(id) && !fs.existsSync(path.join(dataRoot, 'modules', `${id}.json`))) retireDeletedModule(id);
                continue;
            }
            if (record?.enabled === true && !moduleInSync(module, record)) queueModuleSync(id, module);
        }
    }
    function scheduleModuleSync(database) {
        const modules = database?.modules;
        if (!Array.isArray(modules) || !Object.keys(moduleState.modules).length) return;
        setImmediate(() => { try { checkModules(modules); } catch { /* Never affects saves. */ } });
    }
    // Tests and shutdown: resolves when background module work has finished.
    async function moduleSyncIdle() {
        await new Promise(resolve => setImmediate(resolve));
        while (moduleWork.size) await Promise.allSettled([...moduleWork]);
    }
    // Queued part: decides which keys are shared from the current data (memory only).
    function moduleRetirementPlan(database, id) {
        const module = uniqueModule(database, id);
        const record = moduleState.modules[id];
        if (record?.enabled !== true || !Array.isArray(record.entries) || !validFilename(record.directory)) throw new Error('Verified module asset copies are required');
        // Persona-embedded copies of the module count as personas and mark keys shared.
        const otherKeys = replicaKeys(database, null, id);
        const referencedBy = referencePlaces(database, null, module);
        const sharedBy = {};
        const entries = [];
        let shared = 0;
        for (const entry of record.entries) {
            const place = typeof entry?.key !== 'string' ? 'other' : otherKeys.has(entry.key) ? 'replica' : referencedBy(entry.key);
            if (place) { shared++; sharedBy[place] = (sharedBy[place] || 0) + 1; }
            else entries.push(entry);
        }
        return { directory: safePath(`modules/${record.directory}/assets`), entries, shared, sharedBy };
    }
    // Unqueued part: full digest check of each copy, yielding so saves keep flowing.
    // A key shared after planning stays readable: retired keys remain visible in every KV API.
    async function verifyModuleRetirement(plan) {
        const candidates = [];
        let unverified = 0;
        for (const [index, entry] of plan.entries.entries()) {
            try {
                if (!validFilename(entry.filename) || !/^[a-f0-9]{64}$/.test(entry.hash)) throw new Error('Invalid entry');
                const target = path.join(plan.directory, entry.filename);
                if (path.dirname(target) !== plan.directory || (await fs.promises.lstat(target)).isSymbolicLink()) throw new Error('Invalid replica path');
                const bytes = await fs.promises.readFile(target);
                if (bytes.length !== entry.size || hash(bytes) !== entry.hash) throw new Error('Replica differs');
                candidates.push({ key: entry.key, object: entry.hash, size: entry.size });
            } catch { unverified++; }
            if (index % 16 === 15) await new Promise(resolve => setImmediate(resolve));
        }
        return { candidates, shared: plan.shared, sharedBy: plan.sharedBy, unverified };
    }
    async function moduleRetirementCandidates(database, id) {
        return verifyModuleRetirement(moduleRetirementPlan(database, id));
    }
    // Read-only overview for status badges; no file access beyond memory state.
    function overview() {
        const packages = new Set(directories.snapshot().characters.filter(entry => entry.packageVersion === 1).map(entry => entry.id));
        const characters = {};
        for (const id of packages) characters[id] = { package: true, assets: false };
        for (const [id, record] of Object.entries(state.characters)) {
            characters[id] = { package: packages.has(id), assets: record?.enabled === true };
        }
        const modules = {};
        for (const [id, record] of Object.entries(moduleState.modules)) {
            modules[id] = { enabled: record?.enabled === true, copied: record?.copied ?? 0, failed: record?.failed ?? 0 };
        }
        return { characters, modules };
    }
    function disable(id) {
        status(id);
        if (Object.hasOwn(state.characters, id)) publish({ schemaVersion: 1, characters: { ...state.characters, [id]: { ...state.characters[id], enabled: false } } });
        return status(id);
    }
    // Asset keys with a folder copy, for status lines that report where the originals live.
    const ownedKeys = id => (state.characters[id]?.entries || []).map(entry => entry?.key).filter(key => typeof key === 'string');
    const moduleOwnedKeys = id => (moduleState.modules[id]?.entries || []).map(entry => entry?.key).filter(key => typeof key === 'string');
    return { migrate, sync, read, status, disable, reload, retirementCandidates, ownedKeys, moduleOwnedKeys,
        migrateModule, prepareModuleCopy, copyModule, publishModuleCopy, releaseModuleCopy,
        disableModule, moduleStatus, scheduleModuleSync, moduleSyncIdle, moduleRetirementPlan, verifyModuleRetirement, moduleRetirementCandidates, overview, diagnostics: () => ({ scope: 'server-session', folderReads, ...counters }) };
}

module.exports = { createCharacterAssets, MODULE_OWNER };
