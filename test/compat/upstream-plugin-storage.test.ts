/**
 * Upstream RisuAI plugin storage layouts reaching RisuBard through a .bin
 * backup: v2026.10.210's `_coldpluginIndex` pointer and cad8595a's
 * `_coldplugin` map. Both are folded back into plain inline keys on import;
 * the cold rows stay, and what cannot be restored is recorded and reported.
 */
import { describe, test, expect, afterAll } from 'vitest'
import * as fflate from 'fflate'
import { spawnServer, type ServerHandle } from './helpers/spawnServer.js'
import { createClient, type RisuClient } from './helpers/client.js'
import { encodeBackup } from './helpers/encode.js'
import { decodeBackup } from './helpers/decode.js'
import { normalizeBackup } from './helpers/normalize.js'

const IDX = '9a1b2c3d-4e5f-4a6b-8c7d-0e1f2a3b4c5d'
const BIG = '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b'
const OLD_IDX = '2b3c4d5e-6f70-4182-9a3b-4c5d6e7f8091'
const LEGACY = '3c4d5e6f-7081-4293-8b4c-5d6e7f809102'
const LEGACY_MISSING = '4d5e6f70-8192-43a4-9c5d-6e7f80910213'

const MAGIC_RISUSAVE = Buffer.from('RISUSAVE\0', 'latin1')

const baseDb = {
  characters: [], apiType: 'openai', botPresets: [], botPresetsId: 0, personas: [],
  moduleIntergration: [], selectedCharacter: 0,
}

const index = (entries: unknown[], trash: unknown[] = []) => ({ type: 'risu-plugin-storage-index', version: 1, entries, trash })

// One RisuSave block, gzip-compressed like upstream's encodeRisuSave.
function block(type: number, name: string, content: unknown) {
  const nameBuf = Buffer.from(name, 'utf-8')
  const data = Buffer.from(fflate.gzipSync(Buffer.from(JSON.stringify(content), 'utf-8')))
  const head = Buffer.alloc(3 + nameBuf.length + 4)
  head[0] = type
  head[1] = 1
  head[2] = nameBuf.length
  nameBuf.copy(head, 3)
  head.writeUInt32LE(data.length, 3 + nameBuf.length)
  return Buffer.concat([head, data])
}

// The shape upstream v2026.10.210 writes: ROOT (which also repeats
// pluginCustomStorage) followed by the PLUGIN_STORAGE block.
function upstreamBackup(pluginCustomStorage: Record<string, unknown>, cold: Record<string, unknown>) {
  const database = Buffer.concat([
    MAGIC_RISUSAVE,
    block(1, 'root', { ...baseDb, pluginCustomStorage }),
    block(11, 'pluginStorage', pluginCustomStorage),
  ])
  return encodeBackup([
    ...Object.entries(cold).map(([id, value]) => ({ name: `coldstorage_${id}.json`, data: Buffer.from(JSON.stringify(value)) })),
    { name: 'database.risudat', data: database },
  ])
}

const servers: ServerHandle[] = []
afterAll(async () => { await Promise.allSettled(servers.map(s => s.cleanup())) })

async function boot(): Promise<RisuClient> {
  const srv = await spawnServer()
  servers.push(srv)
  return createClient(srv.port, srv.password)
}

describe('upstream plugin storage cold layouts', () => {
  const memory = { entries: [{ id: 1, text: '기억' }], version: 3 }
  const bigValue = { chunks: 'y'.repeat(300 * 1024) }
  const coldIndex = index([
    { k: 'ltm/memory', s: JSON.stringify(memory) },
    { k: 'ltm/big', l: BIG },
    { k: 'v2/written', s: '"older index copy"' },
  ], [{ id: OLD_IDX, at: 1, index: true }])

  test('a v2026.10.210 .bin import restores the index into plain keys and keeps no reserved key', async () => {
    const client = await boot()
    const result = await client.importBackup(upstreamBackup(
      // A key written after upstream loaded its index stays inline and wins.
      { _coldpluginIndex: IDX, 'v2/written': 'newer inline value' },
      { [IDX]: coldIndex, [BIG]: bigValue },
    )) as Record<string, unknown>
    expect(result.ok).toBe(true)
    expect(result.pluginStorageColdFailed).toBe(0)

    const exported = await client.exportBackup()
    const { raw } = normalizeBackup(exported) as any
    expect(raw.pluginCustomStorage).toEqual({
      'ltm/memory': memory,
      'ltm/big': bigValue,
      'v2/written': 'newer inline value',
    })
    expect(raw.nodeOnlyPluginStorageRecovery).toEqual([expect.objectContaining({
      source: 'database', pointer: IDX, trashCount: 1, shadowedIndexKeys: ['v2/written'],
    })])
    // The cold rows are still there for manual recovery.
    const names = decodeBackup(exported).map(e => e.name)
    expect(names.some(n => n.includes(IDX))).toBe(true)
    expect(names.some(n => n.includes(BIG))).toBe(true)
  })

  test('a missing large item is reported and recorded, the other keys restore', async () => {
    const client = await boot()
    const result = await client.importBackup(upstreamBackup({ _coldpluginIndex: IDX }, { [IDX]: coldIndex })) as Record<string, unknown>
    expect(result.ok).toBe(true)
    expect(result.pluginStorageColdFailed).toBe(1)

    const { raw } = normalizeBackup(await client.exportBackup()) as any
    expect(Object.keys(raw.pluginCustomStorage).sort()).toEqual(['ltm/memory', 'v2/written'])
    expect(raw.nodeOnlyPluginStorageRecovery[0].failedEntries).toEqual([{ k: 'ltm/big', l: BIG }])
  })

  test('a cad8595a _coldplugin map restores, inline values win and unreadable keys are recorded', async () => {
    const client = await boot()
    const result = await client.importBackup(upstreamBackup(
      {
        _coldplugin: { 'ltm/config': LEGACY, 'ltm/memory': LEGACY, 'ltm/lost': LEGACY_MISSING },
        // Written after upstream moved it (an older build, a V2 plugin).
        'ltm/memory': 'written after the move',
        'other/flag': 'kept',
      },
      { [LEGACY]: 'config-string' },
    )) as Record<string, unknown>
    expect(result.ok).toBe(true)
    expect(result.pluginStorageColdFailed).toBe(1)

    const { raw } = normalizeBackup(await client.exportBackup()) as any
    expect(raw.pluginCustomStorage).toEqual({
      'ltm/config': 'config-string',
      'ltm/memory': 'written after the move',
      'other/flag': 'kept',
    })
    expect(raw.nodeOnlyPluginStorageRecovery).toEqual([expect.objectContaining({
      source: 'database', shadowedLegacyKeys: ['ltm/memory'], legacyFailed: { 'ltm/lost': LEGACY_MISSING },
    })])
  })
})
