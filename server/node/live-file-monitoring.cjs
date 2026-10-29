'use strict';

const { recoverTransactions } = require('./file-store.cjs');
const { createLiveCharacterFiles } = require('./live-character-files.cjs');
const { createCharacterDirectoryResolver } = require('./character-directories.cjs');

// Live external file monitoring is retired. Outside Windows and macOS, Node
// emulates a recursive watch with one watcher per file and rereads a whole
// directory on each event, so bulk internal writes (KV objects, vector moves)
// stalled the server. A saved `enabled: true` setting is ignored. Files edited
// while the app was closed are adopted on the next read instead.
function createLiveFileMonitoring(options) {
    recoverTransactions(options.repository.dataRoot);
    const monitor = createLiveCharacterFiles({ ...options, enabled: false });
    const status = () => ({ enabled: false, defaultEnabled: false });
    return {
        ...monitor,
        status,
        setEnabled(enabled) {
            if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean');
            if (enabled) throw new Error('External file monitoring is no longer available');
            return status();
        },
        // One explicit read of a single character's assets folder, without a watcher:
        // files added or replaced there since the last adoption become that character's
        // assets (same rules as the retired monitor). Returns the reconcile result, or
        // null when the folder holds nothing new.
        scanCharacterAssets(characterId) {
            if (!createCharacterDirectoryResolver(options.repository.dataRoot).characterIds().includes(characterId)) {
                const error = new Error('Character not found');
                error.code = 'CHARACTER_NOT_FOUND';
                throw error;
            }
            const once = createLiveCharacterFiles({ ...options, enabled: true, watch: false, onlyCharacterIds: [characterId] });
            try { return once.reconcile(); }
            finally { once.close(); }
        },
    };
}

module.exports = { createLiveFileMonitoring };
