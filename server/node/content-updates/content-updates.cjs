'use strict';
// Content updates: one NAS folder where a character card, persona card or prompt preset is published once; every device
// that uses the same NAS asks "a new one was published — import it? yes/no" and imports it through the
// app's own import (a character goes through the upstream "update an installed bot" flow, chats kept).
// On the NAS: the files (named by their SHA-256) and one small record per published name (items/<sha256(name)>.json),
// so devices publishing different names never write the same file and need no lock. What each device decided lives in
// <data>/content-updates/state.json. Nothing here touches characters, chats or the NAS sync workspace.
const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createHash, randomUUID } = require('node:crypto');
const { createAppCodeWatch } = require('./app-code-watch.cjs');

const NAMESPACE = '.risubard-content-updates/';
const RECORDS = 'items';
const RECORD = /^[a-f0-9]{64}\.json$/;
const RECORD_LIMIT = 16 * 1024;
const LIST_LIMIT = 2 * 1024 * 1024;
const FILE_LIMIT = 512 * 1024 * 1024;
const MAX_ITEMS = 200; // new names are refused at this count
const READ_ITEMS = 256; // read cap, above MAX_ITEMS so names that passed the count check at the same moment are all still read
const READ_CONCURRENCY = 8;
const KINDS = new Set(['character', 'persona', 'preset']);
// preset (0.9.92-ver1): a prompt preset as exported by the app (.risup / .risupreset) or its JSON form.
const EXTENSIONS = { character: new Set(['charx', 'png', 'json']), persona: new Set(['png']), preset: new Set(['risup', 'risupreset', 'json']) };
const DECISIONS = new Set(['applied', 'declined', 'published']);
const SHA = /^[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function text(value, max) {
    return typeof value === 'string' && value.trim() && value.length <= max && !CONTROL.test(value) ? value.trim() : null;
}
function validKey(value) {
    const match = typeof value === 'string' && /^(character|persona|preset):(.+)$/.exec(value);
    return !!match && !!text(match[2], 120) && match[2] === match[2].trim();
}
function validItem(value) {
    if (!value || typeof value !== 'object' || !validKey(value.key) || !KINDS.has(value.kind) || !value.key.startsWith(value.kind + ':')) throw new Error('Invalid content update item');
    const ext = typeof value.file === 'string' && /^([a-f0-9]{64})\.([a-z]+)$/.exec(value.file);
    if (!ext || ext[1] !== value.sha256 || !EXTENSIONS[value.kind].has(ext[2])) throw new Error('Invalid content update file');
    if (!SHA.test(value.sha256) || !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > FILE_LIMIT) throw new Error('Invalid content update size');
    if (!text(value.title, 200) || !text(value.fileName, 200) || /[\\/]/.test(value.fileName)) throw new Error('Invalid content update name');
    if (value.version !== undefined && value.version !== '' && !text(value.version, 80)) throw new Error('Invalid content update version');
    if (!text(value.publishedAt, 40) || Number.isNaN(Date.parse(value.publishedAt))) throw new Error('Invalid content update time');
    return {
        key: value.key, kind: value.kind, title: value.title.trim(), version: typeof value.version === 'string' ? value.version.trim() : '',
        file: value.file, fileName: value.fileName.trim(), sha256: value.sha256, bytes: value.bytes, publishedAt: value.publishedAt,
        publishedBy: text(value.publishedBy, 80) || '',
    };
}
/** The record file of a published name: SHA-256 of the key, so any name maps to a fixed, filename-safe record. */
const recordName = key => createHash('sha256').update(key, 'utf8').digest('hex') + '.json';
/** Record file names in a Depth:1 PROPFIND multistatus (the collection's own href never matches). */
function recordNames(xml) {
    const names = new Set();
    for (const match of xml.matchAll(/<(?:[A-Za-z0-9_]+:)?href\b[^>]*>\s*([^<]+?)\s*</gi)) {
        const href = match[1].replace(/&amp;/g, '&').replace(/\/+$/, '');
        let name;
        try { name = decodeURIComponent(href.slice(href.lastIndexOf('/') + 1)); } catch { continue; }
        if (RECORD.test(name)) names.add(name);
    }
    return [...names].sort();
}

function createContentUpdates({ dataRoot, secrets, route, fetch, deviceName = () => '', appCode: appCodeOptions = {} }) {
    // A newer app code patch on the NAS, downloaded in the background for the loader's next start (app-code-watch.cjs).
    const appCode = createAppCodeWatch({ dataRoot, secrets, route, ...appCodeOptions });
    const root = path.join(dataRoot, 'content-updates');
    const statePath = path.join(root, 'state.json');
    const scratch = path.join(root, 'tmp');
    let chain = Promise.resolve();
    const exclusive = work => { const run = chain.then(work, work); chain = run.catch(() => {}); return run; };

    function readState() {
        try {
            const value = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            if (value?.schema === 1 && value.decisions && typeof value.decisions === 'object') return value;
        } catch (error) { if (error.code !== 'ENOENT') console.warn('[ContentUpdates] state unreadable, starting empty:', error.message); }
        return { schema: 1, decisions: {} };
    }
    function writeState(state) {
        fs.mkdirSync(root, { recursive: true });
        const temp = path.join(root, `.state-${randomUUID()}.tmp`);
        fs.writeFileSync(temp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
        fs.renameSync(temp, statePath);
    }
    function decide(key, sha256, decision) {
        if (!validKey(key) || !SHA.test(sha256) || !(DECISIONS.has(decision) || decision === 'reset')) throw new Error('Invalid content update decision');
        const state = readState();
        if (decision === 'reset') {
            if (state.decisions[key]?.sha256 === sha256) delete state.decisions[key];
            writeState(state);
            return null;
        }
        state.decisions[key] = { sha256, decision, at: new Date().toISOString() };
        writeState(state);
        return state.decisions[key];
    }

    async function nas() {
        const config = await secrets.get('nas');
        if (!config?.url || !config.username || !config.password) return null;
        const endpoint = await route.endpointFor(config);
        const base = endpoint.url + NAMESPACE;
        const auth = 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64');
        const call = (name, method = 'GET', body, headers = {}) => {
            if (!/^(?:items\/)?[a-zA-Z0-9._-]*$/.test(name)) throw new Error('Invalid content update filename');
            return fetch(base + name, { method, body, servername: endpoint.servername, headers: { Authorization: auth, ...headers } });
        };
        return { base, call };
    }
    async function checked(response, allowed = [200]) {
        if (!allowed.includes(response.statusCode)) { await drainQuietly(response); throw new Error(`Content update NAS HTTP ${response.statusCode}`); }
        return response;
    }
    async function drainQuietly(response) { try { for await (const _ of response) { /* discard */ } } catch { /* closed */ } }
    async function body(response, limit) {
        const chunks = []; let size = 0;
        for await (const chunk of response) {
            size += chunk.length;
            if (size > limit) { response.destroy(); throw Object.assign(new Error('Content update data is too large'), { code: 'TOO_LARGE' }); }
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }
    /** One published item, or null when its record is missing or not a valid record (a damaged record is skipped, not fatal). */
    async function readRecord(remote, name) {
        const response = await remote.call(`${RECORDS}/${name}`);
        if (response.statusCode === 404) { await drainQuietly(response); return null; }
        await checked(response);
        let data;
        try { data = await body(response, RECORD_LIMIT); } catch (error) {
            if (error.code !== 'TOO_LARGE') throw error;
            console.warn('[ContentUpdates] skipped an oversized record:', name); return null;
        }
        try {
            const item = validItem(JSON.parse(data.toString('utf8')));
            if (recordName(item.key) !== name) throw new Error('record name does not match its key');
            return item;
        } catch (error) { console.warn('[ContentUpdates] skipped an invalid record:', name, error.message); return null; }
    }
    async function listRecordNames(remote) {
        const xml = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';
        const response = await remote.call(`${RECORDS}/`, 'PROPFIND', Readable.from([xml]), { Depth: '1', 'Content-Type': 'application/xml', 'Content-Length': String(Buffer.byteLength(xml)) });
        if (response.statusCode === 404) { await drainQuietly(response); return []; }
        await checked(response, [207]);
        return recordNames((await body(response, LIST_LIMIT)).toString('utf8'));
    }
    /** All published items, oldest first. Network errors fail the whole read (asked again later); a bad record is skipped. */
    async function listItems(remote) {
        const names = await listRecordNames(remote);
        if (names.length > READ_ITEMS) console.warn('[ContentUpdates] more records than the read limit; reading the first', READ_ITEMS);
        const queue = names.slice(0, READ_ITEMS), items = [];
        await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, queue.length) }, async () => {
            while (queue.length) { const item = await readRecord(remote, queue.shift()); if (item) items.push(item); }
        }));
        return items.sort((a, b) => a.publishedAt < b.publishedAt ? -1 : a.publishedAt > b.publishedAt ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    }

    /** Every published item, with this device's decision; `pending` are the ones to ask about. */
    async function overview() {
        const remote = await nas();
        if (!remote) return { configured: false, items: [], pending: [] };
        const list = await listItems(remote);
        const decisions = readState().decisions;
        const items = list.map(item => {
            const local = decisions[item.key];
            return { ...item, decision: local?.sha256 === item.sha256 ? local.decision : '' };
        });
        return { configured: true, items, pending: items.filter(item => !item.decision) };
    }

    async function hashFile(file) {
        const hash = createHash('sha256');
        for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
        return hash.digest('hex');
    }
    function limitStream(limit, label) {
        let bytes = 0;
        const counter = new Transform({ transform(chunk, _encoding, next) {
            bytes += chunk.length;
            next(bytes > limit ? new Error(`${label} exceeds its size`) : null, chunk);
        } });
        return { counter, bytes: () => bytes };
    }
    function tempFile(ext) {
        fs.mkdirSync(scratch, { recursive: true });
        return path.join(scratch, `${randomUUID()}.${ext}`);
    }

    /** Downloads a published file to a temporary file after checking its size and SHA-256. The caller removes it. */
    async function download(key, sha256) {
        if (!validKey(key)) throw new Error('배포 이름이 올바르지 않아요.');
        const remote = await nas();
        if (!remote) throw new Error('NAS가 설정되지 않았어요.');
        const item = await readRecord(remote, recordName(key));
        if (!item || item.sha256 !== sha256) throw new Error('NAS의 배포본이 바뀌었어요. 다시 확인해 주세요.');
        const target = tempFile(item.file.split('.').pop());
        try {
            const response = await checked(await remote.call(item.file));
            const { counter, bytes } = limitStream(item.bytes, 'Content update file');
            await pipeline(response, counter, fs.createWriteStream(target, { flags: 'wx', mode: 0o600 }));
            if (bytes() !== item.bytes || await hashFile(target) !== item.sha256) throw new Error('받은 파일이 배포본과 달라요(크기·해시 불일치).');
            return { file: target, item };
        } catch (error) { fs.rmSync(target, { force: true }); throw error; }
    }

    /** Stores an incoming upload (stream) and publishes it under `meta.key`, replacing that key's previous record. */
    async function publish(stream, meta) {
        if (!meta || !validKey(meta.key) || !KINDS.has(meta.kind) || !meta.key.startsWith(meta.kind + ':')) throw new Error('배포 이름이 올바르지 않아요.');
        const ext = String(meta.fileName ?? '').toLowerCase().split('.').pop();
        if (!EXTENSIONS[meta.kind].has(ext)) throw new Error('이 종류에 맞지 않는 파일 형식이에요.');
        const remote = await nas();
        if (!remote) throw new Error('NAS가 설정되지 않았어요. 먼저 NAS 연결 설정을 해 주세요.');
        const staged = tempFile(ext);
        try {
            const { counter, bytes } = limitStream(FILE_LIMIT, 'Upload');
            await pipeline(stream, counter, fs.createWriteStream(staged, { flags: 'wx', mode: 0o600 }));
            const sha256 = await hashFile(staged), size = bytes();
            if (!size) throw new Error('빈 파일이에요.');
            const item = validItem({ key: meta.key, kind: meta.kind, title: meta.title, version: meta.version ?? '', fileName: meta.fileName,
                file: `${sha256}.${ext}`, sha256, bytes: size, publishedAt: new Date().toISOString(), publishedBy: deviceName() || '' });
            await drainQuietly(await checked(await remote.call('', 'MKCOL'), [201, 405]));
            const part = `upload-${randomUUID()}.part`;
            try {
                await drainQuietly(await checked(await remote.call(part, 'PUT', fs.createReadStream(staged), { 'Content-Length': String(size) }), [200, 201, 204]));
                const moved = await remote.call(part, 'MOVE', undefined, { Destination: remote.base + item.file, Overwrite: 'F' });
                // 412: the same bytes were published before; the existing file is the same content (its name is its SHA-256).
                await drainQuietly(await checked(moved, [201, 204, 412]));
            } finally {
                try { await drainQuietly(await checked(await remote.call(part, 'DELETE'), [200, 204, 404])); } catch { /* an interrupted upload part is not published */ }
            }
            // The record of this name only: other names are other files, so devices publishing at the same time do not collide.
            await drainQuietly(await checked(await remote.call(`${RECORDS}/`, 'MKCOL'), [201, 405]));
            const name = recordName(item.key);
            // An existing name (even with a damaged record) can always be republished; only new names count against the limit.
            const names = await listRecordNames(remote);
            if (!names.includes(name) && names.length >= MAX_ITEMS) {
                throw new Error(`NAS 배포가 너무 많아요(최대 ${MAX_ITEMS}개). 쓰지 않는 배포 기록을 정리한 뒤 다시 올려 주세요.`);
            }
            const data = Buffer.from(JSON.stringify(item, null, 2));
            const temp = `${RECORDS}/${name}.part-${randomUUID()}`;
            try {
                await drainQuietly(await checked(await remote.call(temp, 'PUT', Readable.from([data]), { 'If-None-Match': '*', 'Content-Length': String(data.length), 'Content-Type': 'application/json' }), [200, 201, 204]));
                await drainQuietly(await checked(await remote.call(temp, 'MOVE', undefined, { Destination: `${remote.base}${RECORDS}/${name}`, Overwrite: 'T' }), [201, 204]));
            } finally {
                try { await drainQuietly(await remote.call(temp, 'DELETE')); } catch { /* moved away already, or unreachable */ }
            }
            const saved = await readRecord(remote, name);
            // Another device publishing the same name at the same moment: the later record stands, and this one says so.
            if (saved?.sha256 !== item.sha256 || saved.publishedAt !== item.publishedAt) throw new Error('NAS 배포 기록 확인에 실패했어요. 다른 기기가 같은 배포 이름으로 방금 올렸을 수 있어요. 목록을 확인해 주세요.');
            decide(item.key, item.sha256, 'published');
            return item;
        } finally { fs.rmSync(staged, { force: true }); }
    }

    function registerRoutes(app, { auth, activeSession }) {
        const routeOf = (method, suffix, handler) => app[method]('/api/play-transfer/content-updates' + suffix, async (req, res) => {
            try {
                if (!await auth(req, res) || (method !== 'get' && activeSession && !activeSession(req, res))) return;
                await handler(req, res);
            } catch (error) { if (!res.headersSent) res.status(400).json({ error: error.message }); else res.destroy(error); }
        });
        routeOf('post', '/overview', async (_req, res) => res.json(await overview()));
        routeOf('post', '/decide', async (req, res) => res.json(await exclusive(() => decide(req.body?.key, req.body?.sha256, req.body?.decision))));
        routeOf('post', '/fetch', async (req, res) => {
            const { file, item } = await download(req.body?.key, req.body?.sha256);
            res.setHeader('Content-Type', 'application/octet-stream');
            res.setHeader('Content-Length', String(item.bytes));
            res.setHeader('X-Content-Sha256', item.sha256);
            try { await pipeline(fs.createReadStream(file), res); } finally { fs.rmSync(file, { force: true }); }
        });
        routeOf('post', '/publish', async (req, res) => {
            let meta;
            try { meta = JSON.parse(decodeURIComponent(String(req.headers['x-content-meta'] ?? ''))); } catch { throw new Error('배포 정보를 읽지 못했어요.'); }
            res.json(await exclusive(() => publish(req, meta)));
        });
        routeOf('post', '/app-code', async (req, res) => res.json(req.body?.check === true ? await appCode.check() : appCode.status()));
        appCode.start();
    }

    return { overview, decide, download, publish, registerRoutes, readState, appCode };
}

module.exports = { createContentUpdates, validItem, validKey, recordName, recordNames, NAMESPACE, MAX_ITEMS, READ_ITEMS };
