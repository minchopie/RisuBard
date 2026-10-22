import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import {
    type NarrativeSourceSnapshot,
    validateNarrativeSourceSnapshot,
} from '../../packages/risubard-core/src/sourceSnapshot'
import {
    normalizeNarrativeBaseline,
} from '../../packages/risubard-core/src/modelOutput'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'

export interface SourceSnapshotWorkspace {
    directory: string
    sourceSnapshotFile: string
    baselineFile: string
}

function requireString(value: string, label: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${label} must not be empty`)
    }
    return value
}

function confinedPath(root: string, ...segments: string[]): string {
    const target = resolve(root, ...segments)
    const relation = relative(root, target)
    if (relation === '..'
        || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
        || target === resolve(root)) {
        throw new Error('Source snapshot path escapes its storage root')
    }
    return target
}

export function resolveSourceSnapshotWorkspace(
    userDataDirectory: string,
    characterId: string,
    chatId: string
): SourceSnapshotWorkspace {
    requireString(userDataDirectory, 'userDataDirectory')
    if (!isAbsolute(userDataDirectory)) {
        throw new Error('userDataDirectory must be absolute')
    }
    const directory = resolveMemoryWorkspace(
        userDataDirectory,
        characterId,
        chatId
    ).directory
    return {
        directory,
        sourceSnapshotFile: confinedPath(directory, 'source-snapshot.json'),
        baselineFile: confinedPath(directory, 'baseline-summary.txt'),
    }
}

export function resolveLegacySourceSnapshotWorkspace(
    userDataDirectory: string,
    characterId: string,
    chatId: string
): SourceSnapshotWorkspace {
    const encodeId = (value: string, label: string) =>
        encodeURIComponent(requireString(value, label)).replaceAll('.', '%2E')
    const storageRoot = resolve(userDataDirectory, 'risubard')
    const directory = confinedPath(
        storageRoot,
        'characters',
        encodeId(characterId, 'characterId'),
        'chats',
        encodeId(chatId, 'chatId')
    )
    return {
        directory,
        sourceSnapshotFile: confinedPath(directory, 'source-snapshot.json'),
        baselineFile: confinedPath(directory, 'baseline-summary.txt'),
    }
}

async function ensureSafeDirectory(
    userDataDirectory: string,
    directory: string
): Promise<void> {
    await fs.mkdir(userDataDirectory, { recursive: true })
    let current = userDataDirectory
    for (const segment of relative(
        userDataDirectory,
        directory
    ).split(/[\\/]/)) {
        current = resolve(current, segment)
        try {
            const status = await fs.lstat(current)
            if (status.isSymbolicLink()) {
                throw new Error('Source snapshot workspace contains a symbolic link')
            }
            if (!status.isDirectory()) {
                throw new Error('Source snapshot workspace path is not a directory')
            }
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            await fs.mkdir(current)
        }
    }
}

async function assertSafeFile(file: string): Promise<void> {
    try {
        const status = await fs.lstat(file)
        if (status.isSymbolicLink()) {
            throw new Error('Source snapshot workspace contains a symbolic link')
        }
        if (!status.isFile()) {
            throw new Error('Source snapshot target is not a file')
        }
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
}

async function directoryExistsForRead(directory: string): Promise<boolean> {
    try {
        const status = await fs.lstat(directory)
        if (status.isSymbolicLink()) {
            throw new Error('Source snapshot workspace contains a symbolic link')
        }
        if (!status.isDirectory()) {
            throw new Error('Source snapshot workspace path is not a directory')
        }
        return true
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
    }
}

export function createSourceSnapshotAdapter(userDataDirectory: string) {
    return {
        async loadSnapshot(
            characterId: string,
            chatId: string
        ): Promise<NarrativeSourceSnapshot | null> {
            const workspace = resolveSourceSnapshotWorkspace(
                userDataDirectory,
                characterId,
                chatId
            )
            const legacyWorkspace = resolveLegacySourceSnapshotWorkspace(
                userDataDirectory,
                characterId,
                chatId
            )
            for (const candidate of [workspace, legacyWorkspace]) {
                try {
                if (!await directoryExistsForRead(candidate.directory)) {
                    continue
                }
                await ensureSafeDirectory(
                    userDataDirectory,
                    candidate.directory
                )
                await assertSafeFile(candidate.sourceSnapshotFile)
                const contents = await fs.readFile(
                    candidate.sourceSnapshotFile,
                    'utf8'
                )
                return validateNarrativeSourceSnapshot(JSON.parse(contents))
                }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                        throw error
                    }
                }
            }
            return null
        },

        async saveSnapshot(
            characterId: string,
            chatId: string,
            snapshot: unknown
        ): Promise<NarrativeSourceSnapshot> {
            const parsed = validateNarrativeSourceSnapshot(snapshot)
            const workspace = resolveSourceSnapshotWorkspace(
                userDataDirectory,
                characterId,
                chatId
            )
            await ensureSafeDirectory(userDataDirectory, workspace.directory)
            await assertSafeFile(workspace.sourceSnapshotFile)
            const temporaryFile = `${workspace.sourceSnapshotFile}.tmp-${randomUUID()}`
            try {
                const handle = await fs.open(temporaryFile, 'wx', 0o600)
                try {
                    await handle.writeFile(`${JSON.stringify(parsed)}\n`, 'utf8')
                    await handle.sync()
                }
                finally {
                    await handle.close()
                }
                await fs.rename(temporaryFile, workspace.sourceSnapshotFile)
            }
            catch (error) {
                await fs.rm(temporaryFile, { force: true }).catch(() => undefined)
                throw error
            }
            return validateNarrativeSourceSnapshot(parsed)
        },

        async loadBaseline(
            characterId: string,
            chatId: string
        ): Promise<string | null> {
            const workspace = resolveSourceSnapshotWorkspace(
                userDataDirectory,
                characterId,
                chatId
            )
            const legacyWorkspace = resolveLegacySourceSnapshotWorkspace(
                userDataDirectory,
                characterId,
                chatId
            )
            for (const candidate of [workspace, legacyWorkspace]) {
                if (!await directoryExistsForRead(candidate.directory)) {
                    continue
                }
                await ensureSafeDirectory(userDataDirectory, candidate.directory)
                await assertSafeFile(candidate.baselineFile)
                try {
                    const value = await fs.readFile(candidate.baselineFile, 'utf8')
                    return normalizeNarrativeBaseline(value)
                }
                catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                        throw error
                    }
                }
            }
            return null
        },

        async saveBaseline(
            characterId: string,
            chatId: string,
            summary: unknown
        ): Promise<string> {
            const normalized = normalizeNarrativeBaseline(
                summary as string
            )
            const workspace = resolveSourceSnapshotWorkspace(
                userDataDirectory,
                characterId,
                chatId
            )
            await ensureSafeDirectory(userDataDirectory, workspace.directory)
            await assertSafeFile(workspace.baselineFile)
            const temporaryFile = `${workspace.baselineFile}.tmp-${randomUUID()}`
            try {
                const handle = await fs.open(temporaryFile, 'wx', 0o600)
                try {
                    await handle.writeFile(normalized, 'utf8')
                    await handle.sync()
                }
                finally {
                    await handle.close()
                }
                await fs.rename(temporaryFile, workspace.baselineFile)
            }
            catch (error) {
                await fs.rm(temporaryFile, { force: true }).catch(() => undefined)
                throw error
            }
            return normalized
        },
    }
}
