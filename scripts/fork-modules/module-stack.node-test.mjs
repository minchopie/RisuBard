import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ownership, assertCoverage, assertPayload, selectPatch, normalizeHostText, payloadPath, assertPatchScope } from './module-stack.mjs';
import { sourceSnapshot, reverseAssembly } from './module-stack.mjs';
import { execFileSync } from 'node:child_process';

const fixtureRoots = [];
afterEach(() => { for (const root of fixtureRoots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = prefix => { const root = mkdtempSync(join(tmpdir(), prefix)); fixtureRoots.push(root); return root; };

const config = () => ({ modules: [{ id: 'a', hosts: ['src/a.ts'], files: ['src/new.ts'] }], tooling: ['scripts/fork-modules/module-stack.mjs'] });
test('a host cannot belong to two feature patches', () => {
    const c = config(); c.modules.push({ id: 'b', hosts: ['src/a.ts'], files: [] });
    assert.throws(() => ownership(c), /Duplicate owner/);
});
test('a new patch cannot silently fall outside the assembled module stack', () => {
    assert.equal(assertCoverage(config(), ['src/a.ts', 'src/new.ts']).size, 2);
    assert.throws(() => assertCoverage(config(), ['src/unlisted.ts']), /Unowned/);
});
test('payload drift and an upstream file collision fail without overwriting either file', () => {
    const dir = fixture('stack-payload-test-'), from = join(dir, 'source'), to = join(dir, 'target');
    writeFileSync(from, 'existing feature'); const hash = createHash('sha256').update('existing feature').digest('hex');
    assert.doesNotThrow(() => assertPayload(from, to, hash));
    writeFileSync(to, 'new upstream implementation'); assert.throws(() => assertPayload(from, to, hash), /collision/);
    writeFileSync(from, 'changed during review'); assert.throws(() => assertPayload(from, to, hash), /Source changed/);
});
test('a compatibility adapter applies only to its verified commit and exact source patch', () => {
    const original = { path: 'original', sha256: 'old' }, adapter = { module: 'ui', path: 'adapted', sourceSha256: 'old' };
    const manifest = { compatibility: [{ targetSha: 'verified', patches: [adapter] }] };
    assert.equal(selectPatch(manifest, 'verified', 'ui', original), adapter);
    assert.equal(selectPatch(manifest, 'new-upstream', 'ui', original), original);
    assert.throws(() => selectPatch(manifest, 'verified', 'ui', { ...original, sha256: 'new' }), /Stale/);
    assert.throws(() => selectPatch(manifest, 'verified', 'ui', null), /Stale/);
});

test('adapter paths stay within their feature and LF-only diffs expose real edits', () => {
    const diff = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n';
    assert.doesNotThrow(() => assertPatchScope(diff, ['src/a.ts']));
    assert.throws(() => assertPatchScope(diff, ['src/b.ts']), /outside module/);
    assert.throws(() => assertPatchScope(diff.replace(/\n/g, '\r\n'), ['src/a.ts']), /LF line endings/);
    assert.throws(() => assertPatchScope('not a diff', ['src/a.ts']), /headers/);
});
test('host line endings do not turn a small feature patch into a whole-file replacement', () => {
    assert.equal(normalizeHostText(Buffer.from('한글\r\nsecond\r\n')), '한글\nsecond\n');
});
test('fork notes and tests with upstream name collisions keep separate names only on the reviewed target', () => {
    const manifest = { compatibility: [{ targetSha: 'verified', payloadTargets: { 'patchnote/0.9.81.md': 'docs/fork-modules/history/0.9.81.md' } }] };
    assert.equal(payloadPath(manifest, 'verified', 'patchnote/0.9.81.md'), 'docs/fork-modules/history/0.9.81.md');
    assert.equal(payloadPath(manifest, 'other', 'patchnote/0.9.81.md'), 'patchnote/0.9.81.md');
});


test('real patch removal preserves prior payload/tooling bytes and reapplication reproduces source paths', () => {
    const dir = fixture('stack-roundtrip-test-');
    const command = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: dir });
    command('init', '-q');
    writeFileSync(join(dir, 'host.txt'), 'before\n');
    writeFileSync(join(dir, 'same.txt'), 'same payload');
    writeFileSync(join(dir, 'tool.txt'), 'original tooling');
    command('add', '.');
    const before = sourceSnapshot(dir);
    const patchDir = fixture('stack-roundtrip-patch-'), patch = join(patchDir, 'change.patch');
    writeFileSync(join(dir, 'host.txt'), 'after\n');
    writeFileSync(patch, command('diff', '--binary'));
    const prior = new Map([['same.txt', Buffer.from('same payload')], ['tool.txt', Buffer.from('original tooling')], ['added.txt', null]]);
    writeFileSync(join(dir, 'tool.txt'), 'fork tooling');
    writeFileSync(join(dir, 'added.txt'), 'new payload');
    const after = sourceSnapshot(dir);
    reverseAssembly(dir, [patch], prior);
    assert.equal(sourceSnapshot(dir), before);
    assert.equal(readFileSync(join(dir, 'same.txt'), 'utf8'), 'same payload');
    assert.equal(existsSync(join(dir, 'added.txt')), false);
    command('apply', patch);
    writeFileSync(join(dir, 'tool.txt'), 'fork tooling');
    writeFileSync(join(dir, 'added.txt'), 'new payload');
    assert.equal(sourceSnapshot(dir), after);
    assert.throws(() => reverseAssembly(dir, [], new Map([['../outside', null]])), /outside isolated/);
});

import { targetHostsOf, adapterScope, assertTargetOnlyHosts, assertTargetOnlyAgreement, assertTargetBytes, baseHasIn, patchHeaders } from './module-stack.mjs';

const UP = 'a'.repeat(64);
const targetConfig = (overrides = {}) => ({
    base: 'fixture-base', modules: [{ id: 'a', hosts: ['src/a.ts'], files: ['src/new.ts'] }, { id: 'b', hosts: ['src/b.ts'], files: [] }], tooling: [],
    compatibility: [{ tag: 'v1', targetSha: 'T1', patches: [{ module: 'a', path: 'adapted', sourceSha256: 'x', targetHosts: [{ path: 'test/only.test.ts', sha256: UP }] }] }],
    ...overrides,
});
test('target-only hosts need a relative path plus upstream sha256 and extend only their own adapter scope', () => {
    const adapter = { module: 'a', targetHosts: [{ path: 'test/only.test.ts', sha256: UP }] };
    assert.deepEqual(adapterScope(['src/a.ts'], adapter), ['src/a.ts', 'test/only.test.ts']);
    assert.deepEqual(adapterScope(['src/a.ts'], { module: 'a' }), ['src/a.ts']);
    for (const bad of [{ path: 'test/only.test.ts' }, { path: 'test/only.test.ts', sha256: 'short' }, { path: '../escape.ts', sha256: UP }, { path: 'C:/abs.ts', sha256: UP }, { path: '/abs.ts', sha256: UP }, { path: 'a/../b.ts', sha256: UP }, { path: 'dir\\win.ts', sha256: UP }, { path: 'bare.ts', sha256: UP }]) {
        assert.throws(() => targetHostsOf({ module: 'a', targetHosts: [bad] }), /Target-only host/);
    }
    const diff = 'diff --git a/test/only.test.ts b/test/only.test.ts\n--- a/test/only.test.ts\n+++ b/test/only.test.ts\n@@ -1 +1 @@\n-old\n+new\n';
    assert.doesNotThrow(() => assertPatchScope(diff, adapterScope(['src/a.ts'], adapter)));
    assert.throws(() => assertPatchScope(diff, ['src/a.ts']), /outside module/);
});
test('target-only declarations are singly owned, absent from the base, modified by their adapter, and must agree between config and manifest', () => {
    const patchText = () => 'diff --git a/test/only.test.ts b/test/only.test.ts\n';
    const declared = assertTargetOnlyHosts(targetConfig(), { baseHas: () => false, patchText });
    assert.deepEqual(declared, [{ tag: 'v1', targetSha: 'T1', module: 'a', path: 'test/only.test.ts', sha256: UP }]);
    const reject = (config, pattern, options = { baseHas: () => false, patchText }) => assert.throws(() => assertTargetOnlyHosts(config, options), pattern);
    const withHost = (host, module = 'a') => targetConfig({ compatibility: [{ tag: 'v1', targetSha: 'T1', patches: [{ module, path: 'adapted', sourceSha256: 'x', targetHosts: [host] }] }] });
    reject(withHost({ path: 'src/b.ts', sha256: UP }), /already owned by b/); // wrong owner: an ordinary host of another module
    reject(withHost({ path: 'src/new.ts', sha256: UP }), /already owned by a/); // ordinary payload file
    reject(withHost({ path: 'test/only.test.ts', sha256: UP }, 'missing'), /not a feature module/);
    reject(withHost({ path: 'test/only.test.ts', sha256: UP }, 'transfer-integration'), /not a feature module/);
    reject(targetConfig({ compatibility: [{ tag: 'v1', targetSha: 'T1', patches: [
        { module: 'a', path: 'adapted', sourceSha256: 'x', targetHosts: [{ path: 'test/only.test.ts', sha256: UP }] },
        { module: 'b', path: 'adapted-b', sourceSha256: 'y', targetHosts: [{ path: 'test/only.test.ts', sha256: UP }] }] }] }), /owned twice/);
    reject(targetConfig({ compatibility: [{ tag: 'v1', targetSha: 'T1', patches: [{ module: 'a', path: 'p1', sourceSha256: 'x' }, { module: 'a', path: 'p2', sourceSha256: 'x' }] }] }), /Duplicate adapter module/);
    reject(targetConfig({ compatibility: [targetConfig().compatibility[0], { tag: 'v2', targetSha: 'T1', patches: [] }] }), /Duplicate compatibility target/);
    reject(targetConfig(), /exists in the base/, { baseHas: () => true, patchText });
    reject(targetConfig(), /not modified by its adapter/, { baseHas: () => false, patchText: () => 'diff --git a/src/a.ts b/src/a.ts\n' });
    // An added body line is not a file header: the adapter below modifies only src/a.ts, so the declaration must be refused.
    const bodyOnly = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1,2 @@\n old\n+// diff --git a/test/only.test.ts b/test/only.test.ts\n';
    assert.deepEqual(patchHeaders(bodyOnly), [{ before: 'src/a.ts', after: 'src/a.ts' }]);
    reject(targetConfig(), /not modified by its adapter/, { baseHas: () => false, patchText: () => bodyOnly });
    assert.doesNotThrow(() => assertTargetOnlyHosts(targetConfig(), { baseHas: () => false, patchText: () => bodyOnly + 'diff --git a/test/only.test.ts b/test/only.test.ts\n--- a/test/only.test.ts\n+++ b/test/only.test.ts\n@@ -1 +1 @@\n-old\n+new\n' }));
    // Config and manifest must declare the same target-only hosts (a manifest cannot quietly widen or repoint them).
    const manifestLike = targetConfig({ compatibility: [{ tag: 'v1', targetSha: 'T1', patches: [{ module: 'a', path: 'adapted', sourceSha256: 'x', sha256: 'z', targetHosts: [{ path: 'test/only.test.ts', sha256: 'b'.repeat(64) }] }] }] });
    assert.throws(() => assertTargetOnlyAgreement(targetConfig(), manifestLike, { baseHas: () => false, patchText }), /declarations differ between features and manifest/);
    assert.throws(() => assertTargetOnlyAgreement(targetConfig(), targetConfig({ compatibility: [] }), { baseHas: () => false, patchText }), /declarations differ/); // manifest dropped the declaration
    assert.deepEqual(assertTargetOnlyAgreement(targetConfig(), targetConfig({ compatibility: [{ ...targetConfig().compatibility[0], patches: [{ ...targetConfig().compatibility[0].patches[0], sha256: 'z' }] }] }), { baseHas: () => false, patchText }), declared); // same declaration plus the manifest's own adapter hash
});
test('a target-only host is verified against upstream bytes at the selected target, survives real removal and reapplies', () => {
    const dir = fixture('stack-target-only-test-');
    const command = (...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8' });
    command('init', '-q'); command('config', 'user.email', 'fixture@localhost'); command('config', 'user.name', 'fixture');
    writeFileSync(join(dir, 'host.txt'), 'host\n'); command('add', '.'); command('commit', '-qm', 'base');
    const base = command('rev-parse', 'HEAD').trim();
    const upstream = 'upstream test\n';
    mkdirSync(join(dir, 'test')); writeFileSync(join(dir, 'test/only.test.ts'), upstream); command('add', '.'); command('commit', '-qm', 'target');
    const adapter = { module: 'a', path: 'adapted', targetHosts: [{ path: 'test/only.test.ts', sha256: createHash('sha256').update(upstream).digest('hex') }] };
    assert.equal(baseHasIn(dir, base)('test/only.test.ts'), false); assert.equal(baseHasIn(dir, base)('host.txt'), true);
    const original = sourceSnapshot(dir);
    assert.deepEqual(assertTargetBytes(dir, adapter), adapter.targetHosts); // reviewed bytes present at the target
    writeFileSync(join(dir, 'test/only.test.ts'), 'tampered\n');
    assert.throws(() => assertTargetBytes(dir, adapter), /bytes differ/); // mismatched upstream SHA
    writeFileSync(join(dir, 'test/only.test.ts'), 'fixed test\n');
    const patchDir = fixture('stack-target-only-patch-'), patchFile = join(patchDir, 'adapted.patch');
    writeFileSync(patchFile, command('diff', '--binary'));
    command('checkout', '-q', '--', '.');
    assert.deepEqual(assertTargetBytes(dir, adapter), adapter.targetHosts);
    command('apply', '--whitespace=nowarn', patchFile);
    const assembled = sourceSnapshot(dir);
    reverseAssembly(dir, [patchFile], new Map());
    assert.equal(sourceSnapshot(dir), original);
    assert.deepEqual(assertTargetBytes(dir, adapter), adapter.targetHosts); // removal restored the upstream bytes before reapply
    command('apply', '--whitespace=nowarn', patchFile);
    assert.equal(sourceSnapshot(dir), assembled);
    command('checkout', '-q', '--', '.'); command('checkout', '-q', '--detach', base);
    assert.throws(() => assertTargetBytes(dir, adapter), /missing at this target/); // wrong target: the base has no such file
});
