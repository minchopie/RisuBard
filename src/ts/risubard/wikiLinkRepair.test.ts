import { describe, expect, test } from 'vitest'
import { repairBrokenWikiLinks } from './wikiLinkRepair'

const documents = [
    { id: 'e1', title: '웅영고 원서 접수 확인과 필기시험 정식 응시 결정' },
    { id: 'e2', title: '웅영고 수험서 지원과 실기 준비 점검' },
    { id: 'e3', title: '웅영고 진학 수락과 보육원 지원 약속' },
    { id: 'c1', title: '미드나이트', aliases: ['카야마 네무리'] },
    { id: 'c2', title: '카스미' },
]

describe('repairBrokenWikiLinks', () => {
    test('rewrites a misquoted title to the closest existing one', () => {
        const result = repairBrokenWikiLinks('[[웅영고 원서 확인과 필기시험 정식 응시]]: 수령했다.', documents)
        expect(result.markdown).toBe('[[웅영고 원서 접수 확인과 필기시험 정식 응시 결정]]: 수령했다.')
        expect(result.repaired).toEqual([{
            from: '웅영고 원서 확인과 필기시험 정식 응시',
            to: '웅영고 원서 접수 확인과 필기시험 정식 응시 결정',
        }])
    })

    test('keeps links that already resolve, including aliases and the link suffix', () => {
        const text = '[[미드나이트]] [[카야마 네무리|선생님]] [[웅영고 수험서 지원과 실기 준비 점검#요약]]'
        expect(repairBrokenWikiLinks(text, documents)).toEqual({ markdown: text, repaired: [] })
        expect(repairBrokenWikiLinks('[[웅영고 원서 확인과 필기시험 정식 응시|원서]]', documents).markdown)
            .toBe('[[웅영고 원서 접수 확인과 필기시험 정식 응시 결정|원서]]')
    })

    test('leaves links to unrelated or ambiguous titles alone', () => {
        const text = '[[새로운 조력자]] [[웅영고 진학 지원]]'
        expect(repairBrokenWikiLinks(text, documents).markdown).toBe(text)
        const twins = [
            { id: 'a', title: '폐공장 교전과 수면향 흡입' },
            { id: 'b', title: '폐공장 교전과 수면향 노출' },
        ]
        expect(repairBrokenWikiLinks('[[폐공장 교전과 수면향]]', twins).repaired).toEqual([])
    })

    test('ignores retracted documents', () => {
        const result = repairBrokenWikiLinks('[[웅영고 원서 확인과 필기시험 정식 응시]]',
            [{ ...documents[0], status: 'retracted' }])
        expect(result.repaired).toEqual([])
    })

    test('never throws on malformed documents', () => {
        const text = '[[웅영고 원서 확인과 필기시험 정식 응시]]'
        const odd = [{ id: 'x' }, { id: 'y', title: 3 }, null, { id: 'z', title: '웅영고 원서 접수 확인과 필기시험 정식 응시 결정', aliases: 'nope' }] as never
        expect(repairBrokenWikiLinks(text, odd).markdown).toBe('[[웅영고 원서 접수 확인과 필기시험 정식 응시 결정]]')
        expect(repairBrokenWikiLinks(text, undefined as never)).toEqual({ markdown: text, repaired: [] })
    })
})
