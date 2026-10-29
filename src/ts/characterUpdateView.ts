import type { UpdateItem } from './characterUpdate'

// Body fields are always shown as blocks so both sides line up in the diff.
const blockKeys = new Set(['content', 'in', 'out'])
const longText = (key: string, value: string) => blockKeys.has(key) || value.includes('\n') || value.length > 60

/** Plain text of one side of an update item, for the line diff. */
export function updateValueText(value: unknown): string {
    if (value === undefined || value === null) return ''
    if (typeof value === 'string') return value
    if (Array.isArray(value)) {
        if (value.every(item => typeof item === 'string')) return value.join('\n---\n')
        return JSON.stringify(value, null, 2)
    }
    if (typeof value === 'object') {
        const record = value as Record<string, unknown>
        const lines: string[] = []
        const blocks: string[] = []
        for (const key of Object.keys(record).sort()) {
            const item = record[key]
            if (item === undefined || key === 'id' || key === 'loreCache') continue
            if (typeof item === 'string' && longText(key, item)) blocks.push(`[${key}]\n${item}`)
            else lines.push(`${key}: ${JSON.stringify(item)}`)
        }
        return [...lines, ...blocks].join('\n')
    }
    return JSON.stringify(value)
}

/** The entry's own name inside a list field: lore title, script comment, asset name. */
export function updateItemName(item: UpdateItem): string {
    if (!item.key) return ''
    if (item.field === 'extentions') return item.key
    const value = (item.mine ?? item.theirs) as any
    if (Array.isArray(value)) return String(value[0] ?? '')
    if (value && typeof value === 'object') return String(value.comment || value.name || value.key || '').trim()
    return ''
}

/**
 * The text the user can rewrite while comparing: a whole text field, the body
 * of a lore entry, or the output of a regex. Null when the item has none.
 */
function editableKey(item: UpdateItem): '' | 'content' | 'out' | null {
    const value = item.mine ?? item.theirs
    if (typeof value === 'string') return ''
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>
        if (typeof record.content === 'string') return 'content'
        if (typeof record.out === 'string' && typeof record.in === 'string') return 'out'
    }
    return null
}

export function isEditable(item: UpdateItem): boolean {
    return editableKey(item) !== null
}

export function editableText(item: UpdateItem, side: 'mine' | 'theirs'): string {
    const key = editableKey(item)
    const value = side === 'mine' ? item.mine ?? item.theirs : item.theirs ?? item.mine
    if (key === null || value === undefined) return ''
    if (key === '') return String(value ?? '')
    return String((value as Record<string, unknown>)[key] ?? '')
}

/** The item with the user's text in place: the rest of the entry comes from the user's version. */
export function editedValue(item: UpdateItem, text: string): unknown {
    const key = editableKey(item)
    if (key === '') return text
    const value = item.mine ?? item.theirs
    return { ...(value as object), [key]: text }
}

export type UpdateGroupId = 'info' | 'prompt' | 'lore' | 'regex' | 'trigger' | 'asset' | 'other'
export const updateGroupOrder: UpdateGroupId[] = ['info', 'prompt', 'lore', 'regex', 'trigger', 'asset', 'other']

const groupFields: Record<Exclude<UpdateGroupId, 'other'>, string[]> = {
    info: ['name', 'desc', 'description', 'firstMessage', 'alternateGreetings', 'group_only_greetings', 'personality', 'scenario',
        'exampleMessage', 'creatorNotes', 'tags', 'creator', 'characterVersion', 'nickname', 'source', 'license', 'firstMessageStudio'],
    prompt: ['systemPrompt', 'postHistoryInstructions', 'replaceGlobalNote', 'defaultVariables', 'additionalText', 'depth_prompt', 'cjs'],
    lore: ['globalLore', 'lorebook', 'loreSettings', 'loreExt'],
    regex: ['customscript', 'regex'],
    trigger: ['triggerscript', 'trigger'],
    asset: ['image', 'icon', 'emotionImages', 'additionalAssets', 'ccAssets', 'assets', 'vits'],
}
const fieldGroup = new Map<string, UpdateGroupId>()
for (const [group, fields] of Object.entries(groupFields)) for (const field of fields) fieldGroup.set(field, group as UpdateGroupId)

export function updateGroupOf(item: UpdateItem): UpdateGroupId {
    return fieldGroup.get(item.field) ?? 'other'
}

/** Folder id to folder title, from lore entries of every side. */
export function loreFolderNames(...lists: unknown[]): Map<string, string> {
    const names = new Map<string, string>()
    for (const list of lists) {
        for (const entry of Array.isArray(list) ? list : []) {
            if (entry?.mode === 'folder' && entry.key && !names.has(entry.key)) names.set(entry.key, String(entry.comment || entry.key))
        }
    }
    return names
}

/**
 * The second level inside a group: the lorebook folder an entry is in, or
 * the kind of asset. Empty when the group has no second level.
 */
export function updateSubgroupOf(item: UpdateItem, folders: Map<string, string>, labels: Record<string, string>): { id: string, label: string } {
    const group = updateGroupOf(item)
    if (group === 'asset') return { id: item.field, label: labels[item.field] ?? item.field }
    if (group !== 'lore') return { id: '', label: '' }
    if (!item.key) return { id: 'settings', label: '' }
    const entry = (item.mine ?? item.theirs) as { mode?: string, key?: string, folder?: string } | undefined
    const folder = entry?.mode === 'folder' ? entry.key : entry?.folder
    if (folder) return { id: `folder:${folder}`, label: folders.get(folder) ?? folder }
    return { id: 'root', label: '' }
}

/**
 * Lowercased text an item is searched by: its field, name and the text of
 * both sides. Internal ids and flags are left out so they do not match.
 */
export function updateSearchText(item: UpdateItem, label: string): string {
    const sides = isEditable(item)
        ? [editableText(item, 'mine'), editableText(item, 'theirs')]
        : [updateValueText(item.mine), updateValueText(item.theirs)]
    return [label, updateItemName(item), ...sides].join('\n').toLowerCase()
}
