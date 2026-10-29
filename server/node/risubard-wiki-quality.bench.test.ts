import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { createMarkdownNarrativeWiki } from './risubard-markdown-wiki'
import { createMemoryAnalysisRunner, type MemoryAnalysisModelRequest } from './risubard-memory-analysis'
import {
    buildQualityLedger,
    createOracleModel,
    qualityNames,
    qualityPairs,
    RUMOR_REFUTED,
    seededRandom,
} from './risubard-wiki-quality.fixture'
import {
    buildInquiryTimeline,
    findHistoricalSourceMatches,
    resolveHistoricalSourceMatchesById,
} from '../../src/ts/risubard/historicalSourceRecall'
import { wikiBacklogMessages } from '../../src/ts/risubard/wikiBacklog'

// Long-chat quality measurement with a scripted model. Opt-in: pnpm bench:wiki-quality
const enabled = process.env.RISUBARD_QUALITY_BENCH === '1'
    || process.env.npm_lifecycle_event === 'bench:wiki-quality'
const checkpoints = (process.env.RISUBARD_QUALITY_TURNS ?? '100,300,1000')
    .split(',').map(Number).filter((value) => Number.isSafeInteger(value) && value > 0)
const modes = [
    { name: 'clean', lossyRewriteRate: 0, failureRate: 0 },
    { name: 'faulty', lossyRewriteRate: 0.15, failureRate: 0.05 },
].filter((mode) => !process.env.RISUBARD_QUALITY_MODES
    || process.env.RISUBARD_QUALITY_MODES.split(',').includes(mode.name))

type Message = {
    role: 'user' | 'char'
    data: string
    chatId: string
    risubardMemoryConfirmed?: boolean
    risubardWikiPending?: { reason?: string }
}

describe.skipIf(!enabled)('BardWiki long-chat quality (scripted model)', () => {
    test.each(modes)('$name', async (mode) => {
        const total = Math.max(...checkpoints)
        const ledger = buildQualityLedger(total)
        const oracle = createOracleModel({ ledger, ...mode, random: seededRandom(7) })
        const root = await fs.mkdtemp(join(tmpdir(), `risubard-quality-${mode.name}-`))
        const scope = { characterId: 'quality', chatId: 'chat' }
        const wiki = createMarkdownNarrativeWiki(root, { externalEditSweepMs: 0 })
        const runner = createMemoryAnalysisRunner({
            memoryService: { loadState: async () => { throw new Error('unused') }, applyDelta: async () => { throw new Error('unused') } },
            nativeV2Analysis: true,
            markdownWikiService: {
                inquire: (input) => wiki.inquire(input),
                loadDocuments: async (characterId, chatId) => (await wiki.loadView(characterId, chatId)).documents,
                saveConfirmedTurn: (input) => wiki.saveConfirmedTurn(input),
                saveCanonicalDocument: (input) => wiki.saveCanonicalDocument(input),
            },
            analyze: (request: MemoryAnalysisModelRequest) => oracle.analyze(request),
            onError: () => undefined,
        })
        const messages: Message[] = []
        const reports: Record<string, unknown>[] = []
        let skipped = 0
        let finalLost = 0
        let analysisMs = 0
        const started = Date.now()
        try {
            for (let turn = 1; turn <= total; turn += 1) {
                const entry = ledger.turns[turn - 1]
                messages.push({ role: 'user', data: entry.user, chatId: `u${turn}` },
                    { role: 'char', data: entry.sentences.join(' '), chatId: `a${turn}` })
                const target = messages.at(-1)!
                target.risubardWikiPending ??= {}
                // The client's order: oldest queued turn first, at most four, stop at a failure.
                const startedAt = Date.now()
                for (const message of wikiBacklogMessages(messages, `a${turn}`).slice(0, 4)) {
                    const index = messages.indexOf(message)
                    const user = messages[index - 1]
                    try {
                        await runner.run({
                            ...scope,
                            messages: [
                                { messageId: user.chatId, role: 'user', content: user.data },
                                { messageId: message.chatId, role: 'assistant', content: message.data },
                            ],
                            contextMessages: messages.slice(Math.max(0, index - 7), index + 1)
                                .map((item) => ({ messageId: item.chatId, role: item.role === 'user' ? 'user' : 'assistant', content: item.data })),
                            sourceMessageOrder: messages.slice(0, index + 1).map(({ chatId, role }) => ({ chatId, role })),
                            analysisTokenLimit: 8_192,
                            additionalSearchLimit: 0,
                            wikiWritingLanguage: 'ko',
                        })
                        message.risubardMemoryConfirmed = true
                        delete message.risubardWikiPending
                    }
                    catch (error) {
                        message.risubardWikiPending = { reason: error instanceof Error ? error.message : String(error) }
                        break
                    }
                }
                analysisMs += Date.now() - startedAt
                if (checkpoints.includes(turn)) reports.push(await measure(turn))
            }
            skipped = messages.filter((message) => message.role === 'char' && message.risubardMemoryConfirmed !== true).length
            const finalDocuments = (await wiki.loadView(scope.characterId, scope.chatId)).documents
            finalLost = oracle.stats.droppedByModel.filter((entry) => {
                const [name, unit] = entry.split('\u0000')
                const canon = finalDocuments.find((document) => document.type === 'character' && document.title === name)?.content ?? ''
                return !unit.includes('배신자') && !canon.includes(unit.replace(/\.$/u, ''))
            }).length
        }
        finally {
            await fs.rm(root, { recursive: true, force: true })
        }

        async function recall(question: string, turn: number) {
            const history = messages.map(({ role, data, chatId }) => ({ role, data, chatId }))
            const base = {
                ...scope, contextSelection: 'auto' as const, currentInput: question,
                timeline: buildInquiryTimeline(history, 6),
                sourceMatches: findHistoricalSourceMatches({ currentInput: question, messages: history, excludeRecentMessages: 6, maximumMatches: 8 }),
                sourceLimit: 8,
            }
            const first = await wiki.inquire(base)
            const routed = resolveHistoricalSourceMatchesById({
                messageIds: first.evidenceRequests.map((request) => request.messageId),
                messages: history, currentInput: question, excludeRecentMessages: 6,
            })
            const merged = [...routed, ...base.sourceMatches]
                .filter((match, index, all) => all.findIndex((item) => item.messageId === match.messageId) === index).slice(0, 8)
            void turn
            return merged.length > base.sourceMatches.length ? wiki.inquire({ ...base, sourceMatches: merged }) : first
        }

        async function measure(turn: number) {
            const view = await wiki.loadView(scope.characterId, scope.chatId)
            const catalog = await wiki.loadCatalog(scope.characterId, scope.chatId)
            const documents = view.documents
            const events = documents.filter((document) => document.type === 'event')
            const titleCounts = new Map<string, number>()
            for (const event of events) titleCounts.set(event.title, (titleCounts.get(event.title) ?? 0) + 1)
            const canonOf = (name: string) => documents.find((document) => document.type === 'character' && document.title === name)?.content ?? ''

            // Recall: does the final context hold the answer?
            const probes: Array<{ kind: string; question: string; expect: (text: string) => boolean }> = []
            for (const entry of ledger.turns.slice(0, turn)) {
                if (entry.origin) probes.push({ kind: 'early-fact', question: `${entry.origin.name}의 출신지는 어디였지?`,
                    expect: (text) => text.includes(entry.origin!.origin) })
            }
            for (const [a, b] of qualityPairs) {
                const state = ledger.relation(turn, a, b)
                if (state) probes.push({ kind: 'current-relation', question: `${a}와 ${b}의 지금 관계는?`,
                    expect: (text) => text.includes(`${b}와의 관계: ${state}`) || text.includes(`${a}와의 관계: ${state}`) })
            }
            const past = ledger.turns.filter((entry) => entry.relationChanges.length > 0 && entry.turn <= turn - 100)
            for (const entry of past.filter((_entry, index) => index % Math.max(1, Math.floor(past.length / 6)) === 0).slice(0, 6)) {
                const change = entry.relationChanges[0]
                probes.push({ kind: 'past-event', question: `${change.a}와 ${change.b}의 관계가 '${change.state}'(으)로 바뀌었던 때를 자세히 떠올려 줘.`,
                    expect: (text) => text.includes(`관계가 '${change.state}'(으)로 바뀌었다`) && /Story order: event #\d+/u.test(text) })
            }
            const owner = ledger.keyOwner(turn)
            if (owner) probes.push({ kind: 'current-item', question: '청동 열쇠는 지금 누가 가지고 있지?',
                expect: (text) => text.includes(`${owner}가 가지고 있다`) })
            for (const entry of ledger.turns.slice(0, turn).filter((item) => item.secret)) {
                probes.push({ kind: 'knowledge', question: `'${entry.secret!.secret}'라는 비밀을 누가 알고 있지?`,
                    expect: (text) => text.includes(entry.secret!.secret) && text.includes(entry.secret!.name) })
            }
            if (turn >= RUMOR_REFUTED) probes.push({ kind: 'corrected-rumor', question: '카일이 배신자라는 소문은 사실이야?',
                expect: (text) => text.includes('거짓') })
            for (const early of [3, 17, Math.floor(turn / 2)]) {
                probes.push({ kind: 'old-detail', question: `단서 ${early}를 찾은 장면을 떠올려 줘.`,
                    expect: (text) => new RegExp(`단서 ${early}(?!\\d)`, 'u').test(text) })
            }
            const results: Record<string, { pass: number; total: number }> = {}
            let labeledEvents = 0
            let eventSources = 0
            for (const probe of probes) {
                const inquiry = await recall(probe.question, turn)
                const text = inquiry.sources.map((source) => source.content).join('\n')
                const slot = results[probe.kind] ??= { pass: 0, total: 0 }
                slot.total += 1
                if (probe.expect(text)) slot.pass += 1
                for (const source of inquiry.sources.filter((item) => item.id.includes(':events/'))) {
                    eventSources += 1
                    if (source.content.includes('[Story order: event #')) labeledEvents += 1
                }
            }

            // Canon integrity: are ledger facts still in the character pages, without stale ones?
            let factsExpected = 0
            let factsPresent = 0
            let staleRelations = 0
            for (const name of qualityNames) {
                const canon = canonOf(name)
                const origin = ledger.turns.find((entry) => entry.origin?.name === name && entry.turn <= turn)?.origin
                const facts = [...(origin ? [origin.origin] : []), ...ledger.secretsOf(turn, name),
                    ...ledger.cluesOf(turn, name).map((clue) => clue.replace(/\.$/u, ''))]
                factsExpected += facts.length
                factsPresent += facts.filter((fact) => canon.includes(fact)).length
                for (const [a, b] of qualityPairs) {
                    if (a !== name && b !== name) continue
                    const other = a === name ? b : a
                    const lines = canon.split('\n').filter((line) => line.includes(`${other}와의 관계`))
                    const state = ledger.relation(turn, a, b)
                    staleRelations += lines.filter((line) => !state || !line.includes(state)).length
                }
            }
            const seres = canonOf('세레스')
            const arc = documents.find((document) => document.type === 'other' && document.title === '스토리 아크 플롯')
            const chapters = documents.filter((document) => document.type === 'other' && /스토리 아크 플롯 \(\d+\)$/u.test(document.title))
            const checkpoint = /risubard-story-arc-checkpoint:\s*([^\s]+)/u.exec(arc?.content ?? '')?.[1]
            const checkpointEvent = events.find((event) => event.id === checkpoint)
            const latestSequence = Math.max(0, ...events.map((event) => event.sequence ?? 0))
            return {
                turn,
                recall: Object.fromEntries(Object.entries(results).map(([kind, value]) => [kind, `${value.pass}/${value.total}`])),
                recallRate: Number((Object.values(results).reduce((sum, value) => sum + value.pass, 0)
                    / Math.max(1, Object.values(results).reduce((sum, value) => sum + value.total, 0))).toFixed(3)),
                eventSourcesWithStoryOrder: `${labeledEvents}/${eventSources}`,
                canonFactsKept: `${factsPresent}/${factsExpected}`,
                staleRelationLines: staleRelations,
                rumorStillAsserted: turn >= RUMOR_REFUTED && seres.includes('카일이 배신자라는 소문을 들었다'),
                duplicateEventTitles: [...titleCounts.values()].filter((count) => count > 1).length,
                danglingLinks: catalog.health.danglingLinks.length,
                events: events.length,
                eventsWithSequence: events.filter((event) => event.sequence !== undefined).length,
                arcPlot: Boolean(arc), arcChapters: chapters.length,
                arcCheckpointLag: checkpointEvent?.sequence ? latestSequence - checkpointEvent.sequence : null,
                fullViewBytes: JSON.stringify(view).length,
                catalogBytes: JSON.stringify(catalog).length,
            }
        }

        const summary = {
            mode: mode.name, turns: total,
            modelCalls: oracle.stats.calls, injectedFailures: oracle.stats.failures,
            lossyRewrites: oracle.stats.lossyRewrites,
            unitsDroppedByModelAndLost: finalLost,
            turnsLeftUnconfirmed: skipped,
            averageAnalysisInputCharacters: Math.round(oracle.stats.inputCharacters / Math.max(1, oracle.stats.calls)),
            averageAnalysisMsPerTurn: Math.round(analysisMs / total),
            totalSeconds: Math.round((Date.now() - started) / 1000),
            checkpoints: reports,
        }
        console.info('[BardWiki quality benchmark]', JSON.stringify(summary, null, 2))
        if (process.env.RISUBARD_QUALITY_OUT) {
            await fs.appendFile(process.env.RISUBARD_QUALITY_OUT, `${JSON.stringify(summary)}\n`, 'utf8')
        }
        expect(reports).toHaveLength(checkpoints.length)
    }, 3_600_000)
})
