import { Buffer } from 'buffer';
import { playNative } from './transferNative';

// close requests the picker; Android reports the actual save/cancel result.
// Keep binary exports off the WebView's unsupported blob/StreamSaver download path.
export async function nativeDownloadStream(name: string): Promise<WritableStream<Uint8Array>> {
    const handle = await playNative<string>('download.begin');
    let offset = 0;
    const abort = () => playNative('download.abort', { handle });
    return new WritableStream<Uint8Array>({
        async write(bytes) {
            try {
                for (let at = 0; at < bytes.byteLength; at += 256 * 1024) {
                    const chunk = bytes.subarray(at, at + 256 * 1024);
                    await playNative('download.append', { handle, offset, data: Buffer.from(chunk).toString('base64') });
                    offset += chunk.byteLength;
                }
            } catch (error) { await abort().catch(() => {}); throw error; }
        },
        async close() {
            try { await playNative('download.save', { handle, name, bytes: offset }); }
            catch (error) { await abort().catch(() => {}); throw error; }
        },
        async abort() { await abort(); },
    });
}
