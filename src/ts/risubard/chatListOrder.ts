/**
 * Ordering helpers for the sidebar chat list. The chats array order is the
 * stored order; a folder shows its chats in array order, so a "section" is the
 * set of array slots whose chats share one visible folder.
 */
export interface ListChat {
    id?: string
    folderId?: string | null
}

/** The visible section of a chat: its folder, or null for unfiled and orphaned chats. */
export function chatSection(chat: ListChat, folderIds: ReadonlySet<string>): string | null {
    return chat.folderId != null && folderIds.has(chat.folderId) ? chat.folderId : null
}

const isSelected = (chat: ListChat, selected: ReadonlySet<string>) => !!chat.id && selected.has(chat.id)

/**
 * Moves every selected chat one step up (-1) or down (1) inside its own section.
 * Adjacent selected chats move as a block, and every section keeps its array slots.
 */
export function shiftSelectedChats<T extends ListChat>(
    chats: readonly T[],
    selected: ReadonlySet<string>,
    direction: -1 | 1,
    folderIds: ReadonlySet<string>,
): T[] {
    const result = [...chats]
    const sections = new Map<string | null, number[]>()
    chats.forEach((chat, index) => {
        const key = chatSection(chat, folderIds)
        const slots = sections.get(key)
        if (slots) slots.push(index)
        else sections.set(key, [index])
    })
    for (const slots of sections.values()) {
        const items = slots.map(slot => chats[slot])
        if (direction === -1) {
            for (let i = 1; i < items.length; i++) {
                if (isSelected(items[i], selected) && !isSelected(items[i - 1], selected)) {
                    [items[i - 1], items[i]] = [items[i], items[i - 1]]
                }
            }
        } else {
            for (let i = items.length - 2; i >= 0; i--) {
                if (isSelected(items[i], selected) && !isSelected(items[i + 1], selected)) {
                    [items[i], items[i + 1]] = [items[i + 1], items[i]]
                }
            }
        }
        slots.forEach((slot, k) => { result[slot] = items[k] })
    }
    return result
}

/**
 * After one selected chat was dragged, pulls the rest of the selection in at
 * the drop point, in their previous relative order. Moved chats take the
 * dragged chat's folder (their folderId is updated in place).
 */
export function gatherSelectionAfterDrag<T extends ListChat>(
    chats: readonly T[],
    previousOrder: readonly T[],
    draggedId: string,
    selected: ReadonlySet<string>,
): T[] {
    const dragged = chats.find(chat => chat.id === draggedId)
    if (!dragged || !selected.has(draggedId) || selected.size < 2) return [...chats]
    const group = previousOrder.filter(chat => isSelected(chat, selected) && chats.includes(chat))
    for (const chat of group) {
        if (chat !== dragged) chat.folderId = dragged.folderId ?? null
    }
    const rest = chats.filter(chat => chat === dragged || !group.includes(chat))
    rest.splice(rest.indexOf(dragged), 1, ...group)
    return rest
}

/** Ids from anchor to target inclusive, in display order. */
export function chatIdRange(order: readonly string[], anchor: string, target: string): string[] {
    const from = order.indexOf(anchor)
    const to = order.indexOf(target)
    if (from < 0 || to < 0) return [target]
    return order.slice(Math.min(from, to), Math.max(from, to) + 1)
}
