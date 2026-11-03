import {
    ModelPresetAdapterError,
    type AdapterChatOptions,
} from 'src/ts/preset/adapter'

const SCHEMA_ERROR_MARKERS = [
    'schema',
    'response_format',
    'response format',
    'responseformat',
    'structured output',
    'structured-output',
    'responsemime',
    'response mime',
]

const MAX_FALLBACK_SCHEMA_CHARACTERS = 32_000
const AMBIGUOUS_INVALID_ARGUMENT = /^(?:request contains an )?invalid[_ ]argument\.?$/i

export function createStructuredOutputFallbackMessage(
    responseSchema: Record<string, unknown> | undefined
): AdapterChatOptions['messages'][number] | null {
    if (!responseSchema) return null
    const serializedSchema = JSON.stringify(responseSchema)
    if (serializedSchema.length > MAX_FALLBACK_SCHEMA_CHARACTERS) return null
    return {
        role: 'system',
        content: [
            'Return exactly one JSON value matching this JSON Schema.',
            'Do not return Markdown, code fences, or commentary.',
            serializedSchema,
        ].join('\n'),
    }
}

// Prefix caches (e.g. Gemini implicit caching) reuse only a byte-identical
// leading prompt, and Gemini hoists every system message ahead of contents.
// BardWiki shared-evidence requests (see memoryAnalysisClient) open their
// final user message with the confirmed evidence block; for those, the schema
// instruction is appended after it so the shared prefix stays stable. Every
// other request keeps the schema first.
export const SHARED_EVIDENCE_USER_PREFIX = '<confirmedMessages>\n'

function appendToSharedEvidenceRequest(
    messages: AdapterChatOptions['messages'],
    instruction: string
): AdapterChatOptions['messages'] | null {
    const last = messages.at(-1)
    if (last?.role !== 'user'
        || !last.content.startsWith(SHARED_EVIDENCE_USER_PREFIX)) {
        return null
    }
    return [
        ...messages.slice(0, -1),
        { ...last, content: `${last.content}\n\n${instruction}` },
    ]
}

export function isStructuredOutputSchemaRejection(error: unknown): boolean {
    if (!(error instanceof ModelPresetAdapterError)
        || error.kind !== 'invalid-request') {
        return false
    }
    const message = error.message.toLowerCase()
    return SCHEMA_ERROR_MARKERS.some((marker) => message.includes(marker))
        || (error.status === 400 && AMBIGUOUS_INVALID_ARGUMENT.test(message))
}

// A provider that rejects a native schema keeps rejecting that same schema for the
// same target and request options (request log: every repeated schema had one
// outcome), and each rejection costs a full round trip before the prompt-schema
// retry. When the caller names its target, a rejection is remembered for a while
// and the next identical request goes straight to the prompt-schema request the
// retry would have sent. Without a target key the behavior is unchanged.
const SCHEMA_REJECTION_TTL_MS = 60 * 60 * 1000
const SCHEMA_REJECTION_LIMIT = 64
const rejectedNativeSchemas = new Map<string, number>()

function schemaRejectionKey(
    target: string | undefined,
    options: AdapterChatOptions
): string | null {
    if (!target || !options.responseSchema) return null
    try {
        return JSON.stringify([
            target,
            options.responseSchema,
            options.tools ?? null,
            options.temperature ?? null,
            options.maxOutputTokens ?? null,
            options.reasoningEffort ?? null,
            options.collectStreamUsage ?? null,
            options.anthropicCache1h ?? null,
            options.sessionId ?? null,
            options.cache ? 'cache' : null,
        ])
    }
    catch {
        return null
    }
}

function rememberedSchemaRejection(key: string | null, now: number): boolean {
    if (!key) return false
    const expiresAt = rejectedNativeSchemas.get(key)
    if (expiresAt === undefined) return false
    if (expiresAt > now) return true
    rejectedNativeSchemas.delete(key)
    return false
}

function rememberSchemaRejection(key: string | null, now: number) {
    if (!key) return
    rejectedNativeSchemas.delete(key)
    while (rejectedNativeSchemas.size >= SCHEMA_REJECTION_LIMIT) {
        const oldest = rejectedNativeSchemas.keys().next().value
        if (oldest === undefined) break
        rejectedNativeSchemas.delete(oldest)
    }
    rejectedNativeSchemas.set(key, now + SCHEMA_REJECTION_TTL_MS)
}

export function clearStructuredOutputSchemaRejections() {
    rejectedNativeSchemas.clear()
}

function promptSchemaRequest(
    options: AdapterChatOptions,
    fallbackMessage: AdapterChatOptions['messages'][number]
): AdapterChatOptions {
    return {
        ...options,
        responseSchema: undefined,
        messages: appendToSharedEvidenceRequest(
            options.messages,
            fallbackMessage.content
        ) ?? [fallbackMessage, ...options.messages],
    }
}

export async function sendWithStructuredOutputFallback<T>(
    options: AdapterChatOptions,
    send: (request: AdapterChatOptions) => Promise<T>,
    onFallback?: (error: ModelPresetAdapterError) => void,
    target?: string
): Promise<T> {
    const rejectionKey = schemaRejectionKey(target, options)
    if (rememberedSchemaRejection(rejectionKey, Date.now())) {
        const fallbackMessage = createStructuredOutputFallbackMessage(
            options.responseSchema
        )
        if (fallbackMessage) {
            try {
                return await send(promptSchemaRequest(options, fallbackMessage))
            }
            catch (error) {
                // Next time starts from the native request again.
                if (rejectionKey) rejectedNativeSchemas.delete(rejectionKey)
                throw error
            }
        }
    }
    try {
        return await send(options)
    }
    catch (error) {
        if (!options.responseSchema
            || !isStructuredOutputSchemaRejection(error)) {
            throw error
        }
        const fallbackMessage = createStructuredOutputFallbackMessage(
            options.responseSchema
        )
        if (!fallbackMessage) throw error
        onFallback?.(error as ModelPresetAdapterError)
        const result = await send(promptSchemaRequest(options, fallbackMessage))
        // Remembered only once the prompt-schema request went through, so an
        // ambiguous 400 that was not about the schema is never remembered.
        rememberSchemaRejection(rejectionKey, Date.now())
        return result
    }
}
