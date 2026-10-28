import { localAIRequest } from '../../localAI'

export async function tokenizeGGUFModel(prompt: string): Promise<number[]> {
    const response = await localAIRequest('/tokenize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: prompt }),
    })
    const result = await response.json()
    if (!response.ok) throw new Error(result.error ?? '기기 내 AI 토큰 계산 실패')
    if (!Array.isArray(result.tokens) || result.tokens.some((token: unknown) => !Number.isInteger(token))) throw new Error('잘못된 토큰 계산 응답')
    return result.tokens
}
