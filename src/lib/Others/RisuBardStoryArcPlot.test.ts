// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { mount, unmount } from 'svelte'
import RisuBardStoryArcPlot from './RisuBardStoryArcPlot.svelte'

let mounted: ReturnType<typeof mount> | undefined

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
})

const settingsPath = '설정 > 리스바드 > 공통 설정 > 아크플로터 (Archplotter) > 아크플로터 자동 갱신'

const plotDocument = {
    id: 'other.story-arc', type: 'other' as const, status: 'active' as const,
    title: '스토리 아크 플롯', relativePath: 'notes/story-arc.md',
    sourceMessageIds: [], created: '2026-08-02T00:00:00.000Z',
    updated: '2026-08-02T00:00:00.000Z',
    content: '# 스토리 아크 플롯\n\n## 큰 줄기\n\n- 출발',
    links: [], contextMode: 'auto' as const, contentHash: 'hash',
}

describe('RisuBardStoryArcPlot', () => {
    it('shows the event count once, in the status chip, and the remaining count in the empty text', () => {
        mounted = mount(RisuBardStoryArcPlot, {
            target: document.body,
            props: { documents: [], checkpointSize: 8, enabled: true },
        })
        expect(document.querySelector('.arc-status')?.textContent?.trim()).toBe('확정 사건 0/8개')
        const empty = document.querySelector('[data-story-arc-empty]')!.textContent!
        expect(empty).toContain('8개가 더 쌓이면 첫 플롯을 만듭니다.')
        expect(empty).not.toContain('0/8')
        expect(document.body.textContent!.split('0/8').length - 1).toBe(1)
        expect(document.body.textContent).not.toContain('·')
    })

    it('says where to turn automatic updates on when they are off', () => {
        mounted = mount(RisuBardStoryArcPlot, {
            target: document.body,
            props: { documents: [], checkpointSize: 8, enabled: false },
        })
        expect(document.querySelector('[data-story-arc-empty]')?.textContent).toContain(settingsPath)
    })

    it('keeps the settings path visible next to an existing plot while updates are off', async () => {
        mounted = mount(RisuBardStoryArcPlot, {
            target: document.body,
            props: { documents: [plotDocument], checkpointSize: 8, enabled: false },
        })
        expect(document.querySelector('[data-story-arc-document]')).not.toBeNull()
        expect(document.querySelector('[data-story-arc-paused]')?.textContent).toContain(settingsPath)
    })

    it('uses Korean headings only', () => {
        mounted = mount(RisuBardStoryArcPlot, {
            target: document.body,
            props: { documents: [plotDocument], checkpointSize: 8, enabled: true },
        })
        const text = document.body.textContent!
        expect(text).not.toContain('STORY ARC PLOT')
        expect(text).not.toContain('CANONICAL PLOT')
        expect(document.querySelector('[data-story-arc-paused]')).toBeNull()
    })
})
