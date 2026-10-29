import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { NarrativeMemoryState } from '../../packages/risubard-core/src/memoryDelta'
import { createNarrativeGraphService } from './risubard-graph-service'

const evidence = [{ chatId: 'chat-1', messageId: 'message-1' }]

const fixtureRoots: string[] = []
afterEach(async () => {
    await Promise.all(fixtureRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function userDataDirectory() {
    const root = await mkdtemp(join(tmpdir(), 'risubard-inquiry-'))
    fixtureRoots.push(root)
    return root
}

describe('runtime narrative inquiry', () => {
    test('uses only the current v2 index and reports actual bounded work', async () => {
        const service = createNarrativeGraphService(
            await userDataDirectory(),
            {
                loadV1State: async () => ({
                    facts: [],
                    events: [],
                    appliedOperationIds: [],
                }),
            }
        )
        await service.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            availableEvidence: evidence,
            delta: {
                schemaVersion: 2,
                storyId: 'character-1',
                branchId: 'chat-1',
                operations: [{
                    type: 'add-node',
                    operationId: 'operation-event',
                    node: {
                        id: 'event:ambush',
                        kind: 'event',
                        subtype: 'event',
                        title: 'Kain ambush',
                        summary: 'Kain was ambushed at the bridge.',
                        storyId: 'character-1',
                        branchId: 'chat-1',
                        status: 'active',
                        authority: 'draft',
                        salience: 8,
                        perspective: { kind: 'omniscient' },
                        epistemic: 'fact',
                        evidence,
                    },
                }],
            },
        })

        const result = await service.inquire({
            characterId: 'character-1',
            chatId: 'chat-1',
            currentInput: 'What happened in the Kain ambush?',
        })

        expect(result).toMatchObject({
            mode: 'v2-current',
            graphRevision: 1,
            indexRevision: 1,
            cacheStatus: 'current',
            metrics: {
                candidateCount: 1,
                inspectedNodeCount: 1,
                inspectedEdgeCount: 0,
                selectedNodeCount: 1,
                selectedTokens: expect.any(Number),
            },
        })
        expect(result.sources).toEqual([
            expect.objectContaining({
                id: 'narrative-memory:event:ambush',
                content: '[Event] Kain was ambushed at the bridge.',
            }),
        ])
        expect(service.metrics()).toMatchObject({
            requestGraphNodeInspections: 1,
            requestIndexBuilds: 0,
            lastPromptMode: 'v2-current',
            graphRevision: 1,
            indexRevision: 1,
            cacheStatus: 'current',
            lastInquiry: result.metrics,
        })
    })

    test('uses a bounded v1 window when the current index is unavailable', async () => {
        const state: NarrativeMemoryState = {
            facts: Array.from({ length: 100 }, (_, index) => ({
                id: `fact-${index}`,
                text: `Fact ${index}`,
                status: 'active' as const,
                evidence: [{
                    chatId: 'chat-1',
                    messageId: `fact-message-${index}`,
                }],
            })),
            events: Array.from({ length: 100 }, (_, index) => ({
                id: `event-${index}`,
                summary: `Bridge event ${index}`,
                evidence: [{
                    chatId: 'chat-1',
                    messageId: `event-message-${index}`,
                }],
            })),
            appliedOperationIds: [],
        }
        const service = createNarrativeGraphService(
            await userDataDirectory(),
            { loadV1State: async () => state }
        )

        const result = await service.inquire({
            characterId: 'character-1',
            chatId: 'chat-1',
            currentInput: 'Bridge event 99',
        })

        expect(result.mode).toBe('bounded-v1-fallback')
        expect(result.cacheStatus).toBe('missing-or-stale')
        expect(result.sources.length).toBeLessThanOrEqual(16)
        expect(result.sources.some((source) =>
            source.content.includes('Bridge event 99')
        )).toBe(true)
        expect(JSON.stringify(result.sources)).not.toContain('Bridge event 0')
        expect(result.metrics.candidateCount).toBeLessThanOrEqual(64)
        expect(result.metrics.inspectedNodeCount).toBeLessThanOrEqual(64)
    })

    test('recovers the persisted current index on the first inquiry after restart', async () => {
        const root = await userDataDirectory()
        const first = createNarrativeGraphService(root, {
            loadV1State: async () => ({
                facts: [],
                events: [],
                appliedOperationIds: [],
            }),
        })
        await first.applyDelta({
            characterId: 'character-1',
            chatId: 'chat-1',
            availableEvidence: evidence,
            delta: {
                schemaVersion: 2,
                storyId: 'character-1',
                branchId: 'chat-1',
                operations: [{
                    type: 'add-node',
                    operationId: 'restart-event',
                    node: {
                        id: 'event:restart',
                        kind: 'event',
                        subtype: 'event',
                        title: 'Restart bridge',
                        summary: 'The bridge memory survived restart.',
                        storyId: 'character-1',
                        branchId: 'chat-1',
                        status: 'active',
                        authority: 'draft',
                        salience: 8,
                        perspective: { kind: 'omniscient' },
                        epistemic: 'fact',
                        evidence,
                    },
                }],
            },
        })
        const restarted = createNarrativeGraphService(root, {
            loadV1State: async () => ({
                facts: [],
                events: [],
                appliedOperationIds: [],
            }),
        })

        const result = await restarted.inquire({
            characterId: 'character-1',
            chatId: 'chat-1',
            currentInput: 'restart bridge',
        })

        expect(result.mode).toBe('v2-current')
        expect(result.sources[0]?.content).toContain('survived restart')
    })
})
