import { AppendableBuffer, saveAsset, type LocalWriter, type VirtualWriter } from "../globalApi.svelte";
import * as fflate from "fflate";
import { asBuffer, sleep } from "../util";
import { alertStore } from "../alert";
import { hasher } from "../parser/parser.svelte";
import { hubURL } from "../characterCards";
import { AssetImportBatcher } from "../storage/assetImportBatcher";
import type { ImportTransaction } from '../storage/importTransaction';
import { yieldImportTask } from '../importTaskYield';

// File size and chunk size constants
const MAX_ASSET_SIZE_BYTES = 100 * 1024 * 1024; // 100 MiB
const CHUNK_SIZE_BYTES = 1024 * 1024; // 1MB

// HTTP status code ranges
const HTTP_STATUS_OK_MIN = 200;
const HTTP_STATUS_OK_MAX = 300;

export async function processZip(dataArray: Uint8Array): Promise<string> {
    const unzipped = await new Promise<fflate.Unzipped>((resolve, reject) => {
        fflate.unzip(dataArray, (err, data) => {
            if (err) reject(err);
            else resolve(data);
        });
    });

    const imageFile = Object.keys(unzipped).find(fileName => /\.(jpg|jpeg|png)$/i.test(fileName));
    if (imageFile) {
        const imageData = unzipped[imageFile];
        const blob = new Blob([asBuffer(imageData)], { type: 'image/png' });
        const base64 = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const result = reader.result as string;
                resolve(result);
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
        return base64;
    } else {
        throw new Error("No image found in ZIP file");
    }
}

const CRC_TABLE = (() => {
    const table = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
        let c = n
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
        table[n] = c
    }
    return table
})()

function crc32(data: Uint8Array) {
    let c = -1
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 255] ^ (c >>> 8)
    return (c ^ -1) >>> 0
}

/**
 * Writes a ZIP whose local headers carry each entry's sizes and CRC.
 * fflate's streaming Zip writes data descriptors instead, and streaming readers
 * (RisuBard and RisuAI both use fflate Unzip) end an entry early when its bytes
 * happen to contain the descriptor signature PK\x07\x08.
 */
export class CharXWriter{
    apb = new AppendableBuffer()
    #takenFilenames:Set<string> = new Set()
    #central:Uint8Array[] = []
    #offset = 0
    #dosTime:number
    #dosDate:number
    constructor(private writer:LocalWriter|WritableStreamDefaultWriter<Uint8Array>|VirtualWriter){
        const now = new Date()
        this.#dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)
        this.#dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()
    }
    async init(){
        //do nothing, just to make compatible with other writer
    }

    async writeJpeg(img: Uint8Array){
        const canvas = document.createElement('canvas')
        const ctx = canvas.getContext('2d')
        if(!ctx){
            return
        }
        const imgBlob = new Blob([asBuffer(img)], {type: 'image/jpeg'})
        const imgURL = URL.createObjectURL(imgBlob)
        const imgElement = document.createElement('img')
        imgElement.src = imgURL
        await imgElement.decode()
        canvas.width = imgElement.width
        canvas.height = imgElement.height
        ctx.drawImage(imgElement, 0, 0)
        const blob = await (new Promise((res:BlobCallback, rej) => {
            canvas.toBlob(res, 'image/jpeg')
        }))
        const buf = await blob.arrayBuffer()
        this.apb.append(new Uint8Array(buf))
    }

    async write(key:string,data:Uint8Array|string, level?:0|1|2|3|4|5|6|7|8|9){
        key = this.#sanitizeZipFilename(key)
        let dat:Uint8Array
        if(typeof data === 'string'){
            dat = new TextEncoder().encode(data)
        }
        else{
            dat = data
        }
        const name = new TextEncoder().encode(key)
        const method = level ? 8 : 0
        const body = level ? fflate.deflateSync(dat, { level }) : dat
        const crc = crc32(dat)
        const header = this.#header(false, name, method, crc, body.length, dat.length, 0)
        if (this.#offset + header.length + body.length > 0xFFFFFFFF) {
            throw new Error('CHARX export is larger than 4 GB')
        }
        this.#central.push(this.#header(true, name, method, crc, body.length, dat.length, this.#offset))
        this.#offset += header.length + body.length
        this.apb.append(header)
        this.apb.append(body)
        await this.writer.write(this.apb.buffer)
        this.apb.clear()
    }

    #header(central:boolean, name:Uint8Array, method:number, crc:number, compressedSize:number, size:number, offset:number){
        const d = new Uint8Array((central ? 46 : 30) + name.length)
        const v = new DataView(d.buffer)
        let p = 0
        v.setUint32(p, central ? 0x02014b50 : 0x04034b50, true); p += 4
        if (central) { v.setUint16(p, 20, true); p += 2 }
        v.setUint16(p, 20, true)
        v.setUint16(p + 2, 0x0800, true) // UTF-8 names
        v.setUint16(p + 4, method, true)
        v.setUint16(p + 6, this.#dosTime, true)
        v.setUint16(p + 8, this.#dosDate, true)
        v.setUint32(p + 10, crc, true)
        v.setUint32(p + 14, compressedSize, true)
        v.setUint32(p + 18, size, true)
        v.setUint16(p + 22, name.length, true)
        p += 26
        if (central) { v.setUint32(p + 10, offset, true); p += 14 }
        d.set(name, p)
        return d
    }

    #sanitizeZipFilename(filename:string) {
        let sanitized = filename.replace(/[<>:"\\|?*\x00-\x1F]/g, '_');
        sanitized = sanitized.replace(/[. ]+$/, '');
        const reservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
        if (reservedNames.test(sanitized)) {
            sanitized = '_' + sanitized;
        }
        if (!sanitized || sanitized === '.' || sanitized === '..') {
            sanitized = 'file_' + Date.now();
        }

        const splitName = sanitized.split('.');
        let baseName = splitName.slice(0, -1).join('.');
        const extension = splitName.length > 1 ? '.' + splitName[splitName.length - 1] : '';
        let counter = 1;
        let uniqueName = baseName + extension;
        while (this.#takenFilenames.has(uniqueName)) {
            uniqueName = `${baseName}_${counter}${extension}`;
            counter++;
        }
        
        this.#takenFilenames.add(uniqueName);
        return uniqueName;
    }

    async end(){
        const entries = this.#central.length
        let directorySize = 0
        for (const entry of this.#central) {
            this.apb.append(entry)
            directorySize += entry.length
        }
        if (entries > 0xFFFF || this.#offset + directorySize > 0xFFFFFFFF) {
            throw new Error('CHARX export has too many files or is larger than 4 GB')
        }
        const eocd = new Uint8Array(22)
        const v = new DataView(eocd.buffer)
        v.setUint32(0, 0x06054b50, true)
        v.setUint16(8, entries, true)
        v.setUint16(10, entries, true)
        v.setUint32(12, directorySize, true)
        v.setUint32(16, this.#offset, true)
        this.apb.append(eocd)
        await this.writer.write(this.apb.buffer)
        this.apb.clear()
        await this.writer.close()
    }
}

/**
 * Streaming importer for CharX (character export) files.
 *
 * CharX files are ZIP archives containing:
 * - card.json: Character card data (CCv3 format)
 * - module.risum: Optional module data (scripts, lorebook)
 * - assets/*: Image and other asset files
 *
 * This class reads and imports character data by:
 * - Processing ZIP streams incrementally to handle large files efficiently
 * - Parsing metadata (card.json, module.risum) synchronously
 * - Saving assets to storage concurrently (limited to prevent memory exhaustion)
 */
export interface CharXImportProgress {
    phase: 'reading' | 'scanning' | 'extracting' | 'preparing-assets' | 'saving-assets' | 'finalizing'
    completed: number
    total?: number
}

export class CharXImporter{
    // ZIP streaming parser
    unzip:fflate.Unzip

    // Completion tracking
    private completionResolver?: () => void
    private completionRejecter?: (error: Error) => void
    private completionPromise?: Promise<void>
    private completionSettled: boolean = false
    private errors: Error[] = []
    private readonly importProgress?: (progress: CharXImportProgress) => void
    private inputBytes = 0
    private inputTotal?: number
    private discoveredEntries = 0
    private extractedEntries = 0
    private openFiles: number = 0
    private inputFinalized: boolean = false
    private finalizationStarted: boolean = false
    private assetBatcher: AssetImportBatcher

    // Results: filename -> saved asset ID mapping
    assets:{[key:string]:string} = {}

    // Temporary buffers for accumulating file chunks during streaming
    assetBuffers:{[key:string]:AppendableBuffer} = {}

    // Files excluded due to size limits (> MAX_ASSET_SIZE_BYTES)
    excludedFiles:string[] = []

    // Extracted character card JSON content
    cardData:string|undefined

    // Extracted module binary data
    moduleData:Uint8Array|undefined

    // Configuration
    alertInfo:boolean = false  // Show progress alerts to user
    skipSaving: boolean = false  // If true, only compute hashes without saving
    hashSignal: string|undefined  // Hash to signal server for sync (when skipSaving is false)

    constructor(onProgress?: (progress: CharXImportProgress) => void, private transaction?: ImportTransaction){
        this.importProgress = onProgress
        this.unzip = new fflate.Unzip()
        // AsyncUnzipInflate creates a worker per compressed entry. Module
        // archives can contain hundreds of x_meta files, exhausting the
        // browser worker pool and leaving import completion unresolved.
        this.unzip.register(fflate.UnzipInflate)
        this.unzip.onfile = (file) => this.#handleFile(file)

        const onStoredProgress = (done: number, total: number) => {
            this.importProgress?.({ phase: 'saving-assets', completed: done, ...(this.inputFinalized ? { total } : {}) })
            if(this.alertInfo){
                alertStore.set({
                    type: 'wait',
                    msg: `Loading... (Saving Assets ${done}/${total})`
                })
            }
        }
        this.assetBatcher = new AssetImportBatcher({
            transaction,
            onStored: (id, storageKey) => {
                this.assets[id] = storageKey
            },
            onProgress: onStoredProgress,
            shouldPersist: () => !this.skipSaving,
        })
    }

    /**
     * High-level method to parse ZIP data from various sources.
     *
     * Handles three input types:
     * - ReadableStream: Streams data chunks as they arrive
     * - Uint8Array: Automatically converted to stream
     * - File: Uses built-in stream() method
     *
     * After parse() completes:
     * - cardData and moduleData are immediately available
     * - Asset saving continues in the background
     * - MUST call done() to wait for all assets to finish saving
     *
     * Usage:
     * ```
     * await importer.parse(data)
     * const card = importer.cardData  // Available immediately
     * await importer.done()           // Wait for assets
     * await saveCharacter(card, importer.assets)
     * ```
     */
    async parse(data:Uint8Array|File|ReadableStream<Uint8Array>){
        // Create completion promise at the start of parsing
        this.completionPromise = this.#awaitCompletion()
        // parse may fail before the caller gets to done().
        void this.completionPromise.catch(() => {})

        // Convert all input types to ReadableStream for uniform processing
        this.inputTotal = data instanceof Uint8Array
            ? data.byteLength
            : data instanceof File
                ? data.size
                : undefined
        const stream = this.#toStream(data)

        const reader = stream.getReader()
        try {
        while(true){
            this.transaction?.check()
            const {done, value} = await reader.read()
            if(value){
                this.inputBytes += value.byteLength
                this.importProgress?.({
                    phase: 'reading',
                    completed: this.inputBytes,
                    ...(this.inputTotal === undefined ? {} : { total: this.inputTotal }),
                })
                await this.#feedChunk(value, false)
            }
            if(done){
                await this.#feedChunk(new Uint8Array(0), true)
                break
            }
        }
        } catch (error) {
            await reader.cancel().catch(() => {})
            // Drain already queued writes before the caller rolls back.
            await this.assetBatcher.done().catch(() => {})
            this.completionSettled = true
            this.completionRejecter?.(error instanceof Error ? error : new Error(String(error)))
            throw error
        } finally {
            reader.releaseLock()
        }
    }

    /**
     * Feeds a chunk of ZIP data to the streaming parser.
     * When final=true, marks input as complete and finalizes the save queue.
     */
    async #feedChunk(data:Uint8Array, final:boolean = false){
        this.transaction?.check()
        // fflate recursively visits entries within each push. Bound every input
        // source, including externally supplied streams, to avoid stack overflow
        // on archives containing thousands of tiny entries.
        const parserChunkSize = 32 * 1024
        for (let offset = 0; offset < data.length; offset += parserChunkSize) {
            this.transaction?.check()
            this.unzip.push(data.subarray(offset, offset + parserChunkSize), false)
            await this.assetBatcher.waitForCapacity()
            // Permit cancel clicks even for in-memory or highly compressed ZIPs.
            await yieldImportTask()
        }
        if (final) this.unzip.push(new Uint8Array(0), true)
        this.transaction?.check()
        if(final){
            this.inputFinalized = true
            this.#tryFinalize()
        }
    }

    /**
     * Returns a promise that resolves when all assets have been processed.
     * Must be called after parse() has been invoked.
     */
    async done(){
        if (!this.completionPromise) {
            throw new Error('parse() must be called before done()')
        }
        return this.completionPromise
    }

    #awaitCompletion(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            this.completionResolver = resolve
            this.completionRejecter = reject
            this.completionSettled = false
            this.errors = []
        })
    }

    /**
     * Converts various data types to ReadableStream for uniform processing.
     */
    #toStream(data: Uint8Array|File|ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
        // Already a stream - return as-is
        if(data instanceof ReadableStream){
            return data
        }

        // File has built-in stream() method
        if(data instanceof File){
            return data.stream()
        }

        // Convert Uint8Array to stream, chunked to prevent blocking
        let offset = 0
        return new ReadableStream({
            pull(controller) {
                if (offset >= data.byteLength) {
                    controller.close()
                    return
                }
                const end = Math.min(offset + CHUNK_SIZE_BYTES, data.byteLength)
                controller.enqueue(data.subarray(offset, end))
                offset = end
            }
        })
    }

    /**
     * Called when a new file is discovered in the ZIP archive.
     * Sets up streaming handlers and starts processing if file size is acceptable.
     */
    #handleFile(file: fflate.UnzipFile) {
        const assetIndex = file.name
        this.discoveredEntries += 1
        this.importProgress?.({ phase: 'scanning', completed: this.discoveredEntries })
        // Only process files smaller than MAX_ASSET_SIZE_BYTES (100 MiB)
        if((file.originalSize ?? 0) < MAX_ASSET_SIZE_BYTES){
            this.assetBuffers[assetIndex] = new AppendableBuffer()
            this.openFiles += 1
            file.ondata = (error, dat, final) => this.#handleFileData(assetIndex, error, dat, final)
            file.start()
        } else {
            this.excludedFiles.push(assetIndex)
        }
    }

    /**
     * Called for each chunk of file data as it streams in.
     * Accumulates chunks into buffer until file is complete.
     */
    #handleFileData(fileName: string, error: Error | null, data: Uint8Array, final: boolean) {
        if (error) {
            this.errors.push(error)
            delete this.assetBuffers[fileName]
            this.openFiles -= 1
            this.#tryFinalize()
            return
        }
        this.assetBuffers[fileName].append(data)
        if(final){
            this.#handleFileComplete(fileName)
            this.extractedEntries += 1
            this.importProgress?.({
                phase: 'extracting',
                completed: this.extractedEntries,
                ...(this.inputFinalized ? { total: this.discoveredEntries } : {}),
            })
            this.openFiles -= 1
            this.#tryFinalize()
        }
    }

    /**
     * Called when a file has been completely read from the ZIP.
     * Routes files to appropriate handlers based on filename/extension.
     */
    #handleFileComplete(fileName: string) {
        const assetData = this.assetBuffers[fileName].buffer

        if(assetData.byteLength > MAX_ASSET_SIZE_BYTES){
            this.excludedFiles.push(fileName)
        }
        else if(fileName === 'card.json'){
            this.cardData = new TextDecoder().decode(assetData)
        }
        else if(fileName === 'module.risum'){
            this.moduleData = assetData
        }
        else if(fileName.endsWith('.json')){
            // Ignore other JSON files
        }
        else{
            // All other files are treated as assets (images, etc.)
            this.importProgress?.({
                phase: 'preparing-assets',
                completed: Object.keys(this.assets).length + 1,
                ...(this.inputFinalized ? { total: this.discoveredEntries } : {}),
            })
            this.assetBatcher.enqueue({
                id: fileName,
                data: assetData
            })
        }

        delete this.assetBuffers[fileName]
    }

    #tryFinalize() {
        if (!this.inputFinalized || this.openFiles > 0 || this.finalizationStarted) return
        this.finalizationStarted = true
        void this.#finalize()
    }

    async #finalize(){
        try {
            this.importProgress?.({ phase: 'finalizing', completed: 0 })
            await this.assetBatcher.done()
            if(this.hashSignal){
                await saveAsset(new TextEncoder().encode(this.hashSignal))
            }
            if (this.errors.length > 0) {
                throw this.errors.length === 1
                    ? this.errors[0]
                    : new AggregateError(this.errors, `Failed to read ${this.errors.length} CharX entries`)
            }
            this.completionSettled = true
            this.completionResolver?.()
        } catch (error) {
            this.completionSettled = true
            this.completionRejecter?.(error instanceof Error ? error : new Error(String(error)))
        }
    }
}


/**
 * Checks if a CharX file's assets already exist on the server.
 *
 * This optimization allows skipping asset uploads when importing from the hub:
 * 1. Hashes the entire file
 * 2. Double-hashes the hash (for privacy/security)
 * 3. Checks if server has this hash registered
 *
 * If successful, the importer can skip saving assets and just reference server copies.
 *
 * @returns {success: boolean, hash: string} - Whether assets exist on server, and the file hash
 */
export async function CharXSkippableChecker(data:Uint8Array){
    const hashed = await hasher(data)
    const reHashed = await hasher(new TextEncoder().encode(hashed))
    const x = await fetch(hubURL + '/rs/assets/' + reHashed + '.png')
    return {
        success: x.status >= HTTP_STATUS_OK_MIN && x.status < HTTP_STATUS_OK_MAX,
        hash: hashed
    }
}
