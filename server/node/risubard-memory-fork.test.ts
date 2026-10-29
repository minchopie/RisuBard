import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'
import {
    completeMemoryWorkspaceFork,
    forkMemoryWorkspace,
} from './risubard-memory-fork'

const temporaryDirectories: string[] = []

async function createRoot(): Promise<string> {
    const root = await fs.mkdtemp(join(tmpdir(), 'risubard-fork-'))
    temporaryDirectories.push(root)
    return root
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) =>
        fs.rm(directory, { recursive: true, force: true })
    ))
})

describe('memory workspace fork', () => {
    test('copies the complete durable workspace and keeps copies independent', async () => {
        const root = await createRoot()
        const source = resolveMemoryWorkspace(root, 'character', 'source')
        const destination = resolveMemoryWorkspace(root, 'character', 'copy')
        await fs.mkdir(join(source.directory, 'wiki', '.risubard-history'), {
            recursive: true,
        })
        await fs.writeFile(source.stateFile, 'source-state')
        await fs.writeFile(source.eventsFile, 'source-events')
        await fs.writeFile(join(
            source.directory, 'wiki', 'current-scene.md'
        ), 'scene')
        await fs.writeFile(join(
            source.directory, 'wiki', '.risubard-history', 'audit.md'
        ), 'audit')

        await expect(forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'source', destinationChatId: 'copy', mode: 'copy',
        })).resolves.toMatchObject({
            mode: 'copy', sourceExists: true, forkToken: expect.any(String),
        })

        await expect(fs.readFile(destination.stateFile, 'utf8'))
            .resolves.toBe('source-state')
        // The retired history folder is not copied.
        await expect(fs.readFile(join(
            destination.directory, 'wiki', '.risubard-history', 'audit.md'
        ), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
        await fs.writeFile(destination.stateFile, 'copy-state')
        await expect(fs.readFile(source.stateFile, 'utf8'))
            .resolves.toBe('source-state')
    })

    test('excludes legacy snapshots and transient recovery from copies', async () => {
        const root = await createRoot()
        const source = resolveMemoryWorkspace(root, 'character', 'source')
        const destination = resolveMemoryWorkspace(root, 'character', 'copy')
        for (const internal of ['.risubard-snapshots', '.risubard-recovery']) {
            await fs.mkdir(join(source.directory, 'wiki', internal), {
                recursive: true,
            })
            await fs.writeFile(join(source.directory, 'wiki', internal, 'x'), 'x')
        }
        await fs.writeFile(join(source.directory, 'wiki', 'index.md'), 'wiki')

        await forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'source', destinationChatId: 'copy', mode: 'copy',
        })

        await expect(fs.readFile(join(
            destination.directory, 'wiki', 'index.md'
        ), 'utf8')).resolves.toBe('wiki')
        for (const internal of ['.risubard-snapshots', '.risubard-recovery']) {
            await expect(fs.access(join(
                destination.directory, 'wiki', internal
            ))).rejects.toMatchObject({ code: 'ENOENT' })
        }
        await expect(fs.readFile(join(
            source.directory, 'wiki', '.risubard-snapshots', 'x'
        ), 'utf8')).resolves.toBe('x')
    })

    test('rejects a linked wiki without mutating its external target', async () => {
        const root = await createRoot()
        const source = resolveMemoryWorkspace(root, 'character', 'source')
        const external = join(root, 'external-wiki')
        const protectedFile = join(external, '.risubard-snapshots', 'keep')
        await fs.mkdir(dirname(protectedFile), { recursive: true })
        await fs.writeFile(protectedFile, 'protected')
        await fs.mkdir(source.directory, { recursive: true })
        await fs.symlink(
            external,
            join(source.directory, 'wiki'),
            process.platform === 'win32' ? 'junction' : 'dir'
        )

        await expect(forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'source', destinationChatId: 'copy', mode: 'copy',
        })).rejects.toThrow('symbolic link')
        await expect(fs.readFile(protectedFile, 'utf8'))
            .resolves.toBe('protected')
    })

    test('allows a current-head branch and rejects a historical branch', async () => {
        const root = await createRoot()
        const source = resolveMemoryWorkspace(root, 'character', 'source')
        await fs.mkdir(source.directory, { recursive: true })
        await fs.writeFile(source.stateFile, 'head')

        await expect(forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'source', destinationChatId: 'past', mode: 'branch',
            messageIds: ['m1', 'm2'], retainedMessageIds: ['m1'],
        })).rejects.toThrow('historical branches require save/load')

        await expect(forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'source', destinationChatId: 'head', mode: 'branch',
            messageIds: ['m1', 'm2'], retainedMessageIds: ['m1', 'm2'],
        })).resolves.toMatchObject({ mode: 'branch', warnings: [] })
        await expect(fs.readFile(resolveMemoryWorkspace(
            root, 'character', 'head'
        ).stateFile, 'utf8')).resolves.toBe('head')
    })

    test('copies a workspace into a different character namespace', async () => {
        const root = await createRoot()
        const source = resolveMemoryWorkspace(root, 'source-character', 'source')
        const destination = resolveMemoryWorkspace(root, 'clone-character', 'copy')
        await fs.mkdir(source.directory, { recursive: true })
        await fs.writeFile(source.stateFile, 'source-state')

        await forkMemoryWorkspace({
            userDataDirectory: root,
            characterId: 'source-character',
            destinationCharacterId: 'clone-character',
            sourceChatId: 'source', destinationChatId: 'copy', mode: 'copy',
        })

        await expect(fs.readFile(destination.stateFile, 'utf8'))
            .resolves.toBe('source-state')
    })

    test('finalizes or discards only with the matching fork token', async () => {
        const root = await createRoot()
        const finalized = await forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'missing', destinationChatId: 'finalized',
            mode: 'copy',
        })
        await expect(completeMemoryWorkspaceFork({
            userDataDirectory: root, characterId: 'character',
            destinationChatId: 'finalized', forkToken: finalized.forkToken,
            action: 'finalize',
        })).resolves.toEqual({ action: 'finalize', completed: true })
        await expect(completeMemoryWorkspaceFork({
            userDataDirectory: root, characterId: 'character',
            destinationChatId: 'finalized', forkToken: finalized.forkToken,
            action: 'discard',
        })).rejects.toThrow(/token|marker/i)

        const discarded = await forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'missing', destinationChatId: 'discarded',
            mode: 'copy',
        })
        await expect(completeMemoryWorkspaceFork({
            userDataDirectory: root, characterId: 'character',
            destinationChatId: 'discarded', forkToken: 'wrong-token',
            action: 'discard',
        })).rejects.toThrow(/token/i)
        await completeMemoryWorkspaceFork({
            userDataDirectory: root, characterId: 'character',
            destinationChatId: 'discarded', forkToken: discarded.forkToken,
            action: 'discard',
        })
    })

    test('creates an empty independent destination when the source is absent', async () => {
        const root = await createRoot()
        const destination = resolveMemoryWorkspace(root, 'character', 'empty-copy')
        const receipt = await forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'missing', destinationChatId: 'empty-copy',
            mode: 'copy',
        })
        expect(receipt).toMatchObject({ sourceExists: false })
        await completeMemoryWorkspaceFork({
            userDataDirectory: root, characterId: 'character',
            destinationChatId: 'empty-copy', forkToken: receipt.forkToken,
            action: 'finalize',
        })
        await expect(fs.readdir(destination.directory)).resolves.toEqual([])
    })

    test('rejects invalid destinations and cleans staging on copy failure', async () => {
        const root = await createRoot()
        const source = resolveMemoryWorkspace(root, 'character', 'source')
        const destination = resolveMemoryWorkspace(root, 'character', 'copy')
        await fs.mkdir(source.directory, { recursive: true })
        await fs.writeFile(source.stateFile, 'source-state')
        await expect(forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'same', destinationChatId: 'same', mode: 'copy',
        })).rejects.toThrow('must differ')
        await expect(forkMemoryWorkspace({
            userDataDirectory: root, characterId: 'character',
            sourceChatId: 'source', destinationChatId: 'copy', mode: 'copy',
        }, {
            fileSystem: { ...fs, copyFile: async () => {
                throw new Error('simulated copy failure')
            } },
        })).rejects.toThrow('simulated copy failure')
        await expect(fs.readFile(source.stateFile, 'utf8'))
            .resolves.toBe('source-state')
        await expect(fs.stat(destination.directory)).rejects.toMatchObject({
            code: 'ENOENT',
        })
        expect((await fs.readdir(dirname(destination.directory)))
            .some((name) => name.includes('.fork-'))).toBe(false)
    })
})
