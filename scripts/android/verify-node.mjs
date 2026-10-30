import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile, rename, rm, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

export async function hashFile(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
}

export async function extractNodeBinary(archive, member, destination, archiveHash, machine, pageSize = 16384) {
    assert.equal(await hashFile(archive), archiveHash, 'Runtime archive hash mismatch');
    const temporary = destination + '.part';
    try {
        // Windows bsdtar can lack xz support; Python's build-time standard library is consistent.
        const child = spawn('python', ['-c',
            'import tarfile,sys,shutil; t=tarfile.open(sys.argv[1],"r:*"); f=t.extractfile(sys.argv[2]); shutil.copyfileobj(f,sys.stdout.buffer,262144)',
            archive, member], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let errors = '';
        child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
        const exited = new Promise((accept, reject) => {
            child.on('error', reject);
            child.on('close', code => code === 0 ? accept() : reject(new Error('Runtime extraction failed: ' + errors)));
        });
        const copying = pipeline(child.stdout, createWriteStream(temporary));
        try { await Promise.all([copying, exited]); }
        catch (error) {
            child.kill();
            await Promise.allSettled([copying, exited]);
            throw error;
        }
        const elf = inspectElf(await readFile(temporary), pageSize);
        assert.equal(elf.machine, machine, 'Runtime ABI mismatch');
        await rename(temporary, destination);
        return { sha256: await hashFile(destination), ...elf };
    } finally {
        await rm(temporary, { force: true });
    }
}

export function inspectElf(bytes, pageSize = 16384) {
    assert.equal(bytes.subarray(0, 4).toString('hex'), '7f454c46', 'ELF header');
    assert.equal(bytes[4], 2, '64-bit ELF required');
    assert.equal(bytes[5], 1, 'Little endian ELF required');
    const machine = bytes.readUInt16LE(18);
    assert.ok([183, 62].includes(machine), 'ARM64 or x86_64 required');
    const phoff = Number(bytes.readBigUInt64LE(32));
    const phsize = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
    const loads = [];
    for (let i = 0; i < count; i++) {
        const p = phoff + i * phsize;
        if (bytes.readUInt32LE(p) !== 1) continue;
        const offset = Number(bytes.readBigUInt64LE(p + 8));
        const address = Number(bytes.readBigUInt64LE(p + 16));
        const alignment = Number(bytes.readBigUInt64LE(p + 48));
        assert.ok(alignment >= pageSize && alignment % pageSize === 0 && offset % pageSize === address % pageSize, `LOAD segment must support ${pageSize}-byte pages`);
        loads.push({ offset, address, alignment });
    }
    assert.ok(loads.length > 0, 'LOAD segments required');
    assert.ok(!bytes.includes(Buffer.from('/data/data/com.termux')), 'Termux prefix dependency');
    return { machine, loads };
}

if (process.argv[1] && await realpath(process.argv[1]) === await realpath(fileURLToPath(import.meta.url))) {
    for (const file of process.argv.slice(2)) console.log(JSON.stringify({ file, ...inspectElf(readFileSync(file)) }));
}
