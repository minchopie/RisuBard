'use strict';
// App code watch (content-updates module): while the app runs, looks on the NAS for a newer app code patch (the same
// release the app-update loader takes at start) and downloads it in the background into the loader's own cache
// (<app>/.app-updates/ready-<sha256>.zip + ready.json). The loader installs a cached release at the next server start
// without waiting on the network; the client asks "지금 적용/나중에" when the app is idle, and on the Android app
// "지금 적용" restarts the embedded server (native app.restart). Nothing here installs code or touches user data.
// Only where the loader runs (Android embedded runtime, Windows portable package), like app-update/bootstrap.cjs.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const FIRST_CHECK = 90_000;
const INTERVAL = 30 * 60_000;
const DOWNLOAD_LIMIT = 10 * 60_000;
const READY_ARCHIVE = /^ready-[a-f0-9]{64}\.zip$/;

function loaderActive(appRoot, env = process.env, platform = process.platform) {
    return fs.existsSync(path.join(appRoot, 'server/node/app-update/runtime.json')) && env.RISUBARD_APP_UPDATE !== '0'
        && (env.RISUBARD_EMBEDDED_ANDROID === '1' || platform === 'win32' && fs.existsSync(path.join(appRoot, '.portable')));
}

function createAppCodeWatch({ appRoot = path.resolve(__dirname, '../../..'), dataRoot, secrets, route, enabled,
    core = require('../app-update/core.cjs'), connect = (...args) => require('../app-update/remote.cjs').connect(...args) }) {
    const on = enabled ?? loaderActive(appRoot);
    const cache = core.stateRoot(appRoot);
    const runtime = () => core.readJson(path.join(appRoot, 'server/node/app-update/runtime.json')).fingerprint;
    const current = () => core.readJson(path.join(appRoot, 'package.json')).version;
    const archiveOf = release => path.join(cache, `ready-${release.sha256}.zip`);
    let last = { state: on ? 'waiting' : 'off' }, running = null, timer = null;

    // Same retry rules as the loader (bootstrap canTry): a patch that failed twice at start is not taken again; one
    // rolled back just now is skipped by the next start (retried at the one after), so it is not "ready" for a restart.
    function blocked(release) {
        try {
            const s = core.readJson(path.join(cache, 'status.json'));
            if (s.failedHash !== release.sha256) return null;
            if (s.attempts >= 2) return 'failed-before';
            if (s.state === 'rolled-back') return 'retry-next-launch';
        } catch { /* no status yet */ }
        return null;
    }
    function cached() {
        try { return core.validateRelease(core.readJson(path.join(cache, 'ready.json'))); } catch { return null; }
    }
    /** The downloaded release the loader will install at the next start, or null. */
    function ready() {
        try {
            const release = cached();
            if (release && core.newer(release.version, current()) && release.runtime === runtime() && fs.existsSync(archiveOf(release)) && !blocked(release)) return release;
        } catch { /* unreadable app files */ }
        return null;
    }
    function status() {
        const release = on ? ready() : null;
        return { enabled: on, current: on ? current() : null, ready: release ? release.version : null, ...last };
    }
    async function work() {
        const controller = new AbortController();
        const limit = setTimeout(() => controller.abort(), DOWNLOAD_LIMIT);
        let part = null;
        try {
            const network = typeof route?.network === 'function' ? await route.network() : null;
            const remote = await connect(dataRoot, { signal: controller.signal, network, secrets });
            if (!remote) { last = { state: 'no-nas' }; return; }
            const release = await remote.latest();
            if (!release || !core.newer(release.version, current())) { last = { state: 'current' }; return; }
            if (release.runtime !== runtime()) { last = { state: 'full-package-required', version: release.version }; return; }
            const block = blocked(release);
            if (block === 'failed-before') { last = { state: block, version: release.version }; return; }
            const have = cached();
            if (have?.sha256 === release.sha256 && fs.existsSync(archiveOf(release))) { last = { state: block ?? 'ready', version: release.version }; return; }
            last = { state: 'downloading', version: release.version };
            fs.mkdirSync(cache, { recursive: true });
            const started = Date.now();
            part = path.join(cache, `download-${randomUUID()}.part`);
            await remote.download(release, part);
            // Compare, publish and clean up in one tick (no await): the loader's own slow start-up download shares this
            // cache and may have finished meanwhile; a newer cached release is kept and this one is dropped.
            const now = cached();
            if (now && core.newer(now.version, release.version) && fs.existsSync(archiveOf(now))) {
                last = { state: blocked(now) ?? 'ready', version: now.version };
                return;
            }
            fs.renameSync(part, archiveOf(release)); part = null;
            core.saveState(appRoot, 'ready.json', release);
            for (const file of fs.readdirSync(cache)) {
                // Only archives older than this download: one another writer finished meanwhile is left alone.
                if (READY_ARCHIVE.test(file) && file !== path.basename(archiveOf(release))) {
                    const other = path.join(cache, file);
                    try { if (fs.statSync(other).mtimeMs < started) fs.rmSync(other, { force: true }); } catch { /* gone */ }
                }
            }
            last = { state: block ?? 'ready', version: release.version };
        } catch (error) {
            last = { state: 'error', error: error?.name === 'AbortError' ? 'timeout' : String(error?.message ?? error) };
        } finally {
            clearTimeout(limit);
            if (part) fs.rmSync(part, { force: true });
        }
    }
    /** One check at a time; a caller during a check waits for that one. */
    async function check() {
        if (!on) return status();
        running ??= work().finally(() => { running = null; });
        await running;
        return status();
    }
    function start() {
        if (!on || timer) return;
        const tick = () => { void check(); };
        timer = setTimeout(function next() { tick(); timer = setTimeout(next, INTERVAL); timer.unref?.(); }, FIRST_CHECK);
        timer.unref?.();
    }
    function stop() { clearTimeout(timer); timer = null; }
    return { check, status, ready, start, stop };
}

module.exports = { createAppCodeWatch, loaderActive, FIRST_CHECK, INTERVAL };
