import { afterEach, expect, test, vi } from 'vitest';
import { Buffer } from 'buffer';
import { nativeDownloadStream } from './nativeDownload';
import { playNative } from './transferNative';

vi.mock('./transferNative', () => ({ playNative: vi.fn() }));
afterEach(() => vi.resetAllMocks());

test('streams a binary subview larger than the bridge limit in exact ordered chunks', async () => {
    const input = Uint8Array.from({ length: 10 * 1024 * 1024 + 17 }, (_, i) => i % 251);
    const received: Buffer[] = [];
    let offset = 0;
    vi.mocked(playNative).mockImplementation(async (op, args: any) => {
        if (op === 'download.begin') return 'handle' as any;
        if (op === 'download.append') {
            expect(args.offset).toBe(offset);
            const bytes = Buffer.from(args.data, 'base64');
            expect(bytes.length).toBeLessThanOrEqual(256 * 1024);
            received.push(bytes); offset += bytes.length;
        }
        return undefined as any;
    });
    const writer = (await nativeDownloadStream('캐릭터_chat.json')).getWriter();
    await writer.write(input.subarray(3, input.length - 7));
    await writer.close();
    expect(Buffer.concat(received).equals(Buffer.from(input.subarray(3, input.length - 7)))).toBe(true);
    expect(playNative).toHaveBeenLastCalledWith('download.save', { handle: 'handle', name: '캐릭터_chat.json', bytes: input.length - 10 });
});

test.each(['download.append', 'download.save'])('cleans partial bytes on %s failure without opening a false-success picker', async failing => {
    vi.mocked(playNative).mockImplementation(async op => {
        if (op === 'download.begin') return 'handle' as any;
        if (op === failing) throw new Error('disk full / busy');
        return undefined as any;
    });
    const writer = (await nativeDownloadStream('test.png')).getWriter();
    if (failing === 'download.append') await expect(writer.write(new Uint8Array([0, 255]))).rejects.toThrow('disk full');
    else { await writer.write(new Uint8Array([0, 255])); await expect(writer.close()).rejects.toThrow('busy'); }
    expect(playNative).toHaveBeenLastCalledWith('download.abort', { handle: 'handle' });
});

test('empty files and explicit abort release their own temporary handle', async () => {
    vi.mocked(playNative).mockResolvedValue('empty' as any);
    const writer = (await nativeDownloadStream('empty.txt')).getWriter();
    await writer.close();
    expect(playNative).toHaveBeenLastCalledWith('download.save', { handle: 'empty', name: 'empty.txt', bytes: 0 });
    await (await nativeDownloadStream('cancel.txt')).abort();
    expect(playNative).toHaveBeenLastCalledWith('download.abort', { handle: 'empty' });
});
