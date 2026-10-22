// View helpers behind the NAS sync area: authority binding, explicit peer choice, safe conflict labels, state rows, route restriction.
import { test, expect } from 'vitest'
import { syncItemTitle, syncDifference, syncRevisionTime, SYNC_ITEM_STATE, bootstrapAuthority, incomingPeers, conflictVariantLabel, syncStateRows, keyRequestNeeded, shareMethodAllowed, hydrateSyncForm, withSavedHomeSsids, routeLabel } from './nasSyncUi'

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
    expect(rows[4]).toContain('키 대기 · 최신 상태 · 일시 중지 · 주의: rotated')
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
