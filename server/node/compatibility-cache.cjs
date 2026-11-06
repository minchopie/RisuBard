'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { encodeRisuSaveLegacyBuffer } = require('./utils.cjs');
const DATABASE_KEY = 'database/database.bin';

function attachCompatibilityCache({ store, repository, dataRoot, enabled = false, canInvalidate, record }) {
    const original = { ...store };
    let recorder = record;
    let recover = () => repository.recoverPendingTransactions?.();
    let verified = false;
    const hasCanonical = () => fs.existsSync(path.join(dataRoot, 'index/sidebar.json'));
    const observe = row => { try { recorder?.(row); } catch {} };

    function rebuild(trigger) {
        if (!hasCanonical()) return null;
        const started = performance.now();
        try {
            recover();
            const bytes = encodeRisuSaveLegacyBuffer(repository.exportLegacyDatabase());
            original.kvSet(DATABASE_KEY, bytes);
            observe({ kind: 'compatibility-materialize', trigger, outcome: 'success',
                durationMs: performance.now() - started, databaseBytes: bytes.length });
            return bytes;
        } catch (error) {
            observe({ kind: 'compatibility-materialize', trigger, outcome: 'failure',
                durationMs: performance.now() - started, errorCode: String(error?.code || ''),
                errorName: String(error?.name || 'Error'), errorStage: 'materialize' });
            throw error;
        }
    }

    function materialize(trigger = 'explicit-flush') {
        if (original.kvSize(DATABASE_KEY) > 0) return null;
        return rebuild(trigger);
    }

    store.kvGet = key => {
        const value = original.kvGet(key);
        return value || key !== DATABASE_KEY ? value : rebuild('read');
    };
    for (const name of ['kvSize', 'kvGetUpdatedAt']) {
        store[name] = key => { if (key === DATABASE_KEY) materialize(name); return original[name](key); };
    }
    for (const name of ['kvList', 'kvListWithSizes']) {
        store[name] = (prefix = '') => {
            if (DATABASE_KEY.startsWith(prefix)) materialize(name);
            return original[name](prefix);
        };
    }
    store.kvCopyValue = (source, destination) => {
        if (source === DATABASE_KEY) materialize('copy');
        return original.kvCopyValue(source, destination);
    };

    return {
        // Old runtimes may import stale SQLite when a compatibility key is
        // missing. Leave those roots on the full lane, even if already migrated.
        canDefer: () => enabled && verified && hasCanonical() && canInvalidate?.() === true,
        setVerified: match => { verified = match === true; },
        invalidate: () => original.kvDel(DATABASE_KEY),
        materialize,
        setRecorder: callback => { recorder = callback; },
        setRecoveryHandler: callback => { recover = callback; },
    };
}

module.exports = { attachCompatibilityCache };
