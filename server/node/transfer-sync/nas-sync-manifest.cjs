'use strict';
/**
 * Small self-verifying JSON manifest with draft → durable write → swap semantics (same discipline as nas-sync-store.cjs):
 * an embedded digest validates content even when the checksum sidecar is stale, a damaged file falls back to the `.bak`
 * the atomic writer preserved, and a failed write reloads the authoritative copy or fails closed.
 */
const fs = require('node:fs');
const { atomicWriteJson, resolveInside } = require('../file-store.cjs');
const { hashJson } = require('./nas-sync-core.cjs');

const clone = v => JSON.parse(JSON.stringify(v));
function createManifest({ root, name, initial, writeJson = atomicWriteJson }) {
    const file = resolveInside(root, name);
    const sealed = s => { const { digest: _d, ...rest } = s; return { ...rest, digest: hashJson(rest) }; };
    const verified = text => { const parsed = JSON.parse(text); const { digest, ...rest } = parsed; if (digest !== hashJson(rest)) throw new Error(`${name} digest mismatch`); return rest; };
    let recovery = null, broken = null;
    function load() {
        if (!fs.existsSync(file) && !fs.existsSync(file + '.bak')) return null;
        try { return verified(fs.readFileSync(file, 'utf8')); }
        catch (error) {
            try { const previous = verified(fs.readFileSync(file + '.bak', 'utf8')); recovery = { from: name + '.bak', reason: String(error.message) }; return previous; }
            catch (inner) { throw Object.assign(new Error(`${name} unreadable; manual recovery required: ${error.message} / ${inner.message}`), { code: 'MANIFEST_UNREADABLE' }); }
        }
    }
    let state = load();
    if (!state) { state = clone(initial); writeJson(root, name, sealed(state)); }
    function transact(mutate) {
        if (broken) throw Object.assign(new Error(`${name} needs recovery: ${broken.message}`), { code: 'STORE_BROKEN' });
        const draft = clone(state), result = mutate(draft);
        try { writeJson(root, name, sealed(draft)); }
        catch (error) { try { state = load() ?? state; } catch (reloadError) { broken = reloadError; } throw error; }
        state = draft;
        return result;
    }
    return { get: () => state, view: () => clone(state), transact, recovery: () => recovery, broken: () => broken ? String(broken.message) : null };
}
module.exports = { createManifest };
