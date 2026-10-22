'use strict';

require('sucrase/register/ts');
const { createWriteStream } = require('node:fs');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const yauzl = require('yauzl');
const { ZipFile } = require('yazl');
const { bardFiles, canonical, entryPath, validateManifest, validateRecords, verifyArchive,
    MANIFEST_BYTE_LIMIT, DEFAULT_RECORD_BYTE_BUDGET } = require('../../../shared/play-set/protocol.ts');

const CHUNK = 256 * 1024;
async function availableBytes(directory) {
    const info = await fs.statfs(directory, { bigint: true });
    const bytes = info.bavail * info.bsize;
    return Number(bytes > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : bytes);
}
function expectedEntries(manifest) {
    return new Map([...manifest.items, ...bardFiles(manifest)].map(item => [item.entry, item]));
}

/** One private, disposable export directory. Never overwrites an existing backup. */
async function writePlaySetArchive(snapshot, temporaryDirectory) {
    if (snapshot.missing.length) throw new Error('Missing play-set material: ' + snapshot.missing.map(item => item.path).join(', '));
    validateRecords(snapshot.manifest, snapshot.records);
    const entries = expectedEntries(snapshot.manifest);
    const manifest = Buffer.from(canonical(snapshot.manifest));
    if (manifest.length > MANIFEST_BYTE_LIMIT) throw new Error('Manifest exceeds metadata memory budget');
    const recordsSize = [...entries.values()].filter(item => item.entry.startsWith('records/')).reduce((total, item) => total + item.bytes, 0);
    if (!Number.isSafeInteger(recordsSize) || recordsSize > DEFAULT_RECORD_BYTE_BUDGET) throw new Error('Records exceed JSON memory budget');
    const expanded = manifest.length + [...entries.values()].reduce((total, item) => total + item.bytes, 0);
    if (!Number.isSafeInteger(expanded * 2) || await availableBytes(temporaryDirectory) < expanded * 2) throw new Error('Not enough storage space');
    const directory = await fs.mkdtemp(join(temporaryDirectory, 'play-export-'));
    const destination = join(directory, 'transfer.risuplay');
    const zip = new ZipFile(), active = new Set();
    const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
    zip.on('error', error => zip.outputStream.destroy(error));
    const written = pipeline(zip.outputStream, output);
    // Attach immediately: source validation can fail before we await the writer.
    written.catch(() => {});
    try {
        zip.addBuffer(manifest, 'manifest.json');
        for (const [name, item] of entries) {
            zip.addReadStreamLazy(name, { size: item.bytes, compress: name.startsWith('records/') }, callback => {
                (async () => {
                    let source;
                    if (name.startsWith('records/')) {
                        if (!snapshot.records.has(name)) throw new Error('Missing play-set record');
                        source = new Blob([canonical(snapshot.records.get(name))]);
                    } else source = snapshot.blobs.get(name) ?? await snapshot.blobLoaders?.get(name)?.();
                    if (!source || source.size !== item.bytes) throw new Error('Play-set source size changed');
                    const hash = createHash('sha256'); let bytes = 0;
                    const stream = Readable.from((async function* () {
                        for (let offset = 0; offset < source.size; offset += CHUNK) {
                            const chunk = new Uint8Array(await source.slice(offset, Math.min(offset + CHUNK, source.size)).arrayBuffer());
                            bytes += chunk.length;
                            if (chunk.length > CHUNK || bytes > item.bytes) throw new Error('Play-set source size changed');
                            hash.update(chunk); yield chunk;
                        }
                        if (bytes !== item.bytes || hash.digest('hex') !== item.hash) throw new Error('Play-set source hash changed');
                    })());
                    active.add(stream); stream.once('close', () => active.delete(stream));
                    stream.once('error', error => zip.emit('error', error));
                    callback(null, stream);
                })().catch(callback);
            });
        }
        zip.end();
        await written;
        const handle = await fs.open(destination, 'r+');
        try { await handle.sync(); } finally { await handle.close(); }
        return destination;
    } catch (error) {
        zip.outputStream.destroy(error);
        for (const stream of active) stream.destroy(error);
        await written.catch(() => {});
        await fs.rm(directory, { recursive: true, force: true });
        throw error;
    }
}

/** Central-directory parsing and bounded streaming; ZIP64 is handled by yauzl. */
async function openPlaySetArchive(path, temporaryDirectory) {
    const zip = await yauzl.openPromise(path, { autoClose: false, lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
    let closing;
    const close = () => closing ??= new Promise(resolve => { zip.once('close', resolve); zip.close(); });
    try {
        const entries = new Map(); let metadata = 0;
        for await (const entry of zip.eachEntry()) {
            const name = entry.fileName;
            if (name !== 'manifest.json') entryPath(name);
            const type = (entry.externalFileAttributes >>> 16) & 0xf000;
            if ((type !== 0 && type !== 0x8000) || entry.generalPurposeBitFlag & 1) throw new Error('Unsafe play-set archive member');
            if (entries.has(name)) throw new Error('Duplicate ZIP entry');
            metadata += Buffer.byteLength(name) + 64;
            if (metadata > MANIFEST_BYTE_LIMIT * 2) throw new Error('Archive directory exceeds metadata memory budget');
            if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) throw new Error('Invalid expanded size');
            entries.set(name, entry);
        }
        const stream = async name => {
            if (!entries.has(name)) throw new Error('Missing play-set archive member');
            return zip.openReadStreamPromise(entries.get(name));
        };
        const reader = {
            entries: async () => [...entries.values()].map(entry => ({ name: entry.fileName, bytes: entry.uncompressedSize })),
            availableBytes: () => availableBytes(temporaryDirectory),
            readRecord: async name => {
                const limit = name === 'manifest.json' ? MANIFEST_BYTE_LIMIT : DEFAULT_RECORD_BYTE_BUDGET;
                if (!entries.has(name) || entries.get(name).uncompressedSize > limit) throw new Error('Record exceeds JSON memory budget');
                const chunks = []; let bytes = 0;
                for await (const chunk of await stream(name)) {
                    bytes += chunk.length;
                    if (bytes > limit) throw new Error('Actual record exceeds JSON memory budget');
                    chunks.push(chunk);
                }
                return Buffer.concat(chunks, bytes);
            },
            digestEntry: async (name, expectedBytes) => {
                const hash = createHash('sha256'); let bytes = 0;
                for await (const chunk of await stream(name)) {
                    bytes += chunk.length;
                    if (bytes > expectedBytes) throw new Error('Expanded entry exceeds declared size');
                    hash.update(chunk);
                }
                if (bytes !== expectedBytes) throw new Error('Truncated play-set entry');
                return hash.digest('hex');
            },
        };
        const manifest = validateManifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await reader.readRecord('manifest.json'))));
        const records = await verifyArchive(manifest, reader);
        const expected = expectedEntries(manifest);
        const copyEntry = async (name, destination) => {
            const item = expected.get(name);
            if (!item) throw new Error('Unexpected archive member');
            const handle = await fs.open(destination, 'wx', 0o600);
            const hash = createHash('sha256'); let bytes = 0;
            try {
                for await (const chunk of await stream(name)) {
                    bytes += chunk.length;
                    if (bytes > item.bytes) throw new Error('Expanded entry exceeds declared size');
                    hash.update(chunk); await handle.writeFile(chunk);
                }
                if (bytes !== item.bytes || hash.digest('hex') !== item.hash) throw new Error('Archive entry changed after verification');
                await handle.sync();
            } catch (error) {
                await handle.close(); await fs.rm(destination, { force: true }); throw error;
            }
            await handle.close();
        };
        return { manifest, records, copyEntry, close };
    } catch (error) { await close(); throw error; }
}

module.exports = { writePlaySetArchive, openPlaySetArchive };
