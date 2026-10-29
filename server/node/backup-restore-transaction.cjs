'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { commitTransaction, recoverTransactions, resolveInside } = require('./file-store.cjs');
const { DIRECTORY_INDEX, resetCharacterDirectoryMappings, validateDirectoryMapping } = require('./character-directories.cjs');
const { collisionKey } = require('./friendly-paths.cjs');

function collectFiles(dataRoot, directory, destinationRoot) {
    const root = path.resolve(dataRoot);
    const sourceRoot = path.resolve(directory);
    const relativeRoot = path.relative(root, sourceRoot);
    if (!relativeRoot || relativeRoot === '..' || relativeRoot.startsWith(`..${path.sep}`)) {
        throw new Error('Restore staging directory must be inside the data root');
    }
    const operations = [];
    function walk(current, relative = '') {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) throw new Error('Restore staging path uses a symbolic link');
        if (!stat.isDirectory()) throw new Error('Restore staging root is not a directory');
        const names = new Set();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) throw new Error('Restore staging path uses a symbolic link');
            const key = collisionKey(entry.name);
            if (names.has(key)) throw new Error('Restore staging path collision');
            names.add(key);
            const child = path.join(current, entry.name);
            const childRelative = path.join(relative, entry.name);
            if (entry.isDirectory()) walk(child, childRelative);
            else if (entry.isFile()) {
                if (entry.name.endsWith('.sha256')) throw new Error('Restore input must not contain generated checksum sidecars');
                operations.push({ path: path.join(destinationRoot, childRelative), sourcePath: child });
            } else throw new Error('Unsupported restore staging entry');
        }
    }
    walk(sourceRoot);
    return operations;
}

async function publishBackupRestore(options) {
    const {
        dataRoot, canonicalStagingDir, inlayStagingDir, canonicalDirectories,
        manifestBytes, retiredBytes, assetStoreDirectory, assetStoreKeys, store, restoreId, transactionOptions = {},
    } = options;
    if (!Buffer.isBuffer(manifestBytes)) throw new Error('Prepared KV manifest bytes are required');
    if (!store || typeof store.reloadManifest !== 'function') throw new Error('Reloadable KV store is required');
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(restoreId)) throw new Error('Safe restore ID is required');
    const root = path.resolve(dataRoot);
    const allowed = new Set(canonicalDirectories);
    for (const directory of allowed) {
        if (typeof directory !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(directory) || directory === 'kv') {
            throw new Error('Invalid canonical restore directory');
        }
    }
    const canonicalRoot = path.resolve(canonicalStagingDir);
    for (const entry of fs.readdirSync(canonicalRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !allowed.has(entry.name)) throw new Error(`Unexpected canonical restore root: ${entry.name}`);
    }
    const mappingPath = path.join(canonicalRoot, ...DIRECTORY_INDEX.split('/'));
    if (fs.existsSync(mappingPath)) validateDirectoryMapping(JSON.parse(fs.readFileSync(mappingPath, 'utf8')));

    const operations = [];
    const trashRoot = path.join('trash', restoreId);
    for (const directory of allowed) {
        if (directory === 'trash') continue;
        if (fs.existsSync(resolveInside(root, directory))) {
            operations.push({ path: directory, moveTo: path.join(trashRoot, directory) });
        }
    }
    if (fs.existsSync(resolveInside(root, 'inlays'))) {
        operations.push({ path: 'inlays', moveTo: path.join(trashRoot, 'inlays') });
    }
    operations.push(...collectFiles(root, canonicalRoot, ''));
    operations.push(...collectFiles(root, inlayStagingDir, 'inlays'));
    operations.push({ path: 'inlays/.migrated_to_fs', data: Buffer.from(new Date().toISOString(), 'utf8') });
    operations.push({ path: 'kv/manifest.json', data: manifestBytes });
    if (retiredBytes) operations.push({ path: 'kv/retired-assets.json', data: retiredBytes });
    // Every stored asset is replaced: the asset store folder moves to trash with the old data.
    if (assetStoreDirectory && fs.existsSync(resolveInside(root, assetStoreDirectory))) {
        operations.push({ path: assetStoreDirectory, moveTo: path.join(trashRoot, assetStoreDirectory) });
    }

    try {
        const result = commitTransaction(root, operations, transactionOptions);
        resetCharacterDirectoryMappings(root);
        store.reloadManifest();
        // Only some stored keys were replaced: the manifest is already published, so a
        // failure here leaves stale assets visible but loses nothing.
        if (assetStoreKeys?.length) {
            try { store.removeAssetStoreKeys?.(assetStoreKeys); } catch {}
        }
        return result;
    } catch (error) {
        try {
            recoverTransactions(root);
            resetCharacterDirectoryMappings(root);
            store.reloadManifest();
        } catch (recoveryError) {
            throw new AggregateError([error, recoveryError], 'Backup restore publication and recovery failed');
        }
        throw error;
    }
}

module.exports = { publishBackupRestore };
