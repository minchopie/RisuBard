import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import * as nodeFs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type {
    NarrativeGraphDeltaV2,
} from '../../packages/risubard-core/src/narrativeDelta'
import type { NarrativeMemoryState } from '../../packages/risubard-core/src/memoryDelta'
import {
    createNarrativeGraphService,
} from './risubard-graph-service'
import {
    createNarrativeGraphFileAdapter,
    resolveNarrativeGraphWorkspace,
} from './risubard-graph-workspace'

const evidence = [{ chatId: 'chat-1', messageId: 'message-1' }]

function addCharacterDelta(): NarrativeGraphDeltaV2 {
    return {
        schemaVersion: 2,
        storyId: 'character-1',
        branchId: 'chat-1',
        operations: [{
            type: 'add-node',
            operationId: 'operation-1',
            node: {
                id: 'entity:lina',
                kind: 'entity',
                subtype: 'character',
                title: 'Lina',
                summary: 'Lina is cautious.',
                storyId: 'character-1',
                branchId: 'chat-1',
                status: 'active',
                authority: 'draft',
                salience: 5,
                perspective: { kind: 'omniscient' },
                epistemic: 'fact',
                evidence,
            },
        }],
    }
}

const fixtureRoots: string[] = []
afterEach(async () => {
    await Promise.all(fixtureRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function userDataDirectory() {
    const root = await mkdtemp(join(tmpdir(), 'risubard-graph-'))
    fixtureRoots.push(root)
    return root
}

const emptyV1: NarrativeMemoryState = {
    facts: [],
    events: [],
    appliedOperationIds: [],
}

describe('narrative graph persistence service', () => {
    test('persists state, append-only operations and a current generated index', async () => {
        const root = await userDataDirectory()
        const service = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
        })

        const result = await service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: addCharacterDelta(),
            availableEvidence: evidence,
        })

        expect(result).toMatchObject({
            storyId: 'character-1',
            branchId: 'chat-1',
            revision: 1,
            appliedOperationIds: ['operation-1'],
        })
        const workspace = resolveNarrativeGraphWorkspace(
            root,
            'character-1',
            'chat-1'
        )
        expect((await readFile(workspace.operationsFile, 'utf8'))
            .trim().split('\n')).toHaveLength(1)
        expect(JSON.parse(await readFile(
            workspace.indexFile,
            'utf8'
        )).index.revision).toBe(1)
        await expect(service.readForInquiry(
            'character-1',
            'chat-1'
        )).resolves.toMatchObject({
            mode: 'v2',
            index: { revision: 1 },
        })
    })

    test('does not reread the append-only operation log on warm writes', async () => {
        const root = await userDataDirectory()
        const trackedReadFile = vi.fn(nodeFs.readFile)
        const adapter = createNarrativeGraphFileAdapter(root, {
            ...nodeFs,
            readFile: trackedReadFile,
        })
        const service = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
            adapter,
        })
        await service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: addCharacterDelta(),
            availableEvidence: evidence,
        })
        const second = addCharacterDelta()
        second.operations[0].operationId = 'operation-2'
        if (second.operations[0].type !== 'add-node') {
            throw new Error('Expected add-node')
        }
        second.operations[0].node.id = 'entity:kain'
        second.operations[0].node.title = 'Kain'
        second.operations[0].node.summary = 'Kain is watchful.'
        const workspace = resolveNarrativeGraphWorkspace(
            root,
            'character-1',
            'chat-1'
        )
        const readsAfterFirst = trackedReadFile.mock.calls.filter(
            ([file]) => String(file) === workspace.operationsFile
        ).length

        await service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: second,
            availableEvidence: evidence,
        })

        expect(readsAfterFirst).toBe(1)
        expect(trackedReadFile.mock.calls.filter(
            ([file]) => String(file) === workspace.operationsFile
        )).toHaveLength(1)
    })

    test('recovers state and cache after service restart without duplicating the log', async () => {
        const root = await userDataDirectory()
        const first = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
        })
        await first.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: addCharacterDelta(),
            availableEvidence: evidence,
        })

        const restarted = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
        })
        await expect(restarted.loadState(
            'character-1',
            'chat-1'
        )).resolves.toMatchObject({
            revision: 1,
            nodes: [{ id: 'entity:lina' }],
        })
        await expect(restarted.hydrateIndex(
            'character-1',
            'chat-1'
        )).resolves.toBe(true)
        await restarted.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: addCharacterDelta(),
            availableEvidence: evidence,
        })
        const workspace = resolveNarrativeGraphWorkspace(
            root,
            'character-1',
            'chat-1'
        )
        expect((await readFile(workspace.operationsFile, 'utf8'))
            .trim().split('\n')).toHaveLength(1)
        expect(restarted.metrics('character-1', 'chat-1').lastAnalysis)
            .toEqual({ status: 'success', appliedCount: 0 })
    })

    test('rejects an operation ID retry with a different payload after an interrupted state write', async () => {
        const root = await userDataDirectory()
        const first = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
        })
        await first.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: addCharacterDelta(),
            availableEvidence: evidence,
        })
        const workspace = resolveNarrativeGraphWorkspace(
            root,
            'character-1',
            'chat-1'
        )
        await rm(workspace.stateFile)
        await rm(workspace.indexFile)
        const changed = addCharacterDelta()
        if (changed.operations[0].type === 'add-node') {
            changed.operations[0].node.id = 'entity:changed'
        }
        const restarted = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
        })

        await expect(restarted.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: changed,
            availableEvidence: evidence,
        })).rejects.toThrow('Narrative operation payload mismatch')
        await expect(restarted.loadState(
            'character-1',
            'chat-1'
        )).resolves.toMatchObject({
            nodes: [{ id: 'entity:lina' }],
            appliedOperationIds: ['operation-1'],
        })
    })

    test('recovers an appended operation before applying a different delta after restart', async () => {
        const root = await userDataDirectory()
        const first = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
        })
        await first.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: addCharacterDelta(),
            availableEvidence: evidence,
        })
        const workspace = resolveNarrativeGraphWorkspace(
            root,
            'character-1',
            'chat-1'
        )
        await rm(workspace.stateFile)
        await rm(workspace.indexFile)
        const second = addCharacterDelta()
        second.operations[0].operationId = 'operation-2'
        if (second.operations[0].type === 'add-node') {
            second.operations[0].node.id = 'entity:kain'
            second.operations[0].node.title = 'Kain'
        }
        const restarted = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
        })

        await expect(restarted.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: second,
            availableEvidence: evidence,
        })).resolves.toMatchObject({
            revision: 2,
            nodes: [{ id: 'entity:lina' }, { id: 'entity:kain' }],
            appliedOperationIds: ['operation-1', 'operation-2'],
        })
    })

    test('does not register a current in-memory index when index persistence fails', async () => {
        const root = await userDataDirectory()
        const adapter = createNarrativeGraphFileAdapter(root)
        let failIndexPersistence = false
        const service = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
            adapter: {
                ...adapter,
                async persistUpdate(...args) {
                    await adapter.persistUpdate(...args)
                    if (!failIndexPersistence) return
                    const workspace = resolveNarrativeGraphWorkspace(
                        root,
                        args[0],
                        args[1]
                    )
                    await rm(workspace.indexFile, { force: true })
                    throw new Error('index persistence failed')
                },
            },
        })
        await service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: addCharacterDelta(),
            availableEvidence: evidence,
        })
        const second = addCharacterDelta()
        second.operations[0].operationId = 'operation-2'
        if (second.operations[0].type === 'add-node') {
            second.operations[0].node.id = 'entity:kain'
            second.operations[0].node.title = 'Kain'
        }
        failIndexPersistence = true

        await expect(service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: second,
            availableEvidence: evidence,
        })).rejects.toThrow('index persistence failed')
        await expect(service.readForInquiry(
            'character-1',
            'chat-1'
        )).resolves.toEqual({
            mode: 'v1',
            reason: 'missing-or-stale-v2-index',
            state: emptyV1,
        })
    })

    test('stores a multi-operation delta as one recoverable log record', async () => {
        const root = await userDataDirectory()
        const service = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
        })
        const delta = addCharacterDelta()
        const firstOperation = delta.operations[0]
        if (firstOperation.type !== 'add-node') {
            throw new Error('Expected add-node fixture')
        }
        delta.operations.push({
            type: 'add-node',
            operationId: 'operation-2',
            node: {
                ...structuredClone(firstOperation.node),
                id: 'entity:kain',
                title: 'Kain',
            },
        })
        await service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta,
            availableEvidence: evidence,
        })
        const workspace = resolveNarrativeGraphWorkspace(
            root,
            'character-1',
            'chat-1'
        )
        const complete = await readFile(workspace.operationsFile)
        await rm(workspace.stateFile)
        await rm(workspace.indexFile)
        await writeFile(
            workspace.operationsFile,
            complete.subarray(0, Math.floor(complete.length / 2))
        )
        const restarted = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
        })

        await expect(restarted.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta,
            availableEvidence: evidence,
        })).resolves.toMatchObject({
            revision: 1,
            nodes: [
                { id: 'entity:lina', revision: 1 },
                { id: 'entity:kain', revision: 1 },
            ],
        })
        expect((await readFile(workspace.operationsFile, 'utf8'))
            .trim().split('\n')).toHaveLength(1)
    })

    test.each(['missing', 'stale', 'corrupt'])(
        'falls back to v1 without rebuilding a %s index during the request',
        async (condition) => {
            const root = await userDataDirectory()
            const loadV1State = vi.fn(async () => emptyV1)
            const first = createNarrativeGraphService(root, { loadV1State })
            await first.applyDelta({
                characterId: 'character-1',
                chatId: 'chat-1',
                delta: addCharacterDelta(),
                availableEvidence: evidence,
            })
            const workspace = resolveNarrativeGraphWorkspace(
                root,
                'character-1',
                'chat-1'
            )
            if (condition === 'missing') {
                await writeFile(workspace.indexFile, '', 'utf8')
            }
            else if (condition === 'stale') {
                const stored = JSON.parse(await readFile(
                    workspace.indexFile,
                    'utf8'
                ))
                stored.index.revision = 0
                await writeFile(
                    workspace.indexFile,
                    JSON.stringify(stored),
                    'utf8'
                )
            }
            else {
                await writeFile(workspace.indexFile, '{broken', 'utf8')
            }
            const restarted = createNarrativeGraphService(root, {
                loadV1State,
            })

            await expect(restarted.hydrateIndex(
                'character-1',
                'chat-1'
            )).resolves.toBe(false)
            await expect(restarted.readForInquiry(
                'character-1',
                'chat-1'
            )).resolves.toEqual({
                mode: 'v1',
                reason: 'missing-or-stale-v2-index',
                state: emptyV1,
            })
            expect(loadV1State).toHaveBeenCalledOnce()
            expect(restarted.metrics()).toEqual({
                requestGraphNodeInspections: 0,
                requestIndexBuilds: 0,
                lastPromptMode: 'disabled',
                graphRevision: 0,
                indexRevision: 0,
                cacheStatus: 'disabled',
                lastInquiry: null,
                lastAnalysis: null,
            })
        }
    )

    test('drops an existing cache entry when index hydration fails', async () => {
        const root = await userDataDirectory()
        const loadV1State = vi.fn(async () => emptyV1)
        const service = createNarrativeGraphService(root, { loadV1State })
        await service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: addCharacterDelta(),
            availableEvidence: evidence,
        })
        const workspace = resolveNarrativeGraphWorkspace(
            root,
            'character-1',
            'chat-1'
        )
        await writeFile(workspace.indexFile, '{broken', 'utf8')

        await expect(service.hydrateIndex(
            'character-1',
            'chat-1'
        )).resolves.toBe(false)
        await expect(service.readForInquiry(
            'character-1',
            'chat-1'
        )).resolves.toEqual({
            mode: 'v1',
            reason: 'missing-or-stale-v2-index',
            state: emptyV1,
        })
        expect(loadV1State).toHaveBeenCalledOnce()
    })

    test('keeps the current cache artifact after validation rejection', async () => {
        const root = await userDataDirectory()
        const loadV1State = vi.fn(async () => emptyV1)
        const service = createNarrativeGraphService(root, { loadV1State })
        await service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: addCharacterDelta(),
            availableEvidence: evidence,
        })
        const workspace = resolveNarrativeGraphWorkspace(
            root,
            'character-1',
            'chat-1'
        )

        await expect(service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: {
                schemaVersion: 2,
                storyId: 'character-1',
                branchId: 'chat-1',
                operations: [{
                    type: 'update-node-status',
                    operationId: 'operation-invalid',
                    nodeId: 'claim:v1:missing',
                    status: 'invalidated',
                    evidence,
                }],
            },
            availableEvidence: evidence,
        })).rejects.toThrow('Cannot update unknown or inactive')

        await expect(access(workspace.indexFile)).resolves.toBeUndefined()
        await expect(service.readForInquiry(
            'character-1',
            'chat-1'
        )).resolves.toMatchObject({ mode: 'v2' })
        expect(loadV1State).not.toHaveBeenCalled()

        const restarted = createNarrativeGraphService(root, { loadV1State })
        await expect(restarted.hydrateIndex(
            'character-1',
            'chat-1'
        )).resolves.toBe(true)
        await expect(restarted.readForInquiry(
            'character-1',
            'chat-1'
        )).resolves.toMatchObject({ mode: 'v2' })
    })

    test('deletes the index even when the dirty marker cannot be written', async () => {
        const root = await userDataDirectory()
        const adapter = createNarrativeGraphFileAdapter(root)
        const invalidateIndexArtifact = vi.fn(
            (...args: Parameters<typeof adapter.invalidateIndexArtifact>) =>
                adapter.invalidateIndexArtifact(...args)
        )
        const service = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
            adapter: {
                ...adapter,
                async markIndexDirty() {
                    throw new Error('disk full')
                },
                invalidateIndexArtifact,
            },
        })
        await service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: addCharacterDelta(),
            availableEvidence: evidence,
        })

        await expect(service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: {
                schemaVersion: 2,
                storyId: 'character-1',
                branchId: 'chat-1',
                operations: [{
                    type: 'update-node-status',
                    operationId: 'operation-invalid',
                    nodeId: 'claim:v1:missing',
                    status: 'invalidated',
                    evidence,
                }],
            },
            availableEvidence: evidence,
        })).rejects.toThrow('Cannot update unknown or inactive')
        expect(invalidateIndexArtifact).not.toHaveBeenCalled()

        const restarted = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
        })
        await expect(restarted.hydrateIndex(
            'character-1',
            'chat-1'
        )).resolves.toBe(true)
        await expect(restarted.readForInquiry(
            'character-1',
            'chat-1'
        )).resolves.toMatchObject({ mode: 'v2' })
    })

    test('reconciles a dirty v1 projection before clearing fallback', async () => {
        const root = await userDataDirectory()
        const invalidatedBy = [{
            chatId: 'chat-1',
            messageId: 'message-2',
        }]
        const v1State: NarrativeMemoryState = {
            facts: [{
                id: 'gate-state',
                text: 'The gate is open.',
                status: 'invalidated',
                evidence,
                invalidatedBy,
            }],
            events: [{
                id: 'gate-opened',
                summary: 'The gate opened.',
                evidence,
            }],
            appliedOperationIds: [],
        }
        const service = createNarrativeGraphService(root, {
            loadV1State: async () => v1State,
        })
        await expect(service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: {
                schemaVersion: 2,
                storyId: 'character-1',
                branchId: 'chat-1',
                operations: [{
                    type: 'update-node-status',
                    operationId: 'operation-invalid',
                    nodeId: 'claim:v1:gate-state',
                    status: 'invalidated',
                    evidence: invalidatedBy,
                }],
            },
            availableEvidence: [...evidence, ...invalidatedBy],
        })).rejects.toThrow('Cannot update unknown or inactive')

        await expect(service.reconcileV1(
            'character-1',
            'chat-1'
        )).resolves.toMatchObject({
            revision: 1,
            nodes: [
                {
                    id: 'claim:v1:gate-state',
                    status: 'invalidated',
                    statusEvidence: invalidatedBy,
                },
                {
                    id: 'event:v1:gate-opened',
                    status: 'active',
                },
            ],
        })
        const workspace = resolveNarrativeGraphWorkspace(
            root,
            'character-1',
            'chat-1'
        )
        await expect(access(workspace.dirtyFile)).rejects.toMatchObject({
            code: 'ENOENT',
        })
        await expect(service.readForInquiry(
            'character-1',
            'chat-1'
        )).resolves.toMatchObject({
            mode: 'v2',
            state: { revision: 1 },
            index: { revision: 1 },
        })

        const restarted = createNarrativeGraphService(root, {
            loadV1State: async () => v1State,
        })
        await expect(restarted.hydrateIndex(
            'character-1',
            'chat-1'
        )).resolves.toBe(true)
        await expect(restarted.readForInquiry(
            'character-1',
            'chat-1'
        )).resolves.toMatchObject({ mode: 'v2' })
    })

    test('reconciles an explicit transport failure without a dirty marker', async () => {
        const root = await userDataDirectory()
        const v1State: NarrativeMemoryState = {
            facts: [{
                id: 'gate-state',
                text: 'The gate is open.',
                status: 'active',
                evidence,
            }],
            events: [],
            appliedOperationIds: [],
        }
        const service = createNarrativeGraphService(root, {
            loadV1State: async () => v1State,
        })

        await expect(service.reconcileV1(
            'character-1',
            'chat-1'
        )).resolves.toMatchObject({
            revision: 1,
            nodes: [{
                id: 'claim:v1:gate-state',
                status: 'active',
            }],
        })
        await expect(service.readForInquiry(
            'character-1',
            'chat-1'
        )).resolves.toMatchObject({ mode: 'v2' })
    })

    test('keeps v1 fallback for projected nodes absent from current v1 state', async () => {
        const root = await userDataDirectory()
        const service = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
        })
        await service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: {
                schemaVersion: 2,
                storyId: 'character-1',
                branchId: 'chat-1',
                operations: [{
                    type: 'add-node',
                    operationId: 'operation-ghost',
                    node: {
                        id: 'claim:v1:ghost',
                        kind: 'claim',
                        subtype: 'fact',
                        title: 'Ghost',
                        summary: 'Ghost',
                        storyId: 'character-1',
                        branchId: 'chat-1',
                        status: 'active',
                        authority: 'draft',
                        salience: 5,
                        perspective: { kind: 'omniscient' },
                        epistemic: 'fact',
                        evidence,
                    },
                }],
            },
            availableEvidence: evidence,
        })

        await expect(service.reconcileV1(
            'character-1',
            'chat-1'
        )).rejects.toThrow(
            'Projected narrative node is absent from v1 state: claim:v1:ghost'
        )
        const workspace = resolveNarrativeGraphWorkspace(
            root,
            'character-1',
            'chat-1'
        )
        await expect(access(workspace.dirtyFile)).resolves.toBeUndefined()
        await expect(access(workspace.indexFile)).rejects.toMatchObject({
            code: 'ENOENT',
        })
        await expect(service.readForInquiry(
            'character-1',
            'chat-1'
        )).resolves.toMatchObject({ mode: 'v1' })
    })

    test('keeps v1 fallback after reconciling an empty revision zero graph', async () => {
        const root = await userDataDirectory()
        const service = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
        })
        await expect(service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: {
                schemaVersion: 2,
                storyId: 'character-1',
                branchId: 'chat-1',
                operations: [{
                    type: 'update-node-status',
                    operationId: 'operation-invalid',
                    nodeId: 'claim:v1:missing',
                    status: 'invalidated',
                    evidence,
                }],
            },
            availableEvidence: evidence,
        })).rejects.toThrow()

        await expect(service.reconcileV1(
            'character-1',
            'chat-1'
        )).resolves.toMatchObject({ revision: 0 })
        await expect(service.readForInquiry(
            'character-1',
            'chat-1'
        )).resolves.toEqual({
            mode: 'v1',
            reason: 'missing-or-stale-v2-index',
            state: emptyV1,
        })
    })

    test('keeps the dirty fallback when marker clearing fails', async () => {
        const root = await userDataDirectory()
        const adapter = createNarrativeGraphFileAdapter(root)
        const v1State: NarrativeMemoryState = {
            facts: [{
                id: 'gate-state',
                text: 'The gate is open.',
                status: 'active',
                evidence,
            }],
            events: [],
            appliedOperationIds: [],
        }
        const service = createNarrativeGraphService(root, {
            loadV1State: async () => v1State,
            adapter: {
                ...adapter,
                async clearIndexDirty() {
                    throw new Error('marker clear failed')
                },
            },
        })
        await expect(service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: {
                schemaVersion: 2,
                storyId: 'character-1',
                branchId: 'chat-1',
                operations: [{
                    type: 'update-node-status',
                    operationId: 'operation-invalid',
                    nodeId: 'claim:v1:gate-state',
                    status: 'invalidated',
                    evidence,
                }],
            },
            availableEvidence: evidence,
        })).rejects.toThrow()

        await expect(service.reconcileV1(
            'character-1',
            'chat-1'
        )).rejects.toThrow('marker clear failed')
        const workspace = resolveNarrativeGraphWorkspace(
            root,
            'character-1',
            'chat-1'
        )
        await expect(access(workspace.dirtyFile)).resolves.toBeUndefined()
        await expect(access(workspace.indexFile)).rejects.toMatchObject({
            code: 'ENOENT',
        })
        await expect(service.readForInquiry(
            'character-1',
            'chat-1'
        )).resolves.toMatchObject({ mode: 'v1' })
    })

    test('rejects corrupted graph state instead of replacing it', async () => {
        const root = await userDataDirectory()
        const service = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
        })
        await service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: addCharacterDelta(),
            availableEvidence: evidence,
        })
        const workspace = resolveNarrativeGraphWorkspace(
            root,
            'character-1',
            'chat-1'
        )
        await writeFile(workspace.stateFile, '{"schemaVersion":2}', 'utf8')

        const restarted = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
        })
        await expect(restarted.loadState(
            'character-1',
            'chat-1'
        )).rejects.toThrow()
    })

    test('leaves all graph files absent when a delta partially fails', async () => {
        const root = await userDataDirectory()
        const service = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
        })
        const delta = addCharacterDelta()
        delta.operations.push({
            type: 'add-edge',
            operationId: 'operation-invalid',
            edge: {
                id: 'edge:missing',
                sourceId: 'entity:lina',
                type: 'about',
                targetId: 'missing',
                storyId: 'character-1',
                branchId: 'chat-1',
                evidence,
            },
        })

        await expect(service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta,
            availableEvidence: evidence,
        })).rejects.toThrow()
        const workspace = resolveNarrativeGraphWorkspace(
            root,
            'character-1',
            'chat-1'
        )
        await expect(access(workspace.stateFile)).rejects.toMatchObject({
            code: 'ENOENT',
        })
        await expect(access(workspace.operationsFile)).rejects.toMatchObject({
            code: 'ENOENT',
        })
    })

    test('snapshots queued input and serializes writes for one session', async () => {
        const root = await userDataDirectory()
        const service = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
        })
        const second = addCharacterDelta()
        second.operations[0].operationId = 'operation-2'
        if (second.operations[0].type === 'add-node') {
            second.operations[0].node.id = 'entity:kain'
            second.operations[0].node.title = 'Kain'
        }
        const queued = {
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: second,
            availableEvidence: evidence,
        }
        const first = service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: addCharacterDelta(),
            availableEvidence: evidence,
        })
        const next = service.applyDelta(queued)
        queued.characterId = 'mutated'
        queued.delta.operations.length = 0

        await Promise.all([first, next])
        await expect(service.loadState(
            'character-1',
            'chat-1'
        )).resolves.toMatchObject({
            revision: 2,
            nodes: [{ id: 'entity:lina' }, { id: 'entity:kain' }],
        })
    })

    test('refreshes a stale warm cache shared by overlapping runtimes', async () => {
        const root = await userDataDirectory()
        const first = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
        })
        const second = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
        })
        const deltaFor = (operationId: string, nodeId: string) => {
            const delta = addCharacterDelta()
            delta.operations[0].operationId = operationId
            if (delta.operations[0].type !== 'add-node') {
                throw new Error('Expected add-node')
            }
            delta.operations[0].node.id = nodeId
            delta.operations[0].node.title = nodeId
            return delta
        }
        await first.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: deltaFor('operation-1', 'entity:one'),
            availableEvidence: evidence,
        })
        await expect(second.hydrateIndex(
            'character-1',
            'chat-1'
        )).resolves.toBe(true)
        await first.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: deltaFor('operation-2', 'entity:two'),
            availableEvidence: evidence,
        })

        await second.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: deltaFor('operation-3', 'entity:three'),
            availableEvidence: evidence,
        })

        const workspace = resolveNarrativeGraphWorkspace(
            root,
            'character-1',
            'chat-1'
        )
        const storedState = JSON.parse(await readFile(
            workspace.stateFile,
            'utf8'
        )).state
        expect(storedState.revision).toBe(3)
        expect(storedState.nodes.map(
            (node: { id: string }) => node.id
        ).sort()).toEqual([
            'entity:one',
            'entity:three',
            'entity:two',
        ])
        const restarted = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
        })
        await expect(restarted.hydrateIndex(
            'character-1',
            'chat-1'
        )).resolves.toBe(true)
    })

    test('checks writer revision and applies both stores inside one graph queue', async () => {
        const root = await userDataDirectory()
        let releaseV1!: () => void
        const v1Started = new Promise<void>((resolve) => {
            releaseV1 = resolve
        })
        let enteredV1!: () => void
        const entered = new Promise<void>((resolve) => {
            enteredV1 = resolve
        })
        const applyV1Delta = vi.fn(async () => {
            enteredV1()
            await v1Started
            return emptyV1
        })
        const service = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
            applyV1Delta,
        })
        const source = addCharacterDelta()
        source.operations[0] = {
            type: 'add-node',
            operationId: 'operation-source',
            node: {
                id: 'event:market',
                kind: 'event',
                subtype: 'event',
                title: 'Market encounter',
                summary: 'The protagonist met a blue-haired elf.',
                storyId: 'character-1',
                branchId: 'chat-1',
                status: 'active',
                authority: 'draft',
                salience: 4,
                perspective: { kind: 'omniscient' },
                epistemic: 'fact',
                evidence,
            },
        }
        await service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: source,
            availableEvidence: evidence,
        })
        const writer = service.applyWriterCommand({
            characterId: 'character-1',
            chatId: 'chat-1',
            expectedRevision: 1,
            command: {
                schemaVersion: 1,
                type: 'promote-character',
                commandId: 'eliana',
                storyId: 'character-1',
                branchId: 'chat-1',
                sourceNodeId: 'event:market',
                name: 'Eliana',
                summary: 'Eliana is the princess of a fallen kingdom.',
                salience: 8,
            },
        })
        await entered

        const concurrent = service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: addCharacterDelta(),
            availableEvidence: evidence,
        })
        let concurrentSettled = false
        void concurrent.finally(() => {
            concurrentSettled = true
        })
        await Promise.resolve()
        expect(concurrentSettled).toBe(false)

        releaseV1()
        await expect(writer).resolves.toEqual({ revision: 2 })
        await expect(concurrent).resolves.toMatchObject({ revision: 3 })
        expect(applyV1Delta).toHaveBeenCalledTimes(1)
        await expect(service.applyWriterCommand({
            characterId: 'character-1',
            chatId: 'chat-1',
            expectedRevision: 1,
            command: {
                schemaVersion: 1,
                type: 'promote-character',
                commandId: 'stale',
                storyId: 'character-1',
                branchId: 'chat-1',
                sourceNodeId: 'event:market',
                name: 'Stale',
                summary: 'This stale approval must not be stored.',
                salience: 5,
            },
        })).rejects.toThrow('Writer graph revision is stale')
        expect(applyV1Delta).toHaveBeenCalledTimes(1)
    })

    test('keeps inquiry and analysis observability isolated per chat', async () => {
        const root = await userDataDirectory()
        const service = createNarrativeGraphService(root, {
            loadV1State: async () => emptyV1,
        })
        await service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            delta: addCharacterDelta(),
            availableEvidence: evidence,
        })
        await service.inquire({
            characterId: 'character-1',
            chatId: 'chat-1',
            currentInput: 'Lina',
        })
        service.recordAnalysis('character-1', 'chat-2', {
            status: 'failed',
            appliedCount: 0,
        })

        expect(service.metrics('character-1', 'chat-1')).toMatchObject({
            lastPromptMode: 'v2-current',
            graphRevision: 1,
            indexRevision: 1,
            cacheStatus: 'current',
            lastAnalysis: {
                status: 'success',
                appliedCount: 1,
            },
        })
        expect(service.metrics('character-1', 'chat-2')).toEqual({
            requestGraphNodeInspections: 0,
            requestIndexBuilds: 0,
            lastPromptMode: 'disabled',
            graphRevision: 0,
            indexRevision: 0,
            cacheStatus: 'disabled',
            lastInquiry: null,
            lastAnalysis: {
                status: 'failed',
                appliedCount: 0,
            },
        })
        expect(service.metrics('character-1', 'chat-3').lastAnalysis).toBeNull()
    })
})
