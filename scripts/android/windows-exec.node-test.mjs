// node --test scripts/android/windows-exec.node-test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { batchCommandLine, runTool } from './windows-exec.mjs';

test('batch command line quotes program and arguments that contain spaces', () => {
    assert.equal(batchCommandLine('C:\\with space\\gradle.bat', ['assembleRelease', 'D:\\apk dir\\app.apk']),
        '""C:\\with space\\gradle.bat" "assembleRelease" "D:\\apk dir\\app.apk""');
});

test('a .bat in a directory with spaces receives arguments with spaces intact', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
    const dir = mkdtempSync(join(tmpdir(), 'risubard exec '));
    try {
        const sub = join(dir, 'tool dir'); mkdirSync(sub);
        const bat = join(sub, 'echo args.bat');
        writeFileSync(bat, '@echo off\r\necho first=%~1\r\necho second=%~2\r\n');
        const r = runTool(bat, ['value one', join(dir, 'apk dir', 'app.apk')], { encoding: 'utf8' });
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /first=value one/);
        assert.match(r.stdout, /second=.*apk dir\\app\.apk/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
