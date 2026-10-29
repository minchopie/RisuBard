import { describe, expect, test, vi } from 'vitest'
import { ImportTransaction } from './importTransaction'

function setup(existing: string[] = []) {
    const events: string[] = []
    const deps = {
        write: vi.fn(async (_entries: { key: string, value: Uint8Array }[]) => { events.push('write') }),
        journal: vi.fn(),
        removeOwners: vi.fn(async () => { events.push('owners') }),
        cleanup: vi.fn(async () => { events.push('cleanup') }),
        prepareRollback: vi.fn(async () => { events.push('protect') }),
    }
    return { tx: new ImportTransaction(new Set(existing), deps), deps, events }
}
describe('import rollback', () => {
    test('undoes in-memory changes to existing bots before removing new owners', async () => {
        const { tx, deps, events } = setup()
        await tx.write([{ key: 'assets/base.json', value: new Uint8Array() }])
        tx.onRollback(() => { events.push('undo-first') })
        tx.onRollback(() => { events.push('undo-second') })
        await tx.rollback()
        expect(events).toEqual(['write', 'undo-second', 'undo-first', 'owners', 'cleanup'])
        expect(deps.cleanup).toHaveBeenCalledWith(['assets/base.json'], tx.id)
    })
    test('journals before writes and preserves pre-existing keys', async () => {
        const { tx, deps } = setup(['assets/shared.png'])
        await tx.write([{ key: 'assets/shared.png', value: new Uint8Array() }, { key: 'assets/new.png', value: new Uint8Array() }])
        tx.register('character', 'new-character')
        await tx.rollback()
        expect(deps.write.mock.calls[0][0]).toEqual([{ key: 'assets/new.png', value: new Uint8Array() }])
        expect(deps.journal.mock.invocationCallOrder[0]).toBeLessThan(deps.write.mock.invocationCallOrder[0])
        expect(deps.cleanup).toHaveBeenCalledWith(['assets/new.png'], tx.id)
        expect(deps.removeOwners).toHaveBeenCalledWith([{ type: 'character', id: 'new-character' }])
        expect(deps.prepareRollback.mock.invocationCallOrder[0]).toBeLessThan(deps.removeOwners.mock.invocationCallOrder[0])
    })
    test('waits for a write already in flight before rolling back', async () => {
        const { tx, deps, events } = setup()
        let finish!: () => void
        deps.write.mockImplementationOnce(() => new Promise<void>(resolve => { finish = () => { events.push('write'); resolve() } }))
        const writing = tx.write([{ key: 'assets/new.png', value: new Uint8Array() }])
        tx.cancel()
        const rollback = tx.rollback()
        await Promise.resolve()
        expect(deps.cleanup).not.toHaveBeenCalled()
        finish()
        await writing
        await rollback
        expect(events).toEqual(['write', 'owners', 'cleanup'])
        await expect(tx.write([])).rejects.toThrow('Import cancelled')
    })
    test('failed owner persistence never deletes assets and retains recovery record', async () => {
        const { tx, deps } = setup()
        tx.register('module', 'm')
        deps.removeOwners.mockRejectedValueOnce(new Error('offline'))
        await expect(tx.rollback()).rejects.toThrow('offline')
        expect(deps.cleanup).not.toHaveBeenCalled()
        expect(deps.journal).not.toHaveBeenCalledWith(null)
        await tx.rollback()
        expect(deps.journal).toHaveBeenLastCalledWith(null)
    })
    test('failed or ambiguously acknowledged writes remain rollback candidates', async () => {
        const { tx, deps } = setup()
        deps.write.mockRejectedValueOnce(new Error('connection lost'))
        await expect(tx.write([{ key: 'assets/new.png', value: new Uint8Array() }])).rejects.toThrow()
        await tx.rollback()
        expect(deps.cleanup).toHaveBeenCalledWith(['assets/new.png'], tx.id)
    })
    test('does not remove owners if durable rollback protection cannot be stored', async () => {
        const { tx, deps } = setup()
        tx.register('character', 'new-character')
        deps.prepareRollback.mockRejectedValueOnce(new Error('offline'))
        await expect(tx.rollback()).rejects.toThrow('offline')
        expect(deps.removeOwners).not.toHaveBeenCalled()
        expect(deps.journal).not.toHaveBeenCalledWith(null)
    })
    test('cancellation before any writes does not require a working server', async () => {
        const { tx, deps } = setup()
        tx.cancel()
        await tx.rollback()
        expect(deps.cleanup).not.toHaveBeenCalled()
        expect(deps.journal).toHaveBeenLastCalledWith(null)
    })
})
