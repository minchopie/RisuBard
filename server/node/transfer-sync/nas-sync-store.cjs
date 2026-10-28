'use strict';
/**
 * Durable local NAS-sync repository: identity sidecar, content-addressed blobs (revision content and dependencies),
 * revision headers, outbox of commits, admitted/accepted/waiting/held/quarantined incoming commits, client-apply ACKs,
 * checkpoint and logical-trash bookkeeping.
 *
 * Write discipline: every mutation builds a draft of the manifest, writes blobs/headers (idempotent, content-addressed),
 * then writes `state.json` atomically; only after that durable write does the in-memory manifest and graph advance.
 * A failed write reloads the authoritative manifest (or fails closed), so the same instance retries like a reopened one.
 * No network here.
 */
const fs = require('node:fs');
const { join } = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { atomicWriteJson, atomicWriteFileChunks, resolveInside } = require('../file-store.cjs');
const { createStoredGraph, decodeRevision, encodeRevision, hashJson, makeRevision, rootKey } = require('./nas-sync-core.cjs');
const { canonical } = require('../../../shared/play-set/protocol.ts');

const RETRY_SECONDS = [5, 15, 60, 300];
const CHECKPOINT_EVERY = 256;
const TRASH_DAYS = 30;
/** Restorable deletions offered per device: only the newest TRASH_KEEP deletion operations (each operation is one cohort deleted
 *  together). Older ones leave the list and can no longer be restored from it; their tombstones, history and NAS data are untouched. */
const TRASH_KEEP = 3;
/** Physical deletion stays off until real WebDAV LOCK semantics are verified on the NAS; trash is logical only. */
const PHYSICAL_PURGE = false;
const DIGEST = /^[a-f0-9]{64}$/;
/** Display-only device profile carried by new commits so peers can show "PC / 태블릿 / 스마트폰" instead of an id. Never trusted for
 *  anything else; malformed values are dropped. */
const DEVICE_KINDS = ['pc', 'tablet', 'phone'];
const deviceProfile = value => value && typeof value === 'object' && DEVICE_KINDS.includes(value.kind)
    ? { kind: value.kind, ...(typeof value.name === 'string' && value.name.trim() ? { name: value.name.trim().replace(/[\u0000-\u001f]/g, '').slice(0, 40) } : {}) } : null;
const commitIdOf = ids => hashJson([...ids].sort());
const peerKey = (device, incarnation) => `${device}/${incarnation}`;
const pair = (sequence, commitId) => `${sequence}_${commitId}`;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const bySequence = (a, b) => Number(a.split('_')[0]) - Number(b.split('_')[0]);
const clone = v => JSON.parse(JSON.stringify(v));
const header = rev => { const { content, ...rest } = rev; return rest; };

function createSyncStore({ dataRoot, identityDir, now = Date.now, uuid = randomUUID, writeJson = atomicWriteJson, checkpointEvery = CHECKPOINT_EVERY }) {
    const root = join(dataRoot, 'nas-sync');
    // shortcut: identityDir defaults inside dataRoot; platform wiring must pass the protected no-backup location (Android noBackupFilesDir / Windows local app data).
    const sidecarRoot = identityDir ?? root;
    const file = name => resolveInside(root, name);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 }); fs.mkdirSync(sidecarRoot, { recursive: true, mode: 0o700 });
    /** Self-verifying manifest: the embedded digest proves content integrity even when a crash left the checksum sidecar
     *  stale; a damaged main file falls back to the `.bak` the atomic writer preserved (the last durable state). */
    const sealed = s => { const { digest: _d, ...rest } = s; return { ...rest, digest: hashJson(rest) }; };
    const verified = text => { const parsed = JSON.parse(text); const { digest, ...rest } = parsed; if (parsed.version !== 1 || digest !== hashJson(rest)) throw new Error('nas-sync manifest digest mismatch'); return rest; };
    const writeManifest = s => writeJson(root, 'state.json', sealed(s));
    let recovery = null;
    function loadManifest() {
        if (!fs.existsSync(file('state.json')) && !fs.existsSync(file('state.json.bak'))) return null;
        try { return verified(fs.readFileSync(file('state.json'), 'utf8')); }
        catch (error) {
            try { const previous = verified(fs.readFileSync(file('state.json.bak'), 'utf8')); recovery = { from: 'state.json.bak', reason: String(error.message) }; return previous; }
            catch (inner) { throw Object.assign(new Error('nas-sync manifest unreadable; manual recovery required: ' + error.message + ' / ' + inner.message), { code: 'MANIFEST_UNREADABLE' }); }
        }
    }
    let state = loadManifest();
    let sidecar = fs.existsSync(join(sidecarRoot, 'identity.json')) ? JSON.parse(fs.readFileSync(join(sidecarRoot, 'identity.json'), 'utf8')) : null;
    if (!state) {
        state = { version: 1, deviceId: sidecar?.deviceId ?? uuid(), incarnationId: sidecar?.incarnationId ?? uuid(), workspaceId: null, sequence: 0, publications: 0, commits: [], blobs: {}, bases: {},
            peers: {}, applied: {}, checkpoints: [], trash: {}, ackHash: null, rotations: [] };
        writeManifest(state);
    }
    let broken = null; // fail closed after an ambiguous write whose authoritative state could not be reloaded
    const assertHealthy = () => { if (broken) throw Object.assign(new Error('nas-sync store needs recovery: ' + broken.message), { code: 'STORE_BROKEN' }); };
    /** The sidecar lives outside backups (canonical marker = manifest). A manifest with history but no matching sidecar is a
     *  restored copy of another install and gets a new incarnation before it may publish anything. */
    const writeSidecar = () => writeJson(sidecarRoot, 'identity.json', { version: 1, deviceId: state.deviceId, incarnationId: state.incarnationId });
    const fresh = !state.commits.length && !Object.keys(state.peers).length;
    let restoredIncarnation = null;
    if (!sidecar) { if (fresh) writeSidecar(); else restoredIncarnation = 'missing identity sidecar'; }
    else if (sidecar.incarnationId !== state.incarnationId || sidecar.deviceId !== state.deviceId) restoredIncarnation = 'identity sidecar mismatch';

    const blobPath = hash => { if (!DIGEST.test(hash)) throw new Error('Invalid blob hash'); return `blobs/${hash.slice(0, 2)}/${hash}`; };
    const hasBlob = hash => fs.existsSync(file(blobPath(hash)));
    const blobFile = hash => file(blobPath(hash));
    const headerPath = id => { if (!DIGEST.test(id)) throw new Error('Invalid revision id'); return `revisions/${id}.json`; };
    /** Stream a local file into the blob store, verifying the hash on the way; existing blobs are never rewritten. */
    function importBlob(hash, sourcePath) {
        if (hasBlob(hash)) return false;
        const digest = createHash('sha256'), fd = fs.openSync(sourcePath, 'r'), buffer = Buffer.alloc(1 << 20);
        try {
            atomicWriteFileChunks(root, blobPath(hash), write => {
                for (let read; (read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) { const chunk = buffer.subarray(0, read); digest.update(chunk); write(chunk); }
                if (digest.digest('hex') !== hash) throw new Error('Blob content does not match its hash: ' + hash);
            }, { backup: false });
        } finally { fs.closeSync(fd); }
        return true;
    }
    const writeBlobBytes = (hash, bytes) => { if (!hasBlob(hash)) { if (createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('Blob bytes mismatch'); atomicWriteFileChunks(root, blobPath(hash), write => write(bytes), { backup: false }); } };
    /** Revision = header file + content blob (content-addressed by contentHash); dependencies are blobs named by hash. */
    function writeRevisionFiles(revisions) {
        for (const rev of revisions) {
            writeBlobBytes(rev.contentHash, Buffer.from(canonical(rev.content)));
            if (!fs.existsSync(file(headerPath(rev.id)))) writeJson(root, headerPath(rev.id), header(rev));
        }
    }
    function readRevision(id) {
        const h = JSON.parse(fs.readFileSync(file(headerPath(id)), 'utf8'));
        const content = JSON.parse(fs.readFileSync(blobFile(h.contentHash), 'utf8'));
        return decodeRevision(JSON.stringify({ ...h, content }));
    }
    /** `envelope:` dependencies are semantic secret identities (epoch/slot/version/origin), mapped to physical ciphertext blobs
     *  through the envelope index; every other dependency value is a blob hash that must be present. */
    const isEnvelopeDep = key => key.startsWith('envelope:');
    const isPinDep = key => key.startsWith('pin:'); // exact content identity of a library/settings item the chat needs active; not a blob
    const blobDeps = revisions => [...new Set(revisions.flatMap(r => Object.entries(r.dependencies).filter(([k]) => !isEnvelopeDep(k) && !isPinDep(k)).map(([, h]) => h)))];
    const envelopeDeps = revisions => [...new Set(revisions.flatMap(r => Object.entries(r.dependencies).filter(([k]) => isEnvelopeDep(k)).map(([, h]) => h)))];
    const missingBlobs = revisions => blobDeps(revisions).filter(h => !hasBlob(h));
    const envelopePhysical = semantic => (state.envelopeIndex?.[semantic] ?? []).filter(hasBlob);

    const referenced = () => new Set([...state.commits.flatMap(c => c.revisions), ...Object.values(state.peers).flatMap(p => Object.values(p.admittedRevisions ?? {}).flat())]);
    const loadGraph = () => createStoredGraph([...referenced()].map(id => {
        const header = JSON.parse(fs.readFileSync(file(headerPath(id)), 'utf8'));
        if (header.id !== id) throw new Error('Revision header id does not match its path');
        return header;
    }), readRevision);
    let graph = loadGraph();
    /** Draft → durable manifest → swap. Revisions join the live graph only after the manifest named them. When the write
     *  throws, the outcome is ambiguous (rename may have happened), so the authoritative manifest is reloaded from disk and
     *  the graph rebuilt before anything else may mutate; if even that fails the store fails closed until reopened. */
    function transact(mutate) {
        assertHealthy();
        const draft = clone(state), added = [];
        const result = mutate(draft, added);
        if (added.length) writeRevisionFiles(added);
        try {
            writeManifest(draft);
            state = draft;
            if (added.length) graph.addAll(added);
        } catch (error) {
            try { state = loadManifest() ?? state; graph = loadGraph(); }
            catch (reloadError) { broken = reloadError; }
            throw error;
        }
        return result;
    }
    const peerOf = (s, device, incarnation) => s.peers[peerKey(device, incarnation)] ??= { admitted: {}, accepted: {}, admittedRevisions: {}, quarantined: {}, waiting: {}, held: {}, pendingApply: [], lastSeen: -1, rotation: 0, ambiguous: null, resolution: null };
    const noteTrash = (s, revisions) => { for (const rev of revisions) if (rev.tombstone) s.trash[rev.id] = s.trash[rev.id] ?? now(); };
    if (restoredIncarnation) rotateIncarnation(restoredIncarnation);

    function setWorkspace(workspaceId) {
        if (typeof workspaceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(workspaceId)) throw new Error('Invalid workspace id');
        if (state.workspaceId && state.workspaceId !== workspaceId) throw new Error('Workspace already bound; retire this device first');
        transact(s => { s.workspaceId = workspaceId; });
    }
    /** Local commit. `blobs` maps dependency hash → local file for material the revisions pin (assets, Wiki, slots, envelopes). */
    function commit(revisions, { blobs = {}, envelopes = {} } = {}) {
        const trial = graph.fork(), results = trial.addAll(revisions);
        const added = results.filter(([, r]) => r === 'added').map(([rev]) => rev);
        if (!added.length) return null;
        for (const [hash, path] of Object.entries(blobs)) importBlob(hash, path);
        const missing = missingBlobs(added);
        if (missing.length) throw Object.assign(new Error('Commit pins dependencies that are not in the blob store: ' + missing.join(',')), { code: 'MISSING_BLOBS', missing });
        // Each semantic envelope id needs one physical ciphertext blob: a known one is reused, otherwise the offered mapping.
        const mapping = {};
        for (const semantic of envelopeDeps(added)) {
            // A freshly sealed local ciphertext (known valid) is preferred over anything received earlier for the same identity.
            const physical = envelopes[semantic] ?? envelopePhysical(semantic)[0];
            if (!physical || !DIGEST.test(physical) || !hasBlob(physical)) throw Object.assign(new Error('Commit pins a secret envelope without its ciphertext: ' + semantic), { code: 'MISSING_ENVELOPE', semantic });
            mapping[semantic] = physical;
        }
        return transact((s, out) => {
            out.push(...added);
            s.envelopeIndex ??= {};
            for (const [semantic, physical] of Object.entries(mapping)) if (!(s.envelopeIndex[semantic] ??= []).includes(physical)) s.envelopeIndex[semantic].push(physical);
            const blobList = [...new Set([...added.map(r => r.contentHash), ...blobDeps(added), ...Object.values(mapping)])].sort(compare);
            const entry = { incarnationId: s.incarnationId, sequence: ++s.sequence, commitId: commitIdOf(added.map(r => r.id)), revisions: added.map(r => r.id).sort(compare),
                ...(s.profile ? { device: clone(s.profile) } : {}), blobs: blobList, sizes: Object.fromEntries(blobList.map(h => [h, hasBlob(h) ? fs.statSync(blobFile(h)).size : Buffer.byteLength(canonical(added.find(r => r.contentHash === h).content))])), envelopes: mapping, published: null, attempts: 0, nextAt: 0, error: null }; // content blobs are written by transact right after this draft
            s.commits.push(entry); noteTrash(s, added);
            return clone(entry);
        });
    }
    /** Commit metadata only: revision headers; content, dependencies and envelope ciphertexts travel as blobs. */
    const commitObject = entry => ({ v: 1, workspaceId: state.workspaceId, deviceId: state.deviceId, incarnationId: entry.incarnationId, sequence: entry.sequence, commitId: entry.commitId,
        revisions: entry.revisions.map(id => header(JSON.parse(encodeRevision(graph.get(id))))), blobs: entry.blobs, sizes: entry.sizes ?? {}, envelopes: entry.envelopes ?? {},
        // Only commits drafted after the profile was set carry it, so an already drafted commit re-uploads byte-identically.
        ...(entry.device ? { device: entry.device } : {}) });
    /** This device's display profile for future commits (kind + optional short name). */
    const setProfile = value => { const profile = deviceProfile(value); if (!profile) throw new Error('Invalid device profile'); if (JSON.stringify(state.profile ?? null) !== JSON.stringify(profile)) transact(s => { s.profile = profile; }); return clone(profile); };
    const dueCommits = (at = now()) => clone(state.commits.filter(c => !c.published && c.nextAt <= at));
    const publishedCommits = () => clone(state.commits.filter(c => c.published));
    const unpublishedBlobs = entry => entry.blobs.filter(h => !state.blobs[h]);
    const markBlobPublished = hash => transact(s => { s.blobs[hash] = now(); });
    function markPublished(sequence, commitId, at = now()) {
        return transact(s => {
            const entry = s.commits.find(c => c.sequence === sequence && c.commitId === commitId && c.incarnationId === s.incarnationId);
            if (!entry) throw new Error('Unknown outbox commit');
            if (!entry.published) { entry.published = { at }; entry.error = null; s.publications += 1; }
            return clone(entry);
        });
    }
    /** NAS file times are display metadata only; they never participate in revision IDs or conflict decisions. */
    function noteNasTimes(entries) {
        const updates = {};
        for (const { device, incarnation, sequence, commitId, at } of entries) {
            if (!Number.isSafeInteger(at) || at <= 0 || at > 8640000000000000) continue;
            const ids = device === state.deviceId
                ? state.commits.find(c => c.incarnationId === incarnation && c.sequence === sequence && c.commitId === commitId && c.published)?.revisions
                : state.peers[peerKey(device, incarnation)]?.admittedRevisions?.[pair(sequence, commitId)];
            // An identical revision published by several devices keeps its earliest known NAS time.
            for (const id of ids ?? []) if (at < (updates[id] ?? state.nasTimes?.[id] ?? Infinity)) updates[id] = at;
        }
        if (!Object.keys(updates).length) return;
        transact(s => { s.nasTimes = { ...s.nasTimes, ...updates }; });
    }
    function markPublishFailed(sequence, error, at = now()) {
        transact(s => {
            const entry = s.commits.find(c => c.sequence === sequence && !c.published && c.incarnationId === s.incarnationId);
            if (!entry) return;
            entry.attempts += 1; entry.error = String(error?.message ?? error).slice(0, 500);
            entry.nextAt = at + RETRY_SECONDS[Math.min(entry.attempts - 1, RETRY_SECONDS.length - 1)] * 1000;
        });
    }
    /** New incarnation: every unpublished commit is re-sequenced; published history keeps its identity. Sidecar follows. */
    function rotateIncarnation(reason) {
        const next = uuid();
        transact(s => {
            s.rotations.push({ from: s.incarnationId, to: next, at: now(), reason: String(reason).slice(0, 200) });
            s.incarnationId = next; s.sequence = 0;
            for (const entry of s.commits) if (!entry.published) { entry.incarnationId = next; entry.sequence = ++s.sequence; entry.attempts = 0; entry.nextAt = 0; entry.error = null; }
        });
        writeSidecar();
        return next;
    }
    const lastCheckpointPublications = () => state.checkpoints.at(-1)?.publications ?? 0;
    const needsCheckpoint = () => state.publications - lastCheckpointPublications() >= checkpointEvery;
    const checkpointObject = () => ({ v: 1, workspaceId: state.workspaceId, deviceId: state.deviceId, incarnationId: state.incarnationId, sequence: state.sequence, publications: state.publications,
        heads: Object.fromEntries(graph.rootKeys().map(k => [k, graph.heads(k)])),
        revisions: graph.revisions().map(r => ({ id: r.id, domain: r.domain, type: r.type, root: r.root, parents: r.parents, ...(r.tombstone ? { tombstone: r.tombstone } : {}) })).sort((a, b) => compare(a.id, b.id)) });
    const recordCheckpoint = (id, at = now()) => transact(s => { s.checkpoints.push({ id, sequence: s.sequence, publications: s.publications, at }); });
    /** Imported/backup material keeps its recorded base id even when that revision is absent locally. */
    const recordBase = (key, baseId) => { if (!DIGEST.test(baseId)) throw new Error('Invalid base'); transact(s => { s.bases[key] = baseId; }); };

    // ---------------------------------------------------------------- incoming ----------------------------------------------------------------
    const incomingPath = (device, incarnation, sequence, commitId) => `incoming/${device}__${incarnation}__${sequence}_${commitId}.json`;
    const quarantinePath = (device, incarnation, sequence, commitId) => `quarantine/${device}__${incarnation}__${sequence}_${commitId}.json`;
    const readIncoming = (device, incarnation, sequence, commitId) => JSON.parse(fs.readFileSync(file(incomingPath(device, incarnation, sequence, commitId)), 'utf8'));
    /** Header-level validation: address fields, blob references, revision digests and the content-derived commit id. */
    function validateCommitObject(object, expected = {}) {
        if (!object || object.v !== 1 || !Number.isSafeInteger(object.sequence) || object.sequence < 1 || !DIGEST.test(object.commitId) || !Array.isArray(object.revisions) || !object.revisions.length || !Array.isArray(object.blobs)) throw new Error('Malformed commit object');
        for (const [k, v] of Object.entries(expected)) if (object[k] !== v) throw new Error(`Commit ${k} does not match its address`);
        for (const h of object.blobs) if (!DIGEST.test(h)) throw new Error('Malformed blob reference');
        if (object.revisions.some(h => !h || !DIGEST.test(h.id) || !DIGEST.test(h.contentHash) || !DIGEST.test(h.dependencyHash))) throw new Error('Malformed revision header');
        if (commitIdOf(object.revisions.map(h => h.id)) !== object.commitId) throw new Error('Commit id does not match its revisions');
        const envelopes = object.envelopes ?? {};
        if (!envelopes || typeof envelopes !== 'object' || Array.isArray(envelopes) || Object.entries(envelopes).some(([k, v]) => !DIGEST.test(k) || !DIGEST.test(v))) throw new Error('Malformed envelope mapping');
        if (object.sizes !== undefined && (!object.sizes || typeof object.sizes !== 'object' || Array.isArray(object.sizes) || Object.entries(object.sizes).some(([k, v]) => !DIGEST.test(k) || !Number.isSafeInteger(v) || v < 0))) throw new Error('Malformed blob sizes');
        const deps = object.revisions.flatMap(h => Object.entries(h.dependencies ?? {}));
        const need = object.revisions.map(h => h.contentHash).concat(deps.filter(([k]) => !k.startsWith('envelope:') && !k.startsWith('pin:')).map(([, h]) => h), Object.values(envelopes));
        if (need.some(h => !object.blobs.includes(h))) throw new Error('Commit does not list every blob its revisions need');
        if (deps.some(([k, h]) => k.startsWith('envelope:') && !envelopes[h])) throw new Error('Commit does not map every secret envelope it pins');
        return object;
    }
    const missingCommitBlobs = object => [...new Set(object.blobs)].filter(h => !hasBlob(h));
    /** Headers + blobs → full revisions; every hash is recomputed by makeRevision and compared with the header. */
    function materialize(object) {
        return object.revisions.map(h => {
            const rev = makeRevision({ ...h, content: JSON.parse(fs.readFileSync(blobFile(h.contentHash), 'utf8')) });
            if (rev.id !== h.id || rev.contentHash !== h.contentHash || rev.dependencyHash !== h.dependencyHash) throw new Error('Revision header does not match its content');
            return rev;
        });
    }
    /** Quarantine preserves the bytes as evidence and drops the record from every queue in the same manifest write. */
    function quarantine(object, reason, device, incarnation, sequence, commitId) {
        const text = String(reason?.message ?? reason).slice(0, 500), key = pair(sequence, commitId);
        writeJson(root, quarantinePath(device, incarnation, sequence, commitId), { reason: text, object, at: now() });
        transact(s => { const p = peerOf(s, device, incarnation); if (!(p.quarantined[sequence] ??= []).includes(commitId)) p.quarantined[sequence].push(commitId); delete p.waiting[key]; delete p.held[key]; });
        try { fs.rmSync(file(incomingPath(device, incarnation, sequence, commitId)), { force: true }); } catch {}
        return { state: 'quarantined', reason: text };
    }
    /** Validate the complete batch (headers, commit id, blobs, hashes, parents) before anything enters the graph.
     *  Returns identical | admitted | waiting (parents or blobs pending) | held (ambiguous incarnation) | quarantined.
     *  `release` is used by an explicit resolution: no holding, and the held reference leaves the manifest in the very same
     *  write that admits, parks or quarantines the record. */
    function admitRemote(object, { device, incarnation, sequence, commitId } = object ?? {}, { release = false } = {}) {
        if (device === state.deviceId && incarnation === state.incarnationId) throw new Error('Own commits are not admitted as remote');
        const p = clone(peerOf(clone(state), device, incarnation)), key = pair(sequence, commitId);
        if (p.admitted[sequence] === commitId || p.accepted[key]) return { state: 'identical' };
        if (p.quarantined[sequence]?.includes(commitId)) return { state: 'quarantined', reason: 'previously quarantined' };
        // Header-level validity (address, workspace, content-derived commit id) comes first: a malformed or foreign object
        // at an admitted sequence is quarantined evidence, never grounds to declare the valid incarnation ambiguous.
        try { validateCommitObject(object, { workspaceId: state.workspaceId, deviceId: device, incarnationId: incarnation, sequence, commitId }); }
        catch (error) { return quarantine(object, error, device, incarnation, sequence, commitId); }
        const hold = (reason, ambiguous) => {
            writeJson(root, incomingPath(device, incarnation, sequence, commitId), object);
            // A record lives in exactly one queue: a variant parked as waiting (blobs) that turns out to be a duplicate moves to held.
            transact(s => { const q = peerOf(s, device, incarnation); if (ambiguous) q.ambiguous ??= ambiguous; q.held[key] = { at: now(), reason }; delete q.waiting[key]; q.lastSeen = Math.max(q.lastSeen, sequence); });
            return { state: 'held', reason };
        };
        const acceptedVariant = !!p.admitted[sequence] && p.admitted[sequence] !== commitId;
        if (!release) {
            // A second commit at an admitted sequence: the incarnation is cloned/restored. Keep both, admit nothing further until resolved.
            if (acceptedVariant) return hold('duplicate sequence with a different commit; explicit resolution required', { sequence, commits: [p.admitted[sequence], commitId], at: now() });
            if (p.ambiguous && sequence > p.ambiguous.sequence) return hold('incarnation ambiguous since sequence ' + p.ambiguous.sequence);
        }
        const wait = (reason, blobs = []) => {
            writeJson(root, incomingPath(device, incarnation, sequence, commitId), object);
            transact(s => { const q = peerOf(s, device, incarnation); q.waiting[key] = { at: now(), reason, blobs, ...(acceptedVariant ? { accepted: true } : {}) }; delete q.held[key]; q.lastSeen = Math.max(q.lastSeen, sequence); });
            return { state: 'waiting', reason };
        };
        const blobs = missingCommitBlobs(object);
        if (blobs.length) return wait('missing blobs: ' + blobs.join(','), blobs);
        let revisions, results;
        try { revisions = materialize(object); results = graph.fork().addAll(revisions); }
        catch (error) {
            if (error.code === 'MISSING_PARENT') return wait(error.message);
            return quarantine(object, error, device, incarnation, sequence, commitId);
        }
        const added = results.filter(([, r]) => r === 'added').map(([rev]) => rev);
        transact((s, out) => {
            out.push(...added);
            const q = peerOf(s, device, incarnation);
            if (acceptedVariant) q.accepted[key] = true; else q.admitted[sequence] = commitId;
            s.envelopeIndex ??= {};
            for (const [semantic, physical] of Object.entries(object.envelopes ?? {})) if (!(s.envelopeIndex[semantic] ??= []).includes(physical)) s.envelopeIndex[semantic].push(physical);
            q.admittedRevisions[key] = revisions.map(r => r.id); q.pendingApply.push({ sequence, commitId });
            const profile = deviceProfile(object.device); if (profile) q.profile = profile;
            delete q.waiting[key]; delete q.held[key]; q.lastSeen = Math.max(q.lastSeen, sequence); noteTrash(s, added);
        });
        try { fs.rmSync(file(incomingPath(device, incarnation, sequence, commitId)), { force: true }); } catch {}
        return { state: 'admitted', revisions: revisions.map(r => r.id) };
    }
    /** Durable waiting and held entries with their persisted objects and currently missing blobs, so the transport can
     *  re-download pinned material (held variants included) before any retry or explicit acceptance. */
    function waitingEntries() {
        const out = [];
        for (const [k, p] of Object.entries(state.peers)) for (const kind of ['waiting', 'held']) for (const name of Object.keys(p[kind])) {
            const [device, incarnation] = k.split('/'), [sequence, commitId] = name.split('_');
            let object = null; try { object = readIncoming(device, incarnation, Number(sequence), commitId); } catch {}
            const blobs = object && Array.isArray(object.blobs) && object.blobs.every(h => DIGEST.test(h)) ? missingCommitBlobs(object) : [];
            out.push({ kind, device, incarnation, sequence: Number(sequence), commitId, blobs, object });
        }
        return out;
    }
    /** Waiting commits retry in sequence order. Unreadable files stay queued with the error recorded; nothing is dropped. */
    function retryWaiting() {
        const results = [];
        for (const [k, p] of Object.entries(state.peers)) {
            const [device, incarnation] = k.split('/');
            for (const name of Object.keys(p.waiting).sort(bySequence)) {
                const [sequence, commitId] = name.split('_'), address = { device, incarnation, sequence: Number(sequence), commitId };
                let object;
                try { object = readIncoming(device, incarnation, Number(sequence), commitId); }
                catch (error) { transact(s => { peerOf(s, device, incarnation).waiting[name].error = String(error.message).slice(0, 300); }); results.push({ ...address, state: 'waiting', reason: 'unreadable: ' + error.message }); continue; }
                results.push({ ...address, ...admitRemote(object, address, { release: !!p.waiting[name].accepted }) });
            }
        }
        return results;
    }
    /** Explicit resolution of a cloned incarnation. The decision is recorded durably first and then carried out; each held
     *  record leaves the manifest only in the write that admits, parks or quarantines it, so a crash anywhere resumes on
     *  reopen without losing or resurrecting anything. `acceptHeld` admits the second commit's revisions too (both variants
     *  preserved as branches; applied material is never undone); otherwise it is quarantined as evidence. */
    function resolveAmbiguity(device, incarnation, { acceptHeld = false } = {}) {
        const p = state.peers[peerKey(device, incarnation)];
        if (!p || (!p.ambiguous && !p.resolution)) throw new Error('Incarnation is not ambiguous');
        if (!p.resolution) transact(s => { const q = peerOf(s, device, incarnation); q.resolution = { sequence: q.ambiguous.sequence, kept: q.ambiguous.commits[0], other: q.ambiguous.commits[1], decision: acceptHeld ? 'accept' : 'reject', at: now() }; });
        return continueResolution(device, incarnation);
    }
    function continueResolution(device, incarnation) {
        const results = [];
        const current = () => state.peers[peerKey(device, incarnation)];
        const { sequence, kept, other, decision } = current().resolution;
        const process = (seq, commitId) => {
            const address = { device, incarnation, sequence: seq, commitId };
            let object;
            try { object = readIncoming(device, incarnation, seq, commitId); }
            catch (error) { results.push({ ...address, state: 'held', reason: 'unreadable: ' + error.message }); return; }
            if (seq === sequence && commitId === other && decision === 'reject') { results.push({ ...address, ...quarantine(object, `rejected by explicit resolution; kept ${kept}`, device, incarnation, seq, commitId) }); return; }
            results.push({ ...address, ...admitRemote(object, address, { release: true }) });
        };
        if (current().held[pair(sequence, other)]) process(sequence, other);
        for (const name of Object.keys(current().held).sort(bySequence)) { const [seq, commitId] = name.split('_'); process(Number(seq), commitId); }
        if (Object.keys(current().held).length) return results; // an unreadable record stayed held: the recorded decision resumes later
        transact(s => { const q = peerOf(s, device, incarnation); q.resolved = [...(q.resolved ?? []), { sequence, kept, other, decision, at: now() }]; q.ambiguous = null; q.resolution = null; });
        return results;
    }
    /** Resume resolutions interrupted by a crash (called on open; no network). */
    function resumeResolutions() {
        const out = [];
        for (const k of Object.keys(state.peers)) if (state.peers[k].resolution) { const [device, incarnation] = k.split('/'); out.push(...continueResolution(device, incarnation)); }
        return out;
    }
    const pendingApply = () => Object.entries(state.peers).flatMap(([key, p]) => p.pendingApply.map(entry => ({ device: key.split('/')[0], incarnation: key.split('/')[1], ...entry, revisions: p.admittedRevisions[pair(entry.sequence, entry.commitId)] })));
    /** ACK is recorded only for a completed client apply and validates the exact (sequence, commitId) pair. */
    function markApplied(device, incarnation, sequence, commitId) {
        const p = state.peers[peerKey(device, incarnation)];
        if (!p || !p.pendingApply.some(e => e.sequence === sequence && e.commitId === commitId)) throw new Error('ACK does not match an admitted, unapplied commit');
        transact(s => { const q = peerOf(s, device, incarnation); q.pendingApply = q.pendingApply.filter(e => !(e.sequence === sequence && e.commitId === commitId)); (s.applied[peerKey(device, incarnation)] ??= {})[pair(sequence, commitId)] = now(); });
    }
    /** The ACK snapshot carries its own hash; publishing marks exactly that snapshot, never whatever `applied` holds later. */
    const ackObject = () => { const applied = clone(state.applied); return { v: 1, workspaceId: state.workspaceId, deviceId: state.deviceId, incarnationId: state.incarnationId, applied, hash: hashJson(applied) }; };
    const ackChanged = () => Object.keys(state.applied).length > 0 && hashJson(state.applied) !== state.ackHash;
    const markAckPublished = hash => { if (!DIGEST.test(hash)) throw new Error('ACK snapshot hash required'); transact(s => { s.ackHash = hash; }); };
    /** Known = admitted/accepted/held/quarantined. Waiting entries are NOT known: their blobs may still need downloading. */
    const knownRemote = (device, incarnation, sequence, commitId) => { const p = state.peers[peerKey(device, incarnation)]; if (!p) return false; const k = pair(sequence, commitId); return p.admitted[sequence] === commitId || !!p.accepted[k] || !!p.held[k] || !!p.quarantined[sequence]?.includes(commitId); };
    const isWaiting = (device, incarnation, sequence, commitId) => !!state.peers[peerKey(device, incarnation)]?.waiting[pair(sequence, commitId)];
    const peer = (device, incarnation) => clone(peerOf(clone(state), device, incarnation));
    /** Rotating window over older buckets: `count` of them per scan, advancing each call. */
    const rotateBuckets = (device, incarnation, older, count) => { if (!older.length) return []; const start = (state.peers[peerKey(device, incarnation)]?.rotation ?? 0) % older.length; const chosen = Array.from({ length: Math.min(count, older.length) }, (_, i) => older[(start + i) % older.length]); transact(s => { peerOf(s, device, incarnation).rotation = (start + chosen.length) % older.length; }); return chosen; };
    /** Logical trash: tombstone heads of the newest TRASH_KEEP deletion operations with their recoverable-until time. Read-only:
     *  nothing is physically removed and older operations simply stop being offered. */
    function trash(at = now()) {
        // The kept operations are chosen over the whole deletion history (restored ones included), so restoring a recent deletion
        // never brings an older one back into the list.
        const known = Object.entries(state.trash).filter(([id]) => graph.get(id));
        const operationOf = id => graph.get(id).tombstone?.operation ?? id, latest = new Map();
        for (const [id, deletedAt] of known) latest.set(operationOf(id), Math.max(latest.get(operationOf(id)) ?? 0, deletedAt));
        const kept = new Set([...latest].sort((a, b) => b[1] - a[1] || compare(a[0], b[0])).slice(0, TRASH_KEEP).map(([operation]) => operation));
        return known.filter(([id]) => kept.has(operationOf(id)) && graph.heads(rootKey(graph.get(id))).includes(id))
            .map(([id, deletedAt]) => ({ id, root: graph.get(id).root, deletedAt, recoverableUntil: deletedAt + TRASH_DAYS * 86400000, expired: at > deletedAt + TRASH_DAYS * 86400000 }));
    }
    const status = () => ({ deviceId: state.deviceId, incarnationId: state.incarnationId, workspaceId: state.workspaceId, sequence: state.sequence, publications: state.publications, rotations: state.rotations.length, recovery, broken: broken ? String(broken.message) : null,
        outbox: { pending: state.commits.filter(c => !c.published).map(({ sequence, commitId, attempts, nextAt, error }) => ({ sequence, commitId, attempts, nextAt, error })), published: state.commits.filter(c => c.published).length },
        profile: state.profile ?? null,
        incoming: Object.fromEntries(Object.entries(state.peers).map(([key, p]) => [key, { profile: p.profile ?? null, admitted: Object.keys(p.admitted).length + Object.keys(p.accepted).length, pendingApply: p.pendingApply.length, applied: Object.keys(state.applied[key] ?? {}).length, waiting: Object.keys(p.waiting).length, held: Object.keys(p.held).length, quarantined: Object.values(p.quarantined).flat().length, ambiguous: p.ambiguous, resolution: p.resolution, lastSeen: p.lastSeen }])),
        trash: trash().length, physicalPurge: PHYSICAL_PURGE });
    const resumed = resumeResolutions();
    const publicGraph = { get: id => graph.get(id), heads: k => graph.heads(k), classify: k => graph.classify(k), rootKeys: () => graph.rootKeys(), revisions: () => graph.revisions(), isAncestor: (a, b) => graph.isAncestor(a, b), branchSegments: k => graph.branchSegments(k), containerState: (k, op) => graph.containerState(k, op), bootstrapResolution: (a, b) => graph.bootstrapResolution(a, b), tombstones: (op, targets) => graph.tombstones(op, targets), restore: id => graph.restore(id), resolve: r => graph.resolve(r) };
    for (const [name, read] of Object.entries(publicGraph)) publicGraph[name] = (...args) => { assertHealthy(); return read(...args); };
    return { root, graph: publicGraph, resumed,
        setWorkspace, setProfile, commit, commitObject, dueCommits, publishedCommits, unpublishedBlobs, markBlobPublished, markPublished, noteNasTimes, markPublishFailed, rotateIncarnation, needsCheckpoint, checkpointObject, recordCheckpoint, recordBase,
        validateCommitObject, missingCommitBlobs, admitRemote, waitingEntries, retryWaiting, resolveAmbiguity, resumeResolutions, pendingApply, markApplied, ackObject, ackChanged, markAckPublished, knownRemote, isWaiting, rotateBuckets, peer, trash, status,
        hasBlob, blobFile, blobPath, storeBlobFromFile: importBlob, envelopePhysical, missingBlobs, identity: () => ({ deviceId: state.deviceId, incarnationId: state.incarnationId, workspaceId: state.workspaceId }), state: () => clone(state) };
}
module.exports = { createSyncStore, commitIdOf, RETRY_SECONDS, CHECKPOINT_EVERY, TRASH_DAYS, TRASH_KEEP, PHYSICAL_PURGE, deviceProfile };
