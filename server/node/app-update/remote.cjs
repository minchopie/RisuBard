'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Transform, Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { randomUUID } = require('node:crypto');
const { request, bounded, drain } = require('../transfer-sync/transfer-remote.cjs');
const { createTransferSecrets } = require('../transfer-sync/transfer-secrets.cjs');
const { createNasRoute, detectWindows } = require('../transfer-sync/nas-route.cjs');
const core = require('./core.cjs');

const NAMESPACE = '.risubard-app-updates/';
async function connect(dataRoot, { signal, network, fetch = request, secrets: suppliedSecrets } = {}) {
    const key = process.env.RISUBARD_TRANSFER_KEY;
    const secrets = suppliedSecrets || createTransferSecrets(dataRoot);
    // The normal server still needs the install key after this read-only bootstrap check.
    if (key) process.env.RISUBARD_TRANSFER_KEY = key;
    const config = await secrets.get('nas');
    signal?.throwIfAborted();
    if (!config.url || !config.username || !config.password) return null;
    const route = createNasRoute({ secrets, detect: process.platform === 'win32' ? detectWindows : null });
    if (network) route.report(network);
    const endpoint = await route.endpointFor(config);
    signal?.throwIfAborted();
    const base = endpoint.url + NAMESPACE;
    async function call(name, method = 'GET', body, headers = {}) {
        signal?.throwIfAborted();
        if (!/^[a-zA-Z0-9._-]*$/.test(name)) throw new Error('Invalid app release filename');
        return fetch(base + name, { method, body, signal, servername: endpoint.servername, headers: {
            Authorization: 'Basic ' + Buffer.from(`${config.username}:${config.password}`).toString('base64'), ...headers,
        } });
    }
    function checked(response, allowed = [200]) {
        if (!allowed.includes(response.statusCode)) { response.destroy(); throw new Error(`App update NAS HTTP ${response.statusCode}`); }
        return response;
    }
    return {
        async latest() {
            const response = await call('latest.json');
            if (response.statusCode === 404) { await drain(response); return null; }
            return core.validateRelease(JSON.parse((await bounded(checked(response), 64 * 1024)).toString('utf8')));
        },
        async download(release, destination) {
            const response = checked(await call(release.file));
            let bytes = 0;
            const counter = new Transform({ transform(chunk, _encoding, next) {
                bytes += chunk.length;
                next(bytes > release.bytes ? new Error('App patch exceeds declared size') : null, chunk);
            } });
            await pipeline(response, counter, fs.createWriteStream(destination, { flags: 'wx' }), { signal });
            if (bytes !== release.bytes || await core.hashFile(destination) !== release.sha256) throw new Error('Incomplete app patch download');
        },
        async publish(release, archive) {
            core.validateRelease(release);
            if (fs.statSync(archive).size !== release.bytes || await core.hashFile(archive) !== release.sha256) throw new Error('Publish artifact mismatch');
            await drain(checked(await call('', 'MKCOL'), [201, 405]));
            const verify = path.join(path.dirname(archive), `verify-${randomUUID()}.zip`);
            const stagedName = `upload-${randomUUID()}.part`;
            try {
                await drain(checked(await call(stagedName, 'PUT', fs.createReadStream(archive), { 'Content-Length': String(release.bytes) }), [201, 204]));
                await this.download({ ...release, file: stagedName }, verify);
                const moved = await call(stagedName, 'MOVE', undefined, { Destination: base + release.file, Overwrite: 'F' });
                if (moved.statusCode === 412) {
                    await drain(moved); fs.rmSync(verify, { force: true });
                    await this.download(release, verify);
                } else await drain(checked(moved, [201, 204]));
            } finally {
                fs.rmSync(verify, { force: true });
                try { await drain(checked(await call(stagedName, 'DELETE'), [200, 204, 404])); } catch { /* an interrupted temporary upload is not a published release */ }
            }
            const current = await this.latest();
            if (current && (core.newer(current.version, release.version) || current.version === release.version && current.sha256 !== release.sha256)) throw new Error('A newer or different app release is already published');
            const temp = `latest-${randomUUID()}.json`;
            const data = Buffer.from(JSON.stringify(release));
            await drain(checked(await call(temp, 'PUT', Readable.from([data]), { 'Content-Length': String(data.length) }), [201, 204]));
            await drain(checked(await call(temp, 'MOVE', undefined, { Destination: base + 'latest.json', Overwrite: 'T' }), [201, 204]));
            const saved = await this.latest();
            if (saved.sha256 !== release.sha256) throw new Error('NAS app release pointer verification failed');
        },
    };
}
module.exports = { connect, NAMESPACE };
