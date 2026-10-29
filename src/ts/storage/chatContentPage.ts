export type ChatContentPageEnvelope<
    TMessage = unknown,
    TChat extends object = Record<string, unknown>,
> = {
    chat?: TChat
    messages: TMessage[]
    offset: number
    limit: number
    total: number
}

/** Response of GET /api/chat-preview: what the chat list hover card shows. */
export type ChatPreviewPayload = {
    id: string | null
    bindedPersona: string
    lastMessage: {
        role: 'user' | 'char'
        data: string
        saying?: string
        name?: string
        time?: number
    } | null
}

function requireNonNegativeInteger(value: unknown, name: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new Error(`Chat content page has invalid ${name}`)
    }
    return value as number
}

export function getRemainingChatContentPageOffsets(
    totalValue: number,
    loadedValue: number,
    pageSizeValue: number,
): number[] {
    const total = requireNonNegativeInteger(totalValue, 'total')
    const loaded = requireNonNegativeInteger(loadedValue, 'loaded count')
    const pageSize = requireNonNegativeInteger(pageSizeValue, 'page size')
    if (pageSize === 0) throw new Error('Chat content page has invalid page size')
    if (loaded > total) throw new Error('Chat content page exceeds total')

    const offsets: number[] = []
    for (let offset = loaded; offset < total; offset += pageSize) offsets.push(offset)
    return offsets
}

export function assembleChatContentPages<TMessage, TChat extends object>(
    inputPages: ChatContentPageEnvelope<TMessage, TChat>[],
): TChat & { message: TMessage[] } {
    if (inputPages.length === 0) throw new Error('Chat content page metadata is missing')
    const pages = [...inputPages].sort((left, right) => left.offset - right.offset)
    const first = pages[0]
    if (first.offset !== 0 || !first.chat || typeof first.chat !== 'object') {
        throw new Error('Chat content page metadata is missing')
    }

    const total = requireNonNegativeInteger(first.total, 'total')
    const messages: TMessage[] = []
    let expectedOffset = 0
    for (const page of pages) {
        if (requireNonNegativeInteger(page.total, 'total') !== total) {
            throw new Error('Chat content page total changed during hydration')
        }
        if (requireNonNegativeInteger(page.offset, 'offset') !== expectedOffset) {
            throw new Error('Chat content pages must be contiguous')
        }
        if (!Array.isArray(page.messages)) throw new Error('Chat content page messages are invalid')
        messages.push(...page.messages)
        expectedOffset += page.messages.length
        if (expectedOffset > total) throw new Error('Chat content page exceeds total')
    }
    if (expectedOffset !== total) throw new Error('Chat content pages must be contiguous through total')

    return { ...first.chat, message: messages }
}
