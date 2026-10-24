import { test, expect, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import { writable } from 'svelte/store'
const f = vi.hoisted(() => ({ upload: vi.fn(async () => 'uploaded'), download: vi.fn(async () => 'applied'), coordinator: null as any, status: vi.fn(async () => ({ enabled: true, role: 'authority', lastAppliedAt: Date.parse('2026-10-24T01:23:00Z'), sync: { outbox: { pending: [], published: 1 }, incoming: {} }, vault: { origin: 'generated' } })) }))
vi.mock('./stores.svelte', () => ({ selectedCharID: writable(0), DBState: { db: { characters: [{ name: '표본', chatPage: 0, chats: [{ id: 'chat-id', name: '기존 대화' }] }] } } }))
vi.mock('./globalApi.svelte', () => ({ downloadFile: vi.fn() }))
vi.mock('./alert', () => ({ alertConfirm: vi.fn() }))
vi.mock('./platform', () => ({ isNodeServer: true }))
vi.mock('./transferNas', () => ({ parseNasListing: vi.fn() }))
vi.mock('./transferNative', () => ({ nativeSend: writable(null), playSetAvailable: () => false, androidTransferAvailable: () => false, playNative: vi.fn(), sendNative: vi.fn() }))
vi.mock('./playTransfer', () => ({ transferBusy: writable(false), transferStatus: writable(''), transferQueue: writable([]), refreshTransfers: vi.fn(async () => {}), queueTransferFile: vi.fn(), exportTransfer: vi.fn(), receiveTransfer: vi.fn(), cancelTransfer: vi.fn(), transferRequest: vi.fn(), uploadLegacyChat: vi.fn() }))
vi.mock('./nasSyncCoordinator', () => ({ coordinatorState: f.coordinator = writable({ lastOutcome: 'empty' }), syncCoordinator: () => ({ uploadNow: f.upload, downloadNow: f.download, state: { pendingReview: 2, keptDeletions: 1 } }) }))
vi.mock('./nasSync', () => ({ syncStatus: f.status, syncNetwork: vi.fn(async () => null),
    syncConflicts: vi.fn(async () => [{ root: 'opaque-root', type: 'chat', title: '표본 · 기존 대화', sameMessages: true, differs: ['wiki'], state: 'diverged', variants: [{ heads: ['h1'], messages: 2, wikiFiles: 3, source: { self: true } }, { heads: ['h2'], messages: 2, wikiFiles: 4, source: {} }] }]),
    syncTrash: vi.fn(async () => []), syncOverview: vi.fn(async () => ({ localIssues: [{ name: '선택한 용사', reason: 'local-persona-edit' }], personas: [{ name: '새 페르소나' }], items: [{ type: 'chat', title: '표본 · 기존 대화', state: 'uploaded', nasAt: Date.parse('2026-10-22T16:05:00Z'), wikiFiles: 3, slots: 1, pages: 2 }, { type: 'module', title: '원격 모듈', state: 'recorded', nasAt: null }], chats: [{ character: '표본', name: '기존 대화', state: 'uploaded', wikiFiles: 3, slots: 1, pages: 2 }] })) }))
import Panel from '../lib/Setting/Pages/TransferPanel.svelte'
test('direction buttons call separate actions repeatedly, list dates in Korea time and keep existing names, Wiki and collapsed details', async () => {
    const target = document.createElement('div'); document.body.append(target)
    const instance = mount(Panel, { target })
    try {
        for (let i = 0; i < 15; i++) { await Promise.resolve(); await tick() }
        expect(target.querySelector('legend')?.textContent).toBe('내 기기 자동 동기화')
        expect(target.textContent).toContain('이 기기 마지막 적용 완료: 2026. 10. 24. 10:23')
        expect(target.textContent).toContain('페르소나 편집 화면에서'); expect(target.textContent).toContain('선택한 용사'); expect(target.textContent).toContain('새 페르소나'); expect(target.textContent).toContain('표본 · 기존 대화')
        expect(target.textContent).toContain('Wiki·기억 3파일'); expect(target.textContent).toContain('대화 본문은 같아요')
        expect(target.textContent).toContain('다른 기기의 적용 여부는 아직 확인되지 않았어요')
        const id = [...target.querySelectorAll('code')].find(e => e.textContent === 'opaque-root')!;
        expect(id.closest('details')?.open).toBe(false)
        const manual = [...target.querySelectorAll('details')].find(e => e.querySelector('summary')?.textContent?.includes('직접 옮기기'))!;
        expect(manual.open).toBe(false)
        for (const label of ['NAS에 업로드', '이 기기에 다운로드', 'NAS에 업로드', '이 기기에 다운로드']) {
            const button = [...target.querySelectorAll('button')].find(e => e.textContent === label)!;
            expect(button.disabled).toBe(false); button.click()
            for (let j = 0; j < 15; j++) { await Promise.resolve(); await tick() }
        }
        expect(target.textContent).toContain('다운로드: 이 기기에 적용 완료')
        expect(f.upload).toHaveBeenCalledTimes(2); expect(f.download).toHaveBeenCalledTimes(2)
        f.download.mockResolvedValueOnce('applied-pending')
        ;[...target.querySelectorAll('button')].find(e => e.textContent === '이 기기에 다운로드')!.click()
        for (let j = 0; j < 15; j++) { await Promise.resolve(); await tick() }
        expect(target.textContent).toContain('다운로드: 일부 적용 완료 · 차이 확인 2건 · 삭제 보류 1건')

        expect(target.textContent).toContain('2026. 10. 23. 01:05'); expect(target.textContent).toContain('원격 모듈'); expect(target.textContent).toContain('날짜 기록 없음')
        const timeline = target.querySelector<HTMLDetailsElement>('details.sync-timeline')!
        expect(timeline.open).toBe(false); expect(timeline.querySelector('summary')?.textContent).toBe('NAS 최신판 기록 · 최근 2개 시각 · 마지막 2026. 10. 23. 01:05')
        expect([...timeline.querySelectorAll(':scope > .remote-file > strong')].map(e => e.textContent)).toEqual(['2026. 10. 23. 01:05', '날짜 기록 없음'])
        f.coordinator.set({ running: true, direction: 'upload' }); await tick()
        expect([...target.querySelectorAll('button')].filter(e => ['업로드 중…', '이 기기에 다운로드'].includes(e.textContent ?? '')).every(e => e.disabled)).toBe(true)
        f.coordinator.set({ running: false, paused: true }); await tick()
        expect([...target.querySelectorAll('button')].filter(e => ['NAS에 업로드', '이 기기에 다운로드'].includes(e.textContent ?? '')).every(e => e.disabled)).toBe(true)
        expect(target.querySelector('[role="dialog"]')).toBeNull()
    } finally { await unmount(instance); target.remove() }
})
