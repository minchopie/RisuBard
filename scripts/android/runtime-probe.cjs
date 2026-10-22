'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');

async function main() {
    assert.ok(Number(process.versions.node.split('.')[0]) >= 22);
    const results = { node: process.version, arch: process.arch, platform: process.platform };
    const data = process.argv[2];
    assert.ok(data && path.isAbsolute(data));
    await fs.mkdir(data, { recursive: true });
    const marker = path.join(data, 'probe.json');
    let previous = null;
    try { previous = JSON.parse(await fs.readFile(marker, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous) assert.equal(previous.hash, crypto.createHash('sha256').update(previous.text).digest('hex'));
    const text = '재시작해도 유지되는 RisuBard 표본';
    const record = { text, hash: crypto.createHash('sha256').update(text).digest('hex'), runs: (previous?.runs || 0) + 1 };
    const file = await fs.open(marker + '.tmp', 'w', 0o600);
    try { await file.writeFile(JSON.stringify(record)); await file.sync(); } finally { await file.close(); }
    await fs.rename(marker + '.tmp', marker);
    assert.deepEqual(JSON.parse(await fs.readFile(marker, 'utf8')), record);
    results.persistedRuns = record.runs;
    const key = crypto.randomBytes(32), iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(text), cipher.final()]);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(cipher.getAuthTag());
    assert.equal(Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(), text);
    results.crypto = true;
    const { Packr } = require('msgpackr');
    const packr = new Packr();
    assert.deepEqual(packr.unpack(packr.pack(record)), record);
    results.msgpack = true;
    const vips = await require('wasm-vips')();
    const image = vips.Image.black(8, 8);
    const png = image.writeToBuffer('.png');
    const decoded = vips.Image.newFromBuffer(png);
    assert.equal(decoded.width, 8); assert.equal(decoded.height, 8);
    decoded.delete(); image.delete();
    results.image = true;
    const { LuaFactory } = require('wasmoon');
    const lua = await new LuaFactory(undefined, { _: './risubard' }).createEngine();
    try { assert.equal(await lua.doString('local state = {n=21}; return state.n * 2'), 42); }
    finally { lua.global.close(); }
    results.lua = true;
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: first\n\n');
        setTimeout(() => res.end('data: second\n\n'), 150);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
        const reader = response.body.getReader();
        const first = await reader.read();
        assert.equal(new TextDecoder().decode(first.value), 'data: first\n\n');
        let rest = '';
        while (true) { const next = await reader.read(); if (next.done) break; rest += new TextDecoder().decode(next.value); }
        assert.equal(rest, 'data: second\n\n');
    } finally { await new Promise(resolve => server.close(resolve)); }
    results.streaming = true;
    if (process.argv[3]) {
        const origin = process.argv[3], userData = process.argv[4];
        assert.match(origin, /^http:\/\/127\.0\.0\.1:\d+$/);
        const login = await fetch(origin + '/api/login', { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10000),
            body: JSON.stringify({ password: await fs.readFile(path.join(userData, '__password'), 'utf8') }) });
        assert.equal(login.status, 200);
        const { token } = await login.json();
        const headers = { 'risu-auth': token, 'x-session-id': crypto.randomUUID(), 'x-user-active': '1' };
        const backupPath = await fetch(origin + '/api/backup/server/path', { headers, signal: AbortSignal.timeout(10000) });
        assert.equal(backupPath.status, 200);
        const backupLocation = await backupPath.json();
        if (process.platform === 'android') {
            assert.equal(backupLocation.path, path.join(userData, 'backups'), 'embedded backups must stay outside versioned runtime');
            results.stableBackupDirectory = true;
        }
        const session = await fetch(origin + '/api/session', { method: 'POST', headers, signal: AbortSignal.timeout(10000) });
        assert.equal(session.status, 200);
        const cookie = session.headers.get('set-cookie').split(';')[0];
        if (process.platform === 'android') {
            const before = new Set(await fs.readdir(backupLocation.path));
            const backup = await fetch(origin + '/api/backup/server/save', { method: 'POST', headers, signal: AbortSignal.timeout(30000) });
            assert.equal(backup.status, 200);
            const rows = (await backup.text()).trim().split('\n').map(line => JSON.parse(line));
            const done = rows.at(-1);
            assert.equal(done.type, 'done'); assert.equal(done.ok, true);
            assert.match(done.filename, /^risu-backup-\d+\.bin$/);
            assert.ok(!before.has(done.filename), 'probe must own its newly created backup');
            const created = path.join(backupLocation.path, done.filename);
            assert.equal((await fs.stat(created)).size, done.size);
            assert.ok(done.size > 0);
            results.serverBackupWritten = true;
            await fs.unlink(created);
        }
        const imageId = 'runtime-probe-image';
        const written = await fetch(origin + '/api/write', { method: 'POST', signal: AbortSignal.timeout(10000),
            headers: { ...headers, 'Content-Type': 'application/octet-stream', 'file-path': Buffer.from('inlay/' + imageId).toString('hex') },
            body: JSON.stringify({ type: 'image', ext: 'png', name: 'synthetic runtime probe', data: 'data:image/png;base64,' + Buffer.from(png).toString('base64') }) });
        assert.equal(written.status, 200, 'server inlay write');
        const thumbnail = await fetch(origin + '/api/asset/' + Buffer.from('inlay_thumb/' + imageId).toString('hex'), {
            headers: { Cookie: cookie }, signal: AbortSignal.timeout(10000) });
        assert.equal(thumbnail.status, 200, 'server WASM thumbnail route');
        assert.equal(thumbnail.headers.get('content-type'), 'image/webp');
        const thumb = vips.Image.newFromBuffer(new Uint8Array(await thumbnail.arrayBuffer()));
        assert.equal(thumb.width, 8); assert.equal(thumb.height, 8); thumb.delete();
        results.serverImageRoute = true;
        const scope = { characterId: 'runtime-probe-character', chatId: 'runtime-probe-chat' };
        const api = async (route, body) => {
            const response = await fetch(origin + '/api/risubard/memory/' + route, { method: 'POST',
                headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
            if (!response.ok) throw new Error('memory route ' + route + ': ' + response.status + ' ' + (await response.text()).slice(0,500));
            return response.json();
        };
        await api('wiki/document/save', { ...scope, type: 'location',
            title: '런타임 표본 장소', sourceMessageIds: ['runtime-probe-message'], markdown: '표본 장소는 앱 내부 서버에 저장된다.' });
        const view = await api('view', scope);
        assert.ok(JSON.stringify(view).includes('표본 장소는 앱 내부 서버에 저장된다.'));
        results.serverWikiRoutes = true;
    }
    assert.ok((await fs.statfs(data)).bavail > 0);
    results.diskSpace = true;
    console.log(JSON.stringify(results));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
