import { describe, expect, it, vi } from 'vitest'
import { unzipSync } from 'fflate'
vi.mock('../process/files/inlays', () => ({ getInlayAssetBlob: vi.fn(async (id: string) => id === 'gone' ? null : { ext: 'webp', data: new Blob([id]) }) }))
vi.mock('./gallery', () => ({ loadPainterGalleryRecord: vi.fn(async (id: string) => id === 'a' ? { version: 1, seed: 7 } : null) }))
import { readArchiveFiles, usedInlayIds, writeArchiveFolder, zipArchiveFiles } from './galleryArchive'

describe('gallery archive', () => {
    it('collects images shown in chats, swipes, greetings and lore, reading unloaded chats read-only', async () => {
        const fetchChat = vi.fn(async () => ({ id: 'far', message: [{ role: 'char', data: '{{inlayed::far}}' }] }) as never)
        const bot = { chaId: 'bot', firstMessage: '{{inlay::greet}}', alternateGreetings: ['{{inlay::alt}}'], desc: '', globalLore: [{ content: '{{inlayeddata::lore}}' }],
            chats: [{ id: 'near', message: [{ role: 'char', data: 'x {{inlay::near}}', swipes: ['{{inlay::swipe}}'] }] }, { id: 'far', name: '먼 챗', _placeholder: true }] } as never
        expect([...await usedInlayIds(bot, fetchChat)].sort()).toEqual(['alt', 'far', 'greet', 'lore', 'near', 'swipe'])
        expect(fetchChat).toHaveBeenCalledWith('bot', 1, 'far')
        await expect(usedInlayIds(bot, async () => null)).rejects.toThrow('먼 챗')
    })
    it('zips images with their generation record and reports images it cannot read', async () => {
        const { files, ids, failed } = await readArchiveFiles([{ id: 'a', label: '챗/1' }, { id: 'b', label: '챗/1' }, { id: 'gone', label: 'x' }])
        expect(ids).toEqual(['a', 'b']); expect(failed).toEqual(['gone'])
        expect(Object.keys(unzipSync(zipArchiveFiles(files)))).toEqual(['챗_1_a.webp', '챗_1_a.json', '챗_1_b.webp'])
    })
    it('counts an image as archived only when all of its files were written', async () => {
        const written: string[] = []
        const folder = { getFileHandle: async (name: string) => ({ createWritable: async () => ({ write: async () => { if (name.endsWith('.json')) throw new Error('disk full'); written.push(name) }, close: async () => {} }) }) }
        const saved = await writeArchiveFolder(folder, [{ id: 'a', name: 'a.webp', data: new Uint8Array() }, { id: 'a', name: 'a.json', data: new Uint8Array() }, { id: 'b', name: 'b.webp', data: new Uint8Array() }])
        expect([...saved]).toEqual(['b'])
        expect(written).toEqual(['a.webp', 'b.webp'])
    })
})
