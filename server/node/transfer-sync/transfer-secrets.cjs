'use strict';
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const { createCipheriv, createDecipheriv, randomBytes, randomUUID } = require('node:crypto');
const { atomicWriteJson } = require('../file-store.cjs');

function androidProtector(key) {
    const bytes = Buffer.from(key, 'hex');
    if (bytes.length !== 32 || !/^[a-f0-9]{64}$/.test(key)) throw new Error('Invalid device secret key');
    return async (input, decrypt) => {
        if (decrypt) {
            if (input.length < 28) throw new Error('Damaged protected settings');
            const cipher = createDecipheriv('aes-256-gcm', bytes, input.subarray(0, 12));
            cipher.setAuthTag(input.subarray(12, 28));
            return Buffer.concat([cipher.update(input.subarray(28)), cipher.final()]);
        }
        const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', bytes, nonce);
        const encrypted = Buffer.concat([cipher.update(input), cipher.final()]);
        return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]);
    };
}
async function dpapi(input, decrypt) {
    // Data travels over stdin/stdout, never command-line arguments or a plaintext temporary file.
    const script = `Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $r=[Security.Cryptography.ProtectedData]::${decrypt ? 'Unprotect' : 'Protect'}($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
    return new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
        let output = '', bytes = 0;
        const timer = setTimeout(() => { child.kill(); reject(new Error('Windows protected storage timed out')); }, 15000);
        child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 256 * 1024) child.kill(); else output += chunk; });
        child.stderr.resume();
        child.on('error', () => { clearTimeout(timer); reject(new Error('Windows protected storage unavailable')); });
        child.on('close', code => { clearTimeout(timer); if (code || bytes > 256 * 1024) reject(new Error('Cannot open protected settings for this Windows account')); else resolve(Buffer.from(output.trim(), 'base64')); });
        child.stdin.on('error', () => {}); child.stdin.end(input.toString('base64'));
    });
}
function createTransferSecrets(dataRoot, protect) {
    const deviceKey = process.env.RISUBARD_TRANSFER_KEY;
    delete process.env.RISUBARD_TRANSFER_KEY;
    protect ??= deviceKey ? androidProtector(deviceKey) : process.platform === 'win32' ? dpapi : async () => { throw new Error('Persistent transfer credentials require Android Keystore or Windows DPAPI'); };
    const file = 'transfer-secrets.dat';
    let lane = Promise.resolve();
    const exclusive = operation => { const next = lane.then(operation); lane = next.catch(() => {}); return next; };
    async function load() {
        let saved;
        try { saved = JSON.parse(await fs.readFile(join(dataRoot, file), 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
        return JSON.parse((await protect(Buffer.from(saved.data, 'base64'), true)).toString('utf8'));
    }
    return {
        reset: () => exclusive(async () => {
            const data = (await protect(Buffer.from('{}'), false)).toString('base64');
            try { await fs.copyFile(join(dataRoot, file), join(dataRoot, `transfer-secrets.recovery-${randomUUID()}.dat`), 1); }
            catch (error) { if (error.code !== 'ENOENT') throw error; }
            atomicWriteJson(dataRoot, file, { version: 1, data });
        }),
        get: name => exclusive(async () => (await load())[name] ?? {}),
        set: (name, value) => exclusive(async () => {
            const all = await load(); if (value === null) delete all[name]; else all[name] = value;
            const data = (await protect(Buffer.from(JSON.stringify(all)), false)).toString('base64');
            atomicWriteJson(dataRoot, file, { version: 1, data });
        }),
    };
}
module.exports = { createTransferSecrets, androidProtector, dpapi };
