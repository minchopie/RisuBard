const stages = new Set(['status', 'release', 'snapshot', 'publish', 'pull', 'preview', 'apply'])
const codes = new Set([
    'SNAPSHOT_MISSING', 'LINEAGE_LOST', 'PUBLISH_FAILED', 'REPAIR_FAILED',
    'VAULT_MISSING', 'VAULT_PENDING', 'NAS_SYNC_PLAN_PENDING', 'NAS_SYNC_REPLAN',
    'NAS_SYNC_PARTIAL', 'MANIFEST_UNREADABLE', 'STORE_BROKEN', 'SAVE_FAILED', 'FINISH_PENDING',
    'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH',
    'ENETUNREACH', 'EPIPE', 'EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EIO',
])

export const nasMediaNoticeMessage = 'NAS 동기화에서 그림 또는 인레이 파일이 빠진 자료의 변경을 보류했습니다.'
export const nasPersonasHeldMessage = '페르소나 묶음 전체 보류'
export function nasMediaNoticeDescription(count: number, personasHeld = false) {
    return `stage=snapshot code=MEDIA_SKIPPED count=${count}${personasHeld ? ' personas=held' : ''}`
}

export const nasDiagnosticMessage = 'NAS 동기화 단계에서 오류가 발생했습니다.'

export function nasDiagnosticDescription(stage: unknown, code: unknown) {
    const safeStage = typeof stage === 'string' && stages.has(stage) ? stage : 'unknown'
    const safeCode = typeof code === 'string' && codes.has(code) ? code : 'UNKNOWN'
    return `stage=${safeStage} code=${safeCode}`
}
