'use strict';

const fs = require('fs');
const path = require('path');
const { atomicWriteJson } = require('./file-store.cjs');

const CHUNK_MARKER = Buffer.from('\0RISUCHUNKED\0', 'binary');
const MARKER_PATH = 'migration/legacy-sqlite.json';

function syncedCopy(source, destination) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    const fd = fs.openSync(destination, 'r+');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function migrateLegacySqlite(options) {
    const dataRoot = path.resolve(options.dataRoot);
    const store = options.store;
    const sqlitePath = path.resolve(options.sqlitePath || path.join(dataRoot, 'risuai.db'));
    const marker = path.join(dataRoot, MARKER_PATH);
    if (fs.existsSync(marker)) return { migrated: false, reason: 'already-migrated' };
    if (!fs.existsSync(sqlitePath)) return { migrated: false, reason: 'missing-source' };
    if (!store || typeof store.kvReplaceAll !== 'function') throw new Error('A file KV store is required');

    const backupPath = path.join(dataRoot, 'migration-backups', `risuai-${Date.now()}.db`);
    syncedCopy(sqlitePath, backupPath);

    // Loaded only for this one-shot conversion. It is a Node built-in, not a
    // native application dependency and is never opened during normal startup.
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(sqlitePath, { readOnly: true });
    let count = 0;
    try {
        if (!db.prepare('SELECT 1 FROM kv WHERE key = ?').get('database/database.bin')) {
            throw new Error('Legacy SQLite file does not contain database/database.bin');
        }
        let manifestQuery = null;
        let chunkQuery = null;
        try {
            manifestQuery = db.prepare('SELECT hash FROM manifest_chunks WHERE manifest_key = ? ORDER BY seq');
            chunkQuery = db.prepare('SELECT data FROM chunks WHERE hash = ?');
        } catch {}
        // Rows are read and written one at a time: holding every value at once
        // exhausts the default 1 GB heap on phones (Termux) with large saves.
        function* readEntries() {
            for (const row of db.prepare('SELECT key, value FROM kv ORDER BY key').iterate()) {
                let value = Buffer.from(row.value);
                if (value.equals(CHUNK_MARKER) && manifestQuery && chunkQuery) {
                    const chunks = manifestQuery.all(row.key).map(item => chunkQuery.get(item.hash));
                    if (!chunks.length || chunks.some(item => !item)) {
                        throw new Error(`Legacy chunk manifest is incomplete for ${row.key}`);
                    }
                    value = Buffer.concat(chunks.map(item => Buffer.from(item.data)));
                }
                count++;
                yield { key: row.key, value };
            }
        }
        if (options.mode === 'merge') store.kvSetMany(readEntries());
        else store.kvReplaceAll(readEntries());
    } finally {
        db.close();
    }

    atomicWriteJson(dataRoot, MARKER_PATH, {
        schemaVersion: 1,
        source: sqlitePath,
        backupPath,
        entries: count,
        migratedAt: Date.now(),
    });
    return { migrated: true, entries: count, backupPath };
}

module.exports = { migrateLegacySqlite };
