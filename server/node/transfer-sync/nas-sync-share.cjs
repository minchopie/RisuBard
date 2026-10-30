'use strict';
/**
 * One-time workspace/vault sharing over the already-trusted transfer channels (registered Wi-Fi device, authorized USB), with
 * NOTHING secret in any queue, inbox, export directory or backup (Codex review 25 + follow-up):
 *
 *   joining device  --request (its sync public key, not secret)-->  authority device
 *   authority       --grant (vault master sealed to that public key)-->  joining device
 *
 * Both payloads are ZIPs shaped like a play-set container (`manifest.json` + one `records/<sha256>.json`) so the native
 * transports carry them unchanged; `manifest.format` tells them apart from play sets and the Node receiver routes them to the
 * sync service only from the native inbox, whose `trustedDevice` provenance is written by the transport, never by the bytes.
 * The grant is AES-256-GCM under an X25519 ECDH key agreement (ephemeral sender key × receiver's sync device key); the
 * receiver's private key lives in its device-protected sync secrets store (Android Keystore-wrapped / Windows DPAPI). A grant
 * left in a native inbox after a crash is ciphertext for one device only. No code, PIN or extra UI step is involved.
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { join } = require('node:path');
const { createHash, randomBytes, generateKeyPairSync, createPublicKey, createPrivateKey, diffieHellman, hkdfSync, createCipheriv, createDecipheriv } = require('node:crypto');
const yauzl = require('yauzl');
const { ZipFile } = require('yazl');
const { atomicWriteJson } = require('../file-store.cjs');
const { canonical } = require('../../../shared/play-set/protocol.ts');

const REQUEST = 'risubard-nas-sync-request', GRANT = 'risubard-nas-sync-grant';
const ENTRY_LIMIT = 16 * 1024, ENTRIES = 2;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const b64 = (value, length) => { const out = Buffer.from(typeof value === 'string' ? value : '', 'base64'); if (out.length !== length) throw new Error('Damaged sync share field'); return out; };
// X25519 raw public key <-> SPKI DER (RFC 8410 prefix).
const X25519_SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex');
const rawPublic = key => key.export({ type: 'spki', format: 'der' }).subarray(X25519_SPKI_PREFIX.length);
const publicFromRaw = raw => createPublicKey({ key: Buffer.concat([X25519_SPKI_PREFIX, raw]), type: 'spki', format: 'der' });

/** This device's sync key pair, private half protected by the platform protector in the no-backup secrets directory. */
function deviceKeyStore(secretsDir, protect) {
    const file = 'sync-device-key.dat';
    let lane = Promise.resolve();
    const exclusive = op => { const next = lane.then(op); lane = next.catch(() => {}); return next; };
    async function read() {
        try { const saved = JSON.parse(await fsp.readFile(join(secretsDir, file), 'utf8')); return (await protect(Buffer.from(saved.data, 'base64'), true)); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
    return {
        load: () => exclusive(async () => {
            let der = await read();
            if (!der) { der = generateKeyPairSync('x25519').privateKey.export({ type: 'pkcs8', format: 'der' }); atomicWriteJson(secretsDir, file, { version: 1, data: (await protect(der, false)).toString('base64') }); }
            const privateKey = createPrivateKey({ key: der, type: 'pkcs8', format: 'der' }), publicKey = createPublicKey(privateKey);
            const raw = rawPublic(publicKey);
            return { privateKey, publicRaw: raw, keyId: sha256(raw).slice(0, 16) };
        }),
    };
}

async function writeContainer(path, manifest, record) {
    manifest.record = `records/${sha256(record)}.json`;
    const zip = new ZipFile();
    zip.addBuffer(Buffer.from(canonical(manifest)), 'manifest.json', { compress: false });
    zip.addBuffer(record, manifest.record, { compress: false });
    zip.end();
    await new Promise((resolve, reject) => { const out = fs.createWriteStream(path, { flags: 'wx', mode: 0o600 }); out.on('error', reject); out.on('close', resolve); zip.outputStream.on('error', reject); zip.outputStream.pipe(out); });
    return manifest;
}
/** Request: the joining device's public key (not secret) addressed to any authority of the workspace. */
function writeRequestArchive(path, { workspaceId, device, publicRaw, keyId }) {
    for (const v of [workspaceId, device, keyId]) if (typeof v !== 'string' || !identity.test(v)) throw new Error('Invalid share identity');
    return writeContainer(path, { format: REQUEST, version: 1, workspaceId, device, keyId, createdAt: Date.now() }, Buffer.from(canonical({ publicKey: Buffer.from(publicRaw).toString('base64') })));
}
const grantAad = m => Buffer.from(canonical({ v: 1, workspaceId: m.workspaceId, epoch: m.epoch, device: m.device, recipient: m.recipient, recipientKeyId: m.recipientKeyId }));
/** Grant: the vault master sealed for exactly one recipient key. */
function writeGrantArchive(path, { workspaceId, epoch, device, recipient, recipientKeyId, recipientPublicRaw, master }) {
    if (!Buffer.isBuffer(master) || master.length !== 32) throw new Error('Vault master must be 32 bytes');
    for (const v of [workspaceId, epoch, device, recipient, recipientKeyId]) if (typeof v !== 'string' || !identity.test(v)) throw new Error('Invalid share identity');
    const recipientKey = publicFromRaw(b64(Buffer.from(recipientPublicRaw).toString('base64'), 32));
    if (sha256(recipientPublicRaw).slice(0, 16) !== recipientKeyId) throw new Error('Recipient key id mismatch');
    const ephemeral = generateKeyPairSync('x25519'), ephemeralRaw = rawPublic(ephemeral.publicKey);
    const shared = diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientKey });
    const nonce = randomBytes(12);
    const manifest = { format: GRANT, version: 1, workspaceId, epoch, device, recipient, recipientKeyId, ephemeral: ephemeralRaw.toString('base64'), nonce: nonce.toString('base64'), createdAt: Date.now() };
    const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeralRaw, recipientPublicRaw]), 'risubard-sync-grant v1', 32));
    const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(grantAad(manifest));
    const sealed = Buffer.concat([cipher.update(master), cipher.final()]);
    return writeContainer(path, manifest, Buffer.from(canonical({ sealed: sealed.toString('base64'), tag: cipher.getAuthTag().toString('base64') })));
}
/** Opens a grant with this device's private key; a grant for another key or a tampered one fails authentication. */
function openGrant({ manifest, record }, { privateKey, publicRaw }) {
    const ephemeralRaw = b64(manifest.ephemeral, 32), nonce = b64(manifest.nonce, 12);
    const shared = diffieHellman({ privateKey, publicKey: publicFromRaw(ephemeralRaw) });
    const key = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeralRaw, publicRaw]), 'risubard-sync-grant v1', 32));
    const cipher = createDecipheriv('aes-256-gcm', key, nonce); cipher.setAAD(grantAad(manifest)); cipher.setAuthTag(b64(record.tag, 16));
    try { const master = Buffer.concat([cipher.update(b64(record.sealed, 32)), cipher.final()]); if (master.length !== 32) throw new Error('bad length'); return master; }
    catch { throw Object.assign(new Error('This sync key grant was not issued for this device'), { code: 'GRANT_RECIPIENT' }); }
}

/** Reads a share container with hard bounds. null for any ZIP that is not a share (e.g. a play set); throws on a damaged share. */
async function readShareArchive(path) {
    const zip = await yauzl.openPromise(path, { autoClose: false, lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
    try {
        const entries = new Map();
        for await (const entry of zip.eachEntry()) {
            if (entries.size >= ENTRIES || entry.uncompressedSize > ENTRY_LIMIT || entries.has(entry.fileName)) return null;
            entries.set(entry.fileName, entry);
        }
        if (!entries.has('manifest.json') || entries.size !== ENTRIES) return null;
        const read = async name => { const chunks = []; let bytes = 0; for await (const chunk of await zip.openReadStreamPromise(entries.get(name))) { bytes += chunk.length; if (bytes > ENTRY_LIMIT) throw new Error('Sync share entry exceeds its declared size'); chunks.push(chunk); } return Buffer.concat(chunks, bytes); };
        let m; try { m = JSON.parse((await read('manifest.json')).toString('utf8')); } catch { return null; }
        if (!m || typeof m !== 'object' || (m.format !== REQUEST && m.format !== GRANT)) return null;
        const ids = m.format === REQUEST ? [m.workspaceId, m.device, m.keyId] : [m.workspaceId, m.epoch, m.device, m.recipient, m.recipientKeyId];
        if (m.version !== 1 || ids.some(v => typeof v !== 'string' || !identity.test(v)) || typeof m.record !== 'string' || !/^records\/[a-f0-9]{64}\.json$/.test(m.record) || !entries.has(m.record)) throw new Error('Damaged sync share');
        const bytes = await read(m.record);
        if (`records/${sha256(bytes)}.json` !== m.record) throw new Error('Sync share record hash mismatch');
        const record = JSON.parse(bytes.toString('utf8'));
        if (m.format === REQUEST) {
            const publicRaw = b64(record.publicKey, 32);
            if (sha256(publicRaw).slice(0, 16) !== m.keyId) throw new Error('Sync share key id mismatch');
            return { kind: 'request', manifest: { format: REQUEST, version: 1, workspaceId: m.workspaceId, device: m.device, keyId: m.keyId, createdAt: Number(m.createdAt) || 0 }, publicRaw };
        }
        b64(m.ephemeral, 32); b64(m.nonce, 12); b64(record.sealed, 32); b64(record.tag, 16);
        return { kind: 'grant', manifest: { format: GRANT, version: 1, workspaceId: m.workspaceId, epoch: m.epoch, device: m.device, recipient: m.recipient, recipientKeyId: m.recipientKeyId, ephemeral: m.ephemeral, nonce: m.nonce, createdAt: Number(m.createdAt) || 0 }, record: { sealed: record.sealed, tag: record.tag } };
    } finally { await new Promise(resolve => { zip.once('close', resolve); zip.close(); }); }
}
module.exports = { REQUEST, GRANT, deviceKeyStore, writeRequestArchive, writeGrantArchive, openGrant, readShareArchive };
