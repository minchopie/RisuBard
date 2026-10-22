import { readdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join, relative } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';

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
