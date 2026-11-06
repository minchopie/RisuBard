import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const helperPath = new URL('./workdir-root.cjs', import.meta.url);
const { WINDOWS_WORK_ROOT, workRoot, tempEnv } = createRequire(import.meta.url)('./workdir-root.cjs');
const fixture = t => { const root = mkdtempSync(join(tmpdir(), 'workdir-root-test-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; };
const recorder = () => { const calls = []; return Object.assign((path, options) => { calls.push([path, options]); }, { calls }); };
const envSnapshot = () => JSON.stringify(Object.entries(process.env).sort());

test('Windows uses the fixed root, creates it, and normalizes an override to backslashes', () => {
    const mkdir = recorder();
    assert.equal(workRoot({ env: {}, platform: 'win32', mkdir }), WINDOWS_WORK_ROOT);
    assert.equal(WINDOWS_WORK_ROOT, 'C:\\_risubard_work');
    assert.deepEqual(mkdir.calls, [['C:\\_risubard_work', { recursive: true }]]);
    assert.equal(workRoot({ env: { RISUBARD_WORK_ROOT: 'D:/fixture/work' }, platform: 'win32', mkdir }), 'D:\\fixture\\work');
});

test('other platforms keep the OS temp dir; RISUBARD_WORK_ROOT overrides every platform and is created', t => {
    const mkdir = recorder();
    assert.equal(workRoot({ env: {}, platform: 'linux', mkdir }), resolve(tmpdir()));
    assert.equal(workRoot({ env: {}, platform: 'darwin', fallback: tmpdir(), mkdir }), resolve(tmpdir()));
    const override = join(fixture(t), 'nested', 'work');
    assert.equal(workRoot({ env: { RISUBARD_WORK_ROOT: override } }), override);
    assert.ok(existsSync(override));
});

test('a root that cannot be created throws instead of falling back to the old Temp', t => {
    const denied = () => { throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }); };
    for (const platform of ['win32', 'linux']) {
        assert.throws(() => workRoot({ env: {}, platform, mkdir: denied }), { code: 'EPERM' });
        assert.throws(() => tempEnv({ RISUBARD_WORK_ROOT: 'C:\\denied', TEMP: 'C:\\Users\\u\\AppData\\Local\\Temp', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, { platform, mkdir: denied }), { code: 'EPERM' });
    }
    const file = join(fixture(t), 'not-a-directory'); writeFileSync(file, 'fixture');
    assert.throws(() => workRoot({ env: { RISUBARD_WORK_ROOT: join(file, 'work') } }));
});

test('QA child env: default user Temp moves to <root>\\tmp; explicit temp dirs and the caller env are preserved', () => {
    const before = envSnapshot(), mkdir = recorder();
    const base = Object.freeze({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', TEMP: 'C:\\Users\\u\\AppData\\Local\\Temp', TMP: 'C:\\Users\\u\\AppData\\Local\\Temp', PATH: 'p' });
    const env = tempEnv(base, { platform: 'win32', mkdir });
    assert.deepEqual(env, { ...base, TMP: 'C:\\_risubard_work\\tmp', TEMP: 'C:\\_risubard_work\\tmp', TMPDIR: 'C:\\_risubard_work\\tmp' });
    assert.deepEqual(mkdir.calls.map(([path]) => path), ['C:\\_risubard_work', 'C:\\_risubard_work\\tmp']);
    assert.equal(tempEnv({ ...base, TEMP: 'c:\\users\\U\\appdata\\local\\temp\\' }, { platform: 'win32', mkdir }).TEMP, 'C:\\_risubard_work\\tmp');
    assert.equal(tempEnv({ ...base, RISUBARD_WORK_ROOT: 'E:\\iso' }, { platform: 'win32', mkdir }).TMP, 'E:\\iso\\tmp');
    for (const explicit of [{ ...base, TEMP: 'D:\\fixture', TMP: 'D:\\fixture' }, { ...base, TEMP: 'C:\\_risubard_work\\tmp' }]) {
        const kept = tempEnv(explicit, { platform: 'win32', mkdir });
        assert.deepEqual(kept, explicit); assert.notEqual(kept, explicit);
    }
    const isolated = Object.freeze({ LOCALAPPDATA: 'D:/qa/local', USERPROFILE: 'C:/Users/u', TEMP: 'C:/Users/u/AppData/Local/Temp', TMP: 'C:/Users/u/AppData/Local/Temp', RISUBARD_WORK_ROOT: 'E:/qa/work' });
    assert.deepEqual(tempEnv(isolated, { platform: 'win32', mkdir }), { ...isolated, TMP: 'E:\\qa\\work\\tmp', TEMP: 'E:\\qa\\work\\tmp', TMPDIR: 'E:\\qa\\work\\tmp' });
    const custom = { ...isolated, TEMP: 'D:/fixture', TMP: 'D:/fixture' };
    assert.deepEqual(tempEnv(custom, { platform: 'win32', mkdir }), custom);
    const posix = { TMPDIR: '/var/tmp/x', HOME: '/h' };
    assert.deepEqual(tempEnv(posix, { platform: 'linux', mkdir }), posix);
    assert.deepEqual(tempEnv({ HOME: '/h' }, { platform: 'darwin', mkdir }), { HOME: '/h' });
    assert.equal(envSnapshot(), before);
});

test('applyProcessTemp changes only its own process temp dir', t => {
    const root = fixture(t), before = envSnapshot();
    const code = `require(${JSON.stringify(fileURLToPath(helperPath))}).applyProcessTemp(); console.log(require('node:os').tmpdir())`;
    const result = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...process.env,
        RISUBARD_WORK_ROOT: join(root, 'work'), LOCALAPPDATA: root, TEMP: join(root, 'Temp'), TMP: join(root, 'Temp'), TMPDIR: '/tmp' } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), join(root, 'work', 'tmp'));
    assert.ok(existsSync(join(root, 'work', 'tmp')));
    assert.equal(envSnapshot(), before);
});
