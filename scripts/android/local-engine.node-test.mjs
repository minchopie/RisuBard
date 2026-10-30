import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hashFile } from './verify-node.mjs';
import { verifyLocalEngine } from './verify-local-engine.mjs';

test('local engine gate rejects altered bytes, wrong ABI, 4KiB ELF and unexpected binaries', async t => {
    const root = await mkdtemp(join(tmpdir(), 'risubard-engine-gate-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dir = join(root, 'jniLibs/arm64-v8a'); await mkdir(dir, { recursive: true });
    const binary = join(dir, 'libllama-server.so');
    const elf = Buffer.alloc(128); elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); elf.writeUInt16LE(183, 18);
    elf.writeBigUInt64LE(64n, 32); elf.writeUInt16LE(56, 54); elf.writeUInt16LE(1, 56);
    elf.writeUInt32LE(1, 64); elf.writeBigUInt64LE(16384n, 112);
    const manifest = async () => writeFile(join(root, 'engine-binaries.json'), JSON.stringify({
        revision: 'ea0c4c2c85fb183ec0fbd30a1af4e4275a18a064', binaries: { 'arm64-v8a': { sha256: await hashFile(binary) } },
    }));
    await writeFile(binary, elf); await manifest();
    assert.deepEqual(await verifyLocalEngine(root), ['arm64-v8a']);
    elf.writeUInt16LE(62, 18); await writeFile(binary, elf);
    await assert.rejects(verifyLocalEngine(root), /hash mismatch/); await manifest();
    await assert.rejects(verifyLocalEngine(root), /ABI mismatch/);
    elf.writeUInt16LE(183, 18); elf.writeBigUInt64LE(4096n, 112); await writeFile(binary, elf); await manifest();
    await assert.rejects(verifyLocalEngine(root), /16384-byte/);
    await writeFile(join(dir, 'unknown.so'), 'extra');
    await assert.rejects(verifyLocalEngine(root), /Unverified/);
});
