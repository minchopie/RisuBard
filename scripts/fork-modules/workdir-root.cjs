'use strict';
// Shared root for RisuBard development/build/verification workdirs: C:\_risubard_work on Windows, the OS temp dir elsewhere.
// RISUBARD_WORK_ROOT overrides it (tests isolate with it). A root that cannot be created throws; it never falls back to the old Temp.
// Not for live app IPC (dev-launcher pid, shutdown token) or app data paths.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const WINDOWS_WORK_ROOT = 'C:\\_risubard_work';
const TEMP_KEYS = ['TMP', 'TEMP', 'TMPDIR'];

function workRoot({ env = process.env, platform = process.platform, fallback = os.tmpdir(), mkdir = fs.mkdirSync } = {}) {
    const resolve = platform === 'win32' ? path.win32.resolve : path.resolve;
    const root = resolve(env.RISUBARD_WORK_ROOT || (platform === 'win32' ? WINDOWS_WORK_ROOT : fallback));
    mkdir(root, { recursive: true });
    return root;
}

const sameDir = (a, b, platform) => {
    const real = p => { try { return fs.realpathSync.native(p); } catch { return p; } };
    const [x, y] = [a, b].map(p => (platform === 'win32' ? path.win32.resolve : path.resolve)(real(p)));
    return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

// Env for QA child processes: TMP/TEMP/TMPDIR in <work root>\tmp, so test scratch stays apart from named workdirs. Returns a copy;
// `base` is never mutated. A temp dir that was set on purpose (anything but the default user Temp) is kept as given.
function tempEnv(base = process.env, { platform = process.platform, mkdir = fs.mkdirSync } = {}) {
    if (platform !== 'win32' && !base.RISUBARD_WORK_ROOT) return { ...base };
    const current = platform === 'win32' ? base.TEMP || base.TMP : base.TMPDIR;
    const defaultTemp = platform === 'win32' && base.LOCALAPPDATA ? path.win32.join(base.LOCALAPPDATA, 'Temp') : platform === 'win32' ? os.tmpdir() : '/tmp';
    // LOCALAPPDATA can be isolated while TEMP still inherits the real user Temp; that is a default too.
    const defaults = platform === 'win32' && base.USERPROFILE ? [defaultTemp, path.win32.join(base.USERPROFILE, 'AppData', 'Local', 'Temp')] : [defaultTemp];
    if (current && !defaults.some(dir => sameDir(current, dir, platform))) return { ...base };
    const dir = (platform === 'win32' ? path.win32 : path).join(workRoot({ env: base, platform, mkdir }), 'tmp');
    mkdir(dir, { recursive: true });
    return { ...base, ...Object.fromEntries(TEMP_KEYS.map(key => [key, dir])) };
}

// Process-scoped: for a test runner's own config, so its workers inherit the temp dir. Never touches the system/user TEMP setting.
function applyProcessTemp() {
    const next = tempEnv(process.env);
    for (const key of TEMP_KEYS) if (next[key] !== undefined) process.env[key] = next[key];
}

module.exports = { WINDOWS_WORK_ROOT, workRoot, tempEnv, applyProcessTemp };
