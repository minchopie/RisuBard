import assert from 'node:assert/strict';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';
import { hashFile, inspectElf } from './verify-node.mjs';

export async function verifyRuntime(root) {
    const assets = join(root, 'assets');
    const expected = (await readFile(join(assets, 'runtime.sha256'), 'utf8')).trim();
    assert.equal(await hashFile(join(assets, 'runtime.zip')), expected, 'Packaged runtime ZIP hash mismatch');
    const binaries = JSON.parse(await readFile(join(assets, 'runtime-binaries.json'), 'utf8'));
    const directories = await readdir(join(root, 'jniLibs'));
    assert.deepEqual(directories.sort(), Object.keys(binaries).sort(), 'Unverified native library directory');
    assert.ok(directories.includes('arm64-v8a'), 'ARM64 runtime required');
    for (const abi of directories) {
        assert.deepEqual(await readdir(join(root, 'jniLibs', abi)), ['libnode.so'], 'Unverified native library');
        const path = join(root, 'jniLibs', abi, 'libnode.so');
        assert.equal(await hashFile(path), binaries[abi].sha256, 'Packaged Node hash mismatch');
        const elf = inspectElf(await readFile(path));
        assert.equal(elf.machine, { 'arm64-v8a': 183, x86_64: 62 }[abi], 'Packaged Node ABI mismatch');
    }
    const zip = await yauzl.openPromise(join(assets, 'runtime.zip'), { lazyEntries: true });
    try {
        for await (const entry of zip.eachEntry()) {
            let crc = 0;
            for await (const chunk of await zip.openReadStreamPromise(entry)) crc = crc32(chunk, crc);
            assert.equal(crc, entry.crc32, 'Packaged runtime ZIP entry CRC mismatch: ' + entry.fileName);
        }
    } finally { zip.close(); }
    return directories;
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
    console.log('Verified 16KiB runtime:', await verifyRuntime(resolve(dirname(fileURLToPath(import.meta.url)), '../../android-app/app/src/main')));
}
