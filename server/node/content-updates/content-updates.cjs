'use strict';
// Content updates: one NAS folder where a character card or persona card is published once; every device
// that uses the same NAS asks "a new one was published — import it? yes/no" and imports it through the
// app's own import (a character goes through the upstream "update an installed bot" flow, chats kept).
// Only the files and a small pointer (latest.json) live on the NAS; what each device decided lives in
// <data>/content-updates/state.json. Nothing here touches characters, chats or the NAS sync workspace.
const fs = require('node:fs');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createHash, randomUUID } = require('node:crypto');

const NAMESPACE = '.risubard-content-updates/';
const POINTER = 'latest.json';
const LOCK = 'latest.lock';
const LOCK_STALE_MS = 2 * 60_000;
const LOCK_WAIT_MS = 30_000;
const LOCK_RETRY_MS = 500;
const POINTER_LIMIT = 256 * 1024;
const FILE_LIMIT = 512 * 1024 * 1024;
const MAX_ITEMS = 200;
const KINDS = new Set(['character', 'persona']);
const EXTENSIONS = { character: new Set(['charx', 'png', 'json']), persona: new Set(['png']) };
const DECISIONS = new Set(['applied', 'declined', 'published']);
const SHA = /^[a-f0-9]{64}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function text(value, max) {
    return typeof value === 'string' && value.trim() && value.length <= max && !CONTROL.test(value) ? value.trim() : null;
}
function validKey(value) {
    const match = typeof value === 'string' && /^(character|persona):(.+)$/.exec(value);
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
function validPointer(value) {
    if (value?.schema !== 1 || !Array.isArray(value.items) || value.items.length > MAX_ITEMS) throw new Error('Invalid content update list');
    const items = value.items.map(validItem), keys = new Set();
    for (const item of items) { if (keys.has(item.key)) throw new Error('Duplicate content update key'); keys.add(item.key); }
    return { schema: 1, items };
}

function createContentUpdates({ dataRoot, secrets, route, fetch, deviceName = () => '' }) {
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
            if (!/^[a-zA-Z0-9._-]*$/.test(name)) throw new Error('Invalid content update filename');
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
            if (size > limit) { response.destroy(); throw new Error('Content update list is too large'); }
            chunks.push(chunk);
        }
        return Buffer.concat(chunks);
    }
    async function pointer(remote) {
        const response = await remote.call(POINTER);
        if (response.statusCode === 404) { await drainQuietly(response); return { schema: 1, items: [] }; }
        await checked(response);
        return validPointer(JSON.parse((await body(response, POINTER_LIMIT)).toString('utf8')));
    }

    // NAS lock for replacing latest.json: a lock file created only if absent (If-None-Match: *, as the NAS sync uses).
    // A lock older than LOCK_STALE_MS (a device that stopped mid-publish) is removed and taken over.
    async function withLock(remote, work) {
        const deadline = Date.now() + LOCK_WAIT_MS;
        for (;;) {
            const payload = Buffer.from(JSON.stringify({ at: Date.now(), by: deviceName() || '' }));
            const response = await remote.call(LOCK, 'PUT', Readable.from([payload]), { 'Content-Length': String(payload.length), 'If-None-Match': '*' });
            if ([200, 201, 204].includes(response.statusCode)) { await drainQuietly(response); break; }
            if (response.statusCode !== 412) { await checked(response, []); }
            await drainQuietly(response);
            let held = null;
            try {
                const current = await remote.call(LOCK);
                if (current.statusCode === 200) held = JSON.parse((await body(current, 4096)).toString('utf8'));
                else await drainQuietly(current);
            } catch { /* unreadable lock: treated as stale below */ }
            if (!Number.isFinite(held?.at) || Date.now() - held.at > LOCK_STALE_MS) {
                await drainQuietly(await remote.call(LOCK, 'DELETE'));
                continue;
            }
            if (Date.now() > deadline) throw new Error('다른 기기가 배포 목록을 고치는 중이에요. 잠시 뒤 다시 올려 주세요.');
            await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
        }
        try { return await work(); }
        finally { try { await drainQuietly(await remote.call(LOCK, 'DELETE')); } catch { /* the stale-lock rule frees it */ } }
    }

    /** Every published item, with this device's decision; `pending` are the ones to ask about. */
    async function overview() {
        const remote = await nas();
        if (!remote) return { configured: false, items: [], pending: [] };
        const list = await pointer(remote);
        const decisions = readState().decisions;
        const items = list.items.map(item => {
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
        const remote = await nas();
        if (!remote) throw new Error('NAS가 설정되지 않았어요.');
        const item = (await pointer(remote)).items.find(entry => entry.key === key);
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

    /** Stores an incoming upload (stream) and publishes it under `meta.key`, replacing that key's previous file in the list. */
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
            // The list is read, merged and replaced under a NAS lock, so two devices publishing at once both stay listed.
            await withLock(remote, async () => {
                const list = await pointer(remote);
                const next = validPointer({ schema: 1, items: [...list.items.filter(entry => entry.key !== item.key), item] });
                const data = Buffer.from(JSON.stringify(next, null, 2));
                if (data.length > POINTER_LIMIT) throw new Error('NAS 배포 목록이 너무 커요. 오래된 배포를 정리한 뒤 다시 올려 주세요.');
                const temp = `latest-${randomUUID()}.json`;
                try {
                    await drainQuietly(await checked(await remote.call(temp, 'PUT', Readable.from([data]), { 'Content-Length': String(data.length), 'Content-Type': 'application/json' }), [200, 201, 204]));
                    await drainQuietly(await checked(await remote.call(temp, 'MOVE', undefined, { Destination: remote.base + POINTER, Overwrite: 'T' }), [201, 204]));
                } finally {
                    try { await drainQuietly(await remote.call(temp, 'DELETE')); } catch { /* moved away already, or unreachable */ }
                }
                const saved = await pointer(remote);
                for (const entry of next.items) {
                    if (saved.items.find(x => x.key === entry.key)?.sha256 !== entry.sha256) throw new Error('NAS 배포 목록 확인에 실패했어요. 잠시 뒤 다시 올려 주세요.');
                }
            });
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
    }

    return { overview, decide, download, publish, registerRoutes, readState };
}

module.exports = { createContentUpdates, validPointer, validItem, validKey, NAMESPACE };
