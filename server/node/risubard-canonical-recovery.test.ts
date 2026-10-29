import { describe, expect, test, vi } from 'vitest'
import { createMemoryAnalysisRunner, type MemoryAnalysisModelRequest } from './risubard-memory-analysis'
import { canonicalTurnFailureWarning, canonicalTurnNeedsRetry } from '../../src/ts/risubard/canonicalTurnReceipt'
import type { ModelResponse } from '../../packages/risubard-core/src/modelResponse'

const statePatch = (content: string) => [{ heading: 'Current State', operation: 'upsert', content }]
const batch = (documents: unknown[]) => JSON.stringify({ documents })
const input = { characterId: 'character', chatId: 'chat',
    messages: [{ messageId: 'assistant-1', role: 'assistant' as const, content: 'Alice and the Village are now safe.' }] }

function harness(generate: (request: MemoryAnalysisModelRequest) => Promise<string | ModelResponse>, malformed = false, inline = false) {
    const documents = [
        { id: 'character.alice', type: 'character' as const, title: 'Alice', relativePath: 'characters/Alice.md',
            content: malformed ? '## Alice\n\n## Another title\n\nAmbiguous.' : '## Alice\n\n### Current State\n\nUnsafe.',
            contentHash: 'alice-original', sourceMessageIds: [] },
        { id: 'location.village', type: 'location' as const, title: 'Village', relativePath: 'locations/Village.md',
            content: '## Village\n\n### Current State\n\nUnsafe.', contentHash: 'village-original', sourceMessageIds: [] },
    ]
    const saved: Array<Record<string, any>> = []
    const saveCanonicalDocument = vi.fn(async (value: any) => {
        saved.push(value)
        const original = documents.find((document) => document.id === value.documentId)!
        original.content = value.markdown
        original.contentHash = 'updated'
        return { ...original, content: value.markdown, contentHash: 'updated' }
    })
    const analyze = vi.fn(async (request: MemoryAnalysisModelRequest) => {
        if (request.format !== 'memory-draft') return generate(request)
        return JSON.stringify({ schemaVersion: 1, title: 'Safety', establishedEvents: ['Alice and the Village are safe.'],
            stateChanges: [], characterKnowledge: [], persistentFacts: [], openContinuity: [],
            canonicalUpdateCandidates: documents.map((document) => ({ type: document.type, title: document.title,
                reason: 'Now safe', action: 'update', targetDocumentId: document.id, confidence: 1 })),
            ...(inline ? { canonicalPatches: [{ candidateIndex: 1, sections: statePatch('Safe inline.') }] } : {}),
        })
    })
    const runner = createMemoryAnalysisRunner({ nativeV2Analysis: true,
        memoryService: { loadState: vi.fn(), applyDelta: vi.fn() },
        markdownWikiService: { inquire: vi.fn(async () => ({ graphRevision: 0,
            sources: inline ? documents.map((document) => ({ id: `narrative-memory:wiki:${document.relativePath}`, content: document.content })) : [] })),
            loadDocuments: vi.fn(async () => documents), saveConfirmedTurn: vi.fn(async () => undefined), saveCanonicalDocument },
        analyze, onError: vi.fn(),
    })
    return { runner, saved, analyze, saveCanonicalDocument, documents }
}

describe('canonical recovery boundaries', () => {
    test.each(['noRetry', 'toolExecuted'])('honors %s on partially invalid provider output', async (flag) => {
        const { runner, analyze, saved } = harness(async () => ({ type: 'success', [flag]: true,
            result: batch([{ candidateIndex: 0, sections: [{ heading: 'Current State', operation: 'delete', content: 'Invalid' }] },
                { candidateIndex: 1, sections: statePatch('Safe.') }]),
        }))
        const result = await runner.run(input)
        expect(analyze).toHaveBeenCalledTimes(2)
        expect(saved.map((document) => document.documentId)).toEqual(['location.village'])
        expect(canonicalTurnNeedsRetry(result.canonicalReceipt!)).toBe(false)
    })

    test.each(['deferred', 'saved'])('does not replay a %s target when a neighbor needs a transient retry', async (disposition) => {
        let first = true
        const targets: string[][] = []
        const { runner, saved } = harness(async (request) => {
            const current = JSON.parse(request.input).targets
            targets.push(current.map((entry: any) => entry.target.title))
            if (first) {
                if (current.length > 1) return batch([
                    { candidateIndex: 0, sections: disposition === 'saved' ? statePatch('Safe Alice.') : [{ heading: 'Current State', operation: 'delete', content: 'Invalid' }] },
                    { candidateIndex: 1, sections: [{ heading: 'Current State', operation: 'delete', content: 'Invalid' }] },
                ])
                if (current[0].target.title === 'Alice') return 'broken output'
                throw new Error('timeout')
            }
            return batch(current.map((_: unknown, candidateIndex: number) => ({ candidateIndex, sections: statePatch('Safe.') })))
        })
        const before = await runner.run(input)
        expect(canonicalTurnNeedsRetry(before.canonicalReceipt!)).toBe(true)
        first = false
        targets.length = 0
        const result = await runner.run({ ...input, previousCanonicalReceipt: before.canonicalReceipt })
        expect(targets).toEqual([['Village']])
        expect(saved.filter((document) => document.documentId === 'character.alice')).toHaveLength(disposition === 'saved' ? 1 : 0)
        expect(canonicalTurnNeedsRetry(result.canonicalReceipt!)).toBe(false)
        if (disposition === 'deferred') expect(canonicalTurnFailureWarning(result.canonicalReceipt!)).toContain('Alice')
    })

    test.each(['document', 'evidence', 'manual'])('reopens deferred work after a %s change', async (change) => {
        let broken = true
        const { runner, documents, saved } = harness(async (request) => {
            if (broken) return 'bad'
            return batch(JSON.parse(request.input).targets.map((_: unknown, candidateIndex: number) => ({ candidateIndex, sections: statePatch('Safe.') })))
        })
        const before = await runner.run(input)
        broken = false
        if (change === 'document') documents.forEach((document) => { document.contentHash = 'user-edited' })
        await runner.run({ ...input, previousCanonicalReceipt: before.canonicalReceipt,
            ...(change === 'evidence' ? { messages: [{ ...input.messages[0], content: 'New evidence of safety.' }] } : {}),
            ...(change === 'manual' ? { additionalAnalysis: true } : {}),
        })
        expect(saved).toHaveLength(2)
    })

    test('defers an ambiguous existing document before generation and saves its valid neighbor', async () => {
        const targets: string[][] = []
        const { runner, saved } = harness(async (request) => {
            const current = JSON.parse(request.input).targets
            targets.push(current.map((entry: any) => entry.target.title))
            return batch(current.map((_: unknown, candidateIndex: number) => ({ candidateIndex, sections: statePatch('Safe.') })))
        }, true)
        const result = await runner.run(input)
        expect(targets).toEqual([['Village']])
        expect(saved.map((document) => document.documentId)).toEqual(['location.village'])
        expect(saved[0].expectedContentHash).toBe('village-original')
        expect(result.canonicalReceipt?.warnings.join(' ')).toContain('기존 문서 구조 오류')
        expect(canonicalTurnNeedsRetry(result.canonicalReceipt!)).toBe(false)
        expect(canonicalTurnFailureWarning(result.canonicalReceipt!)).toContain('Alice')
    })

    test('retains the valid batch entry while exhausting only its malformed neighbor', async () => {
        const targets: string[][] = []
        const { runner, saved } = harness(async (request) => {
            const current = JSON.parse(request.input).targets
            targets.push(current.map((entry: any) => entry.target.title))
            if (current.length === 1) return 'broken output'
            return batch([{ candidateIndex: 0, sections: [{ heading: 'Current State', operation: 'delete', content: 'Not empty' }] },
                { candidateIndex: 1, sections: statePatch('Safe, retain this exact result.') }])
        })
        const result = await runner.run(input)
        expect(targets).toEqual([['Alice', 'Village'], ['Alice'], ['Alice']])
        expect(saved).toHaveLength(1)
        expect(saved[0].markdown).toContain('Safe, retain this exact result.')
        expect(result.canonicalReceipt?.changes.map((change) => change.documentId)).toEqual(['location.village'])
        expect(canonicalTurnNeedsRetry(result.canonicalReceipt!)).toBe(false)
        expect(canonicalTurnFailureWarning(result.canonicalReceipt!)).toContain('Alice')
    })

    test('repairs invalid patch content for locations as well as characters', async () => {
        const targets: string[][] = []
        const { runner, saved } = harness(async (request) => {
            const current = JSON.parse(request.input).targets
            targets.push(current.map((entry: any) => entry.target.title))
            return batch(current.length > 1
                ? [{ candidateIndex: 0, sections: statePatch('Alice safe.') },
                    { candidateIndex: 1, sections: statePatch('### Another peer\nWrong nesting.') }]
                : [{ candidateIndex: 0, sections: statePatch('Village safe.') }])
        })
        const result = await runner.run(input)
        expect(targets).toEqual([['Alice', 'Village'], ['Village']])
        expect(saved.map((document) => document.markdown)).toEqual([
            '## Alice\n\n### Current State\n\nAlice safe.', '## Village\n\n### Current State\n\nVillage safe.',
        ])
        expect(result.canonicalReceipt?.warnings).toEqual([])
    })

    test('retains valid inline work on provider failure without fanning out requests', async () => {
        const { runner, saved, analyze } = harness(async () => { throw new Error('timeout') }, false, true)
        const result = await runner.run(input)
        expect(saved.map((document) => document.documentId)).toEqual(['location.village'])
        expect(analyze).toHaveBeenCalledTimes(2)
        expect(canonicalTurnNeedsRetry(result.canonicalReceipt!)).toBe(true)
    })

    test('propagates cancellation without saving partial work', async () => {
        const controller = new AbortController()
        const { runner, saved } = harness(async () => {
            controller.abort()
            throw new Error('Aborted request')
        })
        await expect(runner.run(input, controller.signal)).rejects.toThrow()
        expect(saved).toEqual([])
    })
})
