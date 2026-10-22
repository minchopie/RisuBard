'use strict';
/**
 * WebDAV namespace `.risubard-sync/v1/<workspaceID>/…` under the user's configured NAS folder, plus the publish/pull
 * transport over the local sync store. Reuses transfer-remote request/bounding/folder validation and transfer-secrets
 * credentials. Commit objects are bounded metadata; revision content and dependencies are content-addressed blobs that
 * stream to and from temp files. No network happens in constructors; every call site is explicit.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { createHash, randomUUID } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { join, dirname } = require('node:path');
const { request, bounded, drain, folder, nasServername } = require('./transfer-remote.cjs');
const { canonical } = require('../../../shared/play-set/protocol.ts');
const { hashJson } = require('./nas-sync-core.cjs');

const NAMESPACE = ['.risubard-sync', 'v1'];
const OBJECT = /^(\d{1,15})_([a-f0-9]{64})\.json$/;
const DIGEST = /^[a-f0-9]{64}$/;
const LIST_LIMIT = 2 * 1024 * 1024;
const METADATA_LIMIT = 8 * 1024 * 1024; // commit/checkpoint/ack JSON only; blobs stream without an inherited bundle cap
const BUCKET = 256;
const OLD_BUCKETS_PER_SCAN = 8;
const segment = value => { if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\/\\\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid sync path segment: ' + value); return encodeURIComponent(value); };
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const failure = response => { response.destroy(); return Object.assign(new Error(`NAS 요청 실패 (HTTP ${response.statusCode})`), { status: response.statusCode }); };
const checked = (response, allowed) => { if (!allowed.includes(response.statusCode)) throw failure(response); return response; };
/** Minimal multistatus parser: hrefs + collection flag. Names are decoded per segment, never re-joined into a URL. */
function parseListing(xml, directoryHref) {
    const entries = [], base = directoryHref.replace(/^https?:\/\/[^/]+/i, '').replace(/\/+$/, '');
    for (const m of xml.matchAll(/<(?:[A-Za-z0-9_]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?response>/gi)) {
        const href = /<(?:[A-Za-z0-9_]+:)?href\b[^>]*>\s*([^<]+?)\s*</i.exec(m[1])?.[1];
        if (!href) continue;
        const path = href.replace(/&amp;/g, '&').replace(/^https?:\/\/[^/]+/i, '').replace(/\/+$/, '');
        if (path === base || !path.startsWith(base + '/')) continue;
        const rest = path.slice(base.length + 1);
        if (rest.includes('/')) continue;
        entries.push({ name: decodeURIComponent(rest), collection: /<(?:[A-Za-z0-9_]+:)?collection\b/i.test(m[1]) });
    }
    return entries.sort((a, b) => a.name < b.name ? -1 : 1);
}
async function hashStream(stream, limit) {
    const digest = createHash('sha256'); let bytes = 0;
    for await (const chunk of stream) { bytes += chunk.length; if (bytes > limit) { stream.destroy(); throw new Error('Remote object exceeds expected size'); } digest.update(chunk); }
    return { hash: digest.digest('hex'), bytes };
}

function createSyncRemote({ secrets, fetch = request, route = null }) {
    async function base() {
        const c = await secrets.get('nas'); // home/external: same account, same namespace; URL + TLS name come from ONE pinned decision (route.run)
        const { url, servername } = route ? await route.endpointFor(c) : { url: folder(c.url), servername: nasServername(c, folder(c.url)) };
        if (!c.username || !c.password) throw new Error('연결 설정에서 NAS 주소와 계정을 먼저 저장해 주세요.');
        return { url, auth: 'Basic ' + Buffer.from(`${c.username}:${c.password}`).toString('base64'), servername }; // IP URL: TLS validates against the saved certificate name of that side
    }
    const hrefRaw = (b, full) => b.url + full.map(segment).join('/');
    const href = (b, segments) => hrefRaw(b, [...NAMESPACE, ...segments]);
    const sendRaw = (b, method, full, headers = {}, body) => fetch(hrefRaw(b, full), { method, headers: { Authorization: b.auth, ...headers }, body, servername: b.servername });
    const send = (b, method, segments, headers, body) => sendRaw(b, method, [...NAMESPACE, ...segments], headers, body);
    /** MKCOL every prefix including the namespace itself; 405 means the collection already exists. */
    async function mkcolAll(b, segments) {
        const full = [...NAMESPACE, ...segments];
        for (let depth = 1; depth <= full.length; depth++) await drain(checked(await sendRaw(b, 'MKCOL', full.slice(0, depth)), [200, 201, 204, 405]));
    }
    async function get(segments, limit = METADATA_LIMIT) {
        const b = await base(), response = await send(b, 'GET', segments);
        if (response.statusCode === 404) { await drain(response); return null; }
        return bounded(checked(response, [200]), limit);
    }
    async function list(segments) {
        const b = await base();
        const xml = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/></d:prop></d:propfind>';
        const response = await send(b, 'PROPFIND', segments, { Depth: '1', 'Content-Type': 'application/xml', 'Content-Length': String(Buffer.byteLength(xml)) }, Readable.from([xml]));
        if (response.statusCode === 404) { await drain(response); return []; }
        return parseListing((await bounded(checked(response, [207]), LIST_LIMIT)).toString('utf8'), href(b, segments));
    }
    /** Temp PUT → GET verification (streamed hash) → MOVE. Returns stored | exists-same | conflict; the temp never survives. */
    async function putVerified(segments, { size, hash, open }, { overwrite = false } = {}) {
        const b = await base(), name = segments.at(-1), dir = segments.slice(0, -1), temp = [...dir, `${name}.part-${randomUUID()}`];
        await mkcolAll(b, dir);
        try {
            await drain(checked(await send(b, 'PUT', temp, { 'If-None-Match': '*', 'Content-Length': String(size), 'Content-Type': 'application/octet-stream' }, open()), [200, 201, 204]));
            const echoed = await hashStream(checked(await send(b, 'GET', temp), [200]), size);
            if (echoed.bytes !== size || echoed.hash !== hash) throw new Error('NAS uploaded hash mismatch');
            const moved = await send(b, 'MOVE', temp, { Destination: href(b, segments), Overwrite: overwrite ? 'T' : 'F' });
            if ([200, 201, 204].includes(moved.statusCode)) { await drain(moved); return { state: 'stored', hash }; }
            if (moved.statusCode !== 412) throw failure(moved);
            await drain(moved);
            const existing = await hashStream(checked(await send(b, 'GET', segments), [200]), Number.MAX_SAFE_INTEGER);
            return { state: existing.hash === hash ? 'exists-same' : 'conflict', hash: existing.hash };
        } finally { try { await drain(await send(b, 'DELETE', temp)); } catch {} }
    }
    const putImmutable = (segments, bytes, options) => putVerified(segments, { size: bytes.length, hash: sha256(bytes), open: () => Readable.from([bytes]) }, options);
    const putFile = async (segments, path, hash, options) => putVerified(segments, { size: (await fsp.stat(path)).size, hash, open: () => fs.createReadStream(path) }, options);
    /** Streamed hash check of a content-addressed object: ok | missing | damaged. */
    async function verify(segments, hash) {
        const b = await base(), response = await send(b, 'GET', segments);
        if (response.statusCode === 404) { await drain(response); return 'missing'; }
        return (await hashStream(checked(response, [200]), Number.MAX_SAFE_INTEGER)).hash === hash ? 'ok' : 'damaged';
    }
    /** Stream a blob into a temp file next to its destination, verify the hash, then rename. Never buffers the body. */
    async function getToFile(segments, destination, hash) {
        const b = await base(), response = await send(b, 'GET', segments);
        if (response.statusCode === 404) { await drain(response); return null; }
        checked(response, [200]);
        await fsp.mkdir(dirname(destination), { recursive: true });
        const temp = `${destination}.${randomUUID()}.part`, digest = createHash('sha256');
        try {
            await pipeline(response, new Transform({ transform(chunk, _e, done) { digest.update(chunk); done(null, chunk); } }), fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
            if (digest.digest('hex') !== hash) throw new Error('Downloaded blob hash mismatch: ' + hash);
            const fd = await fsp.open(temp, 'r+'); try { await fd.sync(); } finally { await fd.close(); }
            await fsp.rename(temp, destination);
            return destination;
        } catch (error) { await fsp.rm(temp, { force: true }); throw error; }
    }
    return { get, list, putImmutable, putFile, verify, getToFile, href: async segments => href(await base(), segments) };
}

/** Publish the outbox and pull peers' commits. Local manifest writes happen only after the remote step they record. */
function createSyncTransport({ store, remote, now = Date.now, oldBucketsPerScan = OLD_BUCKETS_PER_SCAN, statfs = path => fsp.statfs(path, { bigint: true }) }) {
    const ws = () => { const { workspaceId } = store.identity(); if (!workspaceId) throw new Error('Sync workspace is not bound'); return workspaceId; };
    const devicePath = (device, incarnation) => [ws(), 'devices', device, incarnation];
    const blobSegments = hash => [ws(), 'blobs', hash.slice(0, 2), hash];
    const bucketOf = sequence => String(Math.floor(sequence / BUCKET));
    const objectName = (sequence, id) => `${sequence}_${id}.json`;
    const listObjects = async segments => (await remote.list(segments)).filter(e => !e.collection && OBJECT.test(e.name)).map(e => ({ name: e.name, sequence: Number(OBJECT.exec(e.name)[1]), commitId: OBJECT.exec(e.name)[2] })).sort((a, b) => a.sequence - b.sequence);
    async function publish({ at = now() } = {}) {
        const report = { stored: [], blobs: 0, failed: [], rotated: null, checkpoint: null, ack: null };
        const listed = new Map();
        for (const entry of store.dueCommits(at)) {
            const { deviceId, incarnationId } = store.identity();
            if (entry.incarnationId !== incarnationId) continue;
            const commitsDir = [...devicePath(deviceId, incarnationId), 'commits'];
            try {
                // Clone/restore detection: another object already claims this (incarnation, sequence) under a different commit id.
                const bucket = bucketOf(entry.sequence);
                if (!listed.has(bucket)) listed.set(bucket, await listObjects([...commitsDir, bucket]));
                const other = listed.get(bucket).find(o => o.sequence === entry.sequence && o.commitId !== entry.commitId);
                if (other) { report.rotated = store.rotateIncarnation(`sequence ${entry.sequence} already published as ${other.commitId}`); return report; }
                // Dependency closure is verified on the NAS itself before the commit may reference it: a restored or damaged
                // remote never ends up with a committed reference to absent content. Local publication records are hints only.
                for (const hash of entry.blobs) {
                    const present = await remote.verify(blobSegments(hash), hash);
                    if (present === 'ok') { if (!store.unpublishedBlobs(entry).includes(hash)) continue; store.markBlobPublished(hash); continue; }
                    const result = await remote.putFile(blobSegments(hash), store.blobFile(hash), hash, { overwrite: present === 'damaged' });
                    if (result.state === 'conflict') throw new Error('Remote blob differs from local content: ' + hash);
                    store.markBlobPublished(hash); report.blobs++;
                }
                const result = await remote.putImmutable([...commitsDir, bucket, objectName(entry.sequence, entry.commitId)], Buffer.from(canonical(store.commitObject(entry))));
                if (result.state === 'conflict') { report.rotated = store.rotateIncarnation(`sequence ${entry.sequence} object differs`); return report; }
                store.markPublished(entry.sequence, entry.commitId, at); report.stored.push({ sequence: entry.sequence, commitId: entry.commitId, state: result.state });
            } catch (error) { store.markPublishFailed(entry.sequence, error, at); report.failed.push({ sequence: entry.sequence, error: String(error.message) }); return report; } // offline: stop here, retry later
        }
        if (store.needsCheckpoint()) {
            const { deviceId, incarnationId } = store.identity(), object = store.checkpointObject(), id = hashJson(object);
            try { await remote.putImmutable([...devicePath(deviceId, incarnationId), 'checkpoints', objectName(object.sequence, id)], Buffer.from(canonical(object))); store.recordCheckpoint(id, at); report.checkpoint = id; }
            catch (error) { report.failed.push({ checkpoint: true, error: String(error.message) }); }
        }
        if (store.ackChanged()) {
            const ack = store.ackObject(); // exact snapshot: applies that land during the upload stay unacknowledged until the next publish
            try { await remote.putImmutable([ws(), 'acks', `${ack.deviceId}.json`], Buffer.from(canonical(ack)), { overwrite: true }); store.markAckPublished(ack.hash); report.ack = 'published'; }
            catch (error) { report.failed.push({ ack: true, error: String(error.message) }); }
        }
        return report;
    }
    /** Download every blob a commit object lists that is missing locally; each is verified by its own hash. */
    async function fetchBlobs(object) {
        const missing = [];
        for (const hash of store.missingCommitBlobs(object)) {
            const size = object.sizes?.[hash];
            if (Number.isSafeInteger(size)) {
                // Reserve room for the streamed blob and a recoverable prior generation, like the manual transfer verifier.
                await fsp.mkdir(dirname(store.blobFile(hash)), { recursive: true });
                const space = await statfs(dirname(store.blobFile(hash)));
                if (space.bavail * space.bsize < BigInt(size) * 2n) throw Object.assign(new Error(`Not enough storage space for blob ${hash.slice(0, 8)} (${size} bytes)`), { code: 'ENOSPC' });
            }
            const path = await remote.getToFile(blobSegments(hash), store.blobFile(hash), hash);
            if (!path) missing.push(hash);
        }
        return missing;
    }
    /** Scan every peer incarnation: current/future buckets always, a rotating window of older buckets, all when `full`. */
    async function pull({ full = false } = {}) {
        const report = { admitted: [], waiting: [], held: [], quarantined: [], identical: 0, scanned: [] };
        const self = store.identity();
        for (const device of (await remote.list([ws(), 'devices'])).filter(e => e.collection)) {
            for (const incarnation of (await remote.list([ws(), 'devices', device.name])).filter(e => e.collection)) {
                if (device.name === self.deviceId && incarnation.name === self.incarnationId) continue;
                const base = [...devicePath(device.name, incarnation.name), 'commits'];
                const buckets = (await remote.list(base)).filter(e => e.collection && /^\d{1,12}$/.test(e.name)).map(e => Number(e.name)).sort((a, b) => a - b);
                const active = Math.floor((store.peer(device.name, incarnation.name).lastSeen + 1) / BUCKET);
                const chosen = full ? buckets : [...buckets.filter(b => b >= active), ...store.rotateBuckets(device.name, incarnation.name, buckets.filter(b => b < active), oldBucketsPerScan)];
                for (const bucket of chosen) {
                    report.scanned.push(`${device.name}/${incarnation.name}/${bucket}`);
                    for (const { name, sequence, commitId } of await listObjects([...base, String(bucket)])) {
                        if (Math.floor(sequence / BUCKET) !== bucket) continue; // misplaced object: never trusted
                        if (store.knownRemote(device.name, incarnation.name, sequence, commitId)) { report.identical++; continue; }
                        if (store.isWaiting(device.name, incarnation.name, sequence, commitId)) continue; // retried below from the durable copy
                        const bytes = await remote.get([...base, String(bucket), name]);
                        if (!bytes) continue;
                        let object;
                        try { object = JSON.parse(bytes.toString('utf8')); if (object?.v === 1 && Array.isArray(object.blobs) && object.blobs.every(h => DIGEST.test(h))) await fetchBlobs(object); }
                        catch (error) { object = object ?? { corrupt: bytes.toString('base64').slice(0, 4096), error: String(error.message) }; }
                        const result = store.admitRemote(object, { device: device.name, incarnation: incarnation.name, sequence, commitId });
                        if (result.state === 'identical') report.identical++; else report[result.state].push({ device: device.name, incarnation: incarnation.name, sequence, commitId, ...(result.reason ? { reason: result.reason } : {}) });
                    }
                }
            }
        }
        // Waiting commits: re-download blobs that were missing or damaged on an earlier pull, then retry admission.
        for (const entry of store.waitingEntries()) if (entry.object && entry.blobs.length) { try { await fetchBlobs(entry.object); } catch (error) { report.waiting.push({ ...entry, object: undefined, reason: 'blob fetch: ' + error.message }); } }
        for (const retry of store.retryWaiting()) if (retry.state !== 'waiting') report[retry.state].push(retry);
        // Repair: a blob pinned by an already ADMITTED revision that is no longer in the local store (consumed or cleaned up) is
        // re-fetched by its hash, so later plans stop reporting it as missing material. Only admitted revisions qualify — held,
        // quarantined and waiting records keep their own paths above. Every download is hash-verified by getToFile; a failure is
        // reported per hash and never fails the pull. The set is bounded by what admitted revisions pin; nothing is skipped.
        report.repaired = []; report.repairFailed = [];
        const admitted = [...new Set(Object.values(store.state().peers).flatMap(p => Object.values(p.admittedRevisions ?? {}).flat()))].map(id => store.graph.get(id)).filter(Boolean);
        for (const hash of store.missingBlobs(admitted)) {
            try { const path = await remote.getToFile(blobSegments(hash), store.blobFile(hash), hash); if (path) report.repaired.push(hash); else report.repairFailed.push({ hash, reason: 'absent on NAS' }); }
            catch (error) { report.repairFailed.push({ hash, reason: String(error.message) }); }
        }
        return report;
    }
    /** Maintenance: verify every blob pinned by already published commits and re-upload missing/damaged ones. */
    async function repair() {
        const repaired = [], checked = new Set();
        for (const entry of store.publishedCommits()) for (const hash of entry.blobs) {
            if (checked.has(hash)) continue; checked.add(hash);
            const present = await remote.verify(blobSegments(hash), hash);
            if (present === 'ok') continue;
            const result = await remote.putFile(blobSegments(hash), store.blobFile(hash), hash, { overwrite: present === 'damaged' });
            if (result.state === 'conflict') throw new Error('Remote blob differs from local content: ' + hash);
            repaired.push({ hash, was: present });
        }
        return { checked: checked.size, repaired };
    }
    /** Receipts distinguish NAS-committed outbox entries from peer commits the client has actually applied. */
    const status = () => ({ ...store.status(), pendingApply: store.pendingApply().length });
    return { publish, pull, repair, status, BUCKET };
}
module.exports = { createSyncRemote, createSyncTransport, parseListing, NAMESPACE, OBJECT, BUCKET, OLD_BUCKETS_PER_SCAN, LIST_LIMIT, METADATA_LIMIT };
