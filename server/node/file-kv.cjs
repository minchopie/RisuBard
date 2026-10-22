'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { atomicWriteFile, atomicWriteJson, readVerifiedJson, recoverTransactions, resolveInside } = require('./file-store.cjs');
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
    const characterAssets = createCharacterAssets({ dataRoot, sourceSize: kvSize, readOriginal: kvGetOriginal,
        sourceVersion: key => entryOf(key)?.object,
        sourcePath: (key, expectedDigest) => {
            if (!/^[a-f0-9]{64}$/.test(expectedDigest) || entryOf(key)?.object !== expectedDigest) {
                throw new Error(`Content object changed during asset sync for ${key}`);
            }
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

    function saveManifest() {
        manifest.updatedAt = Date.now();
        // This internally constructed manifest was validated on load. JSON.stringify
        // already guarantees JSON syntax; reparsing a large asset index here only
        // duplicates allocation. Keep the same bytes and atomic/checksum/fsync path.
        if (manifest.schemaVersion !== 1 || !manifest.entries || typeof manifest.entries !== 'object') {
            throw new Error('Unsupported or corrupt file KV manifest');
        }
        atomicWriteFile(dataRoot, MANIFEST_PATH, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'));
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
    function entryOf(key) {
        return manifest.entries[key] ?? retiredEntries.get(key);
    }

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
        const objectPath = path.join(dataRoot, 'kv', 'objects', entry.object);
        let value;
        try { value = fs.readFileSync(objectPath); } catch { return null; }
        if (digest(value) !== entry.object) throw new Error(`Content object checksum mismatch for ${key}`);
        return value;
    }

    async function kvExportFile(key, destination) {
        const entry = entryOf(key);
        if (!entry) return false;
        const source = resolveInside(dataRoot, path.join('kv', 'objects', entry.object));
        if ((await inspectFileAsync(source)).hash !== entry.object) throw new Error(`Content object checksum mismatch for ${key}`);
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
        writeObject(dataRoot, hash, data);
        manifest.entries[key] = { object: hash, size: data.length, updatedAt: Date.now() };
        saveManifest();
    }

    function prepareEntries(entries) {
        return entries.map(({ key, value }) => {
            const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
            const hash = digest(data);
            writeObject(dataRoot, hash, data);
            return [key, { object: hash, size: data.length, updatedAt: Date.now() }];
        });
    }

    async function prepareEntriesAsync(entries) {
        return mapWithConcurrency(entries, objectWriteConcurrency, async ({ key, value }) => {
            const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
            const hash = await digestAsync(data);
            await writeObjectAsync(dataRoot, hash, data);
            return [key, { object: hash, size: data.length, updatedAt: Date.now() }];
        });
    }

    async function prepareFileEntriesAsync(entries) {
        return mapWithConcurrency(entries, objectWriteConcurrency, async ({ key, sourcePath }) => {
            const prepared = await writeObjectFromFileAsync(dataRoot, sourcePath);
            return [key, { object: prepared.hash, size: prepared.size, updatedAt: Date.now() }];
        });
    }

    function kvSetMany(entries) {
        for (const [key, entry] of prepareEntries(entries)) manifest.entries[key] = entry;
        if (entries.length) saveManifest();
    }

    async function kvSetManyAsync(entries) {
        const prepared = await prepareEntriesAsync(entries);
        for (const [key, entry] of prepared) manifest.entries[key] = entry;
        if (entries.length) saveManifest();
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
    }

    function kvReplaceAll(entries) {
        manifest.entries = Object.fromEntries(prepareEntries(entries));
        saveManifest();
        dropRetired(() => true);
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
        return {
            manifestBytes: Buffer.from(`${JSON.stringify(candidate, null, 2)}\n`, 'utf8'),
            ...(retiredNext ? { retiredBytes: Buffer.from(`${JSON.stringify(retiredNext, null, 2)}\n`, 'utf8') } : {}),
        };
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
        characterAssets.reload();
    }

    async function kvReplaceAllAsync(entries) {
        const prepared = await prepareEntriesAsync(entries);
        manifest.entries = Object.fromEntries(prepared);
        saveManifest();
        dropRetired(() => true);
    }

    function kvDel(key) {
        if (key in manifest.entries) {
            delete manifest.entries[key];
            saveManifest();
        }
        if (retiredEntries.has(key)) dropRetired(candidate => candidate === key);
    }

    function kvDelMany(keys) {
        let count = 0;
        let bytes = 0;
        let changed = false;
        let retiredHit = false;
        const unique = new Set(keys);
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
        return { count, bytes };
    }

    function kvDelManyAndCollect(keys) {
        const objects = new Set(keys.map(key => entryOf(key)?.object).filter(Boolean));
        const previous = { ...manifest.entries };
        let deleted;
        try { deleted = kvDelMany(keys); }
        catch (error) { manifest.entries = previous; throw error; }
        const referenced = referencedObjects();
        let reclaimed = 0;
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
    }

    function kvList(prefix = '') {
        const keys = Object.keys(manifest.entries).filter(key => key.startsWith(prefix));
        for (const key of retiredEntries.keys()) {
            if (key.startsWith(prefix) && !(key in manifest.entries)) keys.push(key);
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

    function objectStoreBytes() {
        const directory = path.join(dataRoot, 'kv', 'objects');
        if (!fs.existsSync(directory)) return 0;
        return fs.readdirSync(directory).reduce((total, name) => {
            if (!/^[a-f0-9]{64}$/.test(name)) return total;
            try { return total + fs.statSync(path.join(directory, name)).size; }
            catch { return total; }
        }, 0);
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
        return { count, bytes };
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
    };
}

module.exports = { createFileKv };
