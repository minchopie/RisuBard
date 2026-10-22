import { test, expect, vi } from 'vitest'
import { mount, unmount, tick } from 'svelte'
import { writable } from 'svelte/store'
const f = vi.hoisted(() => ({ retry: vi.fn(async () => 'empty'), status: vi.fn(async () => ({ enabled: true, role: 'authority', sync: { outbox: { pending: [], published: 1 }, incoming: {} }, vault: { origin: 'generated' } })) }))
vi.mock('./stores.svelte', () => ({ selectedCharID: writable(0), DBState: { db: { characters: [{ name: '표본', chatPage: 0, chats: [{ id: 'chat-id', name: '기존 대화' }] }] } } }))
vi.mock('./globalApi.svelte', () => ({ downloadFile: vi.fn() }))
vi.mock('./alert', () => ({ alertConfirm: vi.fn() }))
vi.mock('./platform', () => ({ isNodeServer: true }))
vi.mock('./transferNas', () => ({ parseNasListing: vi.fn() }))
vi.mock('./transferNative', () => ({ nativeSend: writable(null), playSetAvailable: () => false, androidTransferAvailable: () => false, playNative: vi.fn(), sendNative: vi.fn() }))
vi.mock('./playTransfer', () => ({ transferBusy: writable(false), transferStatus: writable(''), transferQueue: writable([]), refreshTransfers: vi.fn(async () => {}), queueTransferFile: vi.fn(), exportTransfer: vi.fn(), receiveTransfer: vi.fn(), cancelTransfer: vi.fn(), transferRequest: vi.fn(), uploadLegacyChat: vi.fn() }))
vi.mock('./nasSyncCoordinator', () => ({ coordinatorState: writable({ lastOutcome: 'empty' }), syncCoordinator: () => ({ retryNow: f.retry }) }))
vi.mock('./nasSync', () => ({ syncStatus: f.status, syncNetwork: vi.fn(async () => null),
    syncConflicts: vi.fn(async () => [{ root: 'opaque-root', type: 'chat', title: '표본 · 기존 대화', sameMessages: true, differs: ['wiki'], state: 'diverged', variants: [{ heads: ['h1'], messages: 2, wikiFiles: 3, source: { self: true } }, { heads: ['h2'], messages: 2, wikiFiles: 4, source: {} }] }]),
    syncTrash: vi.fn(async () => []), syncOverview: vi.fn(async () => ({ localIssues: [{ name: '선택한 용사', reason: 'local-persona-edit' }], personas: [{ name: '새 페르소나' }], chats: [{ character: '표본', name: '기존 대화', state: 'uploaded', wikiFiles: 3, slots: 1, pages: 2 }] })) }))
import Panel from '../lib/Setting/Pages/TransferPanel.svelte'
test('one automatic sync area names personas, chat and Wiki; manual paths collapse, opaque IDs stay diagnostic, sync can repeat', async () => {
    const target = document.createElement('div'); document.body.append(target)
    const instance = mount(Panel, { target })
    try {
        for (let i = 0; i < 15; i++) { await Promise.resolve(); await tick() }
        expect(target.querySelector('legend')?.textContent).toBe('내 기기 자동 동기화')
        expect(target.textContent).toContain('페르소나 편집 화면에서'); expect(target.textContent).toContain('선택한 용사'); expect(target.textContent).toContain('새 페르소나'); expect(target.textContent).toContain('표본 · 기존 대화')
        expect(target.textContent).toContain('Wiki·기억 3파일'); expect(target.textContent).toContain('대화 본문은 같아요')
        expect(target.textContent).toContain('다른 기기의 적용 여부는 아직 확인되지 않았어요')
        const id = [...target.querySelectorAll('code')].find(e => e.textContent === 'opaque-root')!;
        expect(id.closest('details')?.open).toBe(false)
        const manual = [...target.querySelectorAll('details')].find(e => e.querySelector('summary')?.textContent?.includes('직접 옮기기'))!;
        expect(manual.open).toBe(false)
        for (let i = 0; i < 2; i++) {
            const button = [...target.querySelectorAll('button')].find(e => e.textContent === '지금 동기화')!;
            expect(button.disabled).toBe(false); button.click()
            for (let j = 0; j < 15; j++) { await Promise.resolve(); await tick() }
        }
        expect(f.retry).toHaveBeenCalledTimes(2)
        expect(target.querySelector('[role="dialog"]')).toBeNull()
    } finally { await unmount(instance); target.remove() }
})
