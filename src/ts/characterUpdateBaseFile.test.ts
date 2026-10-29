import { describe, expect, test, vi } from 'vitest'
import { strToU8, zipSync } from 'fflate'

vi.mock('src/lang', () => ({ language: { characterUpdate: { baseFileUnsupported: 'unsupported' } } }))
vi.mock('./globalApi.svelte', () => ({ AppendableBuffer: class {} }))
vi.mock('./pngChunk', () => ({ PngChunk: { readGenerator: async function* () {} } }))
vi.mock('./characterCards', () => ({
    convertCharbook: ({ charbook }: any) => ({ lorebook: charbook.entries.map((entry: any) => ({ comment: entry.comment, content: entry.content, key: entry.keys.join(','), mode: 'normal' })) }),
}))
vi.mock('./process/modules', () => ({ readModuleMetadata: vi.fn(async () => null) }))
vi.mock('./interchangeability', () => ({
    convertCharacterToModule: (char: any) => ({ id: 'random', name: char.name, description: char.creatorNotes, lorebook: char.globalLore, assets: [['a', 'assets/x.png', 'png']] }),
}))

import { readUpdateBaseFile } from './characterUpdateBaseFile'

const card = {
    spec: 'chara_card_v3',
    data: {
        name: 'Old', description: 'old desc', first_mes: 'hi', creator_notes: 'notes',
        character_book: { entries: [{ comment: 'Town', content: 'old town', keys: ['town'] }] },
        extensions: { risuai: { customScripts: [{ comment: 'r', in: 'a', out: 'b', type: 'editoutput' }] } },
    },
}

describe('reading an earlier version as the base', () => {
    test('reads the card text of a JSON or CHARX bot without installing it', async () => {
        const fromJson = await readUpdateBaseFile('character', { name: 'old.json', data: strToU8(JSON.stringify(card)) })
        expect(fromJson).toMatchObject({ name: 'Old', desc: 'old desc', firstMessage: 'hi', globalLore: [{ comment: 'Town', content: 'old town' }], customscript: [{ out: 'b' }] })
        const fromCharx = await readUpdateBaseFile('character', { name: 'old.charx', data: zipSync({ 'card.json': strToU8(JSON.stringify(card)) }) })
        expect(fromCharx).toEqual(fromJson)
    })

    test('reads a module file and leaves out ids and asset paths', async () => {
        const module = { type: 'risuModule', id: 'file-id', name: 'Pack', description: 'd', lorebook: [], assets: [['a', 'assets/x.png', 'png']], updateBase: 'assets/b.json' }
        expect(await readUpdateBaseFile('module', { name: 'pack.json', data: strToU8(JSON.stringify(module)) })).toEqual({ name: 'Pack', description: 'd', lorebook: [] })
        const fromCard = await readUpdateBaseFile('module', { name: 'pack.json', data: strToU8(JSON.stringify(card)) })
        expect(fromCard).toMatchObject({ name: 'Old', description: 'notes' })
        expect(fromCard).not.toHaveProperty('assets')
        expect(fromCard).not.toHaveProperty('id')
    })

    test('rejects files that are not cards', async () => {
        await expect(readUpdateBaseFile('character', { name: 'x.json', data: strToU8('{"hello":1}') })).rejects.toThrow('unsupported')
    })
})
