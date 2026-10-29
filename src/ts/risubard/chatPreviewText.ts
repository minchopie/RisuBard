/** Plain text for the chat list hover card, from a raw stored message. */
export function toChatPreviewText(data: string, names: { user: string, char: string }): string {
    const entities: Record<string, string> = { '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&' }
    return data
        .replace(/\{\{(?:inlay|inlayed|inlayeddata)::[^}]*\}\}/gi, '[이미지]')
        .replace(/<img\b[^>]*>/gi, '[이미지]')
        .replace(/<(?:style|script)\b[\s\S]*?<\/(?:style|script)>/gi, '')
        .replace(/<br\s*\/?>/gi, '\n')
        // A run of block tags is one line break.
        .replace(/(?:\s*<\/?(?:p|div|li|h[1-6]|blockquote|tr)\b[^>]*>\s*)+/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/\{\{user\}\}|<user>/gi, names.user)
        .replace(/\{\{char\}\}|<char>/gi, names.char)
        // Other macros are script state, not story text.
        .replace(/\{\{[^}]*\}\}/g, '')
        .replace(/&(?:nbsp|lt|gt|quot|#39|amp);/g, entity => entities[entity])
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
}

/** "방금", "5분 전", "3일 전", then a date. */
export function formatPreviewTime(time: number, now = Date.now()): string {
    const minutes = Math.floor((now - time) / 60_000)
    if (minutes < 1) return '방금'
    if (minutes < 60) return `${minutes}분 전`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours}시간 전`
    const days = Math.floor(hours / 24)
    if (days < 7) return `${days}일 전`
    const date = new Date(time)
    return `${date.getFullYear()}. ${date.getMonth() + 1}. ${date.getDate()}.`
}
