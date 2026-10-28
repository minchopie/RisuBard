#!/usr/bin/env node
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const tempFamily = /^risubard-(?:stack-verify|stack-generate|graph|inquiry|runtime|shutdown|apk)-.+$/;
const runtimeFamily = /^android-runtime-.+$/;
const sdkFamily = /^risubard-(?:buildtools|module-sdk)-/;
const privateName = name => name.endsWith('.private');
export const defaultKeepFile = join(here, 'workdir-keep.json');

// Report paths are retained even when they point inside a workdir, or use Windows separators on another OS.
export function readKeepNames({ keepFile = defaultKeepFile, outputRoots = [resolve(repo, '../../output'), join(repo, 'output')] } = {}) {
    const names = new Map();
    const add = (value, reason) => {
        for (const part of value.split(/[\\/]/)) {
            if (tempFamily.test(part) || runtimeFamily.test(part) || sdkFamily.test(part)) names.set(part.toLowerCase(), reason);
        }
    };
    const keep = JSON.parse(readFileSync(keepFile, 'utf8'));
    if (!Array.isArray(keep) || keep.some(value => typeof value !== 'string' || !value.trim())) throw new Error('Invalid workdir keep-list');
    for (const value of keep) add(value, 'keep-list');
    const values = value => {
        if (typeof value === 'string') add(value, 'report-reference');
        else if (value && typeof value === 'object') for (const child of Object.values(value)) values(child);
    };
    const walk = path => {
        for (const item of readdirSync(path, { withFileTypes: true })) {
            const child = join(path, item.name);
            if (item.isSymbolicLink()) continue;
            if (item.isDirectory() && !['node_modules', '.git', 'dist', 'assets'].includes(item.name)) walk(child);
            else if (item.isFile() && ['report.json', 'build-inputs.json'].includes(item.name)) values(JSON.parse(readFileSync(child, 'utf8').replace(/^\uFEFF/, '')));
        }
    };
    for (const root of outputRoots) if (existsSync(root) && !lstatSync(root).isSymbolicLink()) walk(root);
    for (const value of keep) add(value, 'keep-list');
    return names;
}

// Windows needs native reparse attributes and deny-delete handle checks, which Node's fs API does not expose.
export function removeWorkdir(path, { apply = false } = {}) {
    path = resolve(path);
    if (process.platform === 'win32') {
        const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'workdir-tree.ps1'), '-Root', path, ...(apply ? ['-Apply'] : [])], { encoding: 'utf8', windowsHide: true, maxBuffer: 4 << 20 });
        if (result.error || result.status !== 0) return { path, status: 'skipped', reason: 'scan-failed', detail: result.error?.message ?? result.stderr, bytes: 0, removedBytes: 0 };
        try { return JSON.parse(result.stdout.replace(/^\uFEFF/, '')); }
        catch (error) { return { path, status: 'skipped', reason: 'scan-failed', detail: error.message, bytes: 0, removedBytes: 0 }; }
    }
    const result = { path, status: 'skipped', bytes: 0, removedBytes: 0 };
    const entries = [];
    const walk = path => {
        const stat = lstatSync(path);
        entries.push({ path, stat });
        if (stat.isSymbolicLink()) return;
        if (stat.isDirectory()) for (const name of readdirSync(path)) walk(join(path, name));
        else result.bytes += stat.size;
    };
    try {
        if (lstatSync(path).isSymbolicLink()) return { ...result, reason: 'reparse' };
        if (!lstatSync(path).isDirectory()) return { ...result, reason: 'not-directory' };
        walk(path);
        if (apply) for (const entry of entries.reverse()) {
            for (let parent = dirname(entry.path); parent !== dirname(path); parent = dirname(parent)) {
                if (lstatSync(parent).isSymbolicLink()) throw new Error(`reparse-parent: ${parent}`);
            }
            if (entry.stat.isDirectory()) rmdirSync(entry.path);
            else { unlinkSync(entry.path); if (!entry.stat.isSymbolicLink()) result.removedBytes += entry.stat.size; }
        }
        result.status = apply ? 'removed' : 'would-remove';
    } catch (error) { result.reason = error.code === 'EBUSY' ? 'locked' : 'removal-or-scan-failed'; result.detail = error.message; }
    return result;
}

export function finishWorkdir(work, { failed = false, keepWorkdir = false, keepNames = readKeepNames({ outputRoots: [] }), log = console.error } = {}) {
    const reason = failed ? 'failed' : keepWorkdir || process.env.RISUBARD_KEEP_WORKDIR === '1' ? 'requested' : keepNames.get(basename(work).toLowerCase());
    if (reason) { log(`[workdir] kept (${reason}): ${work}`); return; }
    const result = removeWorkdir(work, { apply: true });
    if (result.status !== 'removed') log(`[workdir] kept (${result.reason}): ${work}; ${result.detail ?? ''}`);
}

export function cleanupWorkdirs({ apply = false, maxAgeHours = 168, now = Date.now(),
    tempRoot = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Temp') : tmpdir(),
    runtimeRoot = join(repo, 'tmp'), sdkPath = join(homedir(), '.codex/risubard-sdk'),
    keepNames = readKeepNames() } = {}) {
    if (!Number.isFinite(maxAgeHours) || maxAgeHours < 0) throw new Error('--max-age-hours must be a nonnegative number');
    const results = [];
    const inspect = (path, inScope) => {
        try {
            const stat = lstatSync(path), name = basename(path);
            const kept = keepNames.get(name.toLowerCase());
            const reason = stat.isSymbolicLink() ? 'reparse' : !inScope || privateName(name) ? 'out-of-scope' : kept ? kept
                : !stat.isDirectory() ? 'not-directory' : now - Math.max(stat.birthtimeMs, stat.mtimeMs) < maxAgeHours * 3600_000 ? 'too-young' : null;
            results.push(reason ? { path, status: 'skipped', reason, bytes: 0, removedBytes: 0 } : removeWorkdir(path, { apply }));
        } catch (error) { results.push({ path, status: 'skipped', reason: 'inaccessible', detail: error.message, bytes: 0, removedBytes: 0 }); }
    };
    for (const [root, family] of [[tempRoot, tempFamily], [runtimeRoot, runtimeFamily]]) {
        if (!existsSync(root)) continue;
        if (lstatSync(root).isSymbolicLink()) { results.push({ path: root, status: 'skipped', reason: 'reparse', bytes: 0, removedBytes: 0 }); continue; }
        for (const name of readdirSync(root).sort()) if (family.test(name) || (root === tempRoot && sdkFamily.test(name))) inspect(join(root, name), family.test(name));
    }
    if (sdkPath && existsSync(sdkPath)) inspect(sdkPath, false);
    const candidates = results.filter(x => x.status !== 'skipped');
    const skipped = results.filter(x => x.status === 'skipped');
    return { mode: apply ? 'apply' : 'dry-run', maxAgeHours, count: candidates.length,
        bytes: candidates.reduce((sum, x) => sum + x.bytes, 0), removedBytes: results.reduce((sum, x) => sum + x.removedBytes, 0),
        skipped: skipped.length, reasons: skipped.reduce((counts, x) => { counts[x.reason] = (counts[x.reason] ?? 0) + 1; return counts; }, {}), results };
}

export function parseArgs(args) {
    const options = { apply: false, maxAgeHours: 168 };
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--apply') options.apply = true;
        else if (args[i] === '--dry-run') continue;
        else if (args[i] === '--max-age-hours') {
            const value = args[++i];
            if (!value?.trim() || !Number.isFinite(Number(value)) || Number(value) < 0) throw new Error('--max-age-hours must be a nonnegative number');
            options.maxAgeHours = Number(value);
        } else throw new Error(`Unknown argument: ${args[i]}`);
    }
    if (args.includes('--dry-run') && options.apply) throw new Error('Use either --dry-run or --apply');
    return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        const report = cleanupWorkdirs(parseArgs(process.argv.slice(2)));
        for (const item of report.results) console.log(`${item.status} ${item.path} ${item.reason ?? ''}${item.detail ? `: ${item.detail}` : ''}`);
        const { results, ...summary } = report;
        console.log('SUMMARY ' + JSON.stringify(summary));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
