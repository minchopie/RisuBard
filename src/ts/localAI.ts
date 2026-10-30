import { forageStorage } from './globalApi.svelte'
import { isOfflineBuild, localAI, type LocalAIStatus } from './localAI.svelte'

export async function localAIRequest(path = '', init: RequestInit = {}) {
    await forageStorage.Init()
    return forageStorage.realStorage.localAIRequest(path, init)
}

export async function refreshLocalAI() {
    const response = await localAIRequest('', { signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error('기기 내 AI 설정을 읽지 못했어요. 앱을 다시 열어 주세요.')
    const status: LocalAIStatus = await response.json()
    if (isOfflineBuild && !status.available) throw new Error('Offline 앱의 기기 내 AI 엔진을 확인하지 못했어요. 앱 설치 파일을 확인해 주세요.')
    Object.assign(localAI, status)
}

export const localAIFetch: typeof fetch = async (input, init) => {
    const url = String(input)
    if (url !== `${location.origin}/api/local-ai/chat/completions`) throw new Error('기기 내 AI 요청 주소가 잘못됐어요.')
    return localAIRequest('/chat/completions', init)
}
