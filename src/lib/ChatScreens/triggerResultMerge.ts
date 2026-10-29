import isEqual from 'lodash/isEqual'
import type { Chat } from 'src/ts/storage/database.svelte'
import { debugTiming } from 'src/ts/debugTiming'

// A button trigger returns a whole new chat. Putting it in place of the live chat gives every message a new
// object, so every message on screen renders again (on a long chat, most of a second per click). When the
// trigger left the messages as they were, the live chat keeps them: only the other fields that changed are
// written, and the variables key by key.
// Returns 'same' when the trigger changed nothing (the message need not redraw), 'merged' when it changed
// only fields or variables, and false when the messages differ; the caller then replaces the chat.
export function mergeTriggerChat(live: Chat | undefined, next: Chat): 'same' | 'merged' | false {
    if (!live || live.id !== next.id) return false
    const a = live.message ?? []
    const b = next.message ?? []
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
        if (!isEqual(a[i], b[i])) return false
    }
    let changed = false
    const changedFields: string[] = []
    for (const key of Object.keys(next) as (keyof Chat)[]) {
        if (key === 'message' || key === 'scriptstate') continue
        if (!isEqual(live[key], next[key])) {
            (live as unknown as Record<string, unknown>)[key] = next[key]
            changed = true
            changedFields.push(key)
        }
    }
    if (changedFields.length) debugTiming.stage(`chat fields changed: ${changedFields.join(', ')}`)
    // triggers.ts setVar writes the live variables as the trigger runs, so here they are usually equal already;
    // the caller compares them with a copy taken before the trigger to tell whether anything changed.
    const nextState = next.scriptstate ?? {}
    if (!live.scriptstate && Object.keys(nextState).length === 0) return changed ? 'merged' : 'same'
    const state = (live.scriptstate ??= {})
    for (const key of Object.keys(nextState)) {
        if (state[key] !== nextState[key]) {
            state[key] = nextState[key]
            changed = true
        }
    }
    for (const key of Object.keys(state)) {
        if (!(key in nextState)) {
            delete state[key]
            changed = true
        }
    }
    return changed ? 'merged' : 'same'
}
