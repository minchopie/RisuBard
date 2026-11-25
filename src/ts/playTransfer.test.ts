import { beforeEach, test, expect, vi } from 'vitest'
import { get, writable } from 'svelte/store'
import { hashLocalJson } from '../../shared/play-set/protocol'
const f = vi.hoisted(() => ({ db: {} as any, request: vi.fn(), save: vi.fn(), defaults: vi.fn(), normalized: vi.fn(), select: vi.fn() }))
vi.mock('./globalApi.svelte', () => ({ forageStorage: { Init: async () => {}, realStorage: { transferRequest: (...args: any[]) => f.request(...args) } }, requestImmediateSave: (...args: any[]) => f.save(...args), checkCharOrder: () => {} }))
vi.mock('./storage/database.svelte', () => ({ getDatabase: () => f.db, getCurrentCharacter: () => f.db.characters[0], newChatModelDefaults: (...args: any[]) => f.defaults(...args), normalizeChat: (chat: any) => { f.normalized(chat); return chat } }))
vi.mock('./storage/chatStorage', () => ({ ensureChatHydrated: async (chats: any[], index: number) => chats[index] }))
vi.mock('./process/generationState', () => ({ doingChat: writable(false), isAnyGenerating: writable(false) }))
vi.mock('./importSession', () => ({ importSession: writable({ phase: 'idle' }) }))
vi.mock('./stores.svelte', () => ({ loadedStore: writable(true), alertStore: writable({ type: 'none' }) }))
vi.mock('./alert', () => ({ alertSelect: (...args: any[]) => f.select(...args), alertConfirm: (...args: any[]) => f.select(...args) }))
vi.mock('./risubard/memorySaveSlots', () => ({ applyMemorySavePromptSettings: (chat: any, current: any) => { chat.modelBinding = current.modelBinding; delete chat.bindedPersona } }))
import { receiveTransfer, recoverTransfers, exportTransfer, uploadLegacyChat, transferBusy, requestRemoteTransfer, transferProgressView, transferProgressText, transferStatus } from './playTransfer'
import { forageStorage } from './globalApi.svelte'
import { isAnyGenerating } from './process/generationState'
import { importSession } from './importSession'
const reply = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
beforeEach(() => {
    f.db = { characters: [{ chaId: 'existing', name: 'Keep', chatPage: 0, chats: [{ id: 'old', name: 'Keep', message: [], modelBinding: { main: 'receiver-model' } }] }], enabledModules: ['local-module'], apiKey: 'fixture-only' }
    transferBusy.set(false); (isAnyGenerating as any).set(false); importSession.set({ phase: 'idle' } as any)
    f.save.mockReset(); f.save.mockResolvedValue(undefined); f.request.mockReset(); f.normalized.mockReset(); f.defaults.mockReset(); f.defaults.mockReturnValue({ modelBinding: { main: 'receiver-model' } })
    f.select.mockReset()
    forageStorage.realStorage.syncTransaction = undefined; forageStorage.realStorage.transferTransaction = undefined
})

test('automatic direct receive with ambiguous targets defers durably without a selection popup or save', async () => {
    f.request.mockImplementation(async (path: string) => reply(path.endsWith('/inspect') ? { characters: [{ id: 'card', name: 'Keep', candidates: [{ id: 'a' }, { id: 'b' }] }] } : []))
    await receiveTransfer('in', true)
    expect(f.request).toHaveBeenCalledWith('/in/apply-request', expect.objectContaining({ body: JSON.stringify({ requested: false }) }))
    expect(f.select).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled()
})

test('remote requests wait only for transient pre-handler NAS gates, stop at the deadline and keep durable transaction errors', async () => {
    vi.useFakeTimers()
    const gate = (transaction?: string) => new Response(JSON.stringify({ error: 'busy', code: 'NAS_SYNC_BUSY', ...(transaction ? { transaction } : {}) }), { status: 423 })
    try {
        f.request.mockResolvedValueOnce(gate()).mockResolvedValueOnce(reply({ state: 'waiting', applyRequested: true }))
        const success = requestRemoteTransfer('nas', 'download', { name: 'fixture.risuplay', applyRequested: true })
        await vi.advanceTimersByTimeAsync(500)
        expect(await success).toMatchObject({ applyRequested: true })
        expect(f.request.mock.calls[0]).toEqual(f.request.mock.calls[1])
        f.request.mockReset(); f.request.mockResolvedValue(gate('durable-transaction'))
        await expect(requestRemoteTransfer('nas', 'upload', { id: 'out' })).rejects.toMatchObject({ transaction: 'durable-transaction', status: 423 })
        expect(f.request).toHaveBeenCalledTimes(1)
        f.request.mockReset(); f.request.mockImplementation(async () => gate())
        const bounded = expect(requestRemoteTransfer('nas', 'download')).rejects.toMatchObject({ code: 'NAS_SYNC_BUSY' })
        await vi.advanceTimersByTimeAsync(30_000); await bounded
        expect(f.request).toHaveBeenCalledTimes(61)
        f.request.mockReset(); f.request.mockRejectedValue(new Error('network failed'))
        await expect(requestRemoteTransfer('nas', 'upload')).rejects.toThrow('network failed')
        expect(f.request).toHaveBeenCalledTimes(1)
        f.request.mockReset(); f.request.mockImplementation(async () => gate())
        const changed = expect(requestRemoteTransfer('nas', 'upload')).rejects.toMatchObject({ status: 423 })
        await vi.advanceTimersByTimeAsync(100)
        forageStorage.realStorage.syncTransaction = 'new-apply'
        await vi.advanceTimersByTimeAsync(400); await changed
        expect(f.request).toHaveBeenCalledTimes(1)
    } finally { vi.useRealTimers(); forageStorage.realStorage.syncTransaction = undefined }
})

test('legacy backup asks before replacing a diverged revision and carries the confirmed hash', async () => {
    f.db.characters[0].chatPage = 0
    f.request.mockImplementation(async (_path: string, init: RequestInit) => reply(JSON.parse(init.body as string).replaceSha ? { state: 'delivered' } : { conflictSha: 'a'.repeat(40) }))
    f.select.mockResolvedValue(false)
    expect(await uploadLegacyChat()).toEqual({ cancelled: true })
    expect(f.request).toHaveBeenCalledTimes(1)
    f.request.mockClear(); f.select.mockResolvedValue(true)
    expect(await uploadLegacyChat()).toEqual({ state: 'delivered' })
    expect(JSON.parse(f.request.mock.calls[1][1].body).replaceSha).toBe('a'.repeat(40))
    expect(get(transferBusy)).toBe(false)
})
test('append does not select or overwrite old chats/global settings and arms before save/finish', async () => {
    const old = structuredClone(f.db.characters[0].chats[0]), order: string[] = []
    f.save.mockImplementation(async () => { order.push('save') })
    f.request.mockImplementation(async (path: string) => {
        order.push(path)
        if (path.endsWith('/inspect')) return reply({ characters: [{ id: 'card', name: 'Keep', candidates: [{ id: 'existing', name: 'Keep' }] }] })
        if (path.endsWith('/prepare')) return reply({ transaction: 'tx', added: [{ characterId: 'existing', chat: { id: 'incoming', message: [], modelBinding: { main: 'foreign-model' }, scriptstate: { n: 4 } } }], newCharacters: [], registry: { transactions: { tx: 'instance' } } })
        return reply([])
    })
    await receiveTransfer('in')
    expect(f.db.characters[0].chats[0]).toEqual(old); expect(f.db.characters[0].chatPage).toBe(0)
    expect(f.db.characters[0].chats[1].modelBinding).toEqual({ main: 'receiver-model' })
    expect(f.db.characters[0].chats[1].scriptstate).toEqual({ n: 4 })
    expect(f.db.enabledModules).toEqual(['local-module']); expect(f.db.apiKey).toBe('fixture-only')
    expect(order.slice(0, 6)).toEqual(['/in/inspect', 'save', '/in/prepare', '/in/arm', 'save', '/in/finish'])
    expect(f.save).toHaveBeenLastCalledWith({ chats: [['existing', 'incoming']], flushServer: 'canonical', rejectOnFailure: true })
    expect(get(transferBusy)).toBe(false)
})

test.each([false, true])('receiving into an off-screen character explicitly saves its new chat (new=%s)', async (newCharacter) => {
    const target = { chaId: 'offscreen', name: 'Received', chatPage: 0, chats: [] }
    if (!newCharacter) f.db.characters.push(target)
    f.request.mockImplementation(async (path: string) => {
        if (path.endsWith('/inspect')) return reply({ characters: [] })
        if (path.endsWith('/prepare')) return reply({ transaction: 'tx', added: [{ characterId: 'offscreen', chat: { id: 'incoming', message: [{ role: 'user', data: 'preserve' }] } }], newCharacters: newCharacter ? [target] : [], registry: {} })
        return reply([])
    })
    await receiveTransfer('in')
    expect(f.db.characters[0].chaId).toBe('existing')
    expect(f.db.characters[1].chats[0].message[0].data).toBe('preserve')
    expect(f.save).toHaveBeenLastCalledWith({ chats: [['offscreen', 'incoming']], flushServer: 'canonical', rejectOnFailure: true })
})
test('background generation and an existing import defer reception without touching the queue', async () => {
    ;(isAnyGenerating as any).set(true)
    await receiveTransfer('in'); expect(f.request).not.toHaveBeenCalled()
    await expect(exportTransfer(['old'])).rejects.toThrow('진행 중')
    ;(isAnyGenerating as any).set(false); importSession.set({ phase: 'applying' } as any)
    await receiveTransfer('in'); expect(f.request).not.toHaveBeenCalled()
})

test('a manual click racing the background receiver prepares and appends only once', async () => {
    f.request.mockImplementation(async (path: string) => {
        if (path.endsWith('/inspect')) return reply({ characters: [] })
        if (path.endsWith('/prepare')) return reply({ transaction: 'tx', newCharacters: [], added: [{ characterId: 'existing', chat: { id: 'incoming', message: [] } }], registry: {} })
        return reply([])
    })
    await Promise.all([receiveTransfer('in'), receiveTransfer('in', true)])
    expect(f.request.mock.calls.filter(c => c[0] === '/in/prepare')).toHaveLength(1)
    expect(f.db.characters[0].chats.map((chat: any) => chat.id)).toEqual(['old', 'incoming'])
})
test('startup recovery independently verifies committed client chat before server publication', async () => {
    f.db.risuPlaySets = { transactions: { tx: 'instance' } }
    const chat = f.db.characters[0].chats[0]
    const expected = { characterId: 'existing', chatId: 'old', fields: Object.keys(chat), hash: await hashLocalJson(chat) }
    f.request.mockImplementation(async (path: string) => reply(path === '/recovery' ? [{ id: 'in', transaction: 'tx', expected: [expected] }] : {}))
    await recoverTransfers(); expect(f.request).toHaveBeenCalledWith('/in/finish', expect.anything())
    f.request.mockClear(); chat.name = 'changed'
    await expect(recoverTransfers()).rejects.toThrow('복구를 보류')
    expect(f.request).toHaveBeenCalledTimes(1)
    f.select.mockResolvedValue(true); f.request.mockClear()
    await recoverTransfers()
    expect(f.request).toHaveBeenCalledWith('/in/hold-recovery', expect.objectContaining({ body: JSON.stringify({ confirmed: true }) }))
    expect(chat.name).toBe('changed')
})

// 0.9.103-ver4: transfer progress line (display only)
test('progress line: bytes give percent, MB, speed and remaining time; items count when no byte total; unknown totals stay indeterminate', () => {
    const bytes = transferProgressView({ stage: 'upload', bytes: 100_000_000, bytesTotal: 400_000_000, items: 0, itemsTotal: null, elapsedMs: 65_000, stageElapsedMs: 10_000 })
    expect(bytes).toMatchObject({ label: '올리는 중', percent: 25, tone: 'running' })
    expect(bytes.detail).toBe('100/400 MB · 10 MB/s · 남은 시간 약 30초 · 경과 1분 5초')
    const items = transferProgressView({ stage: 'install', bytes: 0, bytesTotal: null, items: 3, itemsTotal: 12, elapsedMs: 1_000, stageElapsedMs: 1_000 })
    expect(items).toMatchObject({ label: '그림 저장 중', percent: 25, detail: '3/12개 · 경과 1초' })
    const open = transferProgressView({ stage: 'collect', bytes: 5_500_000, bytesTotal: null, items: 7, itemsTotal: null, elapsedMs: 1_500, stageElapsedMs: 1_500 })
    expect(open).toMatchObject({ percent: null, detail: '5.5 MB · 7개 · 경과 2초' })
    // more bytes than the total (a re-read) never shows over 100 %
    expect(transferProgressView({ stage: 'hash', bytes: 9, bytesTotal: 5, items: 0, itemsTotal: null, elapsedMs: 0, stageElapsedMs: 0 }).percent).toBe(100)
    expect(transferProgressView({ stage: 'new-stage', bytes: 0, bytesTotal: null, items: 0, itemsTotal: null, elapsedMs: 0, stageElapsedMs: 0 }, null, '대기 문구').label).toBe('대기 문구')
})
test('progress line: native send states, finished and failed, and the text bar for the modal overlay', () => {
    expect(transferProgressView(null, { state: 'sending', sent: 50_000_000, total: 200_000_000 })).toMatchObject({ label: 'Wi-Fi·USB로 전송 중', percent: 25, detail: '50/200 MB', tone: 'running' })
    expect(transferProgressView(null, { state: 'delivered', sent: 0, total: 200_000_000 })).toMatchObject({ percent: 100, tone: 'done' })
    expect(transferProgressView(null, { state: 'applied' })).toMatchObject({ label: '받는 쪽에서 가져오기 완료', tone: 'done' })
    expect(transferProgressView(null, { state: 'unknown', error: '상태 조회 시간 초과' })).toMatchObject({ label: '상대 기기 상태를 확인하지 못했어요', detail: '상태 조회 시간 초과', tone: 'unknown', percent: null })
    expect(transferProgressView(null, { state: 'failed', error: 'x' })).toMatchObject({ label: '전송 실패', tone: 'failed', percent: null, detail: 'x' })
    expect(transferProgressView(null, null, '채팅을 저장하는 중…')).toMatchObject({ label: '채팅을 저장하는 중…', percent: null })
    expect(transferProgressText({ stage: 'pack', bytes: 42, bytesTotal: 100, items: 0, itemsTotal: null, elapsedMs: 3_000, stageElapsedMs: 1_000 })).toBe('전송 파일로 묶는 중 ████░░░░░░ 42% · 0.0/0.0 MB · 경과 3초')
    expect(transferProgressText({ stage: 'collect', bytes: 0, bytesTotal: null, items: 0, itemsTotal: null, elapsedMs: 3_000, stageElapsedMs: 3_000 })).toBe('대화·Wiki·저장 슬롯·그림을 모으는 중 · 경과 3초')
})
test('the modal status line carries the running step and returns to the step text when the server step ends', async () => {
    vi.useFakeTimers()
    try {
        let progress: any = { stage: 'verify', bytes: 50, bytesTotal: 100, items: 0, itemsTotal: null, elapsedMs: 1000, stageElapsedMs: 1000 }
        let release!: () => void
        const held = new Promise<void>(resolve => { release = resolve })
        f.request.mockImplementation(async (path: string) => {
            if (path === '/progress') return reply(progress)
            if (path.endsWith('/inspect')) return reply({ characters: [] })
            if (path.endsWith('/prepare')) { await held; return reply({ transaction: 'tx', newCharacters: [], added: [], registry: {} }) }
            return reply([])
        })
        const running = receiveTransfer('in')
        await vi.advanceTimersByTimeAsync(1000)
        expect(get(transferStatus)).toBe('받은 파일 검증 중 █████░░░░░ 50% · 0.0/0.0 MB · 경과 1초')
        progress = null
        await vi.advanceTimersByTimeAsync(1000)
        expect(get(transferStatus)).toBe('자료 검증 · 가져오기 준비 중…')
        release(); await running
        expect(get(transferStatus)).toBe('가져오기 완료 · 기존 캐릭터 목록에서 확인해 주세요.')
        await vi.advanceTimersByTimeAsync(3000)
        expect(f.request.mock.calls.filter(c => c[0] === '/progress').length).toBe(2)
    } finally { vi.useRealTimers() }
})
test('a progress request that hangs is cut after 5 s so the overlay line keeps updating; stop cancels the one in flight', async () => {
    vi.useFakeTimers()
    try {
        const signals: AbortSignal[] = []
        let release!: () => void
        const held = new Promise<void>(resolve => { release = resolve })
        f.request.mockImplementation(async (path: string, init: any = {}) => {
            if (path === '/progress') {
                signals.push(init.signal)
                if (signals.length !== 2) return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))))
                return reply({ stage: 'copy', bytes: 0, bytesTotal: null, items: 2, itemsTotal: 4, elapsedMs: 8000, stageElapsedMs: 1000 })
            }
            if (path.endsWith('/inspect')) return reply({ characters: [] })
            if (path.endsWith('/prepare')) { await held; return reply({ transaction: 'tx', newCharacters: [], added: [], registry: {} }) }
            return reply([])
        })
        const running = receiveTransfer('in')
        await vi.advanceTimersByTimeAsync(3000)
        expect(signals).toHaveLength(1); expect(get(transferStatus)).toBe('자료 검증 · 가져오기 준비 중…')
        await vi.advanceTimersByTimeAsync(4000)
        expect(signals[0].aborted).toBe(true); expect(signals.length).toBeGreaterThan(1)
        expect(get(transferStatus)).toBe('그림 꺼내는 중 █████░░░░░ 50% · 2/4개 · 경과 8초')
        await vi.advanceTimersByTimeAsync(1000)
        expect(signals).toHaveLength(3); expect(signals[2].aborted).toBe(false)
        release(); await running
        expect(signals[2].aborted).toBe(true)
        expect(get(transferStatus)).toBe('가져오기 완료 · 기존 캐릭터 목록에서 확인해 주세요.')
    } finally { vi.useRealTimers() }
})
test('Asset Maid pictures of a received chat are added to the existing card by name only when the name is new', async () => {
    f.db.characters[0].additionalAssets = [['mine.__am__.chat.a', 'assets/keep.png', 'png']]
    f.request.mockImplementation(async (path: string) => {
        if (path.endsWith('/inspect')) return reply({ characters: [] })
        if (path.endsWith('/prepare')) return reply({ transaction: 'tx', newCharacters: [], added: [{ characterId: 'existing', chat: { id: 'incoming', message: [] } }], registry: {},
            characterAssets: [{ characterId: 'existing', name: 'mine.__am__.chat.a', path: 'assets/other.png', ext: 'png' }, { characterId: 'existing', name: 'pc.__am__.chat.b', path: 'assets/b.png', ext: 'png' }, { characterId: 'missing', name: 'x', path: 'assets/x.png', ext: 'png' }] })
        return reply([])
    })
    await receiveTransfer('in')
    expect(f.db.characters[0].additionalAssets).toEqual([['mine.__am__.chat.a', 'assets/keep.png', 'png'], ['pc.__am__.chat.b', 'assets/b.png', 'png']])
    expect(f.save).toHaveBeenLastCalledWith({ chats: [['existing', 'incoming']], characters: ['existing'], flushServer: 'canonical', rejectOnFailure: true })
})
test('a chat received before (duplicate) still gets its missing Asset Maid names, compared case-insensitively, and the card alone is saved', async () => {
    f.db.characters[0].additionalAssets = [['Mine.__AM__.chat.a', 'assets/keep.png', 'png']]
    f.db.modules = [{ id: 'mod', assets: [['module.taken', 'assets/module.png', 'png']] }, { id: 'no-assets' }]
    f.db.personas = [{ id: 'p', embeddedModule: { id: 'em', assets: [['PERSONA.taken', 'assets/persona.png', 'png']] } }, { id: 'plain' }]
    f.request.mockImplementation(async (path: string) => {
        if (path.endsWith('/inspect')) return reply({ characters: [] })
        if (path.endsWith('/prepare')) return reply({ transaction: 'tx', newCharacters: [], added: [], registry: {}, duplicate: true,
            characterAssets: [{ characterId: 'existing', name: 'mine.__am__.chat.a', path: 'assets/other.png', ext: 'png' }, { characterId: 'existing', name: 'pc.__am__.chat.b', path: 'assets/b.png', ext: 'png' }, { characterId: 'existing', name: 'Module.Taken', path: 'assets/t.png', ext: 'png' }, { characterId: 'existing', name: 'persona.TAKEN', path: 'assets/p.png', ext: 'png' }] })
        return reply([])
    })
    await receiveTransfer('in')
    expect(f.db.characters[0].additionalAssets).toEqual([['Mine.__AM__.chat.a', 'assets/keep.png', 'png'], ['pc.__am__.chat.b', 'assets/b.png', 'png']])
    expect(f.save).toHaveBeenLastCalledWith({ chats: [], characters: ['existing'], flushServer: 'canonical', rejectOnFailure: true })
    expect(get(transferStatus)).toBe('이미 받은 동일한 자료예요. 중복으로 추가하지 않았어요. 에셋메이드 그림 1개를 캐릭터에 더했어요.')
})
