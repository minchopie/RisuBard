import { afterEach, expect, test } from 'vitest'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMarkdownNarrativeWiki, resolveMarkdownWikiWorkspace } from './risubard-markdown-wiki'

const { createRuntimeMemoryService } = require('./risubard-memory-runtime.cjs')

// Existing `.risubard-history` files are user data: whichever upstream version the fork
// is assembled on, reading the wiki must leave them in place (byte for byte), a restart
// must still see them, and the play-set/NAS capture must still carry them. The legacy
// whole-wiki `.risubard-snapshots` folder keeps being removed on access as before.
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

test('existing per-document history survives read, restart and play-set capture; legacy snapshots are still removed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'risubard-wiki-history-'))
    roots.push(root)
    const scope = { characterId: 'character', chatId: 'chat' }
    const wiki = createMarkdownNarrativeWiki(root)
    const created = await wiki.saveManualDocument({
        ...scope, type: 'character', title: '라비안', markdown: '# 라비안\n\n현재 상태.',
    })
    const workspace = resolveMarkdownWikiWorkspace(root, scope.characterId, scope.chatId)
    const historyName = '2026-01-01T00-00-00-000Z-legacy.md'
    const historyFile = join(workspace.historyDirectory, created.id, historyName)
    const historyBytes = Buffer.from('# 라비안\n\n이전 판본.\n')
    await mkdir(join(workspace.historyDirectory, created.id), { recursive: true })
    await writeFile(historyFile, historyBytes)
    await mkdir(workspace.snapshotsDirectory, { recursive: true })
    await writeFile(join(workspace.snapshotsDirectory, 'legacy'), 'x')

    await wiki.loadView(scope.characterId, scope.chatId)
    expect(await readFile(historyFile)).toEqual(historyBytes)
    await expect(access(workspace.snapshotsDirectory)).rejects.toMatchObject({ code: 'ENOENT' })

    // Restart: a fresh service instance reads the same workspace.
    const view = await createMarkdownNarrativeWiki(root).loadView(scope.characterId, scope.chatId)
    expect(view.documents.some((document) => document.id === created.id)).toBe(true)
    expect(await readFile(historyFile)).toEqual(historyBytes)

    // Export: the play-set capture walks the memory workspace and includes the history file.
    const temporaryDirectory = join(root, 'capture-tmp')
    await mkdir(temporaryDirectory)
    const capture = await createRuntimeMemoryService(root).capturePlaySetMemory({
        characterId: scope.characterId, chatIds: [scope.chatId], temporaryDirectory,
    })
    try {
        const files = capture.workspaces.flatMap((item: { files: { path: string, hash: string }[] }) => item.files)
        const captured = files.find((file: { path: string }) => file.path.endsWith(`.risubard-history/${created.id}/${historyName}`))
        expect(captured?.hash).toBe(sha(historyBytes))
    } finally {
        await capture.cleanup()
    }
    expect(await readFile(historyFile)).toEqual(historyBytes)
})
