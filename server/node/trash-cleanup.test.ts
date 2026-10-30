import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { cleanupTrash, retentionDays } = require('./trash-cleanup.cjs')

const roots: string[] = []
function root() {
    const value = fs.mkdtempSync(path.join(os.tmpdir(), 'risubard-trash-'))
    roots.push(value)
    return value
}
afterEach(() => roots.splice(0).forEach(value => fs.rmSync(value, { recursive: true, force: true })))

const DAY = 24 * 60 * 60 * 1000

describe('trash cleanup', () => {
    it('removes only entries older than the retention window and keeps the recovery journal', async () => {
        const dataRoot = root()
        const trash = path.join(dataRoot, 'trash')
        for (const name of ['old', 'recent', 'live-files-recovery']) {
            fs.mkdirSync(path.join(trash, name), { recursive: true })
            fs.writeFileSync(path.join(trash, name, 'file.txt'), name)
        }
        expect(await cleanupTrash(dataRoot, { days: 14, now: Date.now() + 10 * DAY })).toEqual([])
        const removed = await cleanupTrash(dataRoot, { days: 14, now: Date.now() + 30 * DAY })
        expect(removed.sort()).toEqual(['old', 'recent'])
        expect(fs.existsSync(path.join(trash, 'live-files-recovery/file.txt'))).toBe(true)

        fs.mkdirSync(path.join(trash, 'fresh'))
        expect(await cleanupTrash(dataRoot, { days: 14 })).toEqual([])
        expect(fs.existsSync(path.join(trash, 'fresh'))).toBe(true)
    })

    it('does nothing when disabled or when there is no trash folder', async () => {
        const dataRoot = root()
        expect(await cleanupTrash(dataRoot, { days: 14 })).toEqual([])
        fs.mkdirSync(path.join(dataRoot, 'trash/old'), { recursive: true })
        expect(await cleanupTrash(dataRoot, { days: 0, now: Date.now() + 99 * DAY })).toEqual([])
        expect(fs.existsSync(path.join(dataRoot, 'trash/old'))).toBe(true)
    })

    it('reads the retention days from the environment', () => {
        // Personal fork: off by default; an explicit value opts in.
        expect(retentionDays({})).toBe(0)
        expect(retentionDays({ RISUBARD_TRASH_RETENTION_DAYS: '' })).toBe(0)
        expect(retentionDays({ RISUBARD_TRASH_RETENTION_DAYS: '14' })).toBe(14)
        expect(retentionDays({ RISUBARD_TRASH_RETENTION_DAYS: '3' })).toBe(3)
        expect(retentionDays({ RISUBARD_TRASH_RETENTION_DAYS: '0' })).toBe(0)
        expect(retentionDays({ RISUBARD_TRASH_RETENTION_DAYS: 'x' })).toBe(0)
    })

    it('keeps existing trash by default and every recovery copy when cleanup is opted in', async () => {
        const dataRoot = root()
        const trash = path.join(dataRoot, 'trash')
        const files = ['ordinary-old/file.txt', 'live-files-recovery/pending.json',
            'transaction-recovery/journal/original', 'shutdown-recovery/copy.bin']
        for (const file of files) {
            fs.mkdirSync(path.dirname(path.join(trash, file)), { recursive: true })
            fs.writeFileSync(path.join(trash, file), file)
        }
        const later = Date.now() + 30 * DAY
        expect(await cleanupTrash(dataRoot, { days: retentionDays({}), now: later })).toEqual([])
        expect(await cleanupTrash(dataRoot, { now: later })).toEqual([])
        expect(files.every(file => fs.readFileSync(path.join(trash, file), 'utf8') === file)).toBe(true)

        expect(await cleanupTrash(dataRoot, { days: retentionDays({ RISUBARD_TRASH_RETENTION_DAYS: '14' }), now: later }))
            .toEqual(['ordinary-old'])
        expect(fs.existsSync(path.join(trash, 'ordinary-old'))).toBe(false)
        expect(files.slice(1).every(file => fs.readFileSync(path.join(trash, file), 'utf8') === file)).toBe(true)
    })
})
