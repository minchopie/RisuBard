import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { hashFile, inspectElf } from './verify-node.mjs';
import { verifyLocalEngine } from './verify-local-engine.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../android-app/app/src/offline');
const binaries = {};
for (const [index, abi, machine] of [[2, 'arm64-v8a', 183], [3, 'x86_64', 62]]) {
    const source = process.argv[index];
    assert.ok(source, 'Usage: node package-local-engine.mjs <ARM64 binary> <x86_64 binary>');
    const bytes = await readFile(source);
    assert.equal(inspectElf(bytes).machine, machine);
    assert.ok(bytes.includes(Buffer.from('RISUBARD_PARENT_PID')), 'Parent death guard required');
    const destination = join(root, 'jniLibs', abi, 'libllama-server.so');
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    binaries[abi] = { sha256: await hashFile(destination) };
}
await writeFile(join(root, 'engine-binaries.json'), JSON.stringify({
    revision: 'ea0c4c2c85fb183ec0fbd30a1af4e4275a18a064',
    parentGuardSha256: await hashFile(new URL('llama-owner-main.cpp', import.meta.url)), binaries,
}, null, 2));
console.log(await verifyLocalEngine(root));
