import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ownership, assertCoverage, assertPayload, selectPatch, normalizeHostText, payloadPath, assertPatchScope } from './module-stack.mjs';

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
    const dir = mkdtempSync(join(tmpdir(), 'stack-payload-test-')), from = join(dir, 'source'), to = join(dir, 'target');
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
