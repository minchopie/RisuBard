type GeminiRequestPart = Record<string, unknown>

type GeminiRequestContent = {
    role: string
    parts: readonly GeminiRequestPart[]
}

export const PRIVATE_MOBILE_GEMINI_CONTINUATION =
    'Continue the preceding model turn from where it ended. Do not repeat, quote, or explain the preceding text.'

export function normalizePrivateMobileGeminiContents(
    contents: readonly GeminiRequestContent[]
): readonly GeminiRequestContent[] {
    const finalContent = contents.at(-1)
    if (finalContent?.role !== 'model' || !Array.isArray(finalContent.parts)) {
        return contents
    }

    const hasUnansweredFunctionCall = finalContent.parts.some((part) =>
        typeof part === 'object' && part !== null && part.functionCall !== undefined
    )
    if (hasUnansweredFunctionCall) {
        return contents
    }

    return [
        ...contents,
        {
            role: 'user',
            parts: [{ text: PRIVATE_MOBILE_GEMINI_CONTINUATION }],
        },
    ]
}
