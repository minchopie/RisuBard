const failureLabels = {
    'budget-exceeded': '필수 위키의 문서 수 또는 토큰 상한 초과',
    'invalid-document': '위키 문서 형식 오류',
    'storage-error': '위키 파일 읽기 실패',
    'server-error': '위키 조회 서버 오류',
    'http-error': '위키 조회 HTTP 오류',
    'timeout': '위키 조회 제한 시간 초과 또는 취소',
    'network-error': '위키 조회 연결 실패',
    'invalid-response': '위키 조회 응답 처리 실패',
} as const

export type WikiInquiryFailureCode = keyof typeof failureLabels
export interface WikiInquiryFailure { code: WikiInquiryFailureCode; httpStatus?: number }
export class WikiInquiryError extends Error {
    readonly code: WikiInquiryFailureCode
    constructor(code: unknown, readonly httpStatus: number) {
        const safeCode = typeof code === 'string' && Object.hasOwn(failureLabels, code)
            ? code as WikiInquiryFailureCode : 'http-error'
        super(`${failureLabels[safeCode]} (HTTP ${httpStatus})`)
        this.code = safeCode
    }
}

export function wikiInquiryFailure(error: unknown): WikiInquiryFailure {
    if (error instanceof WikiInquiryError) return { code: error.code, httpStatus: error.httpStatus }
    if (error instanceof Error && error.name === 'AbortError') return { code: 'timeout' }
    if (error instanceof TypeError) return { code: 'network-error' }
    return { code: 'invalid-response' }
}

const semanticSkipLabels = {
    'not-ready': '의미 검색 제외: 임베딩 색인 만드는 중',
    'build-failed': '의미 검색 제외: 임베딩 색인 만들기 실패',
    timeout: '의미 검색 제외: 위키 조회 제한 시간 안에 임베딩 응답 없음',
    error: '의미 검색 제외: 임베딩 요청 실패',
} as const

export interface WikiInquiryDiagnostic {
    status: 'skipped' | 'failed' | 'empty' | 'not-injected' | 'partial' | 'injected'
    /** Semantic search was on but contributed nothing, and why. */
    semanticSkip?: keyof typeof semanticSkipLabels
    documentCount?: number
    candidateCount?: number
    selectedWikiCount?: number
    injectedWikiCount: number
    failure?: WikiInquiryFailure
}

/** Counts only evidence preserved in the final assembled prompt, not stale source metadata. */
export function createWikiInquiryDiagnostic(input: {
    attempted: boolean
    documentCount?: number
    candidateCount?: number
    failure?: WikiInquiryFailure
    semanticSkip?: WikiInquiryDiagnostic['semanticSkip']
    sources: readonly { id: string; content: string }[]
    messages: readonly { content: string }[]
}): WikiInquiryDiagnostic {
    const wiki = input.sources.filter(source => source.id.startsWith('narrative-memory:wiki:'))
    const injected = wiki.filter(source => input.messages.some(message =>
        message.content.includes(`[source ${JSON.stringify(source.id)}]`)
        && source.content.trim().length > 0 && message.content.includes(source.content)))
    return {
        status: input.failure ? 'failed' : !input.attempted ? 'skipped'
            : wiki.length === 0 ? 'empty' : injected.length === 0 ? 'not-injected'
                : injected.length < wiki.length ? 'partial' : 'injected',
        ...(input.documentCount === undefined ? {} : { documentCount: input.documentCount }),
        ...(input.candidateCount === undefined ? {} : { candidateCount: input.candidateCount }),
        ...(input.attempted && !input.failure ? { selectedWikiCount: wiki.length } : {}),
        injectedWikiCount: injected.length,
        ...(input.failure ? { failure: input.failure } : {}),
        ...(input.semanticSkip && Object.hasOwn(semanticSkipLabels, input.semanticSkip) ? { semanticSkip: input.semanticSkip } : {}),
    }
}

export function formatWikiInquiryDiagnostic(value: WikiInquiryDiagnostic): string {
    const label = {
        skipped: '조회 미실행', failed: '조회 실패', empty: '검색 결과 없음',
        'not-injected': '선택 후 원문 변경 또는 프롬프트 누락 (프리셋 확인)',
        partial: '선택 자료 일부 누락 또는 변경 (프리셋 확인)', injected: '프롬프트 포함 확인',
    }[value.status]
    const count = (n: number | undefined) => n === undefined ? '미확인' : `${n}개`
    return [`BardWiki: ${label}`,
        `검색 대상 문서 ${count(value.documentCount)}`, `후보 ${count(value.candidateCount)}`,
        `선택 위키 ${count(value.selectedWikiCount)}`, `최종 포함 ${count(value.injectedWikiCount)}`,
        ...(value.failure ? [`${failureLabels[value.failure.code]}${value.failure.httpStatus ? ` (HTTP ${value.failure.httpStatus})` : ''}`] : []),
        ...(value.semanticSkip && Object.hasOwn(semanticSkipLabels, value.semanticSkip) ? [semanticSkipLabels[value.semanticSkip]] : []),
    ].join(' / ')
}
