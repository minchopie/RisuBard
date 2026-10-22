import assert from 'node:assert/strict';
import { readFile, readdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectElf, hashFile } from './verify-node.mjs';

export async function verifyLocalEngine(root) {
    const manifest = JSON.parse(await readFile(join(root, 'engine-binaries.json'), 'utf8'));
    assert.equal(manifest.revision, 'ea0c4c2c85fb183ec0fbd30a1af4e4275a18a064');
    const abis = await readdir(join(root, 'jniLibs'));
    assert.deepEqual(abis.sort(), Object.keys(manifest.binaries).sort());
    assert.ok(abis.includes('arm64-v8a'), 'ARM64 local engine required');
    for (const abi of abis) {
        const directory = join(root, 'jniLibs', abi);
        assert.deepEqual(await readdir(directory), ['libllama-server.so'], 'Unverified local engine library');
        const binary = join(directory, 'libllama-server.so');
        assert.equal(await hashFile(binary), manifest.binaries[abi].sha256, 'Local engine hash mismatch');
        assert.equal(inspectElf(await readFile(binary)).machine, { 'arm64-v8a': 183, x86_64: 62 }[abi], 'Local engine ABI mismatch');
    }
    return abis;
}
if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
    console.log('Verified 16KiB local engine:', await verifyLocalEngine(resolve(dirname(fileURLToPath(import.meta.url)), '../../android-app/app/src/offline')));
}
