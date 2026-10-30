'use strict';
// Stable loader: native/dependency/loader changes are delivered by a full APK or portable update.
const fs = require('node:fs');
const path = require('node:path');
const core = require('./core.cjs');
let entered = false, ownedRoot = null, root = null;

function canTry(appRoot, release) {
    const file = path.join(core.stateRoot(appRoot), 'status.json');
    const last = fs.existsSync(file) ? core.readJson(file) : {};
    if (last.failedHash !== release.sha256) return true;
    if (last.attempts >= 2) return false;
    if (last.state === 'rolled-back') {
        core.status(appRoot, { ...last, state: 'retry-next-launch' });
        return false;
    }
    return true;
}
async function check(appRoot, dataRoot) {
    if (core.rollback(appRoot)) return;
    const runtime = core.readJson(path.join(appRoot, 'server/node/app-update/runtime.json'));
    const current = core.readJson(path.join(appRoot, 'package.json')).version;
    const cache = core.stateRoot(appRoot), readyFile = path.join(cache, 'ready.json');
    if (fs.existsSync(cache)) for (const file of fs.readdirSync(cache)) {
        if (/^download-[a-f0-9-]{36}\.part$/.test(file)) {
            try { fs.rmSync(path.join(cache, file)); } catch { /* a disposable interrupted download */ }
        }
    }
    const cachedArchive = release => path.join(cache, `ready-${release.sha256}.zip`);
    async function install(release) {
        const staged = await core.stage(appRoot, cachedArchive(release), release);
        core.apply(appRoot, staged);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
        if (fs.existsSync(readyFile)) {
            let cached;
            try { cached = core.validateRelease(core.readJson(readyFile)); }
            catch { fs.rmSync(readyFile, { force: true }); }
            if (cached && core.newer(cached.version, current) && cached.runtime === runtime.fingerprint && fs.existsSync(cachedArchive(cached))) {
                if (canTry(appRoot, cached)) {
                    try { await install(cached); return; }
                    catch {
                        if (['applying', 'awaiting-start'].includes(core.journal(appRoot)?.phase)) { core.rollback(appRoot); return; }
                    }
                } else if (core.readJson(path.join(cache, 'status.json')).attempts < 2) {
                    return; // Start the previous code once before retrying a failed patch.
                }
                fs.rmSync(readyFile, { force: true });
                fs.rmSync(cachedArchive(cached), { force: true });
            }
        }
        let network;
        try { network = JSON.parse(process.env.RISUBARD_START_NETWORK || 'null'); } catch {}
        delete process.env.RISUBARD_START_NETWORK;
        controller.signal.throwIfAborted();
        // Bound credential and route detection too; their existing helpers can outlive the network budget.
        const discovery = (async () => {
            const remote = await require('./remote.cjs').connect(dataRoot, { signal: controller.signal, network });
            return { remote, release: remote ? await remote.latest() : null };
        })();
        const { remote, release } = await Promise.race([discovery, new Promise((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
        })]);
        controller.signal.throwIfAborted();
        if (!release || !core.newer(release.version, current)) return;
        if (release.runtime !== runtime.fingerprint) {
            core.status(appRoot, { state: 'full-package-required', version: release.version });
            console.log('[App update] Native/runtime update requires the full APK or PC package.');
            return;
        }
        if (!canTry(appRoot, release)) return;
        clearTimeout(timer);
        fs.mkdirSync(cache, { recursive: true });
        const archive = path.join(cache, `download-${require('node:crypto').randomUUID()}.part`);
        const downloaded = (async () => {
            try {
                await remote.download(release, archive);
                fs.renameSync(archive, cachedArchive(release));
                core.saveState(appRoot, 'ready.json', release);
                return true;
            } catch {
                core.status(appRoot, { state: 'kept-installed', reason: 'download-unavailable' });
                return false;
            } finally { fs.rmSync(archive, { force: true }); }
        })();
        // A slow connection may finish while playing; only the NEXT cold start applies that code.
        let foregroundTimer;
        const complete = await Promise.race([downloaded, new Promise(resolve => { foregroundTimer = setTimeout(() => resolve(false), 2000); })]);
        clearTimeout(foregroundTimer);
        if (complete) await install(release);
    } catch (error) {
        core.rollback(appRoot);
        if (!core.journal(appRoot) || core.journal(appRoot).phase !== 'rolled-back') {
            core.status(appRoot, { state: 'kept-installed', reason: error?.name === 'AbortError' ? 'timeout' : 'update-unavailable' });
        }
    } finally { clearTimeout(timer); }
}

function start(entry) {
    if (entered) return false;
    root = path.resolve(path.dirname(entry), '../..');
    if (!fs.existsSync(path.join(__dirname, 'runtime.json')) || process.env.RISUBARD_APP_UPDATE === '0'
        || !(process.env.RISUBARD_EMBEDDED_ANDROID === '1' || process.platform === 'win32' && fs.existsSync(path.join(root, '.portable')))) return false;
    entered = true;
    ownedRoot = require('../data-root.cjs').resolveDataRoot();
    require('../data-root-lock.cjs').acquireDataRootLock(ownedRoot);
    void check(root, ownedRoot).then(() => {
        // No application module has started yet; retain the loader and its held data-root lock only.
        for (const file of Object.keys(require.cache)) {
            if (file.startsWith(root + path.sep) && !file.includes(path.sep + 'node_modules' + path.sep)
                && !file.startsWith(__dirname + path.sep) && file !== require.resolve('../data-root-lock.cjs')) delete require.cache[file];
        }
        require(entry);
    }).catch(error => {
        let restored = false;
        try { restored = core.rollback(root); } catch (recoveryError) { console.error('[App update] Recovery is pending.', recoveryError); }
        console.error(restored ? '[App update] Previous code restored after startup failure.' : '[App update] Startup failed.', error);
        process.exitCode = 1;
        process.exit(1);
    });
    return true;
}
function ownsDataRoot(dataRoot) { return ownedRoot !== null && path.resolve(dataRoot) === path.resolve(ownedRoot); }
function ready() {
    if (entered) try { core.markHealthy(root); }
    catch (error) { console.error('[App update] Startup succeeded; code recovery record is still pending.', error); }
}
module.exports = { start, ownsDataRoot, ready, check };
