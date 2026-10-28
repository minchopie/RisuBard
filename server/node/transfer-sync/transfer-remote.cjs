'use strict';
const https = require('node:https');
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createHash, randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const GITHUB_LIMIT = 100_000_000;
const JSON_LIMIT = 8 * 1024 * 1024;
function legacyDocument(bytes) {
    if (!bytes.length || bytes.length > JSON_LIMIT) throw new Error('기존 채팅 JSON은 8 MiB 이하여야 해요.');
    const document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (document.type !== 'risuChat' || document.ver !== 2 || !Array.isArray(document.data?.message)) throw new Error('개별 대화 JSON이 아닙니다.');
    return document;
}
function requireContinuation(before, after) {
    if (before.id !== after.id || after.message.length < before.message.length || before.message.some((message, index) => !isDeepStrictEqual(message, after.message[index]))
        || before.message.length === after.message.length && !isDeepStrictEqual(before, after)) throw new Error('기존 GitHub 백업에 다른 수정이나 더 최신 대화가 있어요. 먼저 내려받아 확인해 주세요. 기존 백업은 변경하지 않았어요.');
}
const name = value => {
    if (typeof value !== 'string' || value.length > 200 || !value.endsWith('.risuplay') || value === '.risuplay' || /[\\/\x00-\x1f\x7f-\x9f]/.test(value)) throw new Error('Invalid transfer filename');
    return value;
};
/** Registered home Wi-Fi names: at most 16, each 1–64 chars, no control characters, unique. Compared exactly (case-sensitive) like the OS reports them. */
function validateHomeSsids(value) {
    if (!Array.isArray(value)) throw new Error('집 Wi-Fi 목록 형식이 올바르지 않아요.');
    const out = [];
    for (const item of value) { if (typeof item !== 'string' || !item || item.length > 64 || /[\x00-\x1f\x7f]/.test(item)) throw new Error('집 Wi-Fi 이름을 확인해 주세요.'); if (!out.includes(item)) out.push(item); }
    if (out.length > 16) throw new Error('집 Wi-Fi는 16개까지 등록할 수 있어요.');
    return out;
}
function folder(value) {
    if (!value || typeof value !== 'string') throw new Error('연결 설정에서 NAS 주소와 계정을 먼저 저장해 주세요.');
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('계정 정보가 없는 HTTPS WebDAV 폴더 주소를 입력해 주세요.');
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.href;
}
/** Optional certificate host name for a NAS URL that carries a literal IP (user decision: direct addresses, no relay). Plain DNS name only. */
function certHost(value) {
    if (value === undefined || value === null || value === '') return '';
    const name = String(value).trim();
    if (name.length > 253 || !/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/.test(name) || /^\d{1,3}(\.\d{1,3}){3}$/.test(name)) throw new Error('인증서 이름(호스트명)을 확인해 주세요.');
    return name;
}
/** TLS server name for the NAS endpoint `url`: the saved certificate name of that side (home/external), '' = the URL's own host. */
function nasServername(c, url) { return (c?.homeUrl && url === folder(c.homeUrl) ? c.homeCertHost : c?.certHost) || ''; }
/** `servername`: TLS SNI + certificate validation name + Host header when the URL's host is a literal IP; validation is never relaxed. */
function request(url, { method = 'GET', headers = {}, body, servername = '', signal } = {}) {
    const target = new URL(url);
    if (target.protocol !== 'https:') throw new Error('HTTPS required');
    const options = { method, headers, signal };
    if (servername) { options.servername = certHost(servername); options.headers = { Host: options.servername + (target.port ? ':' + target.port : ''), ...headers }; }
    return new Promise((resolve, reject) => {
        let connecting;
        const req = https.request(url, options, res => {
            clearTimeout(connecting);
            res.setTimeout(90000, () => res.destroy(new Error('전송 응답이 90초 동안 멈췄어요.')));
            resolve(res);
        });
        req.setTimeout(90000, () => req.destroy(new Error('전송 연결이 90초 동안 멈췄어요.')));
        connecting = setTimeout(() => req.destroy(new Error('서버에 15초 안에 연결하지 못했어요.')), 15000);
        req.on('socket', socket => { if (!socket.connecting) clearTimeout(connecting); else socket.once('secureConnect', () => clearTimeout(connecting)); });
        req.on('error', error => { clearTimeout(connecting); reject(error); });
        req.on('close', () => clearTimeout(connecting));
        if (body) pipeline(body, req).catch(reject); else req.end();
    });
}
async function bounded(response, limit = JSON_LIMIT) {
    const chunks = []; let bytes = 0;
    for await (const chunk of response) {
        bytes += chunk.length;
        if (bytes > limit) { response.destroy(); throw new Error('Remote metadata exceeds size limit'); }
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}
/**
 * Read an ignored success body to its end (bounded) and let the keep-alive socket return to the agent pool. Destroying an unread
 * response destroys its socket, so every following request pays a fresh TCP+TLS connection; a WebDAV publish does this per MKCOL,
 * PUT, MOVE and DELETE. Rejects on an aborted/errored response or when the body exceeds [limit] (then destroyed).
 */
async function drain(response, limit = JSON_LIMIT) {
    let bytes = 0;
    for await (const chunk of response) { bytes += chunk.length; if (bytes > limit) { response.destroy(); throw new Error('Remote response exceeds size limit'); } }
    return response;
}
function checked(response, allowed = [200]) {
    if (!allowed.includes(response.statusCode)) {
        response.destroy();
        const error = new Error(`원격 요청 실패 (HTTP ${response.statusCode})`); error.status = response.statusCode; throw error;
    }
    return response;
}
async function gitHash(file, size) {
    const digest = createHash('sha1').update(`blob ${size}\0`);
    for await (const chunk of createReadStream(file)) digest.update(chunk);
    return digest.digest('hex');
}
async function* base64JsonFile(file, fields) {
    yield Buffer.from(JSON.stringify(fields).slice(0, -1) + ',"content":"');
    let carry = Buffer.alloc(0);
    for await (const chunk of createReadStream(file)) {
        const bytes = Buffer.concat([carry, chunk]), end = bytes.length - bytes.length % 3;
        yield Buffer.from(bytes.subarray(0, end).toString('base64')); carry = bytes.subarray(end);
    }
    if (carry.length) yield Buffer.from(carry.toString('base64'));
    yield Buffer.from('"}');
}

function createRemoteTransfers({ secrets, transfers, fetch = request, route = null }) {
    /** The NAS record with the URL of the current route (home/external) — same account and password either way. */
    // One manual operation (list, upload = PUT/verify/MOVE/DELETE, download) resolves the route once and keeps it for every request.
    async function nasConfig() { const c = await secrets.get('nas'); const endpoint = route ? await route.endpointFor(c) : { url: folder(c.url), servername: nasServername(c, folder(c.url)) }; return { ...c, ...endpoint }; } // URL and TLS name from one pinned decision
    let lane = Promise.resolve();
    const exclusive = fn => { const next = lane.then(fn); lane = next.catch(() => {}); return next; };
    async function config(kind) {
        const saved = await secrets.get(kind);
        return kind === 'nas' ? { url: saved.url ?? '', username: saved.username ?? '', hasPassword: !!saved.password, homeUrl: saved.homeUrl ?? '', homeSsids: Array.isArray(saved.homeSsids) ? saved.homeSsids : [], certHost: saved.certHost ?? '', homeCertHost: saved.homeCertHost ?? '' }
            : { repository: saved.repository ?? '', branch: saved.branch ?? '', hasToken: !!saved.token };
    }
    async function configure(kind, input) {
        if (Buffer.byteLength(JSON.stringify(input)) > 65536) throw new Error('전송 설정이 너무 큽니다.');
        if (input.clear) { await secrets.set(kind, null); return config(kind); }
        const previous = await secrets.get(kind);
        if (kind === 'nas') {
            const url = folder(input.url), username = input.username?.trim();
            if (!username || /[:\x00-\x1f\x7f-\x9f]/.test(username)) throw new Error('NAS 계정을 확인해 주세요.');
            const password = input.password || (previous.url === url && previous.username === username ? previous.password : '');
            if (!password || typeof password !== 'string') throw new Error('주소나 계정을 바꾸면 비밀번호를 입력해 주세요.');
            // Optional home profile: internal HTTPS URL (same folder/account on the LAN) and the Wi-Fi names where it applies.
            const homeUrl = input.homeUrl ? folder(input.homeUrl) : '';
            const homeSsids = input.homeSsids !== undefined ? validateHomeSsids(input.homeSsids) : (Array.isArray(previous.homeSsids) ? previous.homeSsids : []);
            // Optional certificate names: when a URL is written as a literal IP, TLS still validates (and sends SNI/Host) against this name. Kept when omitted.
            const certHostName = input.certHost !== undefined ? certHost(input.certHost) : (previous.certHost ?? ''), homeCertHostName = input.homeCertHost !== undefined ? certHost(input.homeCertHost) : (previous.homeCertHost ?? '');
            await secrets.set(kind, { url, username, password, homeUrl, homeSsids, certHost: certHostName, homeCertHost: homeUrl ? homeCertHostName : '' });
            route?.invalidate?.();
        } else {
            if (!/^[\w.-]+\/[\w.-]+$/.test(input.repository ?? '') || input.repository.toLowerCase() === 'minchopie/risubard') throw new Error('개인 대화용 비공개 저장소를 입력해 주세요.');
            const branch = String(input.branch || '');
            if (/[\x00-\x1f\x7f]/.test(branch)) throw new Error('Invalid branch');
            const token = input.token || (previous.repository === input.repository ? previous.token : '');
            if (!token || typeof token !== 'string' || /[\s\x00-\x1f\x7f]/.test(token)) throw new Error('GitHub 토큰을 입력해 주세요.');
            const saved = { repository: input.repository, branch, token };
            await repoInfo(saved); await secrets.set(kind, saved);
        }
        return config(kind);
    }
    async function nasRequest(c, method, suffix = '', extra = {}, body) {
        return fetch(c.url + (suffix ? encodeURIComponent(suffix) : ''), { method, body, servername: c.servername || '', headers: {
            Authorization: 'Basic ' + Buffer.from(`${c.username}:${c.password}`).toString('base64'), ...extra,
        } });
    }
    async function nasList() {
        const c = await nasConfig();
        const xml = '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:getcontentlength/><d:getlastmodified/><d:getetag/><d:resourcetype/></d:prop></d:propfind>';
        const response = checked(await nasRequest(c, 'PROPFIND', '', { Depth: '1', 'Content-Type': 'application/xml', 'Content-Length': String(Buffer.byteLength(xml)) }, Readable.from([xml])), [207]);
        return { url: c.url, xml: (await bounded(response)).toString('utf8') };
    }
    async function nasUpload(id) {
        const c = await nasConfig();
        const file = await transfers.file(id), stat = await fs.stat(file);
        const filename = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.risuplay`, temporary = filename + '.part';
        try {
            await drain(checked(await nasRequest(c, 'PUT', temporary, { 'If-None-Match': '*', 'Content-Length': String(stat.size), 'Content-Type': 'application/octet-stream' }, createReadStream(file)), [200, 201, 204]));
            const verification = checked(await nasRequest(c, 'GET', temporary));
            const remote = createHash('sha256'), local = createHash('sha256'); let count = 0;
            for await (const bytes of verification) { count += bytes.length; if (count > stat.size) throw new Error('NAS uploaded size mismatch'); remote.update(bytes); }
            for await (const bytes of createReadStream(file)) local.update(bytes);
            if (count !== stat.size || remote.digest('hex') !== local.digest('hex')) throw new Error('NAS uploaded hash mismatch');
            await drain(checked(await nasRequest(c, 'MOVE', temporary, { Destination: c.url + encodeURIComponent(filename), Overwrite: 'F' }), [200, 201, 204]));
            return { name: filename, bytes: stat.size, state: 'delivered' };
        } catch (error) {
            try { await drain(await nasRequest(c, 'DELETE', temporary)); } catch {}
            throw error;
        }
    }
    async function nasDownload(input) {
        const c = await nasConfig();
        const filename = name(input.name), headers = {};
        if (input.etag && !input.etag.startsWith('W/')) {
            if (!/^[\x20-\x7e]+$/.test(input.etag)) throw new Error('Invalid ETag');
            headers['If-Match'] = input.etag;
        }
        return transfers.ingest(checked(await nasRequest(c, 'GET', filename, headers)), { name: filename, applyRequested: input.applyRequested === true });
    }
    const api = (c, path, options = {}) => fetch(`https://api.github.com/repos/${c.repository}/${path}`, { ...options, headers: {
        Authorization: `Bearer ${c.token}`, 'User-Agent': 'RisuBard', Accept: 'application/vnd.github.object+json', 'X-GitHub-Api-Version': '2026-03-10', ...options.headers,
    } });
    const json = async response => JSON.parse((await bounded(checked(response))).toString('utf8'));
    async function repoInfo(c) {
        if (!c.repository || !c.token) throw new Error('연결 설정에서 GitHub 비공개 저장소와 토큰을 먼저 저장해 주세요.');
        const info = await json(await api(c, ''));
        if (info.private !== true) throw new Error('개인 대화는 비공개 저장소에만 올릴 수 있어요.');
        return info;
    }
    async function githubList() {
        const c = await secrets.get('github'), repo = await repoInfo(c);
        const commit = await json(await api(c, `commits/${encodeURIComponent(c.branch || repo.default_branch)}`));
        if (!/^[a-f0-9]{40}$/.test(commit.sha)) throw new Error('Invalid repository revision');
        const response = await api(c, `contents/risubard-backups?ref=${commit.sha}`);
        if (response.statusCode === 404) { response.destroy(); return []; }
        const listing = await json(response), entries = Array.isArray(listing) ? listing : listing.entries;
        if (!Array.isArray(entries)) throw new Error('Invalid GitHub listing');
        if (entries.length >= 1000) throw new Error('GitHub 목록 상한에 도달했어요. GitHub 웹사이트의 저장소에서 파일을 내려받아 전송 파일 열기로 가져와 주세요.');
        return entries.filter(row => row.type === 'file' && /^[a-f0-9]{64}\.risuplay$/.test(row.name) && /^[a-f0-9]{40}$/.test(row.sha)
            && Number.isSafeInteger(row.size) && row.size < GITHUB_LIMIT).map(row => ({ name: row.name, bytes: row.size, sha: row.sha, commit: commit.sha }));
    }
    async function githubUpload(id) {
        const c = await secrets.get('github'), repo = await repoInfo(c), branch = c.branch || repo.default_branch;
        const file = await transfers.file(id), stat = await fs.stat(file);
        if (stat.size >= GITHUB_LIMIT) throw new Error('GitHub 묶음은 100,000,000바이트 미만이어야 해요. NAS나 파일 전송을 사용해 주세요.');
        const record = (await transfers.list()).find(record => record.id === id);
        if (!record?.backupKey) throw new Error('보낼 자료를 다시 준비해 주세요.');
        const path = `contents/risubard-backups/${record.backupKey}.risuplay`;
        const previousResponse = await api(c, `${path}?ref=${encodeURIComponent(branch)}`);
        let previous;
        if (previousResponse.statusCode === 404) previousResponse.destroy(); else previous = await json(previousResponse);
        if (previous && (previous.type !== 'file' || !/^[a-f0-9]{40}$/.test(previous.sha))) throw new Error('Backup target is not a regular file');
        const fields = { message: 'Update RisuBard conversation backup', branch, ...(previous ? { sha: previous.sha } : {}) };
        const bytes = Buffer.byteLength(JSON.stringify(fields).slice(0, -1) + ',"content":""}') + Math.ceil(stat.size / 3) * 4;
        const response = checked(await api(c, path, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'Content-Length': String(bytes) }, body: Readable.from(base64JsonFile(file, fields)) }), [200, 201]);
        const uploaded = JSON.parse((await bounded(response)).toString('utf8'));
        if (!/^[a-f0-9]{40}$/.test(uploaded.commit?.sha)) throw new Error('업로드 응답을 확인하지 못했어요. 목록을 새로 고쳐 주세요.');
        const verified = await json(await api(c, `${path}?ref=${uploaded.commit.sha}`));
        if (verified.size !== stat.size || verified.sha !== await gitHash(file, stat.size)) throw new Error('업로드 파일 검증 실패. 이전 Git 이력은 유지됩니다.');
        return { name: `${record.backupKey}.risuplay`, bytes: stat.size, state: 'delivered' };
    }
    async function githubDownload(input) {
        if (!/^[a-f0-9]{64}\.risuplay$/.test(input.name ?? '') || !/^[a-f0-9]{40}$/.test(input.commit ?? '') || !/^[a-f0-9]{40}$/.test(input.sha ?? '')) throw new Error('Invalid GitHub file revision');
        const c = await secrets.get('github'); await repoInfo(c);
        const path = `contents/risubard-backups/${input.name}?ref=${input.commit}`, info = await json(await api(c, path));
        if (info.type !== 'file' || info.sha !== input.sha || !Number.isSafeInteger(info.size) || info.size >= GITHUB_LIMIT || info.size < 0) throw new Error('GitHub file changed or exceeds size limit');
        const stream = checked(await api(c, path, { headers: { Accept: 'application/vnd.github.raw+json' } }));
        const hash = createHash('sha1').update(`blob ${info.size}\0`); let bytes = 0;
        const verify = new Transform({ transform(chunk, _encoding, done) {
            bytes += chunk.length; hash.update(chunk);
            done(bytes > info.size ? new Error('GitHub download exceeds declared size') : null, chunk);
        }, flush(done) { done(bytes !== info.size || hash.digest('hex') !== input.sha ? new Error('GitHub download hash mismatch') : null); } });
        stream.on('error', error => verify.destroy(error)); verify.on('close', () => stream.destroy()); stream.pipe(verify);
        return transfers.ingest(verify, { name: input.name, applyRequested: input.applyRequested === true });
    }
    async function legacyList() {
        const c = await secrets.get('github'); await repoInfo(c);
        const response = await api(c, 'contents/chat-uploads?ref=chat-uploads');
        if (response.statusCode === 404) { await drain(response); return []; }
        const result = await json(response), entries = Array.isArray(result) ? result : result.entries;
        if (!Array.isArray(entries) || entries.length >= 1000) throw new Error('기존 백업 목록을 모두 확인할 수 없어요. 저장소에서 확인해 주세요.');
        return entries.filter(row => row.type === 'file' && /^latest-[a-f0-9]{64}\.json$/.test(row.name) && /^[a-f0-9]{40}$/.test(row.sha)
            && Number.isSafeInteger(row.size) && row.size > 0 && row.size <= JSON_LIMIT).map(row => ({ name: row.name, sha: row.sha, bytes: row.size, legacy: true }));
    }
    async function legacyDownload(input, c) {
        if (!/^latest-[a-f0-9]{64}\.json$/.test(input.name ?? '') || !/^[a-f0-9]{40}$/.test(input.sha ?? '')
            || !Number.isSafeInteger(input.bytes) || input.bytes < 1 || input.bytes > JSON_LIMIT) throw new Error('Invalid legacy backup');
        if (!c) { c = await secrets.get('github'); await repoInfo(c); }
        const blob = JSON.parse((await bounded(checked(await api(c, `git/blobs/${input.sha}`)), 12 * 1024 * 1024)).toString('utf8'));
        if (blob.sha !== input.sha || blob.size !== input.bytes || blob.encoding !== 'base64' || typeof blob.content !== 'string') throw new Error('백업 정보가 일치하지 않아요.');
        const bytes = Buffer.from(blob.content, 'base64');
        if (bytes.length !== input.bytes || createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== input.sha) throw new Error('백업 무결성 확인에 실패했어요.');
        legacyDocument(bytes);
        return bytes;
    }
    async function legacyUpload(input) {
        const bytes = Buffer.from(JSON.stringify(await transfers.legacyChat(input))), document = legacyDocument(bytes);
        const character = document.privateMobileChatSync?.characterId, chat = document.data.id;
        if (!character || !chat) throw new Error('대화 고유 ID가 없어요.');
        const c = await secrets.get('github'), repo = await repoInfo(c), branch = 'chat-uploads';
        const ref = await api(c, `git/ref/heads/${branch}`);
        if (ref.statusCode === 404) {
            ref.destroy();
            const source = await json(await api(c, `git/ref/heads/${encodeURIComponent(repo.default_branch)}`));
            if (!/^[a-f0-9]{40}$/.test(source.object?.sha ?? '')) throw new Error('Invalid branch revision');
            const created = await api(c, 'git/refs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: Readable.from([JSON.stringify({ ref: `refs/heads/${branch}`, sha: source.object.sha })]) });
            if (created.statusCode === 422) { created.destroy(); checked(await api(c, `git/ref/heads/${branch}`)).destroy(); }
            else checked(created, [201]).destroy();
        } else checked(ref).destroy();
        const filename = 'latest-' + createHash('sha256').update(JSON.stringify([character, chat])).digest('hex') + '.json';
        const path = `contents/chat-uploads/${filename}`, prior = await api(c, `${path}?ref=${branch}`);
        let previous;
        if (prior.statusCode === 404) prior.destroy(); else {
            previous = await json(prior);
            if (previous.type !== 'file' || previous.path !== `chat-uploads/${filename}`) throw new Error('Invalid existing backup');
            const old = legacyDocument(await legacyDownload({ name: filename, sha: previous.sha, bytes: previous.size }, c));
            if (old.data.id !== chat || old.privateMobileChatSync?.characterId !== character) throw new Error('기존 백업의 대화 ID가 일치하지 않아요. 기존 백업은 유지됩니다.');
            if (!input.replaceSha) {
                try { requireContinuation(old.data, document.data); }
                catch (error) { if (input.promptConflict === true) return { conflictSha: previous.sha }; throw error; }
            }
        }
        if (input.replaceSha && input.replaceSha !== previous?.sha) throw new Error('확인하는 동안 GitHub 백업이 변경됐어요. 다시 확인해 주세요.');
        const result = JSON.parse((await bounded(checked(await api(c, path, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
            body: Readable.from([JSON.stringify({ message: 'Save current RisuAI chat', branch, content: bytes.toString('base64'), ...(previous ? { sha: previous.sha } : {}) })]) }), [200, 201]))).toString('utf8'));
        const sha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
        if (result.content?.sha !== sha || result.content?.path !== `chat-uploads/${filename}`) throw new Error('GitHub 저장 결과가 일치하지 않아요. 저장소를 확인해 주세요.');
        await legacyDownload({ name: filename, sha, bytes: bytes.length }, c);
        return { name: filename, bytes: bytes.length, state: 'delivered' };
    }
    async function dispatch(kind, operation, input = {}) {
        if (!['nas', 'github'].includes(kind)) throw new Error('Unknown transfer method');
        if (operation === 'config') return config(kind);
        return exclusive(async () => {
            if (operation === 'reset-credentials') { await secrets.reset(); return config(kind); }
            if (kind === 'github' && operation === 'legacy-list') return legacyList();
            if (kind === 'github' && operation === 'legacy-download') return { name: input.name, document: (await legacyDownload(input)).toString('utf8') };
            if (kind === 'github' && operation === 'legacy-upload') return legacyUpload(input);
            if (operation === 'configure') return configure(kind, input);
            if (operation === 'list') return kind === 'nas' ? nasList() : githubList();
            if (operation === 'upload') return kind === 'nas' ? nasUpload(input.id) : githubUpload(input.id);
            if (operation === 'download') return kind === 'nas' ? nasDownload(input) : githubDownload(input);
            throw new Error('Unknown transfer operation');
        });
    }
    return { dispatch };
}
module.exports = { createRemoteTransfers, request, bounded, drain, validateHomeSsids, certHost, nasServername, GITHUB_LIMIT, JSON_LIMIT, base64JsonFile, folder, gitHash, legacyDocument, requireContinuation };
