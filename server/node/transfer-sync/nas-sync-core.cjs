'use strict';
/**
 * NAS sync core: immutable revisions, deterministic IDs, branch identity, causal tombstones.
 * Pure data; no I/O, no device/sequence (the transmission envelope is separate).
 */
require('sucrase/register/ts');
const { createHash } = require('node:crypto');
const { canonical } = require('../../../shared/play-set/protocol.ts');

const sha256 = text => createHash('sha256').update(text).digest('hex');
const hashJson = value => sha256(canonical(value));
const DIGEST = /^[a-f0-9]{64}$/;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const name = (value, label) => {
    if (typeof value !== 'string' || !value || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid revision ' + label);
    return value;
};
const rootKey = rev => `${rev.domain}\n${rev.type}\n${rev.root}`;

/** Revision ID hashes domain/type/root/sorted parents/content/dependencies; parents [] = virtual genesis of the root. */
function revisionId(rev) {
    return hashJson({ domain: rev.domain, type: rev.type, root: rev.root, parents: rev.parents, contentHash: rev.contentHash,
        dependencyHash: rev.dependencyHash, tombstone: rev.tombstone ? { operation: rev.tombstone.operation, base: rev.tombstone.base } : null });
}
function makeRevision({ domain, type, root, parents = [], content = null, dependencies = {}, tombstone }) {
    name(domain, 'domain'); name(type, 'type'); name(root, 'root');
    if (!Array.isArray(parents) || parents.some(p => !DIGEST.test(p))) throw new Error('Invalid revision parents');
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)
        || Object.values(dependencies).some(h => !DIGEST.test(h))) throw new Error('Invalid revision dependencies');
    if (tombstone) {
        if (content !== null) throw new Error('Tombstone carries no content');
        name(tombstone.operation, 'tombstone operation');
        // The recovery base is the deleted head whose content restore brings back: it must be one of the observed parents.
        if (!DIGEST.test(tombstone.base) || !parents.includes(tombstone.base)) throw new Error('Tombstone base must be a deleted parent head');
    }
    const rev = { domain, type, root, parents: [...new Set(parents)].sort(compare), contentHash: hashJson(content), dependencyHash: hashJson(dependencies),
        content: JSON.parse(canonical(content)), dependencies: JSON.parse(canonical(dependencies)),
        ...(tombstone ? { tombstone: { operation: tombstone.operation, base: tombstone.base } } : {}) };
    return { id: revisionId(rev), ...rev };
}
/** Canonical text for storage/transport; decoding recomputes every hash so tampering or drift is rejected. */
function encodeRevision(rev) { return canonical(rev); }
function decodeRevision(text) {
    const raw = JSON.parse(text);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid revision record');
    const rev = makeRevision(raw);
    if (rev.id !== raw.id || rev.contentHash !== raw.contentHash || rev.dependencyHash !== raw.dependencyHash) throw new Error('Revision hash mismatch');
    for (const key of Object.keys(raw)) if (!(key in rev)) throw new Error('Unknown revision field: ' + key);
    return rev;
}
/** Adds in parent-first order regardless of input order; throws MISSING_PARENT when a parent is absent everywhere. */
function addOrdered(list, target) {
    const pending = [...list], results = [];
    while (pending.length) {
        const before = pending.length;
        for (let i = 0; i < pending.length; i++) {
            try { results.push([pending[i], target.add(pending[i])]); pending.splice(i--, 1); }
            catch (error) { if (error.code !== 'MISSING_PARENT') throw error; }
        }
        if (pending.length === before) throw Object.assign(new Error('Missing parent revision: ' + pending[0].parents.join(',')), { code: 'MISSING_PARENT' });
    }
    return results;
}

function createGraph(revisions = []) {
    const byId = new Map(), roots = new Map(), children = new Map();
    const get = id => byId.get(id);
    /** Returns 'identical' when already known. Parents must be known first; the caller defers otherwise. */
    function add(rev) {
        // Structural validation (names, parents, dependency digests, tombstone base) plus every hash, before any lookup.
        if (makeRevision(rev).id !== rev.id || hashJson(rev.content) !== rev.contentHash || hashJson(rev.dependencies) !== rev.dependencyHash) throw new Error('Revision hash mismatch');
        if (byId.has(rev.id)) return 'identical';
        for (const parent of rev.parents) {
            const p = byId.get(parent);
            if (!p) throw Object.assign(new Error('Missing parent revision: ' + parent), { code: 'MISSING_PARENT' });
            if (rootKey(p) !== rootKey(rev)) throw new Error('Parent belongs to another root');
            if (rev.tombstone && p.tombstone) throw new Error('Tombstone parents must be live revisions');
        }
        byId.set(rev.id, rev);
        if (!roots.has(rootKey(rev))) roots.set(rootKey(rev), new Set());
        roots.get(rootKey(rev)).add(rev.id);
        for (const parent of rev.parents) { if (!children.has(parent)) children.set(parent, new Set()); children.get(parent).add(rev.id); }
        return 'added';
    }
    /** All-or-nothing: a trial copy validates the whole batch before this graph changes. */
    function addAll(list) {
        const trial = createGraph(); for (const rev of byId.values()) trial.add(rev);
        addOrdered(list, trial);
        return addOrdered(list, { add });
    }
    const heads = key => [...(roots.get(key) ?? [])].filter(id => !children.has(id)).sort(compare);
    function isAncestor(ancestor, id) {
        const stack = [id], seen = new Set();
        while (stack.length) {
            const current = stack.pop();
            if (current === ancestor) return true;
            if (seen.has(current)) continue;
            seen.add(current); stack.push(...(byId.get(current)?.parents ?? []));
        }
        return false;
    }
    /** Equal-content heads are one variant. Tombstone heads keep the item deleted or delete-pending. */
    function classify(key) {
        const all = heads(key).map(get);
        const live = all.filter(r => !r.tombstone), deleted = all.filter(r => r.tombstone);
        const variants = new Map();
        for (const r of live) { const k = r.contentHash + ':' + r.dependencyHash; if (!variants.has(k)) variants.set(k, []); variants.get(k).push(r.id); }
        const state = !all.length ? 'absent' : !live.length ? 'deleted' : deleted.length ? 'delete-pending' : variants.size > 1 ? 'diverged' : 'live';
        return { state, heads: all.map(r => r.id), liveHeads: live.map(r => r.id), tombstoneHeads: deleted.map(r => r.id), variants: [...variants.values()] };
    }
    /** A container is only deleted once every child deleted by the same operation is deleted too. */
    function containerState(key, operation) {
        const own = classify(key);
        if (own.state !== 'deleted') return own.state;
        // shortcut: scans every root for the operation; index tombstones by operation when stores hold many items.
        for (const [childKey, ids] of roots) if (childKey !== key) {
            if (![...ids].some(id => get(id).tombstone?.operation === operation)) continue;
            if (classify(childKey).state !== 'deleted') return 'delete-pending';
        }
        return 'deleted';
    }
    /** Stable branch identity: at each fork (including virtual genesis) the lexicographically minimum child inherits the
     *  parent segment; other edges derive from root/fork parent/direct child. A merge takes its minimum parent's fork. */
    function branchSegments(key) {
        const ids = [...(roots.get(key) ?? [])].sort(compare), segment = new Map(), remaining = new Set(ids);
        const assign = (parentSegment, parentId, kids) => kids.forEach((child, i) => segment.set(child, i === 0 ? parentSegment : sha256(canonical([key, parentId, child]))));
        assign(key.split('\n')[2], null, ids.filter(id => !get(id).parents.length));
        while (remaining.size) {
            let progressed = false;
            for (const id of remaining) {
                if (!segment.has(id)) continue;
                remaining.delete(id); progressed = true;
                assign(segment.get(id), id, [...(children.get(id) ?? [])].filter(c => get(c).parents[0] === id).sort(compare));
            }
            if (!progressed) throw new Error('Branch graph is not acyclic');
        }
        return segment;
    }
    /** A normal edit continues the base the user actually edited; only equal-content equivalent heads join it.
     *  Conflicting heads stay visible. An outdated base (superseded while offline) simply starts a branch. */
    function edit({ domain, type, root, base, content, dependencies }) {
        const key = `${domain}\n${type}\n${root}`, c = classify(key);
        if (c.state === 'deleted') throw new Error('Item is deleted; restore it first: ' + root);
        if (base === undefined) {
            if (c.state === 'absent') return makeRevision({ domain, type, root, content, dependencies });
            if (c.variants.length !== 1) throw new Error('Diverged item needs the edited base head: ' + root);
            return makeRevision({ domain, type, root, parents: c.variants[0], content, dependencies });
        }
        const b = get(base);
        if (!b || rootKey(b) !== key) throw new Error('Unknown edit base: ' + root);
        if (b.tombstone) throw new Error('Edit base is a tombstone; restore first: ' + root);
        return makeRevision({ domain, type, root, parents: c.variants.find(v => v.includes(base)) ?? [base], content, dependencies });
    }
    /** Deliberate resolution: parents every head, live and tombstone, so a conflict or delete-pending state ends only on request. */
    function resolve({ domain, type, root, content, dependencies }) {
        const c = classify(`${domain}\n${type}\n${root}`);
        if (c.heads.length < 2) throw new Error('Nothing to resolve: ' + root);
        return makeRevision({ domain, type, root, parents: c.heads, content, dependencies });
    }
    /** Delete over the observed live frontier; children deleted by the same operation share its ID. */
    function tombstones(operation, targets) {
        return targets.map(({ domain, type, root, base }) => {
            const parents = classify(`${domain}\n${type}\n${root}`).liveHeads;
            if (!parents.length) throw new Error('Nothing to delete: ' + root);
            if (base === undefined) { if (parents.length !== 1) throw new Error('Choose which variant to keep for restore: ' + root); base = parents[0]; }
            if (!parents.includes(base)) throw new Error('Tombstone base is not a live head');
            return makeRevision({ domain, type, root, parents, tombstone: { operation, base } });
        });
    }
    /** Restore the container and exactly the children removed by that operation, as one batch. */
    function restore(tombstoneId) {
        const head = get(tombstoneId);
        if (!head?.tombstone) throw new Error('Not a tombstone');
        const batch = [];
        for (const t of byId.values()) {
            if (!t.tombstone || t.tombstone.operation !== head.tombstone.operation || !heads(rootKey(t)).includes(t.id)) continue;
            const base = get(t.tombstone.base);
            if (!base) throw new Error('Tombstone has no recorded base: ' + t.root);
            batch.push(makeRevision({ domain: t.domain, type: t.type, root: t.root, parents: [t.id], content: base.content, dependencies: base.dependencies }));
        }
        if (!batch.length) throw new Error('Tombstone is no longer a head');
        return batch;
    }
    /** Bootstrap: tablet head + joining genesis revision only, never unrelated prior conflict heads. */
    function bootstrapResolution(tabletHeadId, joiningId) {
        const tablet = get(tabletHeadId), joining = get(joiningId);
        if (!tablet || !joining || rootKey(tablet) !== rootKey(joining)) throw new Error('Bootstrap heads must share a root');
        if (joining.parents.length) throw new Error('Joining revision must be a genesis revision');
        if (tablet.id === joining.id) return tablet;
        return makeRevision({ domain: tablet.domain, type: tablet.type, root: tablet.root, parents: [tablet.id, joining.id], content: tablet.content, dependencies: tablet.dependencies });
    }
    /** Backup restore parents the recorded base when known, else genesis; never the current frontier. */
    function fromBackup({ domain, type, root, content, dependencies, base }) {
        return makeRevision({ domain, type, root, parents: base && byId.has(base) ? [base] : [], content, dependencies });
    }
    addOrdered(revisions, { add });
    return { add, addAll, get, heads, isAncestor, classify, containerState, branchSegments, edit, resolve, tombstones, restore, bootstrapResolution, fromBackup,
        revisions: () => [...byId.values()], rootKeys: () => [...roots.keys()] };
}
/** Ancestry does not imply runtime compatibility: every pinned dependency must be present. */
function missingDependencies(rev, available) {
    return Object.entries(rev.dependencies).filter(([, hash]) => !available.has(hash)).map(([key]) => key);
}
module.exports = { makeRevision, revisionId, encodeRevision, decodeRevision, createGraph, missingDependencies, hashJson, rootKey };
