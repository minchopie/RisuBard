import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import yauzl from 'yauzl';
import { extractNodeBinary, hashFile, inspectElf } from './verify-node.mjs';
import { verifyRuntime } from './verify-runtime.mjs';
import { writeRuntimeArchive } from './runtime-archive.mjs';

function elf(alignment = 16384, machine = 183) {
    const data = Buffer.alloc(128);
    data.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
    data.writeUInt16LE(machine, 18);
    data.writeBigUInt64LE(64n, 32);
    data.writeUInt16LE(56, 54); data.writeUInt16LE(1, 56);
    data.writeUInt32LE(1, 64); data.writeBigUInt64LE(BigInt(alignment), 112);
    return data;
}
async function temp(t) {
    const root = await mkdtemp(join(tmpdir(), 'risubard-runtime-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}
test('16KiB check rejects 4KiB LOAD segments, malformed ELF and wrong segment offsets', () => {
    assert.equal(inspectElf(elf()).machine, 183);
    assert.throws(() => inspectElf(elf(4096)), /LOAD segment/);
    assert.throws(() => inspectElf(elf(20000)), /LOAD segment/);
    assert.throws(() => inspectElf(Buffer.alloc(128)), /ELF header/);
    const misaligned = elf(); misaligned.writeBigUInt64LE(4096n, 72);
    assert.throws(() => inspectElf(misaligned), /LOAD segment/);
});
test('extracts the hash-verified archive member, rejects tampering and preserves existing binary on failure', async t => {
    const root = await temp(t);
    const archive = join(root, 'runtime.tar'), output = join(root, 'libnode.so');
    await writeFile(join(root, 'node'), elf());
    await promisify(execFile)('tar', ['-cf', archive, '-C', root, 'node'], { windowsHide: true });
    const hash = await hashFile(archive);
    await extractNodeBinary(archive, 'node', output, hash, 183);
    assert.deepEqual(await readFile(output), elf());
    await assert.rejects(extractNodeBinary(archive, 'node', output, '0'.repeat(64), 183), /archive hash/);
    await assert.rejects(extractNodeBinary(archive, 'node', output, hash, 62), /ABI mismatch/);
    await assert.rejects(extractNodeBinary(archive, 'absent', output, hash, 183), /extraction failed/);
    await mkdir(output + '.part');
    await assert.rejects(extractNodeBinary(archive, 'node', output, hash, 183));
    await rm(output + '.part', { recursive: true });
    assert.deepEqual(await readFile(output), elf());
});
test('release gate checks actual ZIP and library bytes and rejects extra libraries', async t => {
    const root = await temp(t), assets = join(root, 'assets'), lib = join(root, 'jniLibs/arm64-v8a');
    await mkdir(assets); await mkdir(lib, { recursive: true });
    await writeFile(join(assets, 'runtime.zip'), zipSync({ 'fixture.txt': Buffer.from('synthetic runtime') }));
    await writeFile(join(assets, 'runtime.sha256'), await hashFile(join(assets, 'runtime.zip')));
    await writeFile(join(lib, 'libnode.so'), elf());
    await writeFile(join(assets, 'runtime-binaries.json'), JSON.stringify({ 'arm64-v8a': { sha256: await hashFile(join(lib, 'libnode.so')) } }));
    assert.deepEqual(await verifyRuntime(root), ['arm64-v8a']);
    await writeFile(join(lib, 'libnode.so'), elf(4096));
    await assert.rejects(verifyRuntime(root), /Node hash/);
    await writeFile(join(assets, 'runtime-binaries.json'), JSON.stringify({ 'arm64-v8a': { sha256: await hashFile(join(lib, 'libnode.so')) } }));
    await assert.rejects(verifyRuntime(root), /LOAD segment/);
    await writeFile(join(lib, 'libnode.so'), elf());
    await writeFile(join(assets, 'runtime-binaries.json'), JSON.stringify({ 'arm64-v8a': { sha256: await hashFile(join(lib, 'libnode.so')) } }));
    await writeFile(join(lib, 'extra.so'), 'unexpected');
    await assert.rejects(verifyRuntime(root), /Unverified native library/);
    await rm(join(lib, 'extra.so'));
    await writeFile(join(assets, 'runtime.zip'), 'corrupt');
    await assert.rejects(verifyRuntime(root), /ZIP hash/);
    const corrupt = Buffer.from(zipSync({ 'fixture.txt': Buffer.from('synthetic runtime') }, { level: 0 }));
    const dataOffset = corrupt.indexOf('synthetic runtime');
    assert.ok(dataOffset >= 0);
    corrupt[dataOffset] ^= 1;
    await writeFile(join(assets, 'runtime.zip'), corrupt);
    await writeFile(join(assets, 'runtime.sha256'), await hashFile(join(assets, 'runtime.zip')));
    await assert.rejects(verifyRuntime(root), /ZIP entry CRC/);
    const badDeflate = Buffer.from(zipSync({ 'fixture.txt': Buffer.from('synthetic runtime') }));
    assert.equal(badDeflate.readUInt16LE(8), 8);
    const compressedOffset = 30 + badDeflate.readUInt16LE(26) + badDeflate.readUInt16LE(28);
    badDeflate[compressedOffset] = 7; // Reserved DEFLATE block type, before any CRC comparison.
    await writeFile(join(assets, 'runtime.zip'), badDeflate);
    await writeFile(join(assets, 'runtime.sha256'), await hashFile(join(assets, 'runtime.zip')));
    await assert.rejects(verifyRuntime(root), error => error.code === 'Z_DATA_ERROR');
});

test('CLI gate checks 4KiB and 16KiB libraries through a directory link', async t => {
    const root = await temp(t), actual = join(root, 'actual'), linked = join(root, 'linked');
    const scripts = join(actual, 'scripts/android');
    const assets = join(actual, 'android-app/app/src/main/assets');
    const lib = join(actual, 'android-app/app/src/main/jniLibs/arm64-v8a/libnode.so');
    await mkdir(scripts, { recursive: true }); await mkdir(assets, { recursive: true });
    await mkdir(join(actual, 'android-app/app/src/main/jniLibs/arm64-v8a'), { recursive: true });
    for (const name of ['verify-runtime.mjs', 'verify-node.mjs']) {
        await copyFile(new URL(name, import.meta.url), join(scripts, name));
    }
    await writeFile(join(assets, 'runtime.zip'), zipSync({ 'fixture.txt': Buffer.from('synthetic runtime') }));
    await writeFile(join(assets, 'runtime.sha256'), await hashFile(join(assets, 'runtime.zip')));
    await symlink(actual, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await symlink(fileURLToPath(new URL('../../node_modules', import.meta.url)), join(actual, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    const args = [join(linked, 'scripts/android/verify-runtime.mjs')];
    const binaryArgs = [join(linked, 'scripts/android/verify-node.mjs'), lib];
    await writeFile(lib, elf(4096));
    await writeFile(join(assets, 'runtime-binaries.json'), JSON.stringify({ 'arm64-v8a': { sha256: await hashFile(lib) } }));
    await assert.rejects(promisify(execFile)(process.execPath, args, { windowsHide: true }), error => /LOAD segment/.test(error.stderr));
    await assert.rejects(promisify(execFile)(process.execPath, binaryArgs, { windowsHide: true }), error => /LOAD segment/.test(error.stderr));
    await writeFile(lib, elf());
    await writeFile(join(assets, 'runtime-binaries.json'), JSON.stringify({ 'arm64-v8a': { sha256: await hashFile(lib) } }));
    const { stdout } = await promisify(execFile)(process.execPath, args, { windowsHide: true });
    assert.match(stdout, /Verified 16KiB runtime/);
    const binaryResult = await promisify(execFile)(process.execPath, binaryArgs, { windowsHide: true });
    assert.equal(JSON.parse(binaryResult.stdout).machine, 183);
});

test('runtime ZIP preserves font bytes, nested names and multi-chunk data with native inflation', async t => {
    const root = await temp(t), source = join(root, 'source'), destination = join(root, 'runtime.zip');
    await mkdir(join(source, 'fonts'), { recursive: true });
    const expected = new Map([
        ['empty.txt', Buffer.alloc(0)],
        ['한글.txt', Buffer.from('오프라인 시험')],
        ['large.txt', Buffer.from('multi-chunk runtime fixture\n'.repeat(120000))],
    ]);
    for (const name of ['KaTeX_SansSerif-Bold.ttf', 'KaTeX_SansSerif-Regular.ttf', 'KaTeX_Size1-Regular.ttf']) {
        expected.set('fonts/' + name, await readFile(new URL('../../node_modules/katex/dist/fonts/' + name, import.meta.url)));
    }
    for (const [name, bytes] of expected) await writeFile(join(source, name), bytes);
    await writeRuntimeArchive(source, destination);
    const zip = await yauzl.openPromise(destination, { lazyEntries: true });
    try {
        for await (const entry of zip.eachEntry()) {
            const chunks = [];
            for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(chunk);
            assert.deepEqual(Buffer.concat(chunks), expected.get(entry.fileName), entry.fileName);
            expected.delete(entry.fileName);
        }
        assert.equal(expected.size, 0);
    } finally { zip.close(); }
    await assert.rejects(writeRuntimeArchive(join(root, 'absent'), destination), /ENOENT/);
    await assert.rejects(writeRuntimeArchive(source, root), /EISDIR|EPERM|EACCES/);
    await mkdir(join(root, 'directory-link-target'));
    await symlink(join(root, 'directory-link-target'), join(source, 'directory-as-file'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(writeRuntimeArchive(source, destination), /not a file/);
});
