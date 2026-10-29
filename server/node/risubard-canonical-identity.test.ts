import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { createMemoryAnalysisRunner } from './risubard-memory-analysis'
import { createMarkdownNarrativeWiki } from './risubard-markdown-wiki'

const roots: string[] = []
afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

const named = (title: string, ...aliases: string[]) => ({ title, aliases })
const evidence = 'Alice (Captain, Ranger, Senpai) and Bob (Senpai) arrived at the gate.'

test.each([
    { name: 'a confirmed alias naming an existing title updates that document',
        existing: [named('Alice')], candidates: [named('Captain', 'ＡＬＩＣＥ')],
        expected: [named('Alice', 'Captain')], changes: 1 },
    { name: 'a new name whose alias equals an existing alias stays separate without the alias',
        existing: [named('Alice', 'Captain')], candidates: [named('Ranger', 'captain')],
        expected: [named('Alice', 'Captain'), named('Ranger')], changes: 1 },
    { name: 'a shared nickname does not merge a new person into an existing one',
        existing: [named('Alice', 'Senpai')], candidates: [named('Bob', 'Senpai')],
        expected: [named('Alice', 'Senpai'), named('Bob')], changes: 1 },
    { name: 'a shared nickname does not collapse two new people',
        existing: [], candidates: [named('Alice', 'Senpai'), named('Bob', 'Senpai')],
        expected: [named('Alice'), named('Bob')], changes: 2 },
    { name: 'a clear title match still updates when an alias belongs to another document',
        existing: [named('Alice'), named('Bob', 'Captain')], candidates: [named('Alice', 'Captain')],
        expected: [named('Alice'), named('Bob', 'Captain')], changes: 1 },
    { name: 'new candidates linked by titles in one batch become one document',
        existing: [], candidates: [named('Alice', 'Captain'), named('Captain', 'Ranger'), named('Ranger')],
        expected: [named('Alice', 'Captain', 'Ranger')], changes: 1 },
    { name: 'an alias naming two queued people does not merge them',
        existing: [], candidates: [named('Alice'), named('Bob'), named('Captain', 'Alice', 'Bob')],
        expected: [named('Alice'), named('Bob')], changes: 2 },
    { name: 'a title shared by two existing documents does not create a third',
        existing: [named('Alice'), named('Alice')], candidates: [named('Alice')],
        expected: [named('Alice'), named('Alice')], changes: 0 },
    { name: 'a title shared by two existing aliases does not create a third',
        existing: [named('Alice', 'Captain'), named('Bob', 'Captain')], candidates: [named('Captain')],
        expected: [named('Alice', 'Captain'), named('Bob', 'Captain')], changes: 0 },
    { name: 'an alias missing from the messages does not merge people',
        existing: [named('Alice')], candidates: [named('Ranger', 'Alice')], messageText: 'Ranger arrived.',
        expected: [named('Alice'), named('Ranger')], changes: 1 },
    { name: 'additional analysis cannot recreate an excluded document through an alias',
        existing: [named('Alice')], candidates: [named('Captain', 'Alice')], excluded: true,
        expected: [named('Alice')], changes: 0 },
])('$name', async ({ existing, candidates, expected, changes, messageText, excluded }) => {
    const root = await fs.mkdtemp(join(tmpdir(), 'risubard-canonical-identity-'))
    roots.push(root)
    const wiki = createMarkdownNarrativeWiki(root)
    const scope = { characterId: 'character', chatId: 'chat' }
    const originals = []
    for (const document of existing) {
        originals.push(await wiki.saveManualDocument({ ...scope, ...document, type: 'character',
            markdown: `## ${document.title}\n\n### Identity\n\nOriginal facts about ${document.title}.` }))
    }
    const errors: unknown[] = []
    const runner = createMemoryAnalysisRunner({
        memoryService: { loadState: vi.fn(), applyDelta: vi.fn() },
        nativeV2Analysis: true,
        markdownWikiService: { ...wiki,
            loadDocuments: async (characterId, chatId) => (await wiki.loadView(characterId, chatId)).documents,
            inquire: async () => ({ graphRevision: 0, sources: [] }) },
        onError: (error) => { errors.push(error) },
        analyze: async (request) => request.format === 'canonical-batch'
            ? JSON.stringify({ schemaVersion: 1, documents: JSON.parse(request.input).targets.map(
                (_target: unknown, candidateIndex: number) => ({ candidateIndex,
                    sections: [{ heading: 'Current State', operation: 'upsert', content: 'Arrived at the gate.' }] })
            ) })
            : JSON.stringify({ schemaVersion: 1, title: 'Arrival', establishedEvents: ['Arrived at the gate.'],
                stateChanges: [], characterKnowledge: [], persistentFacts: [], openContinuity: [],
                canonicalUpdateCandidates: candidates.map((candidate) => ({ ...candidate,
                    type: 'character', action: 'create', targetDocumentId: null, confidence: 1, reason: 'Arrival' })) }),
    })
    const result = await runner.run({ ...scope, wikiWritingLanguage: 'en',
        ...(excluded ? { additionalAnalysis: true, excludeCanonicalDocumentIds: originals.map((doc) => doc.id) } : {}),
        messages: [{ messageId: 'assistant-1', role: 'assistant', content: messageText ?? evidence }],
    })
    expect(errors).toEqual([])
    expect(result.canonicalReceipt?.changes).toHaveLength(changes)
    // Reload from disk, not the runner's snapshot or the wiki's in-memory catalog.
    const documents = (await createMarkdownNarrativeWiki(root).loadView(scope.characterId, scope.chatId)).documents
        .filter((document) => document.type === 'character')
    const byTitle = (a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title)
    expect(documents.map(({ title, aliases }) => ({ title, aliases })).sort(byTitle)).toEqual(expected.sort(byTitle))
    for (const original of originals) {
        const saved = documents.find((document) => document.id === original.id)!
        expect(saved.content).toContain(`Original facts about ${original.title}.`)
        if (changes === 0) expect(saved.contentHash).toBe(original.contentHash)
    }
})
