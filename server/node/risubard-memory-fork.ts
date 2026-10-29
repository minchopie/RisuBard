import * as nodeFs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { resolveMemoryWorkspace } from './risubard-memory-workspace'

export type MemoryForkMode = 'copy' | 'branch'

export interface MemoryForkInput {
    userDataDirectory: string
    characterId: string
    destinationCharacterId?: string
    sourceChatId: string
    destinationChatId: string
    mode: MemoryForkMode
    retainedMessageIds?: string[]
    messageIds?: string[]
}

export interface MemoryForkReceipt {
    mode: MemoryForkMode
    sourceExists: boolean
    destinationChatId: string
    warnings: string[]
    forkToken: string
}

export interface CompleteMemoryForkInput {
    userDataDirectory: string
    characterId: string
    destinationChatId: string
    forkToken: string
    action: 'finalize' | 'discard'
}

export interface CompleteMemoryForkReceipt {
    action: 'finalize' | 'discard'
    completed: true
}

type ForkFileSystem = Pick<
    typeof nodeFs,
    'lstat' | 'mkdir' | 'readdir' | 'readFile' | 'writeFile'
    | 'copyFile' | 'rename' | 'rm' | 'realpath'
>

const FORK_MARKER = '.risubard-fork.json'

/** Fills a staged workspace instead of copying the source file by file. */
export type MemoryWorkspacePopulate = (
    staging: string,
    sourceDirectory: string | null
) => Promise<void>

function replacementBackupPath(directory: string, forkToken: string): string {
    return `${directory}.restore-${Buffer.from(forkToken).toString('base64url')}`
}

function replacementStagingPath(directory: string, forkToken: string): string {
    return `${directory}.replace-${Buffer.from(forkToken).toString('base64url')}`
}

function completionReceiptPath(directory: string, forkToken: string): string {
    return `${directory}.fork-complete-${Buffer.from(forkToken).toString('base64url')}.json`
}

export function resolveMemoryReplacementStaging(
    userDataDirectory: string,
    characterId: string,
    destinationChatId: string,
    forkToken: string
): string {
    return replacementStagingPath(resolveMemoryWorkspace(
        userDataDirectory,
        required(characterId, 'characterId'),
        required(destinationChatId, 'destinationChatId')
    ).directory, required(forkToken, 'forkToken'))
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function required(value: string, label: string): string {
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error(`${label} must not be empty`)
    }
    return value
}

function isWithin(root: string, target: string): boolean {
    const relation = relative(root, target)
    return relation === '' || (relation !== '..'
        && !relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
        && !isAbsolute(relation))
}

async function exists(fileSystem: ForkFileSystem, path: string): Promise<boolean> {
    try {
        await fileSystem.lstat(path)
        return true
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw error
    }
}

async function ensureSafeParent(
    fileSystem: ForkFileSystem,
    userDataDirectory: string,
    targetParent: string
): Promise<void> {
    await fileSystem.mkdir(userDataDirectory, { recursive: true })
    const root = await fileSystem.realpath(userDataDirectory)
    if (!isWithin(userDataDirectory, targetParent)) {
        throw new Error('Memory fork destination escapes user data')
    }
    let current = resolve(userDataDirectory)
    for (const segment of relative(current, targetParent).split(/[\\/]/)) {
        if (!segment) continue
        current = resolve(current, segment)
        try {
            const status = await fileSystem.lstat(current)
            if (status.isSymbolicLink() || !status.isDirectory()) {
                throw new Error('Memory fork destination path is unsafe')
            }
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            await fileSystem.mkdir(current)
        }
    }
    if (!isWithin(root, await fileSystem.realpath(targetParent))) {
        throw new Error('Memory fork destination escapes user data')
    }
}

async function copyDirectoryContents(
    fileSystem: ForkFileSystem,
    source: string,
    destination: string
): Promise<void> {
    for (const entry of await fileSystem.readdir(source, { withFileTypes: true })) {
        if (entry.name === '.risubard-snapshots'
            || entry.name === '.risubard-history'
            || entry.name === '.risubard-recovery') continue
        const sourcePath = join(source, entry.name)
        const destinationPath = join(destination, entry.name)
        const status = await fileSystem.lstat(sourcePath)
        if (status.isSymbolicLink()) {
            throw new Error('Memory fork source contains a symbolic link')
        }
        if (status.isDirectory()) {
            await fileSystem.mkdir(destinationPath)
            await copyDirectoryContents(fileSystem, sourcePath, destinationPath)
            continue
        }
        if (!status.isFile()) {
            throw new Error('Memory fork source contains a non-regular file')
        }
        await fileSystem.copyFile(sourcePath, destinationPath)
    }
}

export async function forkMemoryWorkspace(
    input: MemoryForkInput,
    options: {
        fileSystem?: ForkFileSystem
        wikiOnly?: boolean
        populate?: MemoryWorkspacePopulate
    } = {}
): Promise<MemoryForkReceipt> {
    required(input.characterId, 'characterId')
    required(input.sourceChatId, 'sourceChatId')
    required(input.destinationChatId, 'destinationChatId')
    if (input.mode !== 'copy' && input.mode !== 'branch') {
        throw new Error('Invalid memory fork mode')
    }
    if (input.sourceChatId === input.destinationChatId) {
        throw new Error('Memory fork source and destination must differ')
    }
    if (input.mode === 'branch'
        && (!Array.isArray(input.retainedMessageIds)
            || !Array.isArray(input.messageIds))) {
        throw new Error('Memory branch requires ordered message IDs')
    }
    const retained = input.retainedMessageIds ?? []
    const messageIds = input.messageIds ?? []
    if (retained.some((id) => typeof id !== 'string' || id.length === 0)
        || messageIds.some((id) => typeof id !== 'string' || id.length === 0)
        || new Set(messageIds).size !== messageIds.length
        || retained.length > messageIds.length
        || retained.some((id, index) => messageIds[index] !== id)) {
        throw new Error('Invalid branch message order')
    }
    if (input.mode === 'branch' && retained.length < messageIds.length) {
        throw new Error(
            'Memory fork conflict: historical branches require save/load'
        )
    }
    const fileSystem = options.fileSystem ?? nodeFs
    const source = resolveMemoryWorkspace(
        input.userDataDirectory,
        input.characterId,
        input.sourceChatId
    )
    const destination = resolveMemoryWorkspace(
        input.userDataDirectory,
        input.destinationCharacterId ?? input.characterId,
        input.destinationChatId
    )
    await ensureSafeParent(
        fileSystem,
        input.userDataDirectory,
        dirname(destination.directory)
    )
    if (await exists(fileSystem, destination.directory)) {
        throw new Error('Memory fork destination already exists')
    }
    const staging = `${destination.directory}.fork-${randomUUID()}`
    const forkToken = randomUUID()
    let sourceExists = false
    try {
        await fileSystem.mkdir(staging)
        try {
            const status = await fileSystem.lstat(source.directory)
            if (status.isSymbolicLink() || !status.isDirectory()) {
                throw new Error('Memory fork source workspace is unsafe')
            }
            sourceExists = true
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (options.populate) {
            await options.populate(staging, sourceExists ? source.directory : null)
        }
        else if (sourceExists) {
            if (options.wikiOnly) {
                const wikiSource = join(source.directory, 'wiki')
                const wikiStatus = await fileSystem.lstat(wikiSource)
                if (wikiStatus.isSymbolicLink() || !wikiStatus.isDirectory()) {
                    throw new Error('Memory fork source wiki is unsafe')
                }
                const wikiDestination = join(staging, 'wiki')
                await fileSystem.mkdir(wikiDestination)
                await copyDirectoryContents(fileSystem, wikiSource, wikiDestination)
            }
            else {
                await copyDirectoryContents(fileSystem, source.directory, staging)
            }
        }
        await fileSystem.rm(join(staging, FORK_MARKER), { force: true })
        const warnings: string[] = []
        await fileSystem.writeFile(join(staging, FORK_MARKER), JSON.stringify({
            destinationChatId: input.destinationChatId,
            forkToken,
        }), 'utf8')
        await fileSystem.rename(staging, destination.directory)
        return {
            mode: input.mode,
            sourceExists,
            destinationChatId: input.destinationChatId,
            warnings,
            forkToken,
        }
    }
    catch (error) {
        await fileSystem.rm(staging, { recursive: true, force: true })
            .catch(() => undefined)
        throw error
    }
}

export async function replaceMemoryWorkspace(
    input: Omit<MemoryForkInput, 'mode' | 'retainedMessageIds' | 'messageIds'>,
    options: { fileSystem?: ForkFileSystem; populate?: MemoryWorkspacePopulate } = {}
): Promise<MemoryForkReceipt> {
    required(input.characterId, 'characterId')
    required(input.sourceChatId, 'sourceChatId')
    required(input.destinationChatId, 'destinationChatId')
    if (input.sourceChatId === input.destinationChatId) {
        throw new Error('Memory replacement source and destination must differ')
    }
    const fileSystem = options.fileSystem ?? nodeFs
    const source = resolveMemoryWorkspace(
        input.userDataDirectory,
        input.characterId,
        input.sourceChatId
    )
    const destination = resolveMemoryWorkspace(
        input.userDataDirectory,
        input.destinationCharacterId ?? input.characterId,
        input.destinationChatId
    )
    await ensureSafeParent(
        fileSystem,
        input.userDataDirectory,
        dirname(destination.directory)
    )
    const forkToken = randomUUID()
    const staging = replacementStagingPath(destination.directory, forkToken)
    let sourceExists = false
    let hadDestination = false
    try {
        await fileSystem.mkdir(staging)
        try {
            const status = await fileSystem.lstat(source.directory)
            if (status.isSymbolicLink() || !status.isDirectory()) {
                throw new Error('Memory replacement source workspace is unsafe')
            }
            sourceExists = true
        }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (options.populate) {
            await options.populate(staging, sourceExists ? source.directory : null)
        }
        else if (sourceExists) {
            await copyDirectoryContents(fileSystem, source.directory, staging)
        }
        await fileSystem.rm(join(staging, FORK_MARKER), { force: true })
        if (await exists(fileSystem, destination.directory)) {
            const status = await fileSystem.lstat(destination.directory)
            if (status.isSymbolicLink() || !status.isDirectory()) {
                throw new Error('Memory replacement destination is unsafe')
            }
            hadDestination = true
        }
        await fileSystem.writeFile(
            join(staging, FORK_MARKER),
            JSON.stringify({
                destinationChatId: input.destinationChatId,
                forkToken,
                replacement: true,
                hadDestination,
            }),
            'utf8'
        )
        return {
            mode: 'copy',
            sourceExists,
            destinationChatId: input.destinationChatId,
            warnings: [],
            forkToken,
        }
    }
    catch (error) {
        await fileSystem.rm(staging, { recursive: true, force: true })
            .catch(() => undefined)
        throw error
    }
}

export async function removeRebootMemoryWorkspace(input: {
    userDataDirectory: string
    characterId: string
    chatId: string
}, options: { fileSystem?: ForkFileSystem } = {}): Promise<{ removed: boolean }> {
    required(input.characterId, 'characterId')
    const chatId = required(input.chatId, 'chatId')
    if (!chatId.startsWith('reboot-')) {
        throw new Error('Only reboot staging workspaces can be removed')
    }
    const fileSystem = options.fileSystem ?? nodeFs
    const workspace = resolveMemoryWorkspace(
        input.userDataDirectory,
        input.characterId,
        chatId
    )
    try {
        const status = await fileSystem.lstat(workspace.directory)
        if (status.isSymbolicLink() || !status.isDirectory()) {
            throw new Error('Reboot staging workspace is unsafe')
        }
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return { removed: false }
        }
        throw error
    }
    await fileSystem.rm(workspace.directory, { recursive: true, force: false })
    return { removed: true }
}

export async function completeMemoryWorkspaceFork(
    input: CompleteMemoryForkInput,
    options: { fileSystem?: ForkFileSystem } = {}
): Promise<CompleteMemoryForkReceipt> {
    required(input.characterId, 'characterId')
    required(input.destinationChatId, 'destinationChatId')
    required(input.forkToken, 'forkToken')
    if (input.action !== 'finalize' && input.action !== 'discard') {
        throw new Error('Invalid memory fork completion action')
    }
    const fileSystem = options.fileSystem ?? nodeFs
    const destination = resolveMemoryWorkspace(
        input.userDataDirectory,
        input.characterId,
        input.destinationChatId
    )
    await ensureSafeParent(
        fileSystem,
        input.userDataDirectory,
        dirname(destination.directory)
    )
    const receiptPath = completionReceiptPath(
        destination.directory,
        input.forkToken
    )
    let receipt: Record<string, unknown> | undefined
    try {
        const parsed: unknown = JSON.parse(await fileSystem.readFile(
            receiptPath,
            'utf8'
        ))
        if (!isRecord(parsed)
            || parsed.destinationChatId !== input.destinationChatId
            || parsed.forkToken !== input.forkToken
            || parsed.action !== input.action
            || typeof parsed.completed !== 'boolean') {
            throw new Error('Memory fork completion token/action does not match')
        }
        receipt = parsed
        if (receipt.completed) {
            return { action: input.action, completed: true }
        }
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const staging = replacementStagingPath(
        destination.directory,
        input.forkToken
    )
    if (await exists(fileSystem, destination.directory)) {
        const destinationStatus = await fileSystem.lstat(destination.directory)
        if (destinationStatus.isSymbolicLink()
            || !destinationStatus.isDirectory()) {
            throw new Error('Memory fork destination workspace is unsafe')
        }
    }
    const destinationMarker = join(destination.directory, FORK_MARKER)
    const stagingMarker = join(staging, FORK_MARKER)
    let markerPath = await exists(fileSystem, stagingMarker)
        ? stagingMarker
        : destinationMarker
    if (!await exists(fileSystem, markerPath)) {
        if (receipt) {
            await fileSystem.writeFile(receiptPath, JSON.stringify({
                ...receipt,
                completed: true,
            }), 'utf8')
            return { action: input.action, completed: true }
        }
        throw new Error('Memory fork marker is missing')
    }
    const markerStatus = await fileSystem.lstat(markerPath)
    if (markerStatus.isSymbolicLink() || !markerStatus.isFile()) {
        throw new Error('Memory fork marker is unsafe')
    }
    const markerText = await fileSystem.readFile(markerPath, 'utf8')
    let marker: unknown
    try {
        marker = JSON.parse(markerText)
    }
    catch {
        throw new Error('Memory fork marker is invalid')
    }
    const replacement = isRecord(marker) && marker.replacement === true
    const expectedKeys = replacement
        ? ['destinationChatId', 'forkToken', 'replacement', 'hadDestination']
        : ['destinationChatId', 'forkToken']
    if (!isRecord(marker)
        || Object.keys(marker).length !== expectedKeys.length
        || !expectedKeys.every((key) => Object.hasOwn(marker, key))
        || marker.destinationChatId !== input.destinationChatId
        || marker.forkToken !== input.forkToken
        || (replacement && typeof marker.hadDestination !== 'boolean')) {
        throw new Error('Memory fork token does not match')
    }
    if (replacement) {
        const backup = replacementBackupPath(
            destination.directory,
            input.forkToken
        )
        await fileSystem.writeFile(receiptPath, JSON.stringify({
            destinationChatId: input.destinationChatId,
            forkToken: input.forkToken,
            action: input.action,
            completed: false,
        }), 'utf8')
        if (input.action === 'finalize') {
            if (markerPath === stagingMarker) {
                try {
                    if (marker.hadDestination
                        && !await exists(fileSystem, backup)) {
                        await fileSystem.rename(destination.directory, backup)
                    }
                    await fileSystem.rename(staging, destination.directory)
                }
                catch (error) {
                    // A failed publish must leave the old workspace available
                    // and allow the caller to discard the staged replacement.
                    if (marker.hadDestination
                        && !await exists(fileSystem, destination.directory)
                        && await exists(fileSystem, backup)) {
                        await fileSystem.rename(backup, destination.directory)
                    }
                    await fileSystem.rm(receiptPath, { force: true })
                    throw error
                }
                markerPath = destinationMarker
            }
            await fileSystem.rm(markerPath, { force: false })
            await fileSystem.writeFile(receiptPath, JSON.stringify({
                destinationChatId: input.destinationChatId,
                forkToken: input.forkToken,
                action: input.action,
                completed: true,
            }), 'utf8')
            if (marker.hadDestination) {
                await fileSystem.rm(backup, { recursive: true, force: false })
                    .catch(() => undefined)
            }
        }
        else {
            if (markerPath === stagingMarker) {
                await fileSystem.rm(staging, { recursive: true, force: false })
            }
            else if (marker.hadDestination) {
                const displaced = `${destination.directory}.discard-${randomUUID()}`
                await fileSystem.rename(destination.directory, displaced)
                try {
                    await fileSystem.rename(backup, destination.directory)
                }
                catch (error) {
                    await fileSystem.rename(displaced, destination.directory)
                        .catch(() => undefined)
                    throw error
                }
                await fileSystem.rm(displaced, { recursive: true, force: false })
            }
            else {
                await fileSystem.rm(destination.directory, {
                    recursive: true,
                    force: false,
                })
            }
            await fileSystem.writeFile(receiptPath, JSON.stringify({
                destinationChatId: input.destinationChatId,
                forkToken: input.forkToken,
                action: input.action,
                completed: true,
            }), 'utf8')
        }
        return { action: input.action, completed: true }
    }
    await fileSystem.writeFile(receiptPath, JSON.stringify({
        destinationChatId: input.destinationChatId,
        forkToken: input.forkToken,
        action: input.action,
        completed: false,
    }), 'utf8')
    if (input.action === 'discard') {
        await fileSystem.rm(destination.directory, {
            recursive: true,
            force: false,
        })
    }
    else {
        await fileSystem.rm(markerPath, { force: false })
    }
    await fileSystem.writeFile(receiptPath, JSON.stringify({
        destinationChatId: input.destinationChatId,
        forkToken: input.forkToken,
        action: input.action,
        completed: true,
    }), 'utf8')
    return { action: input.action, completed: true }
}
