import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = fileURLToPath(new URL('../../', import.meta.url));
function fixture(t) {
    const root = mkdtempSync(join(tmpdir(), 'workdir-lifecycle-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const repo = join(root, 'workspace/.tooling/RisuBard'), temp = join(root, 'Temp');
    mkdirSync(repo, { recursive: true }); mkdirSync(temp);
    const save = (path, text) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), text); };
    const copy = path => save(path, readFileSync(join(source, path)));
    const run = (script, args = [], env = {}) => spawnSync(process.execPath, [join(repo, script), ...args], {
        cwd: repo, encoding: 'utf8', windowsHide: true,
        env: { ...process.env, TMP: temp, TEMP: temp, RISUBARD_KEEP_WORKDIR: '', ...env },
    });
    return { root, repo, temp, save, copy, run };
}

test('generate CLI removes successful work only after writing the manifest; keep options and failure retain it', t => {
    const f = fixture(t), script = 'scripts/fork-modules/module-stack.mjs';
    for (const name of ['cleanup-workdirs.mjs', 'workdir-tree.ps1', 'workdir-keep.json']) f.copy('scripts/fork-modules/' + name);
    // Only git is synthetic: no real clone, commit or product patch is created by this lifecycle test.
    f.save(script, readFileSync(join(source, script), 'utf8').replace("from 'node:child_process'", "from './fixture-git.mjs'"));
    f.save('scripts/fork-modules/fixture-git.mjs', `export const spawnSync = () => ({ status: 0 });
export function execFileSync(command, args) {
    if (process.env.FIXTURE_GIT_FAIL === '1' && args.includes('clone')) throw new Error('fixture clone failure');
    return args.includes('rev-parse') ? 'fixture-base' : '';
}`);
    f.save('docs/fork-modules/features.json', JSON.stringify({ base: 'fixture-base', upstream: 'fixture', transferManifest: 'transfer.json', modules: [], tooling: [], compatibility: [] }));
    f.save('transfer.json', JSON.stringify({ upstream: { base: { sha: 'fixture-base' } }, integration: { patch: 'transfer.patch', files: { 'host.txt': { hooks: [] } } }, verify: { upstreamFeatureProbes: {} } }));
    f.save('transfer.patch', 'diff --git a/host.txt b/host.txt\n--- a/host.txt\n+++ b/host.txt\n@@ -1 +1 @@\n-old\n+new\n');
    const success = f.run(script, ['generate']); assert.equal(success.status, 0, success.stderr);
    const result = JSON.parse(success.stdout);
    assert.deepEqual(Object.keys(result).sort(), ['files', 'modules', 'result', 'targetOnlyHosts', 'work']); // target-only hosts are reported separately from inputs
    assert.equal(result.result, 'PASS'); assert.equal(existsSync(result.work), false);
    assert.equal(JSON.parse(readFileSync(join(f.repo, 'docs/fork-modules/manifest.json'))).schema, 1);
    for (const [args, env] of [[['--keep-workdir'], {}], [[], { RISUBARD_KEEP_WORKDIR: '1' }]]) {
        const kept = f.run(script, ['generate', ...args], env); assert.equal(kept.status, 0, kept.stderr);
        assert.ok(existsSync(JSON.parse(kept.stdout).work)); assert.match(kept.stderr, /kept \(requested\)/);
    }
    const failure = f.run(script, ['generate'], { FIXTURE_GIT_FAIL: '1' });
    assert.equal(failure.status, 1); assert.match(failure.stderr, /kept \(failed\): .*risubard-stack-generate-/);
    const verify = f.run(script, ['verify', '--logs', 'output/check']); assert.equal(verify.status, 0, verify.stderr);
    const report = JSON.parse(readFileSync(join(f.repo, 'output/check/report.json')));
    assert.deepEqual(report, JSON.parse(verify.stdout)); assert.equal(report.result, 'STRUCTURAL_PASS');
    assert.ok(existsSync(report.work)); assert.match(verify.stderr, /kept \(report-reference\)/);
    f.save('transfer.patch', 'changed');
    const failedVerify = f.run(script, ['verify', '--logs', 'output/failed']); assert.equal(failedVerify.status, 1);
    const failedReport = JSON.parse(failedVerify.stdout); assert.equal(failedReport.result, 'FAIL');
    assert.ok(existsSync(failedReport.work)); assert.match(failedVerify.stderr, /kept \(failed\)/);
});

test('Android packaging removes its stage after ZIP verification and retains a corrupted ZIP stage', t => {
    const f = fixture(t), script = 'scripts/android/package-runtime.mjs';
    f.copy(script); f.copy('scripts/android/verify-node.mjs');
    const archiveUrl = new URL('../android/runtime-archive.mjs', import.meta.url).href;
    f.save('scripts/android/runtime-archive.mjs', `import { writeRuntimeArchive as write } from ${JSON.stringify(archiveUrl)};
import { writeFile } from 'node:fs/promises';
export { verifyRuntimeArchive } from ${JSON.stringify(archiveUrl)};
export async function writeRuntimeArchive(source, destination) { await write(source, destination); if (process.env.CORRUPT_ZIP === '1') await writeFile(destination, 'corrupt fixture'); }`);
    f.save('package.json', JSON.stringify({ name: 'fixture', version: '0.9.98' }));
    f.save('scripts/android/runtime-lock.json', JSON.stringify({ version: 'fixture', architectures: {} }));
    const text = readFileSync(join(source, script), 'utf8');
    for (const [, name] of text.match(/const roots = \[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)) {
        f.save(`node_modules/${name}/package.json`, JSON.stringify({ name, version: '1.0.0' }));
    }
    for (const [, part] of text.match(/for \(const part of \[([^\]]+)\]\)/)[1].matchAll(/'([^']+)'/g)) {
        if (part !== 'package.json') f.save(part.includes('.') ? part : part + '/fixture.txt', 'synthetic input');
    }
    mkdirSync(join(f.repo, 'tmp'));
    const success = f.run(script); assert.equal(success.status, 0, success.stderr);
    assert.deepEqual(readdirSync(join(f.repo, 'tmp')), []);
    assert.ok(existsSync(join(f.repo, 'android-app/app/src/main/assets/runtime.zip')));
    const failure = f.run(script, [], { CORRUPT_ZIP: '1' });
    assert.equal(failure.status, 1); assert.match(failure.stderr, /kept \(failed\): .*android-runtime-/);
    assert.equal(readdirSync(join(f.repo, 'tmp')).filter(n => n.startsWith('android-runtime-')).length, 1);
});

test('APK verification cleans scratch even when aapt fails before ZIP inspection', t => {
    const f = fixture(t), script = 'scripts/android/release-build.mjs';
    for (const path of [script, 'scripts/android/verify-node.mjs', 'scripts/android/apk-report.mjs']) f.copy(path);
    f.save('package.json', JSON.stringify({ version: '0.9.98' }));
    f.save('node_modules/yauzl/package.json', JSON.stringify({ main: 'index.cjs' })); f.save('node_modules/yauzl/index.cjs', 'module.exports = {}');
    f.save('scripts/android/release-signing.mjs', `export const ALIAS = 'fixture', PASS_ENV = 'FIXTURE_PASSWORD';
export const certificateSummary = () => '', keystorePath = () => '', loadStorePassword = async () => 'synthetic';`);
    f.save('scripts/android/windows-exec.mjs', `export function runTool() { throw new Error('fixture aapt failure'); }`);
    f.save('out/RisuBard-0.9.98.apk', 'synthetic APK'); mkdirSync(join(f.repo, 'sdk/build-tools/35.0.0'), { recursive: true });
    const result = f.run(script, ['out', '--verify-only'], { JAVA_HOME: f.root, ANDROID_HOME: join(f.repo, 'sdk'), RISUBARD_GRADLE: 'unused-fixture' });
    assert.equal(result.status, 1); assert.match(result.stderr, /fixture aapt failure/);
    assert.deepEqual(readdirSync(f.temp), []);
    assert.equal(readFileSync(join(f.repo, 'out/RisuBard-0.9.98.apk'), 'utf8'), 'synthetic APK');
});
