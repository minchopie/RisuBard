export type ChatScriptstate = Record<string, string | number | boolean>
export type ChatScriptstateSnapshot = ChatScriptstate | null

export interface ChatScriptstateCheckpoint {
    before: ChatScriptstateSnapshot
    after: ChatScriptstateSnapshot
}

/** Chat-variable changes from a base state; `cleared` means the state was removed. */
export interface ChatScriptstateDelta {
    set?: ChatScriptstate
    unset?: string[]
    cleared?: true
}

/** A swipe sharing `before` with swipe `base`; `afterChanges` are relative to that swipe's `after`. */
export interface CompactChatScriptstateCheckpoint {
    base: number
    afterChanges: ChatScriptstateDelta
}

export type StoredSwipeScriptstateCheckpoint = ChatScriptstateCheckpoint | CompactChatScriptstateCheckpoint | null

export interface ChatScriptstateCarrier {
    scriptstate?: ChatScriptstate
}

export interface ChatScriptstateCheckpointMessage {
    swipeId?: number
    scriptstateCheckpoint?: ChatScriptstateCheckpoint
    scriptstateSwipeCheckpoints?: StoredSwipeScriptstateCheckpoint[]
}

export function snapshotChatScriptstate(state: ChatScriptstate | undefined): ChatScriptstateSnapshot {
    return state === undefined ? null : { ...state }
}

function cloneSnapshot(snapshot: ChatScriptstateSnapshot): ChatScriptstateSnapshot {
    return snapshot === null ? null : { ...snapshot }
}

function cloneCheckpoint(checkpoint: ChatScriptstateCheckpoint): ChatScriptstateCheckpoint {
    return {
        before: cloneSnapshot(checkpoint.before),
        after: cloneSnapshot(checkpoint.after),
    }
}

export function selectResponseScriptstateBefore(
    scriptstateBeforeSend: ChatScriptstateSnapshot,
    continuedResponse?: ChatScriptstateCheckpoint,
): ChatScriptstateSnapshot {
    return continuedResponse
        ? cloneSnapshot(continuedResponse.before)
        : cloneSnapshot(scriptstateBeforeSend)
}

function restoreChatScriptstate(chat: ChatScriptstateCarrier, snapshot: ChatScriptstateSnapshot): void {
    if(snapshot === null){
        delete chat.scriptstate
        return
    }
    chat.scriptstate = { ...snapshot }
}

// Only the latest response can be rerolled, so earlier messages drop their
// copies. Each copy holds the whole chat state and would otherwise pile up.
export function attachScriptstateCheckpoint(
    messages: ChatScriptstateCheckpointMessage[],
    index: number,
    before: ChatScriptstateSnapshot,
    after: ChatScriptstateSnapshot,
): void {
    messages.forEach((message, i) => {
        if(i === index) return
        if('scriptstateCheckpoint' in message) delete message.scriptstateCheckpoint
        if('scriptstateSwipeCheckpoints' in message) delete message.scriptstateSwipeCheckpoints
    })
    messages[index].scriptstateCheckpoint = {
        before: cloneSnapshot(before),
        after: cloneSnapshot(after),
    }
}

export function restoreScriptstateBeforeReroll(
    chat: ChatScriptstateCarrier,
    message: ChatScriptstateCheckpointMessage,
): boolean {
    const checkpoint = message.scriptstateCheckpoint
    if(!checkpoint) return false
    restoreChatScriptstate(chat, checkpoint.before)
    return true
}

function sameSnapshot(a: ChatScriptstateSnapshot, b: ChatScriptstateSnapshot): boolean {
    if(a === null || b === null) return a === b
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length
        && keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key])
}

function diffSnapshot(base: ChatScriptstateSnapshot, target: ChatScriptstateSnapshot): ChatScriptstateDelta {
    if(target === null) return { cleared: true }
    const set: ChatScriptstate = {}
    for(const [key, value] of Object.entries(target)){
        if(base === null || !Object.hasOwn(base, key) || base[key] !== value) set[key] = value
    }
    const unset = base === null ? [] : Object.keys(base).filter((key) => !Object.hasOwn(target, key))
    return {
        ...(Object.keys(set).length ? { set } : {}),
        ...(unset.length ? { unset } : {}),
    }
}

function applyDelta(base: ChatScriptstateSnapshot, delta: ChatScriptstateDelta): ChatScriptstateSnapshot {
    if(delta.cleared) return null
    const result: ChatScriptstate = base === null ? {} : { ...base }
    for(const key of delta.unset ?? []) delete result[key]
    return { ...result, ...delta.set }
}

function expandSwipeCheckpoint(
    stored: StoredSwipeScriptstateCheckpoint[],
    index: number,
): ChatScriptstateCheckpoint | null {
    const checkpoint = stored[index]
    if(!checkpoint) return null
    if(!('base' in checkpoint)) return cloneCheckpoint(checkpoint)
    const base = stored[checkpoint.base]
    if(!base || 'base' in base) return null
    return {
        before: cloneSnapshot(base.before),
        after: applyDelta(base.after, checkpoint.afterChanges),
    }
}

// Rerolls of one response start from the same chat state and the same scripts
// run on it, so swipes store one full checkpoint and keep only how their result
// differs from it. Otherwise every reroll adds two full copies of the chat
// variables to the message.
export function compactSwipeScriptstateCheckpoints(
    checkpoints: Array<ChatScriptstateCheckpoint | null>,
): StoredSwipeScriptstateCheckpoint[] {
    const baseIndex = checkpoints.findIndex((checkpoint) => checkpoint !== null)
    const base = checkpoints[baseIndex]
    return checkpoints.map((checkpoint, index) => {
        if(!checkpoint) return null
        if(index === baseIndex || !sameSnapshot(checkpoint.before, base.before)) return cloneCheckpoint(checkpoint)
        return { base: baseIndex, afterChanges: diffSnapshot(base.after, checkpoint.after) }
    })
}

export function getSwipeScriptstateCheckpoints(
    message: ChatScriptstateCheckpointMessage,
    swipeCount: number,
): Array<ChatScriptstateCheckpoint | null> {
    const stored = message.scriptstateSwipeCheckpoints
    const checkpoints = stored
        ? stored.map((_, index) => expandSwipeCheckpoint(stored, index))
        : []

    while(checkpoints.length < swipeCount){
        checkpoints.push(null)
    }

    if(!message.scriptstateSwipeCheckpoints && swipeCount === 1 && message.scriptstateCheckpoint){
        checkpoints[0] = cloneCheckpoint(message.scriptstateCheckpoint)
    }

    return checkpoints.slice(0, swipeCount)
}

export function restoreSelectedSwipeScriptstate(
    chat: ChatScriptstateCarrier,
    message: ChatScriptstateCheckpointMessage,
): boolean {
    const checkpoints = message.scriptstateSwipeCheckpoints
    const checkpoint = checkpoints
        ? expandSwipeCheckpoint(checkpoints, message.swipeId ?? 0)
        : message.scriptstateCheckpoint
    if(!checkpoint) {
        delete message.scriptstateCheckpoint
        return false
    }

    const activeCheckpoint = checkpoints ? checkpoint : cloneCheckpoint(checkpoint)
    message.scriptstateCheckpoint = activeCheckpoint
    restoreChatScriptstate(chat, activeCheckpoint.after)
    return true
}
