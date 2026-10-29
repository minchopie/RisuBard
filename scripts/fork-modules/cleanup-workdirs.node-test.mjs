import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, utimesSync, linkSync, chmodSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { cleanupWorkdirs, readKeepNames, finishWorkdir, parseArgs } from './cleanup-workdirs.mjs';

function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'workdir-cleanup-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const tempRoot = join(root, 'Temp'), runtimeRoot = join(root, 'tmp'), output = join(root, 'output'), keepFile = join(root, 'keep.json');
    for (const path of [tempRoot, runtimeRoot, output]) mkdirSync(path);
    writeFileSync(keepFile, '[]');
    const options = { tempRoot, runtimeRoot, sdkPath: null, keepNames: new Map(), now: Date.now() + 200 * 3600_000 };
    const dir = (name, parent = tempRoot) => {
        const path = join(parent, name); mkdirSync(path); writeFileSync(join(path, 'data'), 'fixture'); return path;
    };
    return { root, options, dir, keepFile, output };
}

test('CLI defaults to dry-run and rejects ambiguous or invalid deletion options', () => {
    assert.deepEqual(parseArgs([]), { apply: false, maxAgeHours: 168 });
    assert.equal(parseArgs(['--dry-run']).apply, false);
    assert.equal(parseArgs(['--apply', '--max-age-hours', '0']).apply, true);
    for (const args of [['--apply', '--dry-run'], ['--max-age-hours'], ['--max-age-hours', '-1'], ['--max-age-hours', 'NaN'], ['--max-age-hours', 'Infinity'], ['--all']]) assert.throws(() => parseArgs(args));
});

test('dry-run removes nothing; age uses both creation and modification time', t => {
    const f = fixture(t), old = f.dir('risubard-graph-old'), young = f.dir('risubard-runtime-young');
    const recent = new Date(f.options.now - 3600_000); utimesSync(young, recent, recent);
    const report = cleanupWorkdirs(f.options);
    assert.equal(report.mode, 'dry-run'); assert.equal(report.count, 1); assert.equal(report.bytes, 7);
    assert.equal(report.reasons['too-young'], 1);
    assert.ok(existsSync(join(old, 'data'))); assert.ok(existsSync(join(young, 'data')));
    const fresh = cleanupWorkdirs({ ...f.options, now: Date.now() });
    assert.equal(fresh.count, 0);
    const applied = cleanupWorkdirs({ ...f.options, apply: true });
    assert.equal(applied.count, 1); assert.equal(applied.removedBytes, 7);
    assert.equal(existsSync(old), false); assert.ok(existsSync(young));
});

test('keep-list paths and nested report/build-input references protect workdirs', t => {
    const f = fixture(t);
    const keep = f.dir('risubard-stack-verify-keep'), reportWork = f.dir('risubard-stack-verify-report'), inputWork = f.dir('risubard-runtime-input');
    writeFileSync(f.keepFile, JSON.stringify([keep]));
    mkdirSync(join(f.output, 'nested'));
    writeFileSync(join(f.output, 'nested/report.json'), JSON.stringify({ work: join(reportWork, 'dist') }));
    writeFileSync(join(f.output, 'build-inputs.json'), JSON.stringify({ build: { input: join(inputWork, 'source') } }));
    const keepNames = readKeepNames({ keepFile: f.keepFile, outputRoots: [f.output] });
    const report = cleanupWorkdirs({ ...f.options, keepNames, apply: true });
    assert.equal(report.count, 0); assert.deepEqual(report.reasons, { 'report-reference': 2, 'keep-list': 1 });
    for (const path of [keep, reportWork, inputWork]) assert.ok(existsSync(join(path, 'data')));
    writeFileSync(join(f.output, 'nested/report.json'), '{broken');
    assert.throws(() => readKeepNames({ keepFile: f.keepFile, outputRoots: [f.output] }));
});

test('allow-list excludes private data, build inputs, installers and recovery families', t => {
    const f = fixture(t);
    const excluded = ['risubard-graph-secret.private', 'risubard-startup-clone-a', 'risubard-recovery-a', 'risubard-pc-update-a', 'risubard-sync-recovery-a', 'risubard-release-a'];
    const runtimeExcluded = ['android-node', 'safety196', 'transfer-build31', 'install-a', 'release-a', 'production-a', 'devices-a', 'device-sync-a'];
    const paths = [...excluded.map(n => f.dir(n)), ...runtimeExcluded.map(n => f.dir(n, f.options.runtimeRoot))];
    const removable = f.dir('android-runtime-old', f.options.runtimeRoot);
    const report = cleanupWorkdirs({ ...f.options, apply: true });
    assert.equal(report.count, 1); assert.equal(existsSync(removable), false);
    for (const path of paths) assert.ok(existsSync(join(path, 'data')));
});

test('top-level junctions are skipped; nested junctions remove only the link entry', t => {
    const f = fixture(t), target = f.dir('target', f.root), nested = f.dir('risubard-inquiry-nested');
    const type = process.platform === 'win32' ? 'junction' : 'dir';
    symlinkSync(target, join(f.options.tempRoot, 'risubard-graph-link'), type);
    symlinkSync(target, join(nested, 'linked-data'), type);
    symlinkSync(target, join(f.options.tempRoot, 'risubard-buildtools-test'), type);
    symlinkSync(target, join(f.options.tempRoot, 'risubard-module-sdk-test'), type);
    const sdkPath = join(f.root, 'risubard-sdk'); symlinkSync(target, sdkPath, type);
    const report = cleanupWorkdirs({ ...f.options, sdkPath, apply: true });
    assert.equal(report.count, 1); assert.equal(report.bytes, 7); assert.equal(report.reasons.reparse, 4);
    assert.equal(existsSync(nested), false);
    assert.equal(readFileSync(join(target, 'data'), 'utf8'), 'fixture');
    assert.ok(existsSync(join(f.options.tempRoot, 'risubard-graph-link')));
});

test('a Windows deny-delete file handle skips the whole directory and processing continues', { skip: process.platform !== 'win32' }, async t => {
    const f = fixture(t), locked = f.dir('risubard-graph-locked'), other = f.dir('risubard-graph-other');
    writeFileSync(join(locked, 'another-file'), 'preserve before lock preflight');
    const code = "$f = [IO.File]::Open($env:WORKDIR_LOCK_FILE, 'Open', 'Read', 'Read'); try { [Console]::WriteLine('ready'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null } finally { $f.Dispose() }";
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')], { env: { ...process.env, WORKDIR_LOCK_FILE: join(locked, 'data') }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const closed = once(child, 'close');
    try {
        const ready = await Promise.race([once(child.stdout, 'data'), closed.then(() => { throw new Error('Lock helper exited before acquiring the handle'); })]);
        assert.match(ready[0].toString(), /ready/);
        const report = cleanupWorkdirs({ ...f.options, apply: true });
        assert.equal(report.reasons.locked, 1); assert.equal(report.count, 1);
        assert.equal(report.results.find(x => x.path === locked).removedBytes, 0);
        assert.ok(existsSync(join(locked, 'data'))); assert.ok(existsSync(join(locked, 'another-file')));
        assert.equal(existsSync(other), false);
    } finally { child.stdin.end('\n'); await closed; }
    assert.equal(cleanupWorkdirs({ ...f.options, apply: true }).count, 1);
});

test('successful workdirs are removed; failure, explicit keep, env and keep-list retain them', t => {
    const f = fixture(t), logs = [], options = { keepNames: new Map(), log: line => logs.push(line) };
    const saved = process.env.RISUBARD_KEEP_WORKDIR;
    try {
        delete process.env.RISUBARD_KEEP_WORKDIR;
        const success = f.dir('risubard-stack-generate-success'); finishWorkdir(success, options); assert.equal(existsSync(success), false);
        for (const [name, extra] of [['failed', { failed: true }], ['explicit', { keepWorkdir: true }], ['listed', { keepNames: new Map([['risubard-stack-generate-listed', 'keep-list']]) }]]) {
            const work = f.dir('risubard-stack-generate-' + name); finishWorkdir(work, { ...options, ...extra }); assert.ok(existsSync(work));
            assert.ok(logs.at(-1).includes(work));
        }
        process.env.RISUBARD_KEEP_WORKDIR = '1';
        const env = f.dir('risubard-stack-generate-env'); finishWorkdir(env, options); assert.ok(existsSync(env));
    } finally { if (saved === undefined) delete process.env.RISUBARD_KEEP_WORKDIR; else process.env.RISUBARD_KEEP_WORKDIR = saved; }
});

test('read-only Git-like files are removed without changing another hardlink or its attributes', t => {
    const f = fixture(t), work = f.dir('risubard-stack-generate-readonly'), outside = join(f.root, 'outside-object');
    writeFileSync(outside, 'shared immutable bytes');
    linkSync(outside, join(work, 'git-object'));
    chmodSync(outside, 0o444);
    const mode = statSync(outside).mode;
    try {
        const report = cleanupWorkdirs({ ...f.options, apply: true });
        assert.equal(report.count, 1, JSON.stringify(report));
        assert.equal(existsSync(work), false);
        assert.equal(readFileSync(outside, 'utf8'), 'shared immutable bytes');
        assert.equal(statSync(outside).mode, mode);
    } finally { chmodSync(outside, 0o666); }
});
