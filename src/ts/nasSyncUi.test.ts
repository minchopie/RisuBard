// View helpers behind the NAS sync area: authority binding, explicit peer choice, safe conflict labels, state rows, route restriction.
import { test, expect } from 'vitest'
import { syncItemTitle, syncDifference, syncRevisionTime, SYNC_ITEM_STATE, bootstrapAuthority, incomingPeers, conflictVariantLabel, syncStateRows, keyRequestNeeded, shareMethodAllowed, hydrateSyncForm, withSavedHomeSsids, routeLabel, detectDeviceKind, syncDeviceName, groupSyncTrash, syncHeadline } from './nasSyncUi'

test('revision dates always show Korea time and old or invalid dates stay unknown', () => {
    expect(syncRevisionTime(Date.parse('2026-10-22T16:05:00Z'))).toBe('2026. 10. 23. 01:05')
    for (const at of [undefined, null, '', '2026-10-22', 0, -1, NaN, Infinity, 8640000000000001]) expect(syncRevisionTime(at)).toBe('날짜 기록 없음')
})

test('bootstrap authority is the recorded grant sender, never the first incoming peer; peers are offered as identifiable choices', () => {
    const status = { enabled: true, role: 'joining', vault: { origin: 'shared', sharedFrom: 'tablet-device' }, sync: { incoming: { 'pc-device/inc1': { admitted: 3, applied: 1 }, 'tablet-device/inc9': { admitted: 7, applied: 7 } } } }
    expect(bootstrapAuthority(status)).toEqual({ device: 'tablet-device', from: 'grant' })
    const reversed = { ...status, sync: { incoming: { 'tablet-device/inc9': {}, 'pc-device/inc1': {} } } }
    expect(bootstrapAuthority(reversed)!.device).toBe('tablet-device') // enumeration order is irrelevant
    expect(bootstrapAuthority({ ...status, vault: { origin: null } })).toBeNull() // no recorded sender: explicit choice required
    expect(incomingPeers(status).map(p => p.device)).toEqual(['pc-device', 'tablet-device']); expect(incomingPeers(status)[1].label).toBe('tablet-d · 받은 7 · 적용 7')
})

test('conflict labels show differing public values with their source and never secret-looking fields or the reference list', () => {
    const a = { heads: ['aaaaaaaa1111'], source: { device: 'me', self: true }, content: { aiModel: 'gpt', openAIKey: '', $syncSecrets: [{ slot: '/openAIKey' }], temperature: 0.7, forceReplaceUrl: 'https://x' } }
    const b = { heads: ['bbbbbbbb2222'], source: { device: 'tablet-device', self: false }, content: { aiModel: 'claude', openAIKey: '', $syncSecrets: [{ slot: '/openAIKey' }], temperature: 0.7, forceReplaceUrl: 'https://x' } }
    const la = conflictVariantLabel(a, 0, [b]), lb = conflictVariantLabel(b, 1, [a])
    expect(la).toBe('1번 유지 · 이 기기 · aiModel: gpt'); expect(lb).toBe('2번 유지 · 다른 기기 · aiModel: claude')
    expect(la + lb).not.toMatch(/openAIKey|syncSecrets|temperature/)
    expect(conflictVariantLabel({ heads: ['cccccccc3333'], content: { apiKey: 'x', name: '프리셋' } }, 0)).toBe('1번 유지 · 출처 미상 · name: 프리셋')
    expect(conflictVariantLabel({ heads: ['dddddddd4444'], content: { token: 'x' } }, 0)).toBe('1번 유지 · 출처 미상 · 설정 내용 확인')
})

test('state rows report durable states and the coordinator snapshot; the key request is offered for a joining device without a key and for any installation whose key is missing', () => {
    const status = { enabled: true, role: 'joining', plan: null, conflicts: 2, localApply: 1, vault: { origin: 'shared', sharedFrom: 'tablet-device', missing: false }, sync: { workspaceId: 'ws', deviceId: 'phone-device', outbox: { pending: [{}], published: 4 }, trash: 1, incoming: { 'tablet-device/i': { pendingApply: 2, held: 1, quarantined: 0 } } } }
    const rows = syncStateRows(status, { enabled: true, running: false, paused: true, offline: false, failures: 0, lastCycleAt: 0, lastError: '', nextAt: 0, lastOutcome: 'key-pending:empty', generation: 0, attention: 'rotated', probed: true })
    expect(rows[0]).toContain('참여 기기'); expect(rows[1]).toContain('NAS 대기 1건 · NAS 반영 4건 · 받은 변경 적용 대기 2건 · 검토 필요 1건')
    expect(rows[2]).toContain('충돌 2건 · 휴지통 1건'); expect(rows[2]).toContain('반영 예약 1건'); expect(rows[3]).toContain('공유받음 (기기 tablet-d)')
    expect(rows[4]).toContain('키 대기 · 새로 적용할 변경 없음 · 일시 중지 · 주의: rotated')
    expect(syncStateRows({ enabled: false }, null)).toEqual([])
    expect(syncStateRows({ enabled: true, role: 'joining', vault: { origin: 'generated', missing: false }, sync: {} }, null)[3]).toBe('동기화 키: 아직 받지 않음 · 권한 기기에서 공유 키를 받아 주세요') // the unused local key is never shown as the workspace key
    expect(syncStateRows({ enabled: true, role: 'authority', vault: { origin: 'generated', missing: false }, sync: {} }, null)[3]).toBe('동기화 키: 이 기기에서 생성')
    expect(keyRequestNeeded({ enabled: true, role: 'joining', vault: { origin: null } })).toBe(true)
    expect(keyRequestNeeded({ enabled: true, role: 'joining', vault: { origin: 'shared', missing: false } })).toBe(false)
    expect(keyRequestNeeded({ enabled: true, role: 'authority', vault: { origin: 'generated', missing: true } })).toBe(true) // lost-key authority recovers from another holder
    expect(keyRequestNeeded({ enabled: false, vault: { missing: true } })).toBe(false)
    expect(['wifi', 'usb'].every(shareMethodAllowed)).toBe(true); expect(['file', 'nas', 'github', 'share'].some(shareMethodAllowed)).toBe(false)
})

test('the enable form resumes the saved workspace/role once — also while disabled — and polls never overwrite user edits (Codex 31)', () => {
    const defaults = { workspace: 'risubard', role: 'authority' as const }
    // Nothing saved yet (fresh install): defaults stay, hydration stays pending for the next status.
    expect(hydrateSyncForm({ enabled: false, role: null, workspaceId: null }, defaults, false)).toEqual({ form: defaults, hydrated: false })
    // Disabled joining device with a custom workspace: resumed exactly once.
    const first = hydrateSyncForm({ enabled: false, role: 'joining', workspaceId: 'family-nas' }, defaults, false)
    expect(first).toEqual({ form: { workspace: 'family-nas', role: 'joining' }, hydrated: true })
    // The user edits the workspace; a later poll (even one that now says enabled with other values) leaves the edit alone.
    const edited = { workspace: 'family-nas-2', role: 'joining' as const }
    expect(hydrateSyncForm({ enabled: true, role: 'authority', sync: { workspaceId: 'family-nas' } }, edited, true)).toEqual({ form: edited, hydrated: true })
    // Enabled status without the top-level field still hydrates from the store identity.
    expect(hydrateSyncForm({ enabled: true, role: 'authority', sync: { workspaceId: 'ws-x' } }, defaults, false).form).toEqual({ workspace: 'ws-x', role: 'authority' })
})

test('registering or forgetting a home Wi-Fi refreshes only the saved name list; unsaved URL/account/password/home-URL edits stay in the form; the route label never shows a Wi-Fi name', () => {
    const form = { url: 'https://typed.invalid/x/', username: 'typed', password: 'typed-secret', hasPassword: false, homeUrl: 'https://typed-home.invalid:5006/x/', homeSsids: ['Old'] }
    const next = withSavedHomeSsids(form, { url: 'https://saved.invalid/', username: 'saved', hasPassword: true, homeUrl: '', homeSsids: ['Fixture Home 2G', 'Fixture Home 5G'] })
    expect(next).toEqual({ ...form, homeSsids: ['Fixture Home 2G', 'Fixture Home 5G'] })
    expect(withSavedHomeSsids(form, null)).toEqual(form)
    expect(routeLabel({ route: 'home', reason: 'home-ssid', network: { transport: 'wifi', ssidKnown: true } })).toBe('NAS 경로: 집 네트워크 (내부 주소) · 등록된 집 Wi-Fi')
    expect(routeLabel({ route: 'external', reason: 'unknown-ssid' })).toBe('NAS 경로: 바깥 (외부 주소) · Wi-Fi 이름 미확인')
    expect(routeLabel({ route: 'single', reason: 'single-url' })).toBe('NAS 경로: 기본 주소 · 주소 하나')
})

test('sync overview names content, explains same-message differences and never claims a peer applied an upload', () => {
    expect(syncItemTitle({ type: 'group', id: 'personas' })).toBe('페르소나')
    expect(syncItemTitle({ type: 'chat', id: 'opaque-id', title: '마물소녀도감 · 현재 대화' })).toBe('마물소녀도감 · 현재 대화')
    expect(syncItemTitle({ type: 'group', id: 'userNote' })).not.toContain('userNote')
    expect(syncDifference({ sameMessages: true, differs: ['wiki', 'settings'] })).toBe('대화 본문은 같아요. 다른 항목: Wiki·기억, 페르소나·모듈·프리셋 연결')
    expect(SYNC_ITEM_STATE.uploaded).toBe('NAS 업로드 완료'); expect(SYNC_ITEM_STATE.uploaded).not.toContain('다른 기기')
    expect(conflictVariantLabel({ messages: 3, wikiFiles: 2, source: { device: 'opaque', self: false } }, 0)).not.toContain('opaque')
    expect(conflictVariantLabel({ content: { personas: [{ name: '용사' }] } }, 0)).toContain('새 항목은 함께 보존')
})

test('NAS revision list: same shown minute is one entry, newest five entries kept, undated last, nothing else changed', async () => {
    const { groupSyncItemsByTime, syncGroupTitles, syncGroupStates } = await import('./nasSyncUi')
    const t = (iso: string) => Date.parse(iso)
    const items = [
        { type: 'group', id: 'collectionOrganizers', nasAt: t('2026-10-20T15:03:10Z'), state: 'recorded' },
        { type: 'group', id: 'unknown-a', nasAt: t('2026-10-20T15:03:50Z'), state: 'recorded' }, // same Korea minute 00:03 → same entry
        { type: 'group', id: 'memory', nasAt: t('2026-10-21T03:24:00Z'), state: 'recorded' },
        { type: 'group', id: 'unknown-b', nasAt: t('2026-10-21T00:22:00Z'), state: 'recorded' },
        { type: 'chat', title: '마물 · Chat 1', nasAt: t('2026-10-19T01:00:00Z'), state: 'review' },
        { type: 'group', id: 'theme', nasAt: t('2026-10-18T01:00:00Z'), state: 'recorded' },
        { type: 'group', id: 'personas', nasAt: t('2026-10-17T01:00:00Z'), state: 'upload-pending' },
        { type: 'group', id: 'lorebook', nasAt: null, state: 'upload-pending' },
    ]
    const r = groupSyncItemsByTime(items)
    expect(r.groups.map(g => g.label)).toEqual(['2026. 10. 21. 12:24', '2026. 10. 21. 09:22', '2026. 10. 21. 00:03', '2026. 10. 19. 10:00', '2026. 10. 18. 10:00'])
    expect(r.groups[2].items).toHaveLength(2)
    expect(syncGroupTitles(r.groups[2].items)).toBe('앱 설정 ×2')
    expect({ hiddenGroups: r.hiddenGroups, hiddenItems: r.hiddenItems, hiddenAttention: r.hiddenAttention }).toEqual({ hiddenGroups: 2, hiddenItems: 2, hiddenAttention: 2 })
    expect(groupSyncItemsByTime(items, 20).groups.at(-1)).toMatchObject({ key: 'undated', label: '날짜 기록 없음', at: null })
    expect(syncGroupStates([items[0], items[4], items[1]])).toBe('NAS에 기록된 판본 · 차이 확인 필요')
    expect(syncGroupTitles([{ character: '캐릭', name: '대화' }, { type: 'group', id: 'memory' }])).toBe('캐릭 · 대화 · 기억 설정')
    expect(groupSyncItemsByTime(undefined)).toEqual({ groups: [], hiddenGroups: 0, hiddenItems: 0, hiddenAttention: 0 })
    expect(items).toHaveLength(8) // input untouched
})


test('completion labels distinguish receipt, partial apply and the persisted last application time', async () => {
    const { syncOutcomeText, OUTCOME_LABEL } = await import('./nasSyncUi')
    expect(syncOutcomeText('applied-pending', { pendingReview: 2, keptDeletions: 1 })).toBe('일부 적용 완료 · 차이 확인 2건 · 삭제 보류 1건')
    expect(OUTCOME_LABEL['recovery-pending']).toContain('적용 결과 확인 대기')
    expect(OUTCOME_LABEL.empty).not.toContain('최신')
    expect(OUTCOME_LABEL.deferred).not.toContain('다운로드')
    expect(SYNC_ITEM_STATE.pending).not.toContain('다운로드 완료')
    expect(syncStateRows({ enabled: true, lastAppliedAt: Date.parse('2026-10-24T01:23:00Z') }, null).at(-1)).toBe('이 기기 마지막 적용 완료: 2026. 10. 24. 10:23')
})

test('devices are named PC / 태블릿 / 스마트폰 from their reported profile, the reference device is marked, and unknown peers keep a short id', () => {
    expect(detectDeviceKind('Mozilla/5.0 (Windows NT 10.0) Chrome', { width: 1920, height: 1080 })).toBe('pc')
    expect(detectDeviceKind('Mozilla/5.0 (Linux; Android 15) RisuBardAndroid/0.9.99', { width: 1280, height: 800 })).toBe('tablet')
    expect(detectDeviceKind('Mozilla/5.0 (Linux; Android 15) RisuBardAndroid/0.9.99', { width: 412, height: 915 })).toBe('phone')
    const status = { enabled: true, role: 'joining', vault: { origin: 'shared', sharedFrom: 'tablet-device' }, sync: { deviceId: 'pc-device', profile: { kind: 'pc' }, incoming: { 'tablet-device/i1': { profile: { kind: 'tablet' } }, 'phone-device/i2': { profile: { kind: 'phone', name: 'S25' } }, 'old-device-123/i3': { profile: null } } } }
    expect(syncDeviceName(status, 'pc-device')).toBe('이 기기(PC)')
    expect(syncDeviceName(status, 'tablet-device')).toBe('태블릿 · 기준')
    expect(syncDeviceName(status, 'phone-device')).toBe('스마트폰 S25')
    expect(syncDeviceName(status, 'old-device-123')).toBe('기기 old-')
    expect(syncDeviceName(status, null)).toBe('출처 미상')
    const a = { heads: ['h1'], source: { device: 'pc-device', self: true }, content: { aiModel: 'gpt' } }, b = { heads: ['h2'], source: { device: 'tablet-device', self: false }, content: { aiModel: 'claude' } }
    expect(conflictVariantLabel(b, 1, [a], status)).toBe('태블릿 · 기준 값 유지 · aiModel: claude')
    expect(conflictVariantLabel(a, 0, [b], status)).toBe('이 기기(PC) 값 유지 · aiModel: gpt')
    expect(conflictVariantLabel(b, 1, [a])).toBe('2번 유지 · 다른 기기 · aiModel: claude') // callers without status keep the old wording
})

test('the trash shows one named row per deletion, newest first; the headline sums what needs the user in one line', () => {
    const rows = groupSyncTrash([
        { id: 'c1', operation: 'op1', type: 'chat', title: '리리스 · 첫 대화', deletedAt: 10, recoverableUntil: 99, cohort: 3, expired: false },
        { id: 'k1', operation: 'op1', type: 'character', title: '리리스', deletedAt: 10, recoverableUntil: 99, cohort: 3, expired: false },
        { id: 'c2', operation: 'op2', type: 'chat', title: null, deletedAt: 20, recoverableUntil: 99, cohort: 1, expired: true },
    ])
    expect(rows.map(r => [r.title, r.count, r.expired])).toEqual([['대화', 1, true], ['리리스, 리리스 · 첫 대화 외 1개', 3, false]])
    const status = { enabled: true, role: 'joining', lastAppliedAt: Date.parse('2026-10-28T16:38:00Z'), vault: { origin: 'shared', sharedFrom: 'tablet-device' }, sync: { deviceId: 'pc-device', profile: { kind: 'pc' }, outbox: { pending: [] }, incoming: { 'tablet-device/i': { profile: { kind: 'tablet' } } } } }
    expect(syncHeadline(status, [])).toEqual({ tone: 'ok', title: '최신 상태예요', detail: '이 기기(PC) · 기준 기기: 태블릿 · 마지막 적용: 2026. 10. 29. 01:38' })
    expect(syncHeadline(status, [{ state: 'diverged' }, { state: 'delete-pending' }]).title).toBe('확인이 필요한 항목 1건')
    expect(syncHeadline({ ...status, role: 'authority' }, []).detail).toContain('기준 기기: 이 기기')
    expect(syncHeadline({ enabled: false }, []).tone).toBe('off')
    // Received-but-unapplied changes, errors/offline and an unsettled apply never show as "최신 상태".
    const incoming = { ...status, sync: { ...status.sync, incoming: { 'tablet-device/i': { profile: { kind: 'tablet' }, pendingApply: 2 } } } }
    expect(syncHeadline(incoming, [], { lastOutcome: 'pulled' } as any)).toMatchObject({ tone: 'waiting', title: '받은 변경 2건 적용 대기' })
    expect(syncHeadline(status, [], { offline: true, lastOutcome: 'offline', lastError: 'network fetch failed' } as any)).toMatchObject({ tone: 'attention', title: '연결 안 됨 · 재시도 예정' })
    expect(syncHeadline(status, [], { lastOutcome: 'error', lastError: 'x' } as any)).toMatchObject({ tone: 'attention', title: '오류 · 재시도 예정' })
    expect(syncHeadline({ ...status, plan: { phase: 'saving' } }, [], { lastOutcome: 'recovery-pending' } as any).tone).toBe('attention')
    expect(syncHeadline({ ...status, sync: { ...status.sync, incoming: { 'tablet-device/i': { held: 1 } } } }, []).title).toBe('확인이 필요한 항목 1건')
    expect(syncHeadline(status, [], { paused: true } as any)).toMatchObject({ tone: 'waiting', title: '잠시 중지됨' })
    // Commits still waiting for their parents or blobs are not "최신 상태"; a pause after an error does not promise a retry.
    expect(syncHeadline({ ...status, sync: { ...status.sync, incoming: { 'tablet-device/i': { waiting: 1, pendingApply: 0, held: 0, quarantined: 0 } } } }, [], { lastOutcome: 'empty', lastError: '', offline: false } as any)).toMatchObject({ tone: 'waiting', title: '받은 변경 1건 · 나머지 자료 도착 대기' })
    expect(syncHeadline(status, [], { paused: true, offline: true, lastOutcome: 'offline', lastError: 'network fetch failed' } as any)).toMatchObject({ tone: 'attention', title: '잠시 중지됨 · 연결 안 됨' })
    expect(syncHeadline({ ...status, plan: { phase: 'saving' } }, [], { paused: true } as any)).toMatchObject({ tone: 'attention', title: '잠시 중지됨 · 이전 적용 결과 확인 대기' })
})
