// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import RisuBardStorySoFar from './RisuBardStorySoFar.svelte'

let mounted: ReturnType<typeof mount> | undefined

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
})

const stationDocument = {
    id: 'event.station', type: 'event' as const, status: 'active' as const,
    title: '폐쇄된 역', relativePath: 'events/station.md',
    sourceMessageIds: ['message-7'],
    created: '2026-08-15T00:00:00.000Z',
    updated: '2026-08-15T00:00:00.000Z',
    content: '# 폐쇄된 역\n\n## 이야기 요약\n\n- 일행이 폐쇄된 역에 도착했다.',
    links: [], contextMode: 'auto' as const, contentHash: 'hash',
}

describe('RisuBardStorySoFar', () => {
    it('opens an event for editing while keeping source navigation separate', async () => {
        const onNavigate = vi.fn()
        const onEdit = vi.fn()
        mounted = mount(RisuBardStorySoFar, {
            target: document.body,
            props: { documents: [stationDocument], onNavigate, onEdit },
        })

        const entry = document.querySelector<HTMLElement>(
            '[data-story-entry="event.station"]'
        )
        expect(entry?.textContent).toContain('일행이 폐쇄된 역에 도착했다.')
        entry?.querySelector<HTMLButtonElement>('[data-story-edit]')?.click()
        expect(onEdit).toHaveBeenCalledWith('event.station')
        expect(onNavigate).not.toHaveBeenCalled()

        entry?.querySelector<HTMLButtonElement>('[data-story-source]')?.click()
        expect(onNavigate).toHaveBeenCalledWith({
            kind: 'chat', messageIds: ['message-7'],
        })
    })

    it('keeps the summary as plain text and edits through a small labelled pencil button', () => {
        const onEdit = vi.fn()
        mounted = mount(RisuBardStorySoFar, {
            target: document.body,
            props: { documents: [stationDocument], onEdit },
        })
        const entry = document.querySelector<HTMLElement>('[data-story-entry="event.station"]')!
        const summary = [...entry.querySelectorAll('.story-line')]
        expect(summary.map(line => line.textContent)).toEqual(['일행이 폐쇄된 역에 도착했다.'])
        for (const line of summary) expect(line.closest('button')).toBeNull()
        expect(entry.querySelector('strong')?.closest('button')).toBeNull()
        const edit = entry.querySelector<HTMLButtonElement>('[data-story-edit]')!
        expect(edit.getAttribute('aria-label')).toBe('이 사건 편집')
        expect(edit.querySelector('svg')).not.toBeNull()
        expect(edit.textContent?.trim()).toBe('')
        edit.click()
        expect(onEdit).toHaveBeenCalledWith('event.station')
        expect(document.body.textContent).not.toContain('STORY SO FAR')
    })

    it('explains how events arrive when nothing is recorded yet', () => {
        mounted = mount(RisuBardStorySoFar, { target: document.body, props: { documents: [] } })
        expect(document.querySelector('[data-story-empty]')?.textContent?.trim())
            .toBe('아직 기록된 사건이 없습니다. AI 응답이 위키 분석을 거치면 사건이 여기에 쌓입니다.')
    })

    it.each([
        'RisuBardCurrentChatSettings.svelte',
        'RisuBardStorySoFar.svelte',
        'RisuBardStoryArcPlot.svelte',
        'RisuBardOocNotepad.svelte',
    ])('%s uses no font size below .75rem', (file) => {
        const source = readFileSync(resolve(process.cwd(), 'src/lib/Others', file), 'utf8')
        const sizes = [
            ...source.matchAll(/font-size:\s*(\d*\.?\d+)rem/g),
            ...source.matchAll(/font:\s*\d+\s+(\d*\.?\d+)rem/g),
        ].map(match => Number(match[1]))
        for (const size of sizes) expect(size, file).toBeGreaterThanOrEqual(.75)
    })
})
