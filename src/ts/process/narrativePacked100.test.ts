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
const mapping = fs.readFileSync(join(here, '../rpack/rpack_map.bin'))
mocks.decodeRPack.mockImplementation(async data => Uint8Array.from(data, byte => mapping[256 + byte]))
function packedModule(module: unknown) {
    const json = Buffer.from(JSON.stringify({ type: 'risuModule', module }))
    const encoded = Uint8Array.from(json, byte => mapping[byte])
    expect(Buffer.from(encoded.map(byte => mapping[256 + byte]))).toEqual(json)
    return Buffer.concat([Buffer.from([111, 0]), uint32le(encoded.length), encoded, Buffer.from([0])])
}



const expected=JSON.parse(fs.readFileSync(join(here,'../parser/tests/fixtures/narrative100.json'),'utf8')).module;
describe('Narration100 portable packed import — module JSON fixture and actual readModule',()=>{
 it('imports a generated pack and preserves existing modules/activation',async()=>{
  const packed=packedModule(expected);
  const old={id:'old-life',name:'Existing Life',description:'keep'};
  mocks.database.current.modules=[old];mocks.database.current.enabledModules=['old-life'];
  const imported=await readModule(packed);
  expect(imported.id).not.toBe(expected.id);
  expect('updateLineage' in imported).toBe(lineageImport);
  expect({...imported,id:expected.id}).toEqual({...expected,...(lineageImport?{updateLineage:expected.id}:{})});
  expect(mocks.database.current.modules).toEqual([old]);
  expect(mocks.database.current.enabledModules).toEqual(['old-life']);
 });
 it('rejects a truncated packed payload',async()=>{
  const packed=packedModule(expected);
  await expect(readModule(packed.subarray(0,20))).rejects.toThrow();
 });
});
