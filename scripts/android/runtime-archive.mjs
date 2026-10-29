import { readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import yauzl from 'yauzl';
import assert from 'node:assert/strict';
import { crc32 } from 'node:zlib';

export async function verifyRuntimeArchive(path) {
    const zip = await yauzl.openPromise(path, { lazyEntries: true });
    try {
        for await (const entry of zip.eachEntry()) {
            let crc = 0;
            for await (const chunk of await zip.openReadStreamPromise(entry)) crc = crc32(chunk, crc);
            assert.equal(crc, entry.crc32, 'Packaged runtime ZIP entry CRC mismatch: ' + entry.fileName);
        }
    } finally { zip.close(); }
}

export async function writeRuntimeArchive(source, destination) {
    const zip = new ZipFile();
    zip.on('error', error => zip.outputStream.destroy(error));
    const written = pipeline(zip.outputStream, createWriteStream(destination));
    written.catch(() => {});
    async function addDirectory(directory) {
        for (const item of await readdir(directory, { withFileTypes: true })) {
            const file = join(directory, item.name);
            if (item.isDirectory()) await addDirectory(file);
            else zip.addFile(file, relative(source, file).replaceAll('\\', '/'), { compressionLevel: 6 });
        }
    }
    try {
        await addDirectory(source);
        zip.end();
        await written;
    } catch (error) {
        zip.outputStream.destroy(error);
        await written.catch(() => {});
        throw error;
    }
}
