import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createMarkdownNarrativeWiki, resolveMarkdownWikiWorkspace } from './risubard-markdown-wiki'
import { eventSequences } from './risubard-event-sequence'
import { inquireMarkdownDocuments } from './risubard-markdown-inquiry'
import { resolveCanonicalUnitPatches, stampUnit } from './risubard-canonical-unit-edit'
import { applyCanonicalSectionPatches } from './risubard-markdown-section-patch'
import {
    buildStoryArcUpdatePlan,
    isStoryArcChapterTitle,
    planStoryArcChapter,
    stampStoryArcCheckpoint,
    storyArcChapterTitle,
} from './risubard-story-arc-writer'

const directories: string[] = []
afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })))
})

async function newWiki() {
    const root = await fs.mkdtemp(join(tmpdir(), 'risubard-story-order-'))
    directories.push(root)
    return createMarkdownNarrativeWiki(root, { externalEditSweepMs: 0 })
}

const scope = { characterId: 'character', chatId: 'chat' }

describe('event story order', () => {
    test('numbers events once, keeps the number on edits and tells repeated titles apart', async () => {
        const wiki = await newWiki()
        const first = await wiki.saveConfirmedTurn({ ...scope, sourceMessageIds: ['a1'], markdown: '## 아침 식사\n\n### 이야기 요약\n\n- 토스트를 먹었다.' })
        const second = await wiki.saveConfirmedTurn({ ...scope, sourceMessageIds: ['a2'], markdown: '## 아침 식사\n\n### 이야기 요약\n\n- 죽을 먹었다.' })
        expect([first.sequence, second.sequence]).toEqual([1, 2])
        expect(first.title).toBe('아침 식사')
        expect(second.title).toBe('아침 식사 #2')

        const again = await wiki.saveConfirmedTurn({ ...scope, sourceMessageIds: ['a1'], markdown: '## 아침 식사\n\n### 이야기 요약\n\n- 토스트와 차를 먹었다.' })
        expect(again).toMatchObject({ id: first.id, sequence: 1, title: '아침 식사' })

        const edited = await wiki.saveManualDocument({ ...scope, documentId: second.id, type: 'event', title: '죽 아침',
            markdown: '## 죽 아침\n\n- 죽을 먹었다.', expectedContentHash: second.contentHash })
        expect(edited.sequence).toBe(2)
        const reread = (await wiki.loadView('character', 'chat')).documents.find((document) => document.id === second.id)
        expect(reread?.sequence).toBe(2)
    })

    test('ranks events saved before numbering by save time, below numbered ones', () => {
        const base = { type: 'event' as const, status: 'active' as const, updated: 'x' }
        const sequences = eventSequences([
            { ...base, id: 'old-b', created: '2026-01-02' },
            { ...base, id: 'old-a', created: '2026-01-01' },
            { ...base, id: 'new', created: '2026-01-03', sequence: 3 },
        ])
        expect([...sequences]).toEqual([['old-a', 1], ['old-b', 2], ['new', 3]])
    })

    test('labels events with their story order and lists them oldest first', async () => {
        const wiki = await newWiki()
        for (const [index, text] of ['성문에서 열쇠를 찾았다', '성문 열쇠를 잃어버렸다', '성문 열쇠를 되찾았다'].entries()) {
            await wiki.saveConfirmedTurn({ ...scope, sourceMessageIds: [`a${index + 1}`],
                markdown: `## 열쇠 ${index + 1}\n\n### 이야기 요약\n\n- ${text}.` })
        }
        const documents = (await wiki.loadView('character', 'chat')).documents
        const result = inquireMarkdownDocuments({ contextSelection: 'auto', currentInput: '성문 열쇠는 그때 어떻게 됐었지?', documents })
        const events = result.sources.filter((source) => source.id.includes(':events/'))
        expect(events.length).toBeGreaterThan(1)
        const orders = events.map((source) => Number(/event #(\d+) of 3/.exec(source.content)?.[1]))
        expect(orders).toEqual([...orders].sort((left, right) => left - right))
        expect(events.at(-1)!.content).toContain('[Story order: event #3 of 3, the latest]')
    })
})

describe('unit stamps', () => {
    test('marks added and rewritten units with the event that set them', () => {
        const markdown = '## Alice\n\n### Knowledge\n\n- Knows the gate code. (#2)\n- Knows the bell.'
        const resolution = resolveCanonicalUnitPatches({
            markdown, title: 'Alice', allowSupersede: false, stamp: 7,
            patches: [
                { heading: 'Knowledge', operation: 'edit', content: '', edits: {
                    add: ['Knows the tower stair. (#99)'], replace: [{ index: 0, text: 'Knows the new gate code. (#2)' }], remove: [] } },
                { heading: 'Equipment', operation: 'upsert', content: '- A lantern.' },
                { heading: 'Current State', operation: 'upsert', content: '- At the gate.' },
            ],
        })
        const result = applyCanonicalSectionPatches({ markdown, title: 'Alice', patches: resolution.patches })
        expect(result).toContain('- Knows the new gate code. (#7)\n- Knows the bell.\n- Knows the tower stair. (#7)')
        expect(result).toContain('### Equipment\n\n- A lantern. (#7)')
        expect(result).toContain('### Current State\n\n- At the gate.')
        expect(stampUnit('Fact. (#3)', 4)).toBe('Fact. (#4)')
    })
})

describe('story arc continuity', () => {
    const event = (index: number) => ({
        id: `event.${index}`, type: 'event' as const, title: `사건 ${index}`,
        content: `## 사건 ${index}`, sourceMessageIds: [`a${index}`],
        created: `2026-08-30T00:00:${String(index).padStart(2, '0')}.000Z`,
    })
    const arc = (content: string) => ({
        id: 'other.arc', type: 'other', title: '스토리 아크 플롯', content, sourceMessageIds: ['a1'],
    })

    test('resumes after the last linked event when the checkpoint event is gone or its mark was removed', () => {
        const events = Array.from({ length: 12 }, (_, index) => event(index + 1))
        const linked = '## 스토리 아크 플롯\n\n### 아크 개요\n\n- [[사건 3]]에서 시작했다.'
        const deleted = buildStoryArcUpdatePlan({
            documents: [...events, arc(stampStoryArcCheckpoint(linked, 'event.deleted'))],
            savedEvents: [], writingLanguage: 'ko', settings: { checkpointSize: 8 },
        })
        expect(deleted?.checkpointRecovered).toBe(true)
        expect(deleted?.events.map((item) => item.id)).toEqual(events.slice(3, 11).map((item) => item.id))

        const unmarked = buildStoryArcUpdatePlan({
            documents: [...events, arc(linked)], savedEvents: [], writingLanguage: 'ko', settings: { checkpointSize: 8 },
        })
        expect(unmarked?.events[0].id).toBe('event.4')

        const unlinked = buildStoryArcUpdatePlan({
            documents: [...events, arc('## 스토리 아크 플롯\n\n### 아크 개요\n\n- 시작.')], savedEvents: [],
            writingLanguage: 'ko', settings: { checkpointSize: 8 },
        })
        expect(unlinked).toBeUndefined()
    })

    test('moves a full plot to a closed chapter and restarts from a link to it', () => {
        const arcs = Array.from({ length: 8 }, (_, index) => `- 아크 ${index + 1}: [[사건 ${index + 1}]]`)
        const markdown = stampStoryArcCheckpoint(['## 스토리 아크 플롯', '', '### 아크 개요', '', ...arcs, '',
            '### 미해결 줄기', '', '- 북문의 열쇠는 누가 가졌나'].join('\n'), 'event.8')
        const chapterTitle = storyArcChapterTitle('스토리 아크 플롯', 1)
        expect(isStoryArcChapterTitle(chapterTitle)).toBe(true)
        expect(isStoryArcChapterTitle('스토리 아크 플롯')).toBe(false)
        const plan = planStoryArcChapter({ markdown, title: '스토리 아크 플롯', chapterTitle, writingLanguage: 'ko', settings: { maxArcs: 8 } })!
        expect(plan.chapterMarkdown).toContain('## 스토리 아크 플롯 (1)')
        expect(plan.chapterMarkdown).toContain('- 아크 8: [[사건 8]]')
        expect(plan.chapterMarkdown).not.toContain('risubard-story-arc-checkpoint')
        expect(plan.liveMarkdown).toBe(['## 스토리 아크 플롯', '', '### 아크 개요', '', '- [[스토리 아크 플롯 (1)]]',
            '', '### 미해결 줄기', '', '- 북문의 열쇠는 누가 가졌나'].join('\n'))
        expect(planStoryArcChapter({ markdown, title: '스토리 아크 플롯', chapterTitle, writingLanguage: 'ko', settings: { maxArcs: 9 } }))
            .toBeUndefined()
    })
})

describe('retired history folder', () => {
    // This fork keeps existing per-document history as user data (it travels with play-set/NAS captures): the wiki no longer
    // writes history, still removes the legacy whole-wiki snapshots on open, and leaves the old files untouched on open and save.
    test('keeps existing per-document history on open and on canonical save, still removes legacy snapshots and writes no new history', async () => {
        const wiki = await newWiki()
        const alice = await wiki.saveCanonicalDocument({ ...scope, type: 'character', title: 'Alice',
            sourceMessageIds: ['a1'], markdown: '## Alice\n\n### Knowledge\n\n- Knows the gate.' })
        const workspace = resolveMarkdownWikiWorkspace(directories.at(-1)!, 'character', 'chat')
        await fs.mkdir(join(workspace.historyDirectory, alice.id), { recursive: true })
        await fs.writeFile(join(workspace.historyDirectory, alice.id, 'old.md'), 'old')
        await fs.mkdir(workspace.snapshotsDirectory, { recursive: true })
        await fs.writeFile(join(workspace.snapshotsDirectory, 'legacy'), 'x')
        const historyFile = join(workspace.historyDirectory, alice.id, 'old.md')
        const listing = async () => (await fs.readdir(workspace.historyDirectory, { recursive: true })).map(String).sort()
        const before = await listing()
        expect(before).toEqual([alice.id, join(alice.id, 'old.md')])

        const reopened = createMarkdownNarrativeWiki(directories.at(-1)!, { externalEditSweepMs: 0 })
        await reopened.loadView('character', 'chat')
        expect(await fs.readFile(historyFile, 'utf8')).toBe('old')
        expect(await listing()).toEqual(before)
        await expect(fs.access(workspace.snapshotsDirectory)).rejects.toMatchObject({ code: 'ENOENT' })

        await reopened.saveCanonicalDocument({ ...scope, documentId: alice.id, type: 'character', title: 'Alice',
            sourceMessageIds: ['a2'], markdown: '## Alice\n\n### Knowledge\n\n- Knows the gate and the bell.' })
        const view = await reopened.loadView('character', 'chat')
        expect(view.documents.find((document) => document.id === alice.id)?.content).toContain('the bell')
        expect(await fs.readFile(historyFile, 'utf8')).toBe('old')
        expect(await listing()).toEqual(before) // no new history copy was written by the save
    })
})
