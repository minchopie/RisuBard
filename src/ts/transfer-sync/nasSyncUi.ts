import type { CoordinatorState } from './nasSyncCoordinator'

/** Pure view helpers for the NAS sync area of the transfer panel (tested without rendering Svelte). */
export const SHARE_METHODS = ['wifi', 'usb'] as const
/** Key shares travel only over the trusted native channels; the generic routes (file, NAS, GitHub, Quick Share) reject them by design. */
export const shareMethodAllowed = (method: string) => (SHARE_METHODS as readonly string[]).includes(method)

/**
 * The bootstrap authority is the trusted device that granted this install its key (recorded by the service at install time).
 * Incoming-peer enumeration order is never used: with tablet + PC + phone the first peer may be another joining device.
 * Without a recorded sender the user must pick an identifiable source explicitly.
 */
export function bootstrapAuthority(status: any): { device: string; from: 'grant' } | null {
    const from = status?.vault?.sharedFrom
    return typeof from === 'string' && from ? { device: from, from: 'grant' } : null
}
/** Identifiable peers for an explicit choice: device id + what this install has seen from it. */
export function incomingPeers(status: any): { device: string; incarnation: string; label: string }[] {
    return Object.entries(status?.sync?.incoming ?? {}).map(([key, p]: [string, any]) => { const [device, incarnation] = key.split('/'); return { device, incarnation, label: `${device.slice(0, 8)} · 받은 ${p.admitted ?? 0} · 적용 ${p.applied ?? 0}` } })
}

const SECRET_LIKE = /key|token|secret|password|passwd|auth|credential|cookie/i
const REFS = '$syncSecrets'
/** Safe, reviewable summary of a conflict variant: public content only (the service never materializes secrets into it), secret-looking
 *  keys and the reference list skipped, values shortened. `other` variants are used to show what differs. */
export function conflictVariantLabel(variant: any, index: number, others: any[] = []): string {
    const sourceName = variant?.source?.self ? '이 기기' : '다른 기기';
    if (typeof variant?.messages === 'number') return `${sourceName}의 연결 자료 사용 · 대화 ${variant.messages}개 메시지 · Wiki ${variant.wikiFiles ?? 0}파일`;
    if (Array.isArray(variant?.content?.personas)) return `${sourceName}의 충돌 내용 사용 · ${variant.content.personas.map((p: any) => p.name || '이름 없는 페르소나').join(', ').slice(0, 160)} (새 항목은 함께 보존)`;
    const content = variant?.content ?? {}, keys = Object.keys(content).filter(k => k !== REFS && !SECRET_LIKE.test(k))
    const differing = keys.filter(k => others.some(o => JSON.stringify(o?.content?.[k]) !== JSON.stringify(content[k])))
    const shown = (differing.length ? differing : keys).slice(0, 4)
    const value = (v: unknown) => { const text = typeof v === 'string' ? v : JSON.stringify(v); return text === undefined ? '-' : text.length > 40 ? text.slice(0, 40) + '…' : text }
    const source = variant?.source?.self ? '이 기기' : variant?.source?.device ? '다른 기기' : '출처 미상'
    const summary = shown.map(k => `${k}: ${value(content[k])}`).join(' · ')
    return `${index + 1}번 유지 · ${source} · ${summary || (content.name ?? '설정 내용 확인')}`
}
export function syncItemTitle(item: any): string {
    const groups: Record<string, string> = { personas: '페르소나', activation: '모듈·플러그인 사용 설정', 'prompt-presets': '프롬프트 프리셋', 'model-presets': '모델 프리셋', 'provider-main': 'API 연결 설정', lorebook: '로어북', memory: '기억 설정', theme: '화면 테마', 'risubard-wiki': 'BardWiki 설정', pluginCustomStorage: '플러그인 저장 자료' };
    if (item?.type === 'group') return groups[item.id] ?? '앱 설정';
    return item?.title || ({ chat: '대화', character: '캐릭터', module: '모듈', plugin: '플러그인' } as Record<string, string>)[item?.type] || '자료';
}
export function syncDifference(item: any): string {
    const labels: Record<string, string> = { messages: '대화 본문', wiki: 'Wiki·기억', slots: '저장 슬롯', settings: '페르소나·모듈·프리셋 연결', media: '이미지·삽입 자료', state: '변수·플레이 상태' };
    return (item?.sameMessages ? '대화 본문은 같아요. ' : '') + '다른 항목: ' + (item?.differs ?? []).map((k: string) => labels[k] ?? '연결 자료').join(', ');
}
export const SYNC_ITEM_STATE: Record<string, string> = { 'local-changes': '새 대화 내용 업로드 대기', uncaptured: '아직 동기화 기록 없음', pending: '받은 변경 적용 대기', review: '차이 확인 필요', uploaded: 'NAS 업로드 완료', 'upload-pending': 'NAS 업로드 대기', applied: '받아서 이 기기에 적용 완료' };

export const OUTCOME_LABEL: Record<string, string> = { 'review-needed': '받은 변경 확인 필요', empty: '최신 상태', applied: '적용 완료', deferred: '수정 중이어서 미룸', busy: '다른 작업 중', offline: '연결 안 됨 · 재시도 예정', error: '오류 · 재시도 예정', 'publish-failed': 'NAS 업로드 실패 · 재시도 예정', 'repair-failed': 'NAS 자료 다시 받기 실패 · 재시도 예정', hidden: '화면이 보일 때 재시도', 'deferred-active-chat': '받은 변경 보관 중 · 열어 둔 대화를 다시 열면 적용', 'pulled': '받기 완료 · 한가할 때 적용', cancelled: '취소됨', disabled: '꺼짐', 'finish-pending': '적용 결과 확인 대기 · 복구 보관', 'save-failed': '저장 실패 · 되돌림', running: '진행 중', idle: '대기' }
/** Durable states for the compact status area: local save → NAS → peers, conflicts/trash/recovery, key, last cycle. */
export function syncStateRows(status: any, c: CoordinatorState | null): string[] {
    if (!status?.enabled) return []
    const s = status.sync ?? {}, incoming = Object.values(s.incoming ?? {}) as any[]
    const pendingApply = incoming.reduce((n, p) => n + (p.pendingApply ?? 0), 0), review = incoming.reduce((n, p) => n + (p.held ?? 0) + (p.quarantined ?? 0), 0)
    const raw = c?.lastOutcome ?? '', keyPending = raw.startsWith('key-pending:'), bare = raw.replace(/^key-pending:/, '')
    const outcome = (keyPending ? '키 대기 · ' : '') + (OUTCOME_LABEL[bare] ?? (bare || '아직 실행 전'))
    // A joining device opens its vault (pull/plan) before any grant and so holds a locally generated key that is never used to
    // publish (the coordinator gates on the shared key); showing it as "generated" next to the key-request button misleads.
    const key = status.vault?.missing ? '없음 · 이 작업공간의 키를 가진 다른 기기에서 다시 받아야 해요' : status.vault?.origin === 'shared' ? `공유받음${status.vault?.sharedFrom ? ` (기기 ${String(status.vault.sharedFrom).slice(0, 8)})` : ''}` : status.role === 'joining' ? '아직 받지 않음 · 권한 기기에서 공유 키를 받아 주세요' : status.vault?.origin === 'generated' ? '이 기기에서 생성' : '설치됨'
    return [
        `역할: ${status.role === 'authority' ? '권한 기기 (초기 기준)' : '참여 기기'} · 작업공간 ${s.workspaceId ?? '-'} · 기기 ${String(s.deviceId ?? '').slice(0, 8)}`,
        `로컬 저장 → NAS 대기 ${s.outbox?.pending?.length ?? 0}건 · NAS 반영 ${s.outbox?.published ?? 0}건 · 받은 변경 적용 대기 ${pendingApply}건${review ? ` · 검토 필요 ${review}건` : ''}`,
        `충돌 ${status.conflicts ?? 0}건 · 휴지통 ${s.trash ?? 0}건 · 복구 대기 ${status.plan ? 1 : 0}건${status.pendingRestore ? ' · 복원 반영 대기' : ''}${status.localApply ? ` · 반영 예약 ${status.localApply}건` : ''}`,
        `동기화 키: ${key}${status.vault?.pendingGrant ? ' · 받은 키가 기존 키와 달라 확인 대기' : ''}`,
        `마지막 주기: ${outcome}${c?.paused ? ' · 일시 중지' : ''}${c?.lastError ? ` · ${c.lastError}` : ''}${c?.attention ? ` · 주의: ${c.attention}` : ''}`,
    ]
}
/**
 * Form hydration for the enable controls: the saved workspace/role (reported even while disabled) fill the form exactly once, on
 * the first status that carries them; later polls never overwrite what the user typed. Returns the next form + hydrated flag.
 */
export function hydrateSyncForm(status: any, form: { workspace: string; role: 'authority' | 'joining' }, hydrated: boolean): { form: { workspace: string; role: 'authority' | 'joining' }; hydrated: boolean } {
    if (hydrated || !status) return { form, hydrated }
    const workspace = status.workspaceId ?? status.sync?.workspaceId ?? null, role = status.role ?? null
    if (!workspace && !role) return { form, hydrated: false } // nothing saved yet: keep the defaults, try again on the next status
    return { form: { workspace: workspace ?? form.workspace, role: role === 'joining' || role === 'authority' ? role : form.role }, hydrated: true }
}
/** After registering/forgetting a home Wi-Fi only the saved name list changes; every other field keeps the user's unsaved edits. */
export function withSavedHomeSsids<T extends { homeSsids: string[] }>(form: T, saved: any): T {
    return { ...form, homeSsids: Array.isArray(saved?.homeSsids) ? [...saved.homeSsids] : form.homeSsids }
}
/** Current NAS route for the status area: never the SSID itself, only which side is in use and why. */
export function routeLabel(route: any): string {
    const reason: Record<string, string> = { 'single-url': '주소 하나', 'home-ssid': '등록된 집 Wi-Fi', 'other-ssid': '다른 Wi-Fi', 'unknown-ssid': 'Wi-Fi 이름 미확인', 'no-lan': '모바일 데이터/연결 없음', 'probe-ok': '유선 · 내부 주소 응답', 'probe-failed': '유선 · 내부 주소 무응답', 'probe-pending': '확인 전' }
    const side = route?.route === 'home' ? '집 네트워크 (내부 주소)' : route?.route === 'external' ? '바깥 (외부 주소)' : '기본 주소'
    return `NAS 경로: ${side} · ${reason[route?.reason] ?? route?.reason ?? ''}`
}
/** The key-request action is offered whenever this install lacks a usable key: a joining device before its first grant, or any
 *  installation (authority included) whose protected key is missing. The source must be another device holding this workspace's key. */
export function keyRequestNeeded(status: any): boolean {
    if (!status?.enabled) return false
    return !!status.vault?.missing || (status.role === 'joining' && status.vault?.origin !== 'shared')
}
