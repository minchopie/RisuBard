import { describe, expect, it } from 'vitest'
import { createWikiInquiryDiagnostic, formatWikiInquiryDiagnostic, WikiInquiryError, wikiInquiryFailure } from './wikiInquiryDiagnostics'

const source = { id: 'narrative-memory:wiki:characters/alice.md', content: 'Alice lives in the village.' }
const observation = { attempted: true, documentCount: 5, candidateCount: 2, sources: [source] }
describe('wiki inquiry diagnostics', () => {
    it('distinguishes retrieved documents from a prompt block omitted or overwritten by a preset', () => {
        const marker = `[source ${JSON.stringify(source.id)}]`
        expect(createWikiInquiryDiagnostic({ ...observation, messages: [{ content: 'character only' }] }))
            .toMatchObject({ status: 'not-injected', documentCount: 5, candidateCount: 2, selectedWikiCount: 1, injectedWikiCount: 0 })
        expect(createWikiInquiryDiagnostic({ ...observation, messages: [{ content: `${marker} ${source.content}` }] }))
            .toMatchObject({ status: 'injected', selectedWikiCount: 1, injectedWikiCount: 1 })
        expect(createWikiInquiryDiagnostic({ ...observation, messages: [{ content: marker }] }).status).toBe('not-injected')
    })
    it('distinguishes zero results, skipped lookup and server failure without inventing counts', () => {
        expect(createWikiInquiryDiagnostic({ attempted: true, documentCount: 4, candidateCount: 0, sources: [], messages: [] }))
            .toMatchObject({ status: 'empty', documentCount: 4, selectedWikiCount: 0 })
        expect(createWikiInquiryDiagnostic({ attempted: false, sources: [], messages: [] }).status).toBe('skipped')
        const failure = wikiInquiryFailure(new WikiInquiryError('budget-exceeded', 500))
        const diagnostic = createWikiInquiryDiagnostic({ attempted: true, failure, sources: [], messages: [] })
        expect(diagnostic).toMatchObject({ status: 'failed', failure: { code: 'budget-exceeded', httpStatus: 500 } })
        expect(diagnostic.documentCount).toBeUndefined()
        expect(formatWikiInquiryDiagnostic(diagnostic)).toContain('필수 위키')
        expect(formatWikiInquiryDiagnostic(diagnostic)).toContain('500')
    })
    it('says when semantic search was on but left out, and why', () => {
        const marker = `[source ${JSON.stringify(source.id)}]`
        const diagnostic = createWikiInquiryDiagnostic({ ...observation, semanticSkip: 'timeout',
            messages: [{ content: `${marker} ${source.content}` }] })
        expect(diagnostic).toMatchObject({ status: 'injected', semanticSkip: 'timeout' })
        expect(formatWikiInquiryDiagnostic(diagnostic)).toContain('의미 검색 제외: 위키 조회 제한 시간 안에 임베딩 응답 없음')
        expect(createWikiInquiryDiagnostic({ ...observation, messages: [] }).semanticSkip).toBeUndefined()
        expect(createWikiInquiryDiagnostic({ ...observation, semanticSkip: 'bogus' as never, messages: [] }).semanticSkip).toBeUndefined()
    })
    it('does not retain raw exception messages or document bodies', () => {
        const failure = wikiInquiryFailure(new Error('secret prompt E:/private/file.md API_KEY=secret'))
        expect(JSON.stringify(failure)).not.toMatch(/secret|private|API_KEY/)
        expect(wikiInquiryFailure(new DOMException('private', 'AbortError')).code).toBe('timeout')
        expect(JSON.stringify(createWikiInquiryDiagnostic({ ...observation, messages: [] }))).not.toContain(source.content)
    })
})
