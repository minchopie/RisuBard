import { safeStructuredClone } from './polyfill'
import type { Database, character, Chat, folder } from './storage/database.svelte'
import { hasDisplayNameCollision } from './displayName'

export type CharacterVaultShortcut =
    | { kind: 'character'; id: string }
    | { kind: 'folder'; id: string }

export interface CharacterVaultState {
    quickAccess?: CharacterVaultShortcut[]
    newCharacterIds?: string[]
}

export type CharacterVaultSortKey = 'name' | 'lastInteraction' | 'creationDate'
export type CharacterVaultSortDirection = 'asc' | 'desc'

export interface CharacterVaultClonePlan {
    sourceCharacterId: string
    clone: character
    chatForks: {
        sourceChatId: string
        destinationChatId: string
    }[]
}

interface CharacterVaultCloneOptions {
    withChats: boolean
    createId(): string
    now?: number
}

type VaultDatabase = Pick<
    Database,
    'characters' | 'characterOrder' | 'characterVault'
>

function folderIds(db: VaultDatabase): Set<string> {
    return new Set(db.characterOrder.flatMap((entry) =>
        typeof entry === 'string' ? [] : [entry.id]
    ))
}

function characterIds(db: VaultDatabase): Set<string> {
    return new Set(db.characters
        .filter((character) => !character.trashTime)
        .map((character) => character.chaId))
}

function normalizeNewCharacterIds(
    db: VaultDatabase,
    ids: string[]
): string[] {
    const valid = characterIds(db)
    return [...new Set(ids.filter((id) => valid.has(id)))]
}

function nextCloneName(name: string, reserved: Set<string>): string {
    const base = name.trim() || 'Character'
    let suffix = 2
    let candidate = `${base}-${suffix}`
    while (hasDisplayNameCollision(candidate, reserved)) {
        suffix += 1
        candidate = `${base}-${suffix}`
    }
    reserved.add(candidate)
    return candidate
}

function emptyCloneChat(id: string): Chat {
    return {
        id,
        name: 'Chat 1',
        note: '',
        message: [],
        localLore: [],
    }
}

export function createCharacterVaultClones(
    db: VaultDatabase,
    ids: string[],
    options: CharacterVaultCloneOptions
): CharacterVaultClonePlan[] {
    const reservedNames = new Set(db.characters.map((item) => item.name))
    const sourceIds = new Set(ids)
    const sources = db.characters.filter((item) =>
        sourceIds.has(item.chaId) && !item.trashTime
    )
    return sources.map((source) => {
        const clone = safeStructuredClone(source)
        const chatForks: CharacterVaultClonePlan['chatForks'] = []
        clone.chaId = options.createId()
        clone.name = nextCloneName(source.name, reservedNames)
        clone.creation_date = options.now ?? Date.now()
        clone.trashTime = undefined
        if (options.withChats && source.chats.length > 0) {
            clone.chats = source.chats.map((sourceChat) => {
                const destinationChatId = options.createId()
                const chat = safeStructuredClone(sourceChat)
                chat.id = destinationChatId
                if (sourceChat.id) {
                    chatForks.push({
                        sourceChatId: sourceChat.id,
                        destinationChatId,
                    })
                }
                return chat
            })
            clone.chatPage = Math.min(
                Math.max(0, source.chatPage ?? 0),
                clone.chats.length - 1
            )
        }
        else {
            clone.chats = [emptyCloneChat(options.createId())]
            clone.chatFolders = []
            clone.chatPage = 0
        }
        return {
            sourceCharacterId: source.chaId,
            clone,
            chatForks,
        }
    })
}

export function applyCharacterVaultClones(
    db: VaultDatabase,
    plans: CharacterVaultClonePlan[]
): void {
    if (plans.length === 0) return
    const clonesBySource = new Map<string, string[]>()
    for (const plan of plans) {
        db.characters.push(plan.clone)
        const ids = clonesBySource.get(plan.sourceCharacterId) ?? []
        ids.push(plan.clone.chaId)
        clonesBySource.set(plan.sourceCharacterId, ids)
    }
    const placed = new Set<string>()
    db.characterOrder = db.characterOrder.flatMap<string | folder>((entry) => {
        if (typeof entry === 'string') {
            const clones = clonesBySource.get(entry) ?? []
            clones.forEach((id) => placed.add(id))
            return [entry, ...clones]
        }
        const data = entry.data.flatMap((id) => {
            const clones = clonesBySource.get(id) ?? []
            clones.forEach((cloneId) => placed.add(cloneId))
            return [id, ...clones]
        })
        return [{ ...entry, data }]
    })
    for (const plan of plans) {
        if (!placed.has(plan.clone.chaId)) db.characterOrder.push(plan.clone.chaId)
    }
}

function shortcutKey(shortcut: CharacterVaultShortcut): string {
    return `${shortcut.kind}:${shortcut.id}`
}

function normalizeShortcuts(
    db: VaultDatabase,
    shortcuts: CharacterVaultShortcut[]
): CharacterVaultShortcut[] {
    const characters = characterIds(db)
    const folders = folderIds(db)
    const seen = new Set<string>()
    return shortcuts.filter((shortcut) => {
        const valid = shortcut.kind === 'character'
            ? characters.has(shortcut.id)
            : folders.has(shortcut.id)
        const key = shortcutKey(shortcut)
        if (!valid || seen.has(key)) return false
        seen.add(key)
        return true
    })
}

export function getCharacterVaultQuickAccess(
    db: VaultDatabase
): CharacterVaultShortcut[] {
    const explicit = db.characterVault?.quickAccess
    if (explicit) return normalizeShortcuts(db, explicit)
    return db.characterOrder.map((entry) => typeof entry === 'string'
        ? { kind: 'character' as const, id: entry }
        : { kind: 'folder' as const, id: entry.id }
    )
}

export function setCharacterVaultQuickAccess(
    db: VaultDatabase,
    shortcuts: CharacterVaultShortcut[]
): void {
    db.characterVault = {
        ...db.characterVault,
        quickAccess: normalizeShortcuts(db, shortcuts),
    }
}

export function pinCharacterVaultQuickAccess(
    db: VaultDatabase,
    characterId: string
): void {
    if (!characterIds(db).has(characterId)) return
    const shortcut: CharacterVaultShortcut = {
        kind: 'character',
        id: characterId,
    }
    const key = shortcutKey(shortcut)
    setCharacterVaultQuickAccess(db, [
        ...getCharacterVaultQuickAccess(db).filter((entry) =>
            shortcutKey(entry) !== key
        ),
        shortcut,
    ])
    db.characterVault = {
        ...db.characterVault,
        newCharacterIds: [
            ...normalizeNewCharacterIds(
                db,
                db.characterVault?.newCharacterIds ?? []
            ).filter((id) => id !== characterId),
            characterId,
        ],
    }
}

export function isCharacterVaultNew(
    db: VaultDatabase,
    characterId: string
): boolean {
    return normalizeNewCharacterIds(
        db,
        db.characterVault?.newCharacterIds ?? []
    ).includes(characterId)
}

export function clearCharacterVaultNew(
    db: VaultDatabase,
    characterId: string
): void {
    if (!db.characterVault?.newCharacterIds?.includes(characterId)) return
    db.characterVault = {
        ...db.characterVault,
        newCharacterIds: normalizeNewCharacterIds(
            db,
            db.characterVault.newCharacterIds
        ).filter((id) => id !== characterId),
    }
}

export function toggleCharacterVaultQuickAccess(
    db: VaultDatabase,
    shortcut: CharacterVaultShortcut
): boolean {
    const shortcuts = getCharacterVaultQuickAccess(db)
    const key = shortcutKey(shortcut)
    const index = shortcuts.findIndex((entry) => shortcutKey(entry) === key)
    if (index >= 0) {
        shortcuts.splice(index, 1)
        setCharacterVaultQuickAccess(db, shortcuts)
        return false
    }
    setCharacterVaultQuickAccess(db, [...shortcuts, shortcut])
    return getCharacterVaultQuickAccess(db).some((entry) =>
        shortcutKey(entry) === key
    )
}

function selectedIds(db: VaultDatabase, ids: string[]): Set<string> {
    const valid = characterIds(db)
    return new Set(ids.filter((id) => valid.has(id)))
}

function deduplicateCharacterOrder(
    order: (string | folder)[]
): (string | folder)[] {
    const seen = new Set<string>()
    const normalized: (string | folder)[] = []
    for (const entry of order) {
        if (typeof entry === 'string') {
            if (seen.has(entry)) continue
            seen.add(entry)
            normalized.push(entry)
            continue
        }
        const data = entry.data.filter((id) => {
            if (seen.has(id)) return false
            seen.add(id)
            return true
        })
        normalized.push({ ...entry, data })
    }
    return normalized
}

export function moveCharactersToVaultFolder(
    db: VaultDatabase,
    ids: string[],
    targetFolderId: string | null
): void {
    const selected = selectedIds(db, ids)
    if (selected.size === 0) return

    const target = targetFolderId
        ? db.characterOrder.find((entry): entry is folder =>
            typeof entry !== 'string' && entry.id === targetFolderId
        )
        : undefined
    if (targetFolderId && !target) return

    if (target) {
        const targetData = [...new Set(target.data)]
        const alreadyThere = new Set(targetData)
        const incomingSeen = new Set<string>()
        const incoming: string[] = []
        for (const entry of db.characterOrder) {
            if (typeof entry === 'string') {
                if (selected.has(entry)
                    && !alreadyThere.has(entry)
                    && !incomingSeen.has(entry)) {
                    incoming.push(entry)
                    incomingSeen.add(entry)
                }
                continue
            }
            if (entry.id === target.id) continue
            for (const id of entry.data) {
                if (selected.has(id)
                    && !alreadyThere.has(id)
                    && !incomingSeen.has(id)) {
                    incoming.push(id)
                    incomingSeen.add(id)
                }
            }
        }
        db.characterOrder = deduplicateCharacterOrder(
            db.characterOrder.flatMap<string | folder>((entry) => {
                if (typeof entry === 'string') {
                    return selected.has(entry) ? [] : [entry]
                }
                if (entry.id === target.id) {
                    return [{ ...entry, data: [...targetData, ...incoming] }]
                }
                const data = entry.data.filter((id) => !selected.has(id))
                return [{ ...entry, data }]
            })
        )
        return
    }

    db.characterOrder = deduplicateCharacterOrder(
        db.characterOrder.flatMap<string | folder>((entry) => {
            if (typeof entry === 'string') return [entry]
            const data = entry.data.filter((id) => !selected.has(id))
            const moved = entry.data.filter((id) => selected.has(id))
            return [{ ...entry, data }, ...moved]
        })
    )
}

export function reorderCharacterVaultSidebarShortcuts(
    db: VaultDatabase,
    shortcut: CharacterVaultShortcut,
    targetIndex: number
): boolean {
    const shortcuts = getCharacterVaultQuickAccess(db)
    const key = shortcutKey(shortcut)
    const sourceIndex = shortcuts.findIndex((entry) => shortcutKey(entry) === key)
    if (sourceIndex < 0) return false

    const [moving] = shortcuts.splice(sourceIndex, 1)
    let insertionIndex = Math.max(0, Math.min(targetIndex, shortcuts.length + 1))
    if (sourceIndex < insertionIndex) insertionIndex -= 1
    shortcuts.splice(insertionIndex, 0, moving)
    setCharacterVaultQuickAccess(db, shortcuts)
    return sourceIndex !== insertionIndex
}

export function moveCharacterVaultSidebarCharacter(
    db: VaultDatabase,
    characterId: string,
    targetFolderId: string | null,
    targetIndex: number
): boolean {
    if (!characterIds(db).has(characterId)) return false

    if (targetFolderId) {
        const targetBefore = db.characterOrder.find((entry): entry is folder =>
            typeof entry !== 'string' && entry.id === targetFolderId
        )
        if (!targetBefore) return false
        const sourceIndex = targetBefore.data.indexOf(characterId)

        moveCharactersToVaultFolder(db, [characterId], targetFolderId)
        const target = db.characterOrder.find((entry): entry is folder =>
            typeof entry !== 'string' && entry.id === targetFolderId
        )
        if (!target) return false

        const data = target.data.filter((id) => id !== characterId)
        let insertionIndex = Math.max(0, Math.min(targetIndex, data.length + 1))
        if (sourceIndex >= 0 && sourceIndex < insertionIndex) insertionIndex -= 1
        data.splice(insertionIndex, 0, characterId)
        target.data = data
        setCharacterVaultQuickAccess(
            db,
            getCharacterVaultQuickAccess(db).filter((entry) =>
                entry.kind !== 'character' || entry.id !== characterId
            )
        )
        return true
    }

    moveCharactersToVaultFolder(db, [characterId], null)
    const shortcuts = getCharacterVaultQuickAccess(db)
    const key = shortcutKey({ kind: 'character', id: characterId })
    const existingIndex = shortcuts.findIndex((entry) => shortcutKey(entry) === key)
    if (existingIndex >= 0) shortcuts.splice(existingIndex, 1)
    let insertionIndex = Math.max(0, Math.min(targetIndex, shortcuts.length))
    if (existingIndex >= 0 && existingIndex < insertionIndex) insertionIndex -= 1
    shortcuts.splice(insertionIndex, 0, { kind: 'character', id: characterId })
    setCharacterVaultQuickAccess(db, shortcuts)
    return true
}

export function createCharacterVaultFolder(
    db: VaultDatabase,
    name: string,
    id: string
): folder | null {
    const normalizedName = name.trim()
    if (!normalizedName || folderIds(db).has(id)) return null
    const created: folder = {
        id,
        name: normalizedName,
        color: 'default',
        data: [],
    }
    db.characterOrder.push(created)
    return created
}

export function trashCharacterVaultCharacters(
    db: VaultDatabase,
    ids: string[],
): number {
    const selected = selectedIds(db, ids)
    if (selected.size === 0) return 0

    db.characters = db.characters.filter(character => !selected.has(character.chaId))
    db.characterOrder = deduplicateCharacterOrder(
        db.characterOrder.flatMap<string | folder>((entry) => {
            if (typeof entry === 'string') return selected.has(entry) ? [] : [entry]
            return [{ ...entry, data: entry.data.filter((id) => !selected.has(id)) }]
        })
    )
    if (db.characterVault?.quickAccess) {
        setCharacterVaultQuickAccess(
            db,
            db.characterVault.quickAccess.filter((shortcut) =>
                shortcut.kind !== 'character' || !selected.has(shortcut.id)
            )
        )
    }
    return selected.size
}

type SortableCharacter = Pick<
    character,
    'chaId' | 'name' | 'lastInteraction' | 'creation_date'
>

export function sortCharacterVaultCharacters<T extends SortableCharacter>(
    characters: T[],
    sortBy: CharacterVaultSortKey,
    direction: CharacterVaultSortDirection
): T[] {
    const directionFactor = direction === 'asc' ? 1 : -1
    return [...characters].sort((a, b) => {
        let comparison = 0
        if (sortBy === 'name') {
            comparison = a.name.localeCompare(b.name)
        }
        else {
            const aTime = sortBy === 'lastInteraction'
                ? a.lastInteraction ?? 0
                : a.creation_date ?? 0
            const bTime = sortBy === 'lastInteraction'
                ? b.lastInteraction ?? 0
                : b.creation_date ?? 0
            comparison = aTime - bTime
        }
        if (comparison !== 0) return comparison * directionFactor
        const nameFallback = a.name.localeCompare(b.name)
        if (nameFallback !== 0) return nameFallback
        return a.chaId.localeCompare(b.chaId)
    })
}

/** One block of the vault's sidebar-order view: a folder, or a run of unfiled characters between folders. */
export interface CharacterVaultSection<T> {
    key: string
    folder: folder | null
    items: T[]
}

/**
 * Groups already-filtered items in sidebar order: one section per folder
 * (empty ones only when `keepEmptyFolders`) and unfiled runs between them.
 * Items missing from the order go to a trailing unfiled run; repeats are dropped.
 */
export function buildCharacterVaultSections<T extends { chaId: string }>(
    order: (string | folder)[],
    items: T[],
    keepEmptyFolders: boolean
): CharacterVaultSection<T>[] {
    const byId = new Map(items.map((item) => [item.chaId, item]))
    const seen = new Set<string>()
    const sections: CharacterVaultSection<T>[] = []
    const take = (id: string, into: T[]) => {
        const item = byId.get(id)
        if (item && !seen.has(id)) { seen.add(id); into.push(item) }
    }
    const looseRun = () => {
        const last = sections[sections.length - 1]
        if (last && !last.folder) return last
        const run = { key: `unfiled:${sections.length}`, folder: null, items: [] as T[] }
        sections.push(run)
        return run
    }
    for (const entry of order) {
        if (typeof entry === 'string') {
            take(entry, looseRun().items)
            continue
        }
        const folderItems: T[] = []
        entry.data.forEach((id) => take(id, folderItems))
        if (folderItems.length > 0 || keepEmptyFolders) {
            sections.push({ key: `folder:${entry.id}`, folder: entry, items: folderItems })
        }
    }
    for (const item of items) take(item.chaId, looseRun().items)
    return sections.filter((section) => section.folder || section.items.length > 0)
}

export function deleteCharacterVaultFolder(
    db: VaultDatabase,
    folderId: string
): void {
    db.characterOrder = deduplicateCharacterOrder(
        db.characterOrder.flatMap<string | folder>((entry) => {
            if (typeof entry === 'string' || entry.id !== folderId) return [entry]
            return entry.data
        })
    )
    if (db.characterVault?.quickAccess) {
        setCharacterVaultQuickAccess(
            db,
            db.characterVault.quickAccess.filter((shortcut) =>
                shortcut.kind !== 'folder' || shortcut.id !== folderId
            )
        )
    }
}
