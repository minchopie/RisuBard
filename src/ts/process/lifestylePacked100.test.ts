import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const mocks = vi.hoisted(() => ({
    events: [] as string[],
    alertWait: vi.fn(),
    decodeRPackBatch: vi.fn<(data: Uint8Array[]) => Promise<Uint8Array[]>>(async (data) => data.map(item => Buffer.from(item))),
    decodeRPack: vi.fn<(data: Uint8Array) => Promise<Uint8Array>>(async (data) => Buffer.from(data)),
    hasher: vi.fn(async (data: Uint8Array) => `hash-${data[0]}`),
    saveAsset: vi.fn<(data: Uint8Array) => Promise<string>>(async () => 'single-write'),
    readImage: vi.fn(),
    requestImmediateSave: vi.fn(),
    selectSingleFile: vi.fn(),
    setItems: vi.fn<(entries: Array<{ key: string; value: Uint8Array }>) => Promise<void>>(async () => undefined),
    database: {
        current: {
            characters: [],
            characterOrder: [],
            modules: [] as Array<{ id: string, name: string, description: string }>,
            enabledModules: [] as string[],
            personaEnabledModules: {} as Record<string, string[]>,
            personas: [] as Array<{ id?: string }>,
            selectedPersona: 0,
        },
    },
}))

vi.mock('src/lang', async () => ({
    language: {
        importInstall: (await import('src/lang/en')).languageEnglish.importInstall,
        errors: { noData: 'no data' },
        successImport: 'imported',
        fileDropImport: {
            moduleAssets: (completed: number, total: number) =>
                `module assets ${completed} / ${total}`,
        },
    },
}))
vi.mock('../alert', () => ({
    alertClear: vi.fn(),
    alertConfirm: vi.fn(),
    alertError: vi.fn(),
    alertModuleSelect: vi.fn(),
    alertNormal: vi.fn(),
    alertStore: { set: vi.fn() },
    alertWait: mocks.alertWait,
    notifySuccess: vi.fn(() => mocks.events.push('notified')),
}))
vi.mock('../storage/database.svelte', () => ({
    getCurrentCharacter: vi.fn(),
    getCurrentChat: vi.fn(),
    getDatabase: vi.fn(() => mocks.database.current),
    setCurrentCharacter: vi.fn(),
    setDatabase: vi.fn(),
}))
vi.mock('../globalApi.svelte', () => ({
    AppendableBuffer: class {
        parts: Uint8Array[] = []
        append(data: Uint8Array) { this.parts.push(data) }
        get buffer() { return Buffer.concat(this.parts) }
    },
    downloadFile: vi.fn(),
    forageStorage: { setItems: mocks.setItems, keys: vi.fn(async () => []), cleanupImportAssets: vi.fn(async () => {}), prepareImportRollback: vi.fn(async () => {}), observeImportProgress: vi.fn(async () => () => {}) },
    LocalWriter: class {},
    readImage: mocks.readImage,
    requestImmediateSave: mocks.requestImmediateSave,
    saveAsset: mocks.saveAsset,
    VirtualWriter: class {},
}))
vi.mock('../util', () => ({
    checkPersonaBinded: vi.fn(),
    selectSingleFile: mocks.selectSingleFile,
    sleep: vi.fn(async () => undefined),
}))

vi.mock('./lorebook.svelte', () => ({ convertExternalLorebook: vi.fn() }))
vi.mock('../media', () => ({ compressImage: vi.fn(async data => data) }))
vi.mock('../rpack/rpack_js', () => ({
    decodeRPackBatch: mocks.decodeRPackBatch,
    decodeRPack: mocks.decodeRPack,
    encodeRPack: vi.fn(async data => data),
}))
vi.mock('../stores.svelte', () => ({
    HideIconStore: { set: vi.fn() },
    moduleBackgroundEmbedding: { set: vi.fn() },
    ReloadGUIPointer: { set: vi.fn() },
}))
vi.mock('svelte/store', async (original) => ({ ...await original<typeof import('svelte/store')>() }))
vi.mock('../interchangeability', () => ({
    convertCharacterToModule: vi.fn(),
    convertModuleToCharacter: vi.fn(),
}))
vi.mock('../characterCards', () => ({
    exportCharacterCard: vi.fn(),
    importCharacterProcess: vi.fn(),
}))
vi.mock('../parser/parser.svelte', () => ({ hasher: mocks.hasher }))

import { exportModuleLegacy, getModules, importModule, importRisum, readModule, refreshModules, resolveModuleIds } from './modules'
import * as modulesApi from './modules'
// Upstream v0.9.84 exports prepareImportedModule: an imported module keeps the file's id as `updateLineage` (the next version of
// the same file can update it) before receiving a fresh id. Older upstreams (v0.9.71 base, v0.9.81) only assign the fresh id.
// The same payload test runs on every target, so each contract is asserted strictly on the target that defines it.
const lineageImport = typeof Reflect.get(modulesApi, 'prepareImportedModule') === 'function'
import { getCurrentCharacter, getCurrentChat } from '../storage/database.svelte'

function uint32le(value: number) {
    const bytes = Buffer.alloc(4)
    bytes.writeUInt32LE(value)
    return bytes
}

const here = dirname(fileURLToPath(import.meta.url))
const map = fs.readFileSync(join(here, '../rpack/rpack_map.bin'))
mocks.decodeRPack.mockImplementation(async data => Uint8Array.from(data, byte => map[256 + byte]))
function packedModule(module: unknown) {
    const json = Buffer.from(JSON.stringify({ type: 'risuModule', module }))
    const encoded = Uint8Array.from(json, byte => map[byte])
    expect(Buffer.from(encoded.map(byte => map[256 + byte]))).toEqual(json)
    return Buffer.concat([Buffer.from([111, 0]), uint32le(encoded.length), encoded, Buffer.from([0])])
}


const a=JSON.parse(fs.readFileSync(join(here,'../parser/tests/fixtures/lifestyle-a100.json'),'utf8')).module;
const b=JSON.parse(fs.readFileSync(join(here,'../parser/tests/fixtures/lifestyle-b100.json'),'utf8')).module;
describe('Life lifestyle portable packed import — module JSON fixture and actual readModule',()=>{
  it.each([['A',a],['B',b]])('imports generated packed %s without assets or executable effects',async(_tag,expected)=>{
    const bytes=packedModule(expected);
    const actual=await readModule(bytes);
    expect(actual.id).not.toBe(expected.id);
    expect(actual.id).toMatch(/^[0-9a-f-]{36}$/);
    expect('updateLineage' in actual).toBe(lineageImport);
    expect(actual).toEqual({...expected,id:actual.id,...(lineageImport?{updateLineage:expected.id}:{})});
    expect(actual.lowLevelAccess).toBe(false);
    expect(actual.trigger).toEqual([]);expect(actual.regex).toEqual([]);expect(actual.assets).toEqual([]);
    expect(mocks.saveAsset).not.toHaveBeenCalled();
  });
  it('rejects a truncated packed module',async()=>{
    const bytes=packedModule(a);
    await expect(readModule(bytes.subarray(0,bytes.length-1))).rejects.toThrow('Truncated');
  });
  it('reimporting creates separate ids, so users must enable only one copy',async()=>{
    const bytes=packedModule(a);
    const first=await readModule(bytes),second=await readModule(bytes);
    expect(first.id).not.toBe(second.id);
    expect(first.lorebook).toEqual(second.lorebook);
    if(lineageImport){expect(first).toMatchObject({updateLineage:a.id});expect(second).toMatchObject({updateLineage:a.id});}
  });
});
