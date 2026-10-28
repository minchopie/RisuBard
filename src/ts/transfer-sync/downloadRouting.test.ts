import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { Buffer } from 'buffer';
import { afterEach, expect, test, vi } from 'vitest';

// Run the actual public entry points with only platform I/O replaced.
const source = readFileSync('src/ts/globalApi.svelte.ts', 'utf8');
const ast = ts.createSourceFile('globalApi.ts', source, ts.ScriptTarget.Latest, true);
const selected = ast.statements.filter(s => (ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s)) && ['downloadFile', 'LocalWriter'].includes(s.name?.text ?? ''));
const code = ts.transpileModule(selected.map(s => s.getText(ast)).join('\n'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
afterEach(() => vi.unstubAllGlobals());
function fixture() {
    const chunks: Uint8Array[] = [];
    const close = vi.fn();
    const nativeDownloadStream = vi.fn(async () => new WritableStream<Uint8Array>({ write(bytes) { chunks.push(bytes) }, close }));
    const streamSaver = { createWriteStream: vi.fn(() => new WritableStream()) };
    const url = { createObjectURL: vi.fn(() => 'blob:download'), revokeObjectURL: vi.fn() };
    const notifyError = vi.fn();
    const exports: any = {};
    new Function('exports', 'require', 'Buffer', 'URL', 'document', 'setTimeout', 'notifyError', 'streamSaver', code)(exports, () => ({ nativeDownloadStream }), Buffer, url, document, vi.fn(), notifyError, streamSaver);
    return { ...exports, nativeDownloadStream, chunks, close, streamSaver, url, notifyError };
}
test('Android text and binary exports use the native save path, never blob anchors', async () => {
    vi.stubGlobal('RisuPlay', {});
    const f = fixture();
    await f.downloadFile('한글_chat.json', '{"data":"대화"}');
    await f.downloadFile('persona.png', new Uint8Array([9, 0, 255, 3]).subarray(1, 3));
    expect(Buffer.from(f.chunks[0]).toString('utf8')).toBe('{"data":"대화"}');
    expect(Array.from(f.chunks[1])).toEqual([0, 255]);
    expect(f.close).toHaveBeenCalledTimes(2);
    expect(f.url.createObjectURL).not.toHaveBeenCalled();
});
test('PC/browser still uses the existing blob anchor and StreamSaver', async () => {
    vi.stubGlobal('RisuPlay', undefined);
    const f = fixture();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await f.downloadFile('chat.json', new Uint8Array([0, 255]));
    expect(f.url.createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    const writer = new f.LocalWriter();
    await writer.init('card', ['charx']);
    expect(f.streamSaver.createWriteStream).toHaveBeenCalledWith('card.charx');
    expect(f.nativeDownloadStream).not.toHaveBeenCalled();
    click.mockRestore();
});
test('streamed card writer uses native storage on Android', async () => {
    vi.stubGlobal('RisuPlay', {});
    const f = fixture();
    const writer = new f.LocalWriter();
    await writer.init('card', ['charx']);
    await writer.write(new Uint8Array([80, 75, 0, 255]));
    await writer.close();
    expect(f.nativeDownloadStream).toHaveBeenCalledWith('card.charx');
    expect(Array.from(f.chunks[0])).toEqual([80, 75, 0, 255]);
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.streamSaver.createWriteStream).not.toHaveBeenCalled();
});
test('native failures are visible even for legacy fire-and-forget callers', async () => {
    vi.stubGlobal('RisuPlay', {});
    const f = fixture();
    f.nativeDownloadStream.mockRejectedValue(new Error('storage unavailable'));
    await expect(f.downloadFile('chat.json', '{}')).rejects.toThrow('storage unavailable');
    expect(f.notifyError).toHaveBeenCalledWith('Error: storage unavailable');
});

test('chat-menu JSON bytes can be imported into a different character without changing the source', async () => {
    vi.stubGlobal('RisuPlay', {});
    const f = fixture();
    const text = readFileSync('src/ts/characters.ts', 'utf8');
    const ast = ts.createSourceFile('characters.ts', text, ts.ScriptTarget.Latest, true);
    const code = ts.transpileModule(ast.statements.filter(s => ts.isFunctionDeclaration(s) && ['exportChat', 'importChat'].includes(s.name?.text ?? '')).map(s => s.getText(ast)).join('\n'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const chat = { id: 'old-chat', name: '진행 중', message: [{ role: 'char', data: '대화 본문' }], note: '노트', scriptstate: { hp: 7 }, localLore: [] };
    const db = { characters: [{ chaId: 'source', name: '원래 캐릭터', chats: [structuredClone(chat)], chatFolders: [] }, { chaId: 'target', name: '새 캐릭터', chats: [], chatFolders: [] }] };
    let selected = 0;
    const errors = vi.fn(), save = vi.fn(), fork = vi.fn(async () => ({ sourceExists: true, forkToken: 'test-fork' }));
    const deps = {
        Buffer, alertSelect: async () => '0', selectedCharID: {}, get: () => selected, getDatabase: () => db,
        downloadFile: f.downloadFile, notifySuccess: vi.fn(), notifyInfo: vi.fn(), language: {}, alertError: errors,
        selectSingleFile: async () => ({ name: 'chat.json', data: f.chunks[0] }), v4: () => 'new-chat',
        normalizeChat: (value: unknown) => value, rebindPainterChatScope: vi.fn(), forkMemoryWiki: fork,
        forageStorage: { createAuth: vi.fn() }, createUniqueDisplayName: (name: string) => name,
        requestImmediateSave: save, completeMemoryWikiFork: vi.fn(),
    };
    const exports: any = {};
    new Function('exports', ...Object.keys(deps), code)(exports, ...Object.values(deps));
    await exports.exportChat(0);
    expect(errors).not.toHaveBeenCalled();
    expect(JSON.parse(Buffer.from(f.chunks[0]).toString()).sourceCharacterId).toBe('source');
    selected = 1;
    await exports.importChat();
    expect(errors).not.toHaveBeenCalled();
    expect(db.characters[0].chats).toEqual([chat]);
    expect(db.characters[1].chats).toEqual([{ ...chat, id: 'new-chat' }]);
    expect(save).toHaveBeenCalledWith({ forceFullWrite: true, rejectOnFailure: true });
    expect(fork).toHaveBeenCalledWith(expect.objectContaining({ characterId: 'source', destinationCharacterId: 'target', sourceChatId: 'old-chat', destinationChatId: 'new-chat' }));
});
