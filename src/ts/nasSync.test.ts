import { beforeEach, test, expect, vi } from 'vitest'
import { get, writable } from 'svelte/store'
const f = vi.hoisted(() => ({ db: {} as any, request: vi.fn(), save: vi.fn(), unavailable: vi.fn(), confirm: vi.fn(), order: vi.fn(), storage: { syncTransaction: undefined as string | undefined }, tracked: null as any, hydrate: undefined as any }))
vi.mock('./globalApi.svelte', () => ({ forageStorage: { Init: async () => {}, realStorage: Object.assign(f.storage, { syncRequest: (...args: any[]) => f.request(...args) }) }, requestImmediateSave: (...args: any[]) => f.save(...args), checkCharOrder: () => f.order(), pendingTrackedChanges: () => f.tracked }))
vi.mock('./storage/database.svelte', () => ({ getDatabase: () => f.db, normalizeChat: (chat: any) => chat }))
vi.mock('./storage/chatStorage', () => ({ ensureChatHydrated: async (chats: any[], index: number, id: string) => f.hydrate ? f.hydrate(chats, index, id) : chats[index] }))
vi.mock('./alert', () => ({ alertConfirm: (...args: any[]) => f.confirm(...args) }))
vi.mock('./transfer-sync/playTransfer', () => ({ transferUnavailable: () => f.unavailable() }))
vi.mock('./stores.svelte', () => ({ selectedCharID: writable(0) }))
vi.mock('./polyfill', async () => { const rfdc = (await import('rfdc')).default({ circles: true }); return { safeStructuredClone: (v: any) => { try { return structuredClone(v) } catch { return rfdc(v) } } } })
import { applySync, recoverSync, restoreOpenDeletion, acceptOpenDeletion } from './nasSync'
import { selectedCharID } from './stores.svelte'
import { transferBusy, syncSaveHold, syncBusyOwned } from './transferState'
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const chatA = () => ({ id: 'A', name: 'A', message: [{ role: 'char', data: 'a' }], scriptstate: { n: 1 } }), chatB = () => ({ id: 'B', name: 'B', message: [{ role: 'char', data: 'b' }] })
function basePlan(overrides: any = {}) {
    return { transaction: 'tx', phase: 'prepared', settings: { aiModel: 'remote-model' }, pluginEnabled: { plug: false }, modules: [{ id: 'mod', name: '원격 모듈' }], plugins: [{ name: 'plug', script: '', realArg: {}, enabled: false }],
        characters: [{ chaId: 'card', fields: { chaId: 'card', name: '원격 이름', desc: '원격 설명' }, chatIds: ['B', 'A'] }], newCharacters: [], chats: [{ characterId: 'card', chat: { ...chatA(), message: [{ role: 'char', data: 'a' }, { role: 'user', data: '원격 추가' }] }, update: true, root: 'A', head: 'h' }], deletions: [], pending: [], ...overrides }
}
/** Faithful stand-in for Svelte $state: a Proxy tree, which structuredClone rejects with DataCloneError exactly like rune state. */
const stateLike = <T>(value: T): T => (value && typeof value === 'object') ? new Proxy(Array.isArray(value) ? (value as any).map(stateLike) : Object.fromEntries(Object.entries(value as any).map(([k, v]) => [k, stateLike(v)])), {}) as T : value
const liveDb = () => stateLike({ aiModel: 'local-model', textAreaSize: 7, modules: [{ id: 'local-mod', name: '로컬 모듈' }], plugins: [{ name: 'plug', script: '', realArg: {}, enabled: true }], characters: [{ chaId: 'card', name: '로컬 이름', desc: '로컬 설명', chatPage: 1, viewScreen: 'x', chats: [chatA(), chatB()] }] })
beforeEach(() => {
    f.db = liveDb()
    expect(() => structuredClone(f.db.characters[0].chats[0])).toThrow() // the fixture really behaves like proxied app state
    f.request.mockReset(); f.save.mockReset(); f.save.mockResolvedValue(undefined); f.unavailable.mockReturnValue(false); f.confirm.mockReset(); f.order.mockReset(); f.storage.syncTransaction = undefined
    selectedCharID.set(0); transferBusy.set(false); syncSaveHold.set(false); f.tracked = null; f.hydrate = undefined
})
const EMPTY_TRACKED = { character: [] as string[], chat: [] as [string, string][], root: false, botPreset: false, modules: false, plugins: false, pluginCustomStorage: false }
const script = (handlers: Record<string, (init?: RequestInit) => Response | Promise<Response>>) => f.request.mockImplementation(async (path: string, init?: RequestInit) => { const h = handlers[path]; if (!h) throw new Error('unexpected ' + path); return h(init) })

test('arm comes before any mutation, the header is set before the save, selection follows ids (not indexes), in-place chat identity and local fields survive', async () => {
    const order: string[] = [], chatRef = f.db.characters[0].chats[0]
    f.db.characters[0].chats[1].draftText = '작성 중 초안'
    script({
        '/plan': () => { order.push('plan'); return reply(basePlan()) },
        '/arm': init => { order.push('arm'); expect(f.db.aiModel).toBe('local-model'); expect(f.storage.syncTransaction).toBeUndefined(); const body = JSON.parse(init!.body as string); expect(body.chats[0].chat.message).toHaveLength(2); expect(body.keptDeletions).toEqual([]); return reply({ ready: true }) },
        '/finish': () => { order.push('finish'); return reply({ state: 'applied', pending: [], keptDeletions: [] }) },
    })
    f.save.mockImplementation(async (options: any) => { order.push(options?.chats ? 'save-chats' : 'save'); if (options?.chats) { expect(f.storage.syncTransaction).toBe('tx'); expect(f.db.aiModel).toBe('remote-model'); expect(options.syncOwned).toBe(true); expect(get(syncSaveHold)).toBe(true) } else expect(get(syncSaveHold)).toBe(false) })
    const result = await applySync()
    expect(result.state).toBe('applied')
    expect(order).toEqual(['save', 'plan', 'save', 'arm', 'save-chats', 'finish'])
    const a = f.db.characters[0].chats.find((c: any) => c.id === 'A')
    expect(a).toBe(chatRef) // same object: screen bindings/draft stay attached
    expect(a.message).toHaveLength(2); expect(a.scriptstate).toEqual({ n: 1 })
    expect(f.db.characters[0].chats.map((c: any) => c.id)).toEqual(['B', 'A']) // remote order applied
    expect(f.db.characters[0].chatPage).toBe(0) // the open chat was B at index 1; it is still B at index 0
    expect(f.db.characters[0].chats.find((c: any) => c.id === 'B').draftText).toBe('작성 중 초안')
    expect(f.db.characters[0]).toMatchObject({ name: '원격 이름', viewScreen: 'x' }) // metadata applied, device-local kept
    expect(f.db.textAreaSize).toBe(7); expect(f.db.aiModel).toBe('remote-model')
    expect(f.db.modules.map((m: any) => m.id)).toEqual(['local-mod', 'mod']); expect(f.db.plugins[0].enabled).toBe(false)
    expect(f.storage.syncTransaction).toBeUndefined(); expect(get(transferBusy)).toBe(false); expect(get(syncSaveHold)).toBe(false)
})

test('a rejected save is not proof of no save: the rewind happens only after the server proves every entity untouched', async () => {
    const before = JSON.parse(JSON.stringify(f.db)) // proxied app state: compare by value
    script({ '/plan': () => reply(basePlan()), '/arm': () => reply({ ready: true }), '/finish': init => { expect(JSON.parse(init!.body as string).confirmed).toBe(false); return reply({ state: 'rolled-back', transaction: 'tx' }) } })
    f.save.mockImplementation(async (options: any) => { if (options?.chats) throw new Error('flush failed') })
    const result = await applySync()
    expect(result.state).toBe('save-failed')
    expect(JSON.parse(JSON.stringify(f.db))).toEqual(before) // exact targeted rollback: settings, modules, plugins, chats, order, chatPage
    expect(f.storage.syncTransaction).toBeUndefined(); expect(get(syncSaveHold)).toBe(false)
})

test('partial or unknown save outcome keeps the applied local state, the write gate header and the journal for recovery', async () => {
    for (const verdict of [() => reply({ error: 'partial', code: 'NAS_SYNC_PARTIAL' }, 400), () => reply({ error: 'down' }, 503)]) {
        f.db.characters[0].chats[0] = chatA(); f.db.aiModel = 'local-model'; f.storage.syncTransaction = undefined
        script({ '/plan': () => reply(basePlan()), '/arm': () => reply({ ready: true }), '/finish': verdict })
        f.save.mockImplementation(async (options: any) => { if (options?.chats) throw new Error('response lost after write') })
        const result = await applySync()
        expect(result.state).toBe('finish-pending')
        expect(f.db.aiModel).toBe('remote-model'); expect(f.db.characters[0].chats.find((c: any) => c.id === 'A').message).toHaveLength(2) // nothing rewound
        expect(f.storage.syncTransaction).toBeUndefined() // no header: the server gate now refuses ordinary saves (423 NAS_SYNC_BUSY)
        expect(get(syncSaveHold)).toBe(true) // and the local autosave loop is held until recovery settles the transaction
        syncSaveHold.set(false)
    }
    // Save succeeded but finish is unreachable: same outcome, no rewind, no reload.
    f.save.mockResolvedValue(undefined)
    script({ '/plan': () => reply(basePlan()), '/arm': () => reply({ ready: true }), '/finish': () => reply({ error: 'gone' }, 502) })
    const result = await applySync()
    expect(result.state).toBe('finish-pending'); expect(f.db.aiModel).toBe('remote-model'); expect(get(syncSaveHold)).toBe(true)
    // Startup recovery then settles it and releases the hold.
    script({ '/recovery': () => reply([{ transaction: 'tx', phase: 'saving' }]), '/finish': () => reply({ state: 'applied' }) })
    await recoverSync(); expect(get(syncSaveHold)).toBe(false)
})

test('an exception during the mutation stage is settled like a failed save: rollback only on the server verdict, otherwise hold and journal stay', async () => {
    const before = JSON.parse(JSON.stringify(f.db))
    f.order.mockImplementation(() => { throw new Error('ordering exploded') })
    // Verdict: rolled back → exact restore, hold released.
    script({ '/plan': () => reply(basePlan()), '/arm': () => reply({ ready: true }), '/finish': () => reply({ state: 'rolled-back' }) })
    expect((await applySync()).state).toBe('save-failed')
    expect(JSON.parse(JSON.stringify(f.db))).toEqual(before); expect(get(syncSaveHold)).toBe(false); expect(f.storage.syncTransaction).toBeUndefined(); expect(f.save).toHaveBeenCalledTimes(2) // the pre-plan and pre-arm drains, never the apply save
    // Verdict unknown (server unreachable) → nothing rewound, hold kept, header dropped, busy kept.
    script({ '/plan': () => reply(basePlan()), '/arm': () => reply({ ready: true }), '/finish': () => reply({ error: 'gone' }, 503) })
    expect((await applySync()).state).toBe('finish-pending')
    expect(f.db.aiModel).toBe('remote-model'); expect(get(syncSaveHold)).toBe(true); expect(f.storage.syncTransaction).toBeUndefined(); expect(get(transferBusy)).toBe(true)
    f.order.mockReset(); syncSaveHold.set(false); transferBusy.set(false)
})

test('the currently open chat is never removed by a remote deletion: it keeps its draft with inline restore state and is reported as kept', async () => {
    f.db.characters[0].chatPage = 0 // A is open
    let armed: any
    script({ '/plan': () => reply(basePlan({ chats: [], characters: [], deletions: [{ kind: 'chat', characterId: 'card', id: 'A' }, { kind: 'chat', characterId: 'card', id: 'B' }] })), '/arm': init => { armed = JSON.parse(init!.body as string); return reply({ ready: true }) }, '/finish': () => reply({ state: 'applied', pending: [], keptDeletions: armed.keptDeletions }) })
    const result = await applySync()
    expect(result.state).toBe('applied')
    expect(armed.keptDeletions).toEqual([{ kind: 'chat', characterId: 'card', id: 'A' }])
    expect(f.db.characters[0].chats.map((c: any) => c.id)).toEqual(['A'])
    expect(f.db.characters[0].chats[0].risuSyncDeleted).toEqual({ transaction: 'tx', restorable: true })
    expect(f.db.characters[0].chatPage).toBe(0)
})

test('selected character survives insertion before it, and the busy gate refuses to start', async () => {
    f.db.characters.unshift({ chaId: 'other', name: '다른', chatPage: 0, chats: [] }); selectedCharID.set(1)
    script({ '/plan': () => reply(basePlan({ chats: [], characters: [], newCharacters: [{ chaId: 'new', name: '새 캐릭터', chatIds: [] }] })), '/arm': () => reply({ ready: true }), '/finish': () => reply({ state: 'applied', pending: [], keptDeletions: [] }) })
    expect((await applySync()).state).toBe('applied')
    expect(f.db.characters[get(selectedCharID)].chaId).toBe('card')
    f.unavailable.mockReturnValue(true)
    expect((await applySync()).state).toBe('busy'); expect(f.request).toHaveBeenCalledTimes(3)
})

test('startup recovery fails closed on a transient read error, bypasses only a legacy server without the endpoint', async () => {
    let attempts = 0
    script({ '/recovery': () => { attempts++; return reply({ error: 'boom' }, 503) } })
    await expect(recoverSync()).rejects.toThrow(/복구 상태를 확인할 수 없어요/); expect(attempts).toBe(3)
    script({ '/recovery': () => reply({ error: 'not found' }, 404) })
    await expect(recoverSync()).resolves.toBeUndefined()
})

test('startup recovery finishes pending plans before anything else and holds only on explicit confirmation', async () => {
    const calls: string[] = []
    script({ '/recovery': () => reply([{ transaction: 'tx', phase: 'saving' }]), '/finish': () => { calls.push('finish'); return reply({ error: 'Saved state does not match the prepared sync apply; recovery retained' }, 400) }, '/hold': init => { calls.push('hold'); expect(JSON.parse(init!.body as string)).toEqual({ transaction: 'tx', confirmed: true }); return reply({ state: 'recovery-held' }) } })
    f.confirm.mockResolvedValue(false)
    await expect(recoverSync()).rejects.toThrow(/recovery retained/)
    f.confirm.mockResolvedValue(true)
    await recoverSync()
    expect(calls).toEqual(['finish', 'finish', 'hold'])
    expect(f.storage.syncTransaction).toBeUndefined(); expect(get(transferBusy)).toBe(false)
})

test('an edit the user makes while /plan is pending is preserved: the plan is abandoned before any mutation, released only on the rollback verdict, and the edit stays queued for the next ordinary save (Codex 21)', async () => {
    const calls: string[] = []
    script({
        '/plan': () => { f.db.characters[0].chats[0].message.push({ role: 'user', data: '기다리는 동안 입력' }); f.tracked = { ...EMPTY_TRACKED, chat: [['card', 'A']], character: ['card'] }; calls.push('plan'); return reply(basePlan()) },
        '/arm': () => { calls.push('arm'); return reply({ ready: true }) },
        '/finish': init => { calls.push('finish'); expect(JSON.parse(init!.body as string)).toEqual({ transaction: 'tx', confirmed: false }); return reply({ state: 'rolled-back', transaction: 'tx' }) },
    })
    const result = await applySync()
    expect(result).toMatchObject({ state: 'deferred', transaction: 'tx', deferred: ['chat:card/A', 'character:card'] })
    expect(calls).toEqual(['plan', 'finish'])
    expect(f.db.characters[0].chats[0].message.map((m: any) => m.data)).toEqual(['a', '기다리는 동안 입력']); expect(f.db.aiModel).toBe('local-model'); expect(f.db.characters[0].name).toBe('로컬 이름')
    expect(f.save).toHaveBeenCalledTimes(1) // only the pre-plan drain: the edit is left to the ordinary save queue, never saved under the sync header
    expect(f.tracked.chat).toEqual([['card', 'A']]) // still tracked, not consumed
    expect(get(syncSaveHold)).toBe(false); expect(get(transferBusy)).toBe(false); expect(f.storage.syncTransaction).toBeUndefined()
})

test('edits during hydration or while arming are caught at the apply boundary; an edit the plan does not touch does not defer', async () => {
    f.hydrate = async (chats: any[], index: number) => { chats[index].message.push({ role: 'user', data: '하이드레이션 중 입력' }); f.tracked = { ...EMPTY_TRACKED, chat: [['card', 'A']] }; return chats[index] }
    script({ '/plan': () => reply(basePlan()), '/arm': () => { throw new Error('must not arm') }, '/finish': () => reply({ state: 'rolled-back' }) })
    expect((await applySync()).state).toBe('deferred'); expect(f.db.characters[0].chats[0].message).toHaveLength(2); expect(f.db.aiModel).toBe('local-model')
    f.hydrate = undefined; f.tracked = null
    // While arming (the first check passed): still nothing mutated; the verdict releases the gate.
    script({ '/plan': () => reply(basePlan()), '/arm': () => { f.db.characters[0].chats[0].message.push({ role: 'user', data: '암 중 입력' }); f.tracked = { ...EMPTY_TRACKED, chat: [['card', 'A']] }; return reply({ ready: true }) }, '/finish': init => { expect(JSON.parse(init!.body as string).confirmed).toBe(false); return reply({ state: 'rolled-back' }) } })
    expect((await applySync()).state).toBe('deferred'); expect(f.db.aiModel).toBe('local-model'); expect(f.db.characters[0].chats[0].message).toHaveLength(3)
    expect(f.save).toHaveBeenCalledTimes(3); expect(f.storage.syncTransaction).toBeUndefined(); expect(get(syncSaveHold)).toBe(false) // two drains + no apply save
    // A tracked edit of another chat: the apply proceeds (that chat is not written by the plan).
    f.tracked = { ...EMPTY_TRACKED, chat: [['card', 'B']] }
    script({ '/plan': () => reply(basePlan()), '/arm': () => reply({ ready: true }), '/finish': () => reply({ state: 'applied', pending: [], keptDeletions: [] }) })
    expect((await applySync()).state).toBe('applied'); expect(f.db.aiModel).toBe('remote-model')
})

test('a replan verdict from arm abandons the plan; an unreachable release after arming is an unknown outcome (hold kept) that recovery with nothing pending settles, releasing only sync-owned busy state (Codex 20/21)', async () => {
    script({ '/plan': () => reply(basePlan()), '/arm': () => reply({ error: 'changed after prepare', code: 'NAS_SYNC_REPLAN' }, 409), '/finish': () => reply({ state: 'rolled-back' }) })
    expect(await applySync()).toMatchObject({ state: 'deferred', deferred: ['baseline-changed'] }); expect(f.db.aiModel).toBe('local-model'); expect(get(syncSaveHold)).toBe(false)
    script({ '/plan': () => reply(basePlan()), '/arm': () => { f.tracked = { ...EMPTY_TRACKED, chat: [['card', 'A']] }; return reply({ ready: true }) }, '/finish': () => reply({ error: 'gone' }, 503) })
    expect((await applySync()).state).toBe('finish-pending'); expect(f.db.aiModel).toBe('local-model'); expect(get(syncSaveHold)).toBe(true); expect(get(transferBusy)).toBe(true)
    script({ '/recovery': () => reply([]) }) // the server settled it meanwhile (e.g. the release did land)
    await recoverSync(); expect(get(syncSaveHold)).toBe(false); expect(get(transferBusy)).toBe(false)
    // Busy state owned by a manual transfer is left alone by recovery.
    transferBusy.set(true); script({ '/recovery': () => reply([]) }); await recoverSync(); expect(get(transferBusy)).toBe(true); transferBusy.set(false)
})

test('the kept-deletion actions (banner/panel) are refused while generation, import, transfer or an apply runs, own the busy state while they run, and mutate the open chat only after the server call (Codex 29)', async () => {
    f.db.characters[0].chats[0].risuSyncDeleted = { transaction: 'tx', restorable: true }
    f.unavailable.mockReturnValue(true) // generation/import/transfer/apply running
    await expect(restoreOpenDeletion('card', 'A')).rejects.toThrow(/진행 중인 작업/); await expect(acceptOpenDeletion('card', 'A')).rejects.toThrow(/진행 중인 작업/)
    expect(f.request).not.toHaveBeenCalled(); expect(f.db.characters[0].chats).toHaveLength(2); expect(f.db.characters[0].chats[0].risuSyncDeleted).toBeTruthy()
    f.unavailable.mockReturnValue(false)
    let busyDuring = false
    script({ '/open-deletion/restore': () => { busyDuring = get(transferBusy); return reply({ restored: [{ root: 'A' }], state: 'live' }) } })
    expect(await restoreOpenDeletion('card', 'A')).toMatchObject({ state: 'live' })
    expect(busyDuring).toBe(true); expect(get(transferBusy)).toBe(false) // owned during, released after
    expect(f.db.characters[0].chats[0].risuSyncDeleted).toBeUndefined(); expect(f.save).toHaveBeenCalledTimes(2) // publish-before and persist-after saves
    // Accept: server first, then the local removal; a server refusal leaves the chat in place.
    f.db.characters[0].chats[1].risuSyncDeleted = { transaction: 'tx', restorable: true }; f.save.mockClear()
    script({ '/open-deletion/accept': () => reply({ error: 'refused' }, 400) })
    await expect(acceptOpenDeletion('card', 'B')).rejects.toThrow('refused'); expect(f.db.characters[0].chats.map((c: any) => c.id)).toEqual(['A', 'B']); expect(get(transferBusy)).toBe(false)
    script({ '/open-deletion/accept': () => reply({ accepted: 'B' }) })
    await acceptOpenDeletion('card', 'B'); expect(f.db.characters[0].chats.map((c: any) => c.id)).toEqual(['A']); expect(f.db.characters[0].chatPage).toBe(0); expect(f.save).toHaveBeenCalledTimes(1)
})

test('planned theme presets keep this device\'s layout fields (merged before arm, so the echo and the saved entries agree); synced fields come from the plan', async () => {
    f.db.themePresets = [{ name: '로컬', font: 'l', zoomsize: 7, iconsize: 3, textAreaSize: 12 }, { name: '둘째', zoomsize: 9 }] as any
    let echoed: any
    script({
        '/plan': () => reply({ ...basePlan(), settings: { ...basePlan().settings, themePresets: [{ name: '원격', font: 'r', lineHeight: 1.6 }, { name: '둘째', font: 'q' }, { name: '셋째' }] } }),
        '/arm': init => { echoed = JSON.parse(init!.body as string).settings.themePresets; return reply({ ready: true }) },
        '/finish': () => reply({ state: 'applied', pending: [], keptDeletions: [] }),
    })
    expect((await applySync()).state).toBe('applied')
    const expected = [{ name: '원격', font: 'r', lineHeight: 1.6, zoomsize: 7, iconsize: 3, textAreaSize: 12 }, { name: '둘째', font: 'q', zoomsize: 9 }, { name: '셋째' }]
    expect(echoed).toEqual(expected)
    expect(JSON.parse(JSON.stringify(f.db.themePresets))).toEqual(expected)
})

test('the pre-arm stage keeps the app usable: no app-wide busy during drain/plan/hydration, busy only from arm to the verdict (sync-owned); with the real transferUnavailable (which counts the hold) a plan still arms; a foreign transfer that started during the plan wait defers it and keeps its own busy', async () => {
    // Production transferUnavailable() includes get(syncSaveHold): the apply's own hold must never count as a foreign activity.
    f.unavailable.mockImplementation(() => get(transferBusy) || get(syncSaveHold))
    const busyAt: Record<string, boolean> = {}
    script({
        '/plan': () => { busyAt.plan = get(transferBusy); busyAt.holdAtPlan = get(syncSaveHold); return reply(basePlan()) },
        '/arm': () => { busyAt.arm = get(transferBusy); busyAt.armOwned = get(syncBusyOwned); return reply({ ready: true }) },
        '/finish': () => reply({ state: 'applied', pending: [], keptDeletions: [] }),
    })
    expect((await applySync()).state).toBe('applied')
    expect(busyAt).toEqual({ plan: false, holdAtPlan: false, arm: true, armOwned: true }) // no hold while the plan is prepared; hold + busy start at arm; expect(get(transferBusy)).toBe(false); expect(get(syncBusyOwned)).toBe(false); expect(get(syncSaveHold)).toBe(false)
    // A manual transfer begins while the plan is pending (it sets transferBusy itself): the plan is abandoned before any mutation,
    // released on the server, and the transfer's busy flag is left exactly as it was.
    f.request.mockReset(); let finished = false
    script({ '/plan': () => { transferBusy.set(true); return reply(basePlan()) }, '/finish': () => { finished = true; return reply({ state: 'rolled-back' }) } })
    const deferred = await applySync()
    expect(deferred.state).toBe('deferred'); expect(finished).toBe(true); expect(get(transferBusy)).toBe(true); expect(get(syncBusyOwned)).toBe(false); expect(get(syncSaveHold)).toBe(false)
    transferBusy.set(false); f.unavailable.mockReturnValue(false)
})

test('pause/disable during the pre-plan drain cancels the apply before anything is held: the flush receives the signal, no plan is requested, hold and busy stay released', async () => {
    const controller = new AbortController()
    let flushSignal: AbortSignal | undefined
    f.save.mockImplementation(async (options: any) => { flushSignal = options?.flushSignal; controller.abort() })
    script({ '/plan': () => { throw new Error('must not be called') } })
    await expect(applySync(true, controller.signal)).rejects.toThrow('sync apply cancelled')
    expect(flushSignal).toBe(controller.signal)
    expect(f.request).not.toHaveBeenCalledWith('/plan', expect.anything())
    expect(get(syncSaveHold)).toBe(false); expect(get(transferBusy)).toBe(false); expect(get(syncBusyOwned)).toBe(false)
})

test('startup recovery with nothing pending releases an own busy together with its owned flag, so a later manual transfer never shows the NAS pause control', async () => {
    const { recoverSync: recover } = await import('./nasSync')
    // Drive the same path the product takes: a finish-pending apply (unreachable finish) leaves busy held and owned, then recovery runs.
    script({ '/plan': () => reply(basePlan()), '/arm': () => reply({ ready: true }), '/finish': () => { throw Object.assign(new Error('unreachable'), { status: 503 }) } })
    expect((await applySync()).state).toBe('finish-pending'); expect(get(transferBusy)).toBe(true); expect(get(syncBusyOwned)).toBe(true)
    f.request.mockReset(); script({ '/recovery': () => reply([]) })
    await recover()
    expect(get(transferBusy)).toBe(false); expect(get(syncBusyOwned)).toBe(false); expect(get(syncSaveHold)).toBe(false)
    transferBusy.set(true) // an unrelated manual transfer afterwards: busy without the NAS pause control
    expect(get(syncBusyOwned)).toBe(false); transferBusy.set(false)
})

test('startup recovery confirmation is reachable: the own busy (inert overlay) is released while asking and the save hold stays; busy returns for the hold and everything is released afterwards; declining fails closed; a manual transfer\'s busy is never released (live .77 tablet)', async () => {
    const seen: any[] = []
    const snapshot = (at: string) => seen.push({ at, busy: get(transferBusy), owned: get(syncBusyOwned), hold: get(syncSaveHold) })
    script({ '/recovery': () => reply([{ transaction: 'tx', phase: 'saving' }]), '/finish': () => reply({ error: 'Part of the sync apply may have been saved; recovery retained', code: 'NAS_SYNC_PARTIAL' }, 400), '/hold': () => { snapshot('hold'); return reply({ state: 'recovery-held' }) } })
    f.confirm.mockImplementation(async () => { snapshot('confirm'); return true })
    await recoverSync()
    expect(seen).toEqual([{ at: 'confirm', busy: false, owned: false, hold: true }, { at: 'hold', busy: true, owned: true, hold: true }])
    expect(get(transferBusy)).toBe(false); expect(get(syncBusyOwned)).toBe(false); expect(get(syncSaveHold)).toBe(false)
    // Declined: the error propagates (startup stops), the save hold stays (fail closed), the own busy is released with its owned flag.
    f.confirm.mockResolvedValue(false)
    await expect(recoverSync()).rejects.toThrow(/recovery retained/)
    expect(get(syncSaveHold)).toBe(true); expect(get(transferBusy)).toBe(false); expect(get(syncBusyOwned)).toBe(false)
    syncSaveHold.set(false)
    // A manual transfer's busy (not own) is left exactly as it was throughout.
    seen.length = 0; transferBusy.set(true); f.confirm.mockImplementation(async () => { snapshot('confirm'); return true })
    await recoverSync()
    expect(seen).toEqual([{ at: 'confirm', busy: true, owned: false, hold: true }, { at: 'hold', busy: true, owned: false, hold: true }])
    expect(get(transferBusy)).toBe(true); expect(get(syncBusyOwned)).toBe(false); expect(get(syncSaveHold)).toBe(false); transferBusy.set(false)
})

test('no hold during the plan wait: while /plan stalls the save hold is OFF and ordinary saves may persist; typing (tracked edit) during the stall abandons the plan before any mutation (DB object untouched), the hold is never taken', async () => {
    let releasePlan: ((r: Response) => void) | null = null
    const holdSeen: boolean[] = [], finished: any[] = []
    script({
        '/plan': () => new Promise<Response>(r => { releasePlan = r }),
        '/finish': init => { finished.push(JSON.parse(init!.body as string)); return reply({ state: 'rolled-back' }) },
    })
    const before = structuredClone(JSON.parse(JSON.stringify(f.db))), chatRef = f.db.characters[0].chats[0]
    const running = applySync(true, undefined, { window: 'foreground', interacted: () => false })
    await new Promise(r => setTimeout(r, 0)); holdSeen.push(get(syncSaveHold)) // plan request is in flight
    expect(holdSeen).toEqual([false]); expect(get(transferBusy)).toBe(false)
    f.tracked = { ...EMPTY_TRACKED, chat: [['card', 'A']] } // the user typed in the open chat while the plan stalled
    releasePlan!(reply(basePlan()))
    const outcome = await running
    expect(outcome.state).toBe('deferred'); expect(finished).toEqual([{ transaction: 'tx', confirmed: false }]) // released, not armed
    expect(get(syncSaveHold)).toBe(false); expect(get(transferBusy)).toBe(false); expect(f.save).not.toHaveBeenCalledWith(expect.objectContaining({ syncOwned: true }))
    expect(JSON.parse(JSON.stringify(f.db))).toEqual(before); expect(f.db.characters[0].chats[0]).toBe(chatRef) // nothing mutated, same objects
})

test('safe-window guard: an interaction reported after the plan returns releases it (no hold, no busy, no mutation); a plan that targets the chat on screen is released in a foreground window and applied in a reopen window', async () => {
    let interacted = false
    f.db.characters[0].chatPage = 0 // the chat on screen is A (the plan's chat row), fixed before the baseline is taken
    script({ '/plan': () => reply(basePlan()), '/finish': () => reply({ state: 'rolled-back' }) })
    const before = JSON.parse(JSON.stringify(f.db))
    // 1. interaction after the plan answer
    f.request.mockImplementationOnce(async () => { interacted = true; return reply(basePlan()) }) // the user touches the app exactly when /plan answers
    const a = await applySync(true, undefined, { window: 'foreground', interacted: () => interacted })
    expect(a.state).toBe('deferred'); expect(get(syncSaveHold)).toBe(false); expect(get(transferBusy)).toBe(false); expect(JSON.parse(JSON.stringify(f.db))).toEqual(before)
    // 2. the plan's real targets include the open chat (open chat A: chatPage 0): foreground → deferred-active-chat, nothing mutated
    interacted = false
    const b = await applySync(true, undefined, { window: 'foreground', interacted: () => false })
    expect(b.state).toBe('deferred-active-chat'); expect(get(syncSaveHold)).toBe(false); expect(JSON.parse(JSON.stringify(f.db))).toEqual(before)
    // 3. the same plan in a reopen window is applied (arm → save → finish), the hold is taken only for the armed stage
    const order: string[] = []
    script({
        '/plan': () => reply(basePlan()),
        '/arm': () => { order.push('arm:' + get(syncSaveHold)); return reply({ ready: true }) },
        '/finish': () => { order.push('finish'); return reply({ state: 'applied', pending: [], keptDeletions: [] }) },
    })
    f.save.mockImplementation(async (options: any) => { order.push(options?.syncOwned ? 'save-owned:' + get(syncSaveHold) : 'drain:' + get(syncSaveHold)) })
    const c = await applySync(true, undefined, { window: 'reopen', interacted: () => false })
    expect(c.state).toBe('applied'); expect(order).toEqual(['drain:false', 'drain:false', 'arm:true', 'save-owned:true', 'finish']) // two drains (before plan, before arm), hold only from arm
    expect(get(syncSaveHold)).toBe(false); expect(get(transferBusy)).toBe(false); expect(f.db.aiModel).toBe('remote-model')
})

test('selection change during the plan wait (the user opened another chat) releases the plan prepared for the previous view', async () => {
    let releasePlan: ((r: Response) => void) | null = null
    script({ '/plan': () => new Promise<Response>(r => { releasePlan = r }), '/finish': () => reply({ state: 'rolled-back' }) })
    const running = applySync(true, undefined, { window: 'reopen', interacted: () => false })
    await new Promise(r => setTimeout(r, 0))
    f.db.characters[0].chatPage = 0 // the user switched from chat B to chat A while the plan was pending
    releasePlan!(reply(basePlan()))
    const outcome = await running
    expect(outcome.state).toBe('deferred'); expect(get(syncSaveHold)).toBe(false); expect(f.db.aiModel).toBe('local-model')
})

test('pending memory differences are not reported as latest and never acquire a write hold', async () => {
    script({ '/plan': () => reply({ empty: true, pending: [{ reason: 'same-messages' }] }) })
    const result = await applySync(); expect(result.state).toBe('review-needed'); expect(get(syncSaveHold)).toBe(false)
    expect(f.request.mock.calls.some(([path]: any[]) => path === '/arm')).toBe(false)
})
