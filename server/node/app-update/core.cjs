'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');

const CODE_ROOTS = ['dist/', 'server/node/', 'shared/play-set/', 'src/ts/risubard/', 'src/ts/preset/adapter/', 'packages/risubard-core/'];
const CONTROL = 'server/node/app-update/';
const VERSION = /^\d+\.\d+\.\d+$/;
const HASH = /^[a-f0-9]{64}$/;
function codePath(name) {
    if (typeof name !== 'string' || !name || /[\\:\x00-\x1f]/.test(name) || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('Invalid app patch path');
    if (name.startsWith(CONTROL) || name.startsWith('server/node/ssl/') || ['server/node/data-root-lock.cjs', 'server/node/data-root.cjs'].includes(name) || name.split('/').some(p => p.startsWith('.'))
        || !(name === 'package.json' || CODE_ROOTS.some(prefix => name.startsWith(prefix)))) throw new Error('App patch contains a non-code path');
    return name;
}
function targetPath(root, name) {
    codePath(name);
    const target = path.join(root, name);
    for (let item = target; item !== root; item = path.dirname(item)) {
        if (fs.existsSync(item) && fs.lstatSync(item).isSymbolicLink()) throw new Error('App patch target is a symbolic link');
    }
    return target;
}
function newer(a, b) {
    if (!VERSION.test(a) || !VERSION.test(b)) return false;
    const left = a.split('.').map(Number), right = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i];
    return false;
}
async function hashFile(file) {
    const hash = createHash('sha256');
    for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
    return hash.digest('hex');
}
function validateRelease(value) {
    if (value?.schema !== 1 || !VERSION.test(value.version) || !HASH.test(value.runtime) || !HASH.test(value.sha256)
        || !Number.isSafeInteger(value.bytes) || value.bytes < 1
        || value.file !== `RisuBard-code-${value.version}-${value.sha256}.zip`) throw new Error('Invalid app release manifest');
    return value;
}
const stateRoot = root => path.join(root, '.app-updates');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function journal(root) {
    const file = path.join(stateRoot(root), 'pending.json');
    return fs.existsSync(file) ? readJson(file) : null;
}
function saveState(root, name, value) {
    const directory = stateRoot(root); fs.mkdirSync(directory, { recursive: true });
    const target = path.join(directory, name), temp = target + '.' + randomUUID() + '.tmp';
    const fd = fs.openSync(temp, 'wx');
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { renameFile(temp, target); }
    finally { fs.rmSync(temp, { force: true }); }
}
function syncDirectory(directory) {
    if (process.platform === 'win32') return;
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function renameFile(source, target) {
    const deadline = Date.now() + 1000, wait = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
            try { fs.renameSync(source, target); break; }
            catch (error) {
                if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error?.code) || Date.now() >= deadline) throw error;
                Atomics.wait(wait, 0, 0, 20);
            }
    }
    syncDirectory(path.dirname(target));
}
function copySynced(source, target) {
    const temp = target + '.' + randomUUID() + '.tmp';
    try {
        fs.copyFileSync(source, temp);
        const fd = fs.openSync(temp, 'r+');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        renameFile(temp, target);
    } finally { fs.rmSync(temp, { force: true }); }
}
function writeJournal(root, value) { saveState(root, 'pending.json', value); }
function status(root, value) {
    const file = path.join(stateRoot(root), 'status.json');
    const previous = fs.existsSync(file) ? readJson(file) : {};
    saveState(root, 'status.json', { failedHash: previous.failedHash, attempts: previous.attempts, ...value, at: new Date().toISOString() });
}
function confinedDirectory(root, name) {
    if (typeof name !== 'string' || !/^previous-\d+\.\d+\.\d+-[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid app update directory');
    const directory = path.join(stateRoot(root), name);
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Invalid app update directory');
    return directory;
}
async function stage(root, archive, release, signal) {
    validateRelease(release);
    if (fs.statSync(archive).size !== release.bytes || await hashFile(archive) !== release.sha256) throw new Error('App patch download is incomplete');
    signal?.throwIfAborted();
    fs.mkdirSync(stateRoot(root), { recursive: true });
    const directory = fs.mkdtempSync(path.join(stateRoot(root), 'stage-'));
    const files = [], seen = new Set();
    let total = 0;
    const free = fs.statfsSync(root); const available = Number(free.bavail) * Number(free.bsize);
    const zip = await yauzl.openPromise(archive, { lazyEntries: true });
    try {
        for await (const entry of zip.eachEntry()) {
            signal?.throwIfAborted();
            if (entry.fileName.endsWith('/')) continue;
            const name = codePath(entry.fileName);
            const folded = name.toLowerCase();
            if (seen.has(folded) || (entry.externalFileAttributes >>> 16 & 0xf000) === 0xa000) throw new Error('Duplicate or linked app patch entry');
            seen.add(folded); total += entry.uncompressedSize;
            // Space for extraction, previous code and copying; the current app remains intact on failure.
            if (!Number.isSafeInteger(total) || total * 3 + release.bytes > available) throw Object.assign(new Error('Not enough space for app patch'), { code: 'ENOSPC' });
            const target = targetPath(root, name);
            if (fs.existsSync(target) && !fs.statSync(target).isFile()) throw new Error('App patch target is not a file');
            const staged = path.join(directory, name);
            fs.mkdirSync(path.dirname(staged), { recursive: true });
            await pipeline(await zip.openReadStreamPromise(entry), fs.createWriteStream(staged, { flags: 'wx' }), { signal });
            if (fs.statSync(staged).size !== entry.uncompressedSize) throw new Error('Incomplete app patch entry');
            files.push(name);
        }
        for (const required of ['package.json', 'server/node/server.cjs', 'dist/index.html']) if (!seen.has(required)) throw new Error('Missing app patch entry: ' + required);
        const pkg = readJson(path.join(directory, 'package.json'));
        if (pkg.version !== release.version) throw new Error('App patch version mismatch');
        signal?.throwIfAborted();
        return { directory, files, release };
    } catch (error) { fs.rmSync(directory, { recursive: true, force: true }); throw error; }
    finally { zip.close(); }
}
function rollback(root) {
    const pending = journal(root);
    if (!pending || ['healthy', 'rolled-back', 'superseded'].includes(pending.phase)) return false;
    const version = readJson(path.join(root, 'package.json')).version;
    const runtimeFile = path.join(root, CONTROL, 'runtime.json');
    const marker = path.join(root, '.installed-version');
    if (![pending.baseVersion, pending.version].includes(version)
        || (fs.existsSync(runtimeFile) && readJson(runtimeFile).fingerprint !== pending.runtime)
        || (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === 'v' + pending.version)) {
        writeJournal(root, { ...pending, phase: 'superseded' });
        return false;
    }
    const backup = confinedDirectory(root, pending.backup);
    for (const entry of pending.entries) {
        const target = targetPath(root, entry.name);
        if (entry.existed) {
            const source = path.join(backup, codePath(entry.name));
            if (!fs.existsSync(source)) throw new Error('App patch recovery backup is missing');
            fs.mkdirSync(path.dirname(target), { recursive: true });
            copySynced(source, target);
        } else if (fs.existsSync(target)) fs.unlinkSync(target);
    }
    writeJournal(root, { ...pending, phase: 'rolled-back' });
    const previous = path.join(stateRoot(root), 'status.json');
    const last = fs.existsSync(previous) ? readJson(previous) : {};
    status(root, { state: 'rolled-back', version: pending.version, failedHash: pending.sha256,
        attempts: (last.failedHash === pending.sha256 ? last.attempts || 0 : 0) + 1 });
    return true;
}
function apply(root, staged, checkpoint = () => {}) {
    if (journal(root) && !['healthy', 'rolled-back', 'superseded'].includes(journal(root).phase)) throw new Error('Pending app patch recovery');
    const backupName = `previous-${staged.release.version}-${randomUUID()}`;
    const backup = path.join(stateRoot(root), backupName);
    fs.mkdirSync(backup, { recursive: true });
    const ordered = [...staged.files.filter(name => name !== 'package.json'), 'package.json'];
    const entries = ordered.map(name => {
        const target = targetPath(root, name), existed = fs.existsSync(target);
        if (existed) { const dest = path.join(backup, name); fs.mkdirSync(path.dirname(dest), { recursive: true }); copySynced(target, dest); }
        return { name, existed };
    });
    const pending = { phase: 'applying', baseVersion: readJson(path.join(root, 'package.json')).version,
        version: staged.release.version, runtime: staged.release.runtime, sha256: staged.release.sha256,
        backup: backupName, stage: path.basename(staged.directory), entries };
    writeJournal(root, pending);
    for (const entry of entries) {
        const target = targetPath(root, entry.name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        copySynced(path.join(staged.directory, entry.name), target);
        checkpoint(entry.name);
    }
    writeJournal(root, { ...pending, phase: 'awaiting-start' });
}
function markHealthy(root) {
    const pending = journal(root);
    if (pending?.phase !== 'awaiting-start') return;
    writeJournal(root, { ...pending, phase: 'healthy' });
    status(root, { state: 'updated', version: pending.version, failedHash: null, attempts: 0 });
    if (fs.existsSync(path.join(root, '.portable'))) {
        try { fs.writeFileSync(path.join(root, '.installed-version'), 'v' + pending.version); }
        catch (error) { console.warn('[App update] Code started, but version marker could not be updated:', error?.code); }
    }
    // Only disposable app-code staging and older code backups; never walk user-data directories.
    for (const entry of fs.readdirSync(stateRoot(root), { withFileTypes: true })) {
        if (entry.isFile() && (entry.name === 'ready.json' || /^ready-[a-f0-9]{64}\.zip$/.test(entry.name))) {
            try { fs.rmSync(path.join(stateRoot(root), entry.name)); } catch { /* retry after the next successful patch */ }
        }
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === pending.backup) continue;
        if (/^stage-[a-zA-Z0-9]+$/.test(entry.name) || /^previous-\d+\.\d+\.\d+-[a-f0-9-]{36}$/.test(entry.name)) {
            try { fs.rmSync(path.join(stateRoot(root), entry.name), { recursive: true }); } catch { /* harmless code cache; retry after the next successful patch */ }
        }
    }
}
module.exports = { CODE_ROOTS, codePath, targetPath, newer, hashFile, validateRelease, stateRoot, readJson, status, saveState, stage, apply, rollback, markHealthy, journal };
