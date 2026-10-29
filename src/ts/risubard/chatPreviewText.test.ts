import { describe, expect, test } from 'vitest'
import { formatPreviewTime, toChatPreviewText } from './chatPreviewText'

const names = { user: '유저', char: '리나' }

describe('toChatPreviewText', () => {
    test('turns markup into readable lines', () => {
        expect(toChatPreviewText('<p>{{char}}가 웃었다.</p><p>"안녕, {{user}}."</p>', names))
            .toBe('리나가 웃었다.\n"안녕, 유저."')
        expect(toChatPreviewText('a<br>b<div>c</div>&nbsp;&lt;d&gt;', names)).toBe('a\nb\nc\n <d>')
    })

    test('drops images, styles and script macros', () => {
        expect(toChatPreviewText('{{inlay::abc}}\n<style>p{}</style>본문 {{setvar::x::1}}끝 <img src="x">', names))
            .toBe('[이미지]\n본문 끝 [이미지]')
    })

    test('collapses long blank runs', () => {
        expect(toChatPreviewText('하나\n\n\n\n둘  \n', names)).toBe('하나\n\n둘')
    })
})

describe('formatPreviewTime', () => {
    const now = new Date(2026, 9, 19, 12, 0).getTime()
    test('uses relative time for the last week', () => {
        expect(formatPreviewTime(now - 10_000, now)).toBe('방금')
        expect(formatPreviewTime(now - 5 * 60_000, now)).toBe('5분 전')
        expect(formatPreviewTime(now - 3 * 3_600_000, now)).toBe('3시간 전')
        expect(formatPreviewTime(now - 2 * 86_400_000, now)).toBe('2일 전')
        expect(formatPreviewTime(new Date(2026, 8, 1).getTime(), now)).toBe('2026. 9. 1.')
    })
})
