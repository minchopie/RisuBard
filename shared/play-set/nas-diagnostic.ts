const stages = new Set(['status', 'release', 'snapshot', 'publish', 'pull', 'preview', 'apply'])
const codes = new Set([
    'SNAPSHOT_MISSING', 'LINEAGE_LOST', 'PUBLISH_FAILED', 'REPAIR_FAILED',
    'VAULT_MISSING', 'VAULT_PENDING', 'NAS_SYNC_PLAN_PENDING', 'NAS_SYNC_REPLAN',
    'NAS_SYNC_PARTIAL', 'MANIFEST_UNREADABLE', 'STORE_BROKEN', 'SAVE_FAILED', 'FINISH_PENDING',
    'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH',
    'ENETUNREACH', 'EPIPE', 'EACCES', 'EPERM', 'ENOENT', 'ENOSPC', 'EIO',
])

export const nasDiagnosticMessage = 'NAS 동기화 단계에서 오류가 발생했습니다.'

export interface MissingSyncMedia {
    count: number
    files: { path: string; owners: { kind: 'module' | 'character' | 'persona' | 'chat' | 'plugin' | 'settings'; name?: string; parent?: string; field?: string }[] }[]
}

export function nasDiagnosticDescription(stage: unknown, code: unknown, missingFiles?: unknown) {
    const safeStage = typeof stage === 'string' && stages.has(stage) ? stage : 'unknown'
    const safeCode = typeof code === 'string' && codes.has(code) ? code : 'UNKNOWN'
    const count = safeStage === 'snapshot' && safeCode === 'SNAPSHOT_MISSING' && typeof missingFiles === 'number' && Number.isSafeInteger(missingFiles) && missingFiles > 0 ? ` missingFiles=${missingFiles}` : ''
    return `stage=${safeStage} code=${safeCode}${count}`
}
