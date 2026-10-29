'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { atomicWriteFile, atomicWriteJson, readVerifiedJson, recoverTransactions, resolveInside } = require('./file-store.cjs');
const { createAssetStore, parseStoreKey, STORE_DIR: ASSET_STORE_DIR } = require('./asset-store.cjs');
const { createCharacterAssets } = require('./character-assets.cjs');

const MANIFEST_PATH = 'kv/manifest.json';
// V4 pilot: asset entries a user moved out of the manifest. Their objects stay in
// kv/objects and every KV API still reports the keys; reads prefer the verified
// character folder copy. The file only exists after an explicit V4 transition.
const RETIRED_PATH = 'kv/retired-assets.json';
const HEX_MIGRATION_MARKER = 'migration/legacy-hex-save-folder.json';

function digest(data) {
    return crypto.createHash('sha256').update(data).digest('hex');
}

async function digestAsync(data) {
    return Buffer.from(await crypto.webcrypto.subtle.digest('SHA-256', data)).toString('hex');
}

async function inspectFileAsync(filePath) {
    const hash = crypto.createHash('sha256');
    let size = 0;
    for await (const chunk of fs.createReadStream(filePath)) {
        hash.update(chunk);
        size += chunk.length;
    }
    return { hash: hash.digest('hex'), size };
}

async function mapWithConcurrency(items, concurrency, mapper) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workers = Array.from({ length: Math.min(items.length, Math.max(1, concurrency)) }, async () => {
        while (nextIndex < items.length) {
            const index = nextIndex++;
            results[index] = await mapper(items[index], index);
        }
    });
    await Promise.all(workers);
    return results;
}

function writeObject(dataRoot, hash, data) {
    const directory = path.join(dataRoot, 'kv', 'objects');
    const target = path.join(directory, hash);
    if (fs.existsSync(target)) return;
    fs.mkdirSync(directory, { recursive: true });
    const temp = path.join(directory, `.${hash}.${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temp, 'wx', 0o600);
    try {
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
    } finally {
        fs.closeSync(fd);
    }
    if (digest(fs.readFileSync(temp)) !== hash) {
        fs.unlinkSync(temp);
        throw new Error(`Content object checksum verification failed: ${hash}`);
    }
    try {
        fs.renameSync(temp, target);
    } catch (error) {
        if (fs.existsSync(target)) fs.unlinkSync(temp);
        else throw error;
    }
}

async function writeObjectAsync(dataRoot, hash, data) {
    const directory = path.join(dataRoot, 'kv', 'objects');
    const target = path.join(directory, hash);
    try {
        await fsp.access(target);
        return;
    } catch {}
    await fsp.mkdir(directory, { recursive: true });
    const temp = path.join(directory, `.${hash}.${crypto.randomUUID()}.tmp`);
    const handle = await fsp.open(temp, 'wx', 0o600);
    try {
        await handle.writeFile(data);
        await handle.sync();
    } finally {
        await handle.close();
    }
    if (await digestAsync(await fsp.readFile(temp)) !== hash) {
        await fsp.unlink(temp);
        throw new Error(`Content object checksum verification failed: ${hash}`);
    }
    try {
        await fsp.rename(temp, target);
    } catch (error) {
        try {
            await fsp.access(target);
            await fsp.unlink(temp);
        } catch {
            throw error;
        }
    }
}

async function writeObjectFromFileAsync(dataRoot, sourcePath) {
    const directory = path.join(dataRoot, 'kv', 'objects');
    await fsp.mkdir(directory, { recursive: true });
    const handle = await fsp.open(sourcePath, 'r+');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }

    const inspected = await inspectFileAsync(sourcePath);
    const target = path.join(directory, inspected.hash);
    try {
        await fsp.access(target);
        await fsp.unlink(sourcePath);
        return inspected;
    } catch {}

    try {
        await fsp.rename(sourcePath, target);
    } catch (error) {
        try {
            await fsp.access(target);
            await fsp.unlink(sourcePath);
        } catch {
            throw error;
        }
    }
    return inspected;
}

function createFileKv(options = {}) {
    const dataRoot = path.resolve(options.dataRoot || path.join(process.cwd(), 'save'));
    fs.mkdirSync(dataRoot, { recursive: true });
    recoverTransactions(dataRoot);
    const assetStore = createAssetStore({ dataRoot, digest });
    const characterAssets = createCharacterAssets({ dataRoot, sourceSize: kvSize, readOriginal: kvGetOriginal,
        sourceVersion: key => entryOf(key)?.object,
        sourcePath: (key, expectedDigest) => {
            const entry = entryOf(key);
            if (!/^[a-f0-9]{64}$/.test(expectedDigest) || entry?.object !== expectedDigest) {
                throw new Error(`Content object changed during asset sync for ${key}`);
            }
            if (entry.store) return assetStore.pathOf(key);
            return resolveInside(dataRoot, path.join('kv', 'objects', expectedDigest));
        } });

    let manifest = fs.existsSync(path.join(dataRoot, MANIFEST_PATH))
        ? readVerifiedJson(dataRoot, MANIFEST_PATH)
        : { schemaVersion: 1, updatedAt: 0, entries: {} };
    if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.entries !== 'object') {
        throw new Error('Unsupported or corrupt file KV manifest');
    }
    let retired = loadRetired();
    let retiredEntries = indexRetired(retired);
    const objectWriteConcurrency = options.objectWriteConcurrency
        ?? Math.min(8, Math.max(1, (os.availableParallelism?.() ?? os.cpus().length) - 1));

    let lastManifestSaveMs = null;
    function saveManifest() {
        const started = performance.now();
        manifest.updatedAt = Date.now();
        // This internally constructed manifest was validated on load. JSON.stringify
        // already guarantees JSON syntax; reparsing a large asset index here only
        // duplicates allocation. Keep the same bytes and atomic/checksum/fsync path.
        if (manifest.schemaVersion !== 1 || !manifest.entries || typeof manifest.entries !== 'object') {
            throw new Error('Unsupported or corrupt file KV manifest');
        }
        atomicWriteFile(dataRoot, MANIFEST_PATH, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
        lastManifestSaveMs = performance.now() - started;
    }

    function loadRetired() {
        if (!fs.existsSync(path.join(dataRoot, RETIRED_PATH))) return { schemaVersion: 1, characters: {} };
        const value = readVerifiedJson(dataRoot, RETIRED_PATH);
        if (!value || value.schemaVersion !== 1 || !value.characters
            || typeof value.characters !== 'object' || Array.isArray(value.characters)) {
            throw new Error('Unsupported or corrupt retired asset index');
        }
        return value;
    }

    function indexRetired(value) {
        const entries = new Map();
        for (const [owner, keys] of Object.entries(value.characters)) {
            for (const [key, entry] of Object.entries(keys || {})) {
                if (entries.has(key) || !/^[a-f0-9]{64}$/.test(entry?.object) || !Number.isSafeInteger(entry.size)) continue;
                entries.set(key, { object: entry.object, size: entry.size, updatedAt: entry.updatedAt ?? 0, owner });
            }
        }
        return entries;
    }

    function saveRetired(next) {
        atomicWriteJson(dataRoot, RETIRED_PATH, next);
        retired = next;
        retiredEntries = indexRetired(next);
    }

    function retiredWithout(drop) {
        const characters = {};
        let changed = false;
        for (const [owner, keys] of Object.entries(retired.characters)) {
            const kept = {};
            for (const [key, entry] of Object.entries(keys || {})) {
                if (drop(key)) changed = true;
                else kept[key] = entry;
            }
            if (Object.keys(kept).length) characters[owner] = kept;
        }
        return changed ? { schemaVersion: 1, characters } : null;
    }

    // Deletion and replacement apply to retired keys exactly as to manifest keys.
    function dropRetired(drop) {
        if (!retiredEntries.size) return;
        const next = retiredWithout(drop);
        if (next) saveRetired(next);
    }

    // The manifest wins when a key exists in both (an interrupted transition, or a later kvSet).
    // Asset store keys come last; their entry is derived from the key and the file.
    function entryOf(key) {
        const entry = manifest.entries[key] ?? retiredEntries.get(key);
        if (entry || !assetStore.has(key)) return entry;
        return { object: parseStoreKey(key).digest, size: assetStore.size(key), updatedAt: assetStore.updatedAt(key) ?? 0, store: true };
    }

    // Content-addressed asset writes go to the asset store instead of the
    // manifest. A key the manifest or retired index already holds with the same
    // bytes is left there: rewriting the manifest for identical bytes buys nothing.
    function storeWrite(key, data, hash) {
        const parsed = parseStoreKey(key);
        if (!parsed || parsed.digest !== hash) return false;
        const existing = manifest.entries[key] ?? retiredEntries.get(key);
        if (existing) {
            if (existing.object !== hash) return false;
            writeObject(dataRoot, hash, data);
            return true;
        }
        return assetStore.write(key, data, hash);
    }

    async function storeWriteAsync(key, data, hash) {
        const parsed = parseStoreKey(key);
        if (!parsed || parsed.digest !== hash) return false;
        const existing = manifest.entries[key] ?? retiredEntries.get(key);
        if (existing) {
            if (existing.object !== hash) return false;
            await writeObjectAsync(dataRoot, hash, data);
            return true;
        }
        return assetStore.writeAsync(key, data, hash);
    }

    const storeKeysMatching = prefixes => assetStore.list().filter(matchesPrefix(prefixes));

    const matchesPrefix = prefixes => key => prefixes.some(prefix => key === prefix || key.startsWith(prefix));

    function kvGet(key) {
        const entry = entryOf(key);
        if (!entry) return null;
        const replica = characterAssets.read(key, entry);
        if (replica !== null) return replica;
        return kvGetOriginal(key);
    }

    // Explicit asset validation must bypass the performance-oriented replica reader.
    function kvGetOriginal(key) {
        const entry = entryOf(key);
        if (!entry) return null;
        if (entry.store) return assetStore.read(key);
        const objectPath = path.join(dataRoot, 'kv', 'objects', entry.object);
        let value;
        try { value = fs.readFileSync(objectPath); } catch {
            // A missing object is served from a store file with the same digest, if one exists.
            return parseStoreKey(key)?.digest === entry.object ? assetStore.read(key) : null;
        }
        if (digest(value) !== entry.object) throw new Error(`Content object checksum mismatch for ${key}`);
        return value;
    }

    // Streams one stored value to `destination` for play-set/sync media staging.
    // The source follows kvGetOriginal: a store-only key reads its asset-store
    // file; a manifest/retired entry reads kv/objects, and only a missing object
    // (ENOENT) whose key names the same digest falls back to the store file. A
    // corrupt object, a digest mismatch or any other I/O error is reported, never
    // served from another location.
    async function kvExportFile(key, destination) {
        const entry = entryOf(key);
        if (!entry) return false;
        let source = entry.store ? assetStore.pathOf(key) : resolveInside(dataRoot, path.join('kv', 'objects', entry.object));
        let inspected;
        try { inspected = await inspectFileAsync(source); }
        catch (error) {
            if (entry.store || error.code !== 'ENOENT' || parseStoreKey(key)?.digest !== entry.object || !assetStore.has(key)) throw error;
            source = assetStore.pathOf(key);
            inspected = await inspectFileAsync(source);
        }
        if (inspected.hash !== entry.object) throw new Error(`Content object checksum mismatch for ${key}`);
        await fsp.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
        if ((await inspectFileAsync(destination)).hash !== entry.object) {
            await fsp.unlink(destination);
            throw new Error(`Content object changed while exporting ${key}`);
        }
        return true;
    }

    function kvSet(key, value) {
        const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const hash = digest(data);
        if (storeWrite(key, data, hash)) return;
        const previous = key === 'database/database.bin' ? manifest.entries[key]?.object : undefined;
        writeObject(dataRoot, hash, data);
        manifest.entries[key] = { object: hash, size: data.length, updatedAt: Date.now() };
        saveManifest();
        // The compatibility database is rewritten whole on every save, and a
        // failing save retries it each time. Background GC waits an hour, so a
        // large database would fill the disk first. Snapshots that share the
        // replaced object keep it referenced.
        if (previous && previous !== hash && !referencedObjects().has(previous)) {
            try { fs.unlinkSync(path.join(dataRoot, 'kv', 'objects', previous)); } catch {}
        }
    }

    // Accepts any iterable so a generator can stream values one at a time.
    // `toStore` sends content-addressed assets to the asset store and leaves
    // them out of the result. Prefix replacement (restore) keeps everything in
    // the manifest because it must publish one consistent snapshot.
    function prepareEntries(entries, { toStore = false } = {}) {
        const prepared = [];
        for (const { key, value } of entries) {
            const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
            const hash = digest(data);
            if (toStore && storeWrite(key, data, hash)) continue;
            writeObject(dataRoot, hash, data);
            prepared.push([key, { object: hash, size: data.length, updatedAt: Date.now() }]);
        }
        return prepared;
    }

    async function prepareEntriesAsync(entries, { toStore = false } = {}) {
        const prepared = await mapWithConcurrency(entries, objectWriteConcurrency, async ({ key, value }) => {
            const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
            const hash = await digestAsync(data);
            if (toStore && await storeWriteAsync(key, data, hash)) return null;
            await writeObjectAsync(dataRoot, hash, data);
            return [key, { object: hash, size: data.length, updatedAt: Date.now() }];
        });
        return prepared.filter(Boolean);
    }

    async function prepareFileEntriesAsync(entries) {
        return mapWithConcurrency(entries, objectWriteConcurrency, async ({ key, sourcePath }) => {
            const prepared = await writeObjectFromFileAsync(dataRoot, sourcePath);
            return [key, { object: prepared.hash, size: prepared.size, updatedAt: Date.now() }];
        });
    }

    function kvSetMany(entries) {
        const prepared = prepareEntries(entries, { toStore: true });
        for (const [key, entry] of prepared) manifest.entries[key] = entry;
        if (prepared.length) saveManifest();
    }

    async function kvSetManyAsync(entries) {
        const prepared = await prepareEntriesAsync(entries, { toStore: true });
        for (const [key, entry] of prepared) manifest.entries[key] = entry;
        if (prepared.length) saveManifest();
    }

    function kvReplacePrefixes(entries, prefixes) {
        const next = { ...manifest.entries };
        for (const key of Object.keys(next)) {
            if (prefixes.some(prefix => key === prefix || key.startsWith(prefix))) delete next[key];
        }
        for (const [key, entry] of prepareEntries(entries)) next[key] = entry;
        manifest.entries = next;
        saveManifest();
        dropRetired(matchesPrefix(prefixes));
        assetStore.remove(storeKeysMatching(prefixes));
    }

    function kvReplaceAll(entries) {
        manifest.entries = Object.fromEntries(prepareEntries(entries));
        saveManifest();
        dropRetired(() => true);
        assetStore.remove(assetStore.list());
    }

    async function kvReplacePrefixesAsync(entries, prefixes) {
        const prepared = await prepareEntriesAsync(entries);
        const next = { ...manifest.entries };
        for (const key of Object.keys(next)) {
            if (prefixes.some(prefix => key === prefix || key.startsWith(prefix))) delete next[key];
        }
        for (const [key, entry] of prepared) next[key] = entry;
        manifest.entries = next;
        saveManifest();
        dropRetired(matchesPrefix(prefixes));
        assetStore.remove(storeKeysMatching(prefixes));
    }

    async function kvReplacePrefixesFromFilesAsync(entries, prefixes) {
        const prepared = await prepareFileEntriesAsync(entries);
        const next = { ...manifest.entries };
        for (const key of Object.keys(next)) {
            if (prefixes.some(prefix => key === prefix || key.startsWith(prefix))) delete next[key];
        }
        for (const [key, entry] of prepared) next[key] = entry;
        manifest.entries = next;
        saveManifest();
        dropRetired(matchesPrefix(prefixes));
        assetStore.remove(storeKeysMatching(prefixes));
    }

    async function preparePrefixReplacementFromFilesAsync(entries, prefixes) {
        const prepared = await prepareFileEntriesAsync(entries);
        const next = { ...manifest.entries };
        for (const key of Object.keys(next)) {
            if (prefixes.some(prefix => key === prefix || key.startsWith(prefix))) delete next[key];
        }
        for (const [key, entry] of prepared) next[key] = entry;
        const candidate = { schemaVersion: 1, updatedAt: Date.now(), entries: next };
        // Publish the retired index in the same transaction so replaced keys cannot reappear.
        const retiredNext = retiredWithout(matchesPrefix(prefixes));
        // Replaced asset store files leave with the same transaction: the whole
        // folder when every stored key is replaced, otherwise key by key afterwards.
        const storeKeys = storeKeysMatching(prefixes);
        const moveAssetStore = storeKeys.length > 0 && storeKeys.length === assetStore.count();
        return {
            manifestBytes: Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`, 'utf8'),
            ...(retiredNext ? { retiredBytes: Buffer.from(`${JSON.stringify(retiredNext, null, 2)}\n`, 'utf8') } : {}),
            ...(moveAssetStore ? { assetStoreDirectory: ASSET_STORE_DIR } : {}),
            ...(!moveAssetStore && storeKeys.length ? { assetStoreKeys: storeKeys } : {}),
        };
    }

    function removeAssetStoreKeys(keys) {
        return assetStore.remove(keys);
    }

    function reloadManifest() {
        const next = readVerifiedJson(dataRoot, MANIFEST_PATH);
        if (!next || next.schemaVersion !== 1 || typeof next.entries !== 'object') {
            throw new Error('Unsupported or corrupt file KV manifest');
        }
        const nextRetired = loadRetired();
        manifest = next;
        retired = nextRetired;
        retiredEntries = indexRetired(nextRetired);
        assetStore.reload();
        characterAssets.reload();
    }

    async function kvReplaceAllAsync(entries) {
        const prepared = await prepareEntriesAsync(entries);
        manifest.entries = Object.fromEntries(prepared);
        saveManifest();
        dropRetired(() => true);
        assetStore.remove(assetStore.list());
    }

    function kvDel(key) {
        if (key in manifest.entries) {
            delete manifest.entries[key];
            saveManifest();
        }
        if (retiredEntries.has(key)) dropRetired(candidate => candidate === key);
        if (assetStore.has(key)) assetStore.remove([key]);
    }

    function kvDelMany(keys) {
        let count = 0;
        let bytes = 0;
        let changed = false;
        let retiredHit = false;
        const unique = new Set(keys);
        // Store-only keys count when their file actually leaves; a locked file stays listed.
        const storeOnly = [...unique].filter(key => assetStore.has(key) && !(key in manifest.entries) && !retiredEntries.has(key));
        for (const key of unique) {
            const entry = manifest.entries[key];
            if (entry) {
                bytes += entry.size ?? 0;
                delete manifest.entries[key];
                changed = true;
                count += 1;
            } else if (retiredEntries.has(key)) {
                bytes += retiredEntries.get(key).size ?? 0;
                count += 1;
            }
            if (retiredEntries.has(key)) retiredHit = true;
        }
        if (changed) saveManifest();
        if (retiredHit) dropRetired(key => unique.has(key));
        const removed = assetStore.remove(storeOnly);
        assetStore.remove([...unique].filter(key => assetStore.has(key)));
        return { count: count + removed.count, bytes: bytes + removed.bytes };
    }

    function kvDelManyAndCollect(keys) {
        // Explicit cleanup reclaims asset store files at once, like unreferenced objects below.
        const stored = keys.filter(key => assetStore.has(key) && !(key in manifest.entries) && !retiredEntries.has(key));
        const purged = assetStore.purge(stored);
        const storedSet = new Set(stored);
        keys = keys.filter(key => !storedSet.has(key));
        const objects = new Set(keys.map(key => entryOf(key)?.object).filter(Boolean));
        const previous = { ...manifest.entries };
        let deleted;
        try { deleted = kvDelMany(keys); }
        catch (error) { manifest.entries = previous; throw error; }
        deleted = { count: deleted.count + purged.count, bytes: deleted.bytes + purged.bytes };
        const referenced = referencedObjects();
        let reclaimed = purged.bytes;
        for (const object of objects) {
            if (!/^[a-f0-9]{64}$/.test(object) || referenced.has(object)) continue;
            const target = resolveInside(dataRoot, path.join('kv', 'objects', object));
            try {
                const size = fs.statSync(target).size;
                fs.unlinkSync(target);
                reclaimed += size;
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        return { ...deleted, reclaimed };
    }

    function kvSize(key) {
        return entryOf(key)?.size ?? 0;
    }

    function kvGetUpdatedAt(key) {
        return entryOf(key)?.updatedAt ?? null;
    }

    function kvCopyValue(source, destination) {
        const entry = entryOf(source);
        if (!entry) return;
        if (entry.store) {
            const value = assetStore.read(source);
            if (value) kvSet(destination, value);
            return;
        }
        manifest.entries[destination] = { object: entry.object, size: entry.size, updatedAt: Date.now() };
        saveManifest();
    }

    function kvDelPrefix(prefix) {
        let changed = false;
        for (const key of Object.keys(manifest.entries)) {
            if (key.startsWith(prefix)) {
                delete manifest.entries[key];
                changed = true;
            }
        }
        if (changed) saveManifest();
        dropRetired(key => key.startsWith(prefix));
        assetStore.remove(assetStore.list(prefix));
    }

    function kvList(prefix = '') {
        const keys = Object.keys(manifest.entries).filter(key => key.startsWith(prefix));
        for (const key of retiredEntries.keys()) {
            if (key.startsWith(prefix) && !(key in manifest.entries)) keys.push(key);
        }
        for (const key of assetStore.list(prefix)) {
            if (!(key in manifest.entries) && !retiredEntries.has(key)) keys.push(key);
        }
        return keys.sort();
    }

    function kvListWithSizes(prefix = '') {
        return kvList(prefix).map(key => ({ key, size: entryOf(key).size }));
    }

    // Retired objects stay referenced so GC keeps them as the restore source.
    function referencedObjects() {
        const objects = new Set(Object.values(manifest.entries).map(entry => entry.object));
        for (const entry of retiredEntries.values()) objects.add(entry.object);
        return objects;
    }

    // Moves verified, character-owned asset entries out of the manifest. The caller
    // proves each folder copy equals the object; the object itself is kept.
    function retireAssets(owner, candidates) {
        if (typeof owner !== 'string' || !owner) throw new Error('Invalid retired asset owner');
        const accepted = [];
        for (const candidate of candidates) {
            const entry = manifest.entries[candidate?.key];
            if (!entry || retiredEntries.has(candidate.key) || !candidate.key.startsWith('assets/')
                || entry.object !== candidate.object || entry.size !== candidate.size) continue;
            if (!fs.existsSync(path.join(dataRoot, 'kv', 'objects', entry.object))) continue;
            accepted.push([candidate.key, entry]);
        }
        if (!accepted.length) return { retired: 0 };
        const characters = { ...retired.characters, [owner]: { ...(retired.characters[owner] || {}) } };
        for (const [key, entry] of accepted) {
            characters[owner][key] = { object: entry.object, size: entry.size, updatedAt: entry.updatedAt ?? 0 };
        }
        // Retired index first: an interruption leaves the key in both files and the manifest wins.
        saveRetired({ schemaVersion: 1, characters });
        const previous = { ...manifest.entries };
        for (const [key] of accepted) delete manifest.entries[key];
        try { saveManifest(); }
        catch (error) { manifest.entries = previous; throw error; }
        return { retired: accepted.length };
    }

    // Puts an owner's retired entries back into the manifest. A missing object is
    // rebuilt only from bytes matching its digest; otherwise the entry stays retired.
    function restoreRetiredAssets(owner, readCopy) {
        const keys = Object.entries(retired.characters[owner] || {});
        if (!keys.length) return { restored: 0, failed: 0 };
        const previous = { ...manifest.entries };
        const restored = new Set();
        let added = 0;
        let failed = 0;
        for (const [key, entry] of keys) {
            if (!manifest.entries[key]) {
                if (!fs.existsSync(path.join(dataRoot, 'kv', 'objects', entry.object))) {
                    let bytes = null;
                    try { bytes = readCopy?.(key, entry) ?? null; } catch { bytes = null; }
                    if (!Buffer.isBuffer(bytes) || bytes.length !== entry.size || digest(bytes) !== entry.object) { failed += 1; continue; }
                    writeObject(dataRoot, entry.object, bytes);
                }
                manifest.entries[key] = { object: entry.object, size: entry.size, updatedAt: entry.updatedAt ?? Date.now() };
                added += 1;
            }
            restored.add(key);
        }
        if (added) {
            try { saveManifest(); }
            catch (error) { manifest.entries = previous; throw error; }
        }
        const next = retiredWithout(key => retiredEntries.get(key)?.owner === owner && restored.has(key));
        if (next) saveRetired(next);
        return { restored: restored.size, failed };
    }

    function retiredSummary() {
        const summary = {};
        for (const [owner, keys] of Object.entries(retired.characters)) summary[owner] = Object.keys(keys || {}).length;
        return summary;
    }

    function retiredStatus(owner) {
        const entries = Object.values(retired.characters[owner] || {});
        return { retired: entries.length, bytes: entries.reduce((total, entry) => total + (entry.size ?? 0), 0) };
    }

    function reclaimableObjects() {
        const directory = path.join(dataRoot, 'kv', 'objects');
        if (!fs.existsSync(directory)) return [];
        const referenced = referencedObjects();
        return fs.readdirSync(directory)
            .filter(name => /^[a-f0-9]{64}$/.test(name) && !referenced.has(name));
    }

    function reclaimableChunkBytes() {
        return reclaimableObjects().reduce((total, name) => {
            try { return total + fs.statSync(path.join(dataRoot, 'kv', 'objects', name)).size; }
            catch { return total; }
        }, 0);
    }

    // Hard-linked asset store files share bytes with their KV object until GC
    // removes the object, so this total can briefly count them twice.
    function objectStoreBytes() {
        const directory = path.join(dataRoot, 'kv', 'objects');
        if (!fs.existsSync(directory)) return assetStore.bytes();
        return fs.readdirSync(directory).reduce((total, name) => {
            if (!/^[a-f0-9]{64}$/.test(name)) return total;
            try { return total + fs.statSync(path.join(directory, name)).size; }
            catch { return total; }
        }, 0) + assetStore.bytes();
    }

    function gcChunks(options = {}) {
        const minAgeMs = Number.isFinite(options.minAgeMs) ? Math.max(0, options.minAgeMs) : 0;
        const maxDeletes = Number.isFinite(options.maxDeletes)
            ? Math.max(0, Math.floor(options.maxDeletes))
            : Number.POSITIVE_INFINITY;
        const now = Number.isFinite(options.now) ? options.now : Date.now();
        const objects = reclaimableObjects();
        let count = 0;
        let bytes = 0;
        for (const name of objects) {
            if (count >= maxDeletes) break;
            const objectPath = path.join(dataRoot, 'kv', 'objects', name);
            try {
                const stat = fs.statSync(objectPath);
                if (minAgeMs > 0 && now - stat.mtimeMs < minAgeMs) continue;
                fs.unlinkSync(objectPath);
                count += 1;
                bytes += stat.size;
            } catch {}
        }
        try {
            const swept = assetStore.sweepTrash({ minAgeMs, now, maxDeletes: maxDeletes - count });
            count += swept.count;
            bytes += swept.bytes;
        } catch {}
        return { count, bytes };
    }

    // ── Asset store conversion ──────────────────────────────────────────────
    // Moves content-addressed asset entries out of the manifest (and the V4
    // retired index) into asset store files, or back. Each call handles at most
    // `limit` keys and saves the manifest once, so callers can report progress,
    // stop between calls and resume later. Nothing runs without a caller.
    const unconvertible = new Set();

    function assetStoreCandidates() {
        const keys = [];
        for (const [key, entry] of Object.entries(manifest.entries)) {
            if (!unconvertible.has(key) && parseStoreKey(key)?.digest === entry.object) keys.push(key);
        }
        for (const [key, entry] of retiredEntries) {
            if (!(key in manifest.entries) && !unconvertible.has(key) && parseStoreKey(key)?.digest === entry.object) keys.push(key);
        }
        return keys;
    }

    // Stored keys a revert would return to the manifest.
    function assetStoreOnlyKeys() {
        return assetStore.list().filter(key => !(key in manifest.entries) && !retiredEntries.has(key));
    }

    // How many of these keys live only in the asset store.
    function assetStoreShare(keys) {
        let stored = 0;
        let bytes = 0;
        for (const key of new Set(keys)) {
            if (key in manifest.entries || retiredEntries.has(key) || !assetStore.has(key)) continue;
            stored += 1;
            bytes += assetStore.size(key);
        }
        return { stored, bytes };
    }

    function assetStoreStatus() {
        let manifestBytes = 0;
        try { manifestBytes = fs.statSync(path.join(dataRoot, MANIFEST_PATH)).size; } catch {}
        return {
            convertible: assetStoreCandidates().length,
            unconvertible: unconvertible.size,
            stored: assetStoreOnlyKeys().length,
            manifestEntries: Object.keys(manifest.entries).length,
            manifestBytes,
            lastManifestSaveMs,
        };
    }

    async function convertToAssetStore({ limit = 5000, verify = false } = {}) {
        const keys = assetStoreCandidates().slice(0, Math.max(1, Math.floor(limit)));
        let missing = 0;
        let errors = 0;
        const copied = new Set();
        const adopted = (await mapWithConcurrency(keys, objectWriteConcurrency, async key => {
            const object = parseStoreKey(key).digest;
            try {
                if (await assetStore.adopt(key, path.join(dataRoot, 'kv', 'objects', object)) === 'copy') copied.add(object);
                return key;
            } catch (error) {
                if (error.code === 'ENOENT') {
                    // A store file left by an earlier version of this conversion still counts.
                    try { if (assetStore.read(key)) return key; } catch {}
                    missing += 1;
                } else {
                    // Locked or unreadable for now; skipped until the server restarts.
                    errors += 1;
                }
                unconvertible.add(key);
                return null;
            }
        })).filter(Boolean);
        assetStore.syncDirectories(adopted);

        let manifestChanged = false;
        const fromRetired = new Set();
        const vanished = [];
        for (const key of adopted) {
            const object = parseStoreKey(key).digest;
            if (manifest.entries[key]?.object === object) {
                delete manifest.entries[key];
                manifestChanged = true;
            } else if (!(key in manifest.entries) && retiredEntries.get(key)?.object === object) {
                fromRetired.add(key);
            } else {
                // Deleted or replaced while files were being linked: it must not come back.
                vanished.push(key);
            }
        }
        if (manifestChanged) saveManifest();
        if (fromRetired.size) {
            const next = retiredWithout(key => fromRetired.has(key));
            if (next) saveRetired(next);
        }
        if (vanished.length) assetStore.remove(vanished);
        // Copied (not linked) objects would otherwise hold their space until GC
        // reaches them; drop the ones nothing references any more.
        if (copied.size) {
            const referenced = referencedObjects();
            for (const object of copied) {
                if (referenced.has(object)) continue;
                try { fs.unlinkSync(path.join(dataRoot, 'kv', 'objects', object)); } catch {}
            }
        }

        const converted = adopted.length - vanished.length;
        let failed = 0;
        if (verify) {
            const gone = new Set(vanished);
            for (const key of adopted) {
                if (gone.has(key)) continue;
                try { if (!kvGetOriginal(key)) failed += 1; } catch { failed += 1; }
            }
        }
        return { converted, missing, errors, remaining: assetStoreCandidates().length, ...(verify ? { verified: converted - failed, failed } : {}) };
    }

    async function revertAssetStore({ limit = 5000 } = {}) {
        // Copies the manifest or retired index already shadows become redundant
        // once their object is back in kv/objects (an interrupted conversion may have moved it).
        const shadowed = assetStore.list().filter(key => key in manifest.entries || retiredEntries.has(key));
        const keys = assetStoreOnlyKeys().slice(0, Math.max(1, Math.floor(limit)));
        const directory = path.join(dataRoot, 'kv', 'objects');
        await fsp.mkdir(directory, { recursive: true });
        const ensureObject = async key => {
            const object = parseStoreKey(key).digest;
            const target = path.join(directory, object);
            const source = assetStore.pathOf(key);
            try {
                try { await fsp.access(target); return key; } catch {}
                try { await fsp.link(source, target); return key; }
                catch (error) { if (error.code === 'EEXIST') return key; }
                const temp = path.join(directory, `.${object}.${crypto.randomUUID()}.tmp`);
                await fsp.copyFile(source, temp);
                const handle = await fsp.open(temp, 'r+');
                try { await handle.sync(); } finally { await handle.close(); }
                if (await digestAsync(await fsp.readFile(temp)) !== object) {
                    await fsp.unlink(temp);
                    return null;
                }
                await fsp.rename(temp, target);
                return key;
            } catch { return null; }
        };
        const restored = (await mapWithConcurrency(keys, objectWriteConcurrency, ensureObject)).filter(Boolean);
        const redundant = (await mapWithConcurrency(shadowed, objectWriteConcurrency, async key =>
            entryOf(key)?.object === parseStoreKey(key).digest ? ensureObject(key) : null)).filter(Boolean);
        // A key deleted while objects were being linked stays deleted.
        const returning = restored.filter(key => assetStore.has(key) && !(key in manifest.entries) && !retiredEntries.has(key));
        for (const key of returning) {
            manifest.entries[key] = { object: parseStoreKey(key).digest, size: assetStore.size(key), updatedAt: assetStore.updatedAt(key) ?? Date.now() };
        }
        if (returning.length) saveManifest();
        // The bytes now live in kv/objects; the store copies go only after the manifest is durable.
        assetStore.purge([...returning, ...redundant]);
        return { reverted: returning.length, failed: keys.length - restored.length, remaining: assetStoreOnlyKeys().length };
    }

    function snapshotFootprint(key) {
        const entry = manifest.entries[key];
        if (!entry) return 0;
        const live = manifest.entries['database/database.bin'];
        return live && live.object === entry.object ? 0 : entry.size;
    }

    function migrateLegacyHexFiles() {
        if (fs.existsSync(path.join(dataRoot, HEX_MIGRATION_MARKER))) return;
        const files = fs.readdirSync(dataRoot, { withFileTypes: true })
            .filter(entry => entry.isFile() && /^[a-fA-F0-9]+$/.test(entry.name) && entry.name.length % 2 === 0);
        let imported = 0;
        for (const entry of files) {
            const key = Buffer.from(entry.name, 'hex').toString('utf8');
            if (!key || key in manifest.entries) continue;
            const data = fs.readFileSync(path.join(dataRoot, entry.name));
            const hash = digest(data);
            writeObject(dataRoot, hash, data);
            manifest.entries[key] = { object: hash, size: data.length, updatedAt: fs.statSync(path.join(dataRoot, entry.name)).mtimeMs };
            imported += 1;
        }
        if (imported) saveManifest();
        atomicWriteJson(dataRoot, HEX_MIGRATION_MARKER, { schemaVersion: 1, imported, completedAt: Date.now() });
    }

    migrateLegacyHexFiles();

    return {
        kvGet,
        kvExportFile,
        kvSet,
        kvSetMany,
        kvSetManyAsync,
        kvReplacePrefixes,
        kvReplacePrefixesAsync,
        kvReplacePrefixesFromFilesAsync,
        preparePrefixReplacementFromFilesAsync,
        reloadManifest,
        kvReplaceAll,
        kvReplaceAllAsync,
        kvDel,
        kvDelMany,
        kvDelManyAndCollect,
        kvSize,
        kvGetUpdatedAt,
        kvCopyValue,
        kvDelPrefix,
        kvList,
        kvListWithSizes,
        gcChunks,
        reclaimableChunkBytes,
        objectStoreBytes,
        snapshotFootprint,
        characterAssets,
        retireAssets,
        restoreRetiredAssets,
        retiredStatus,
        retiredSummary,
        removeAssetStoreKeys,
        assetStoreStatus,
        assetStoreShare,
        convertToAssetStore,
        revertAssetStore,
    };
}

module.exports = { createFileKv };
