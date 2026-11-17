// Only ordinary, dense data with identical key order is safe to retain as reactive state.
export function samePluginData(left: any, right: any, seen = new WeakSet<object>()): boolean {
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
        return typeof left !== 'function' && typeof left !== 'symbol' && Object.is(left, right)
    }
    const array = Array.isArray(left)
    if (array !== Array.isArray(right)
        || Object.getPrototypeOf(left) !== (array ? Array.prototype : Object.prototype)
        || Object.getPrototypeOf(right) !== (array ? Array.prototype : Object.prototype)
        || seen.has(left) || seen.has(right)) return false
    seen.add(left)
    seen.add(right)
    const keys = Reflect.ownKeys(left)
    const otherKeys = Reflect.ownKeys(right)
    if (keys.length !== otherKeys.length || (array && left.length !== right.length)) return false
    if (array && keys.length !== left.length + 1) return false
    for (let i = 0; i < keys.length; i++) {
        const key = keys[i]
        if (typeof key !== 'string' || key !== otherKeys[i] || key === '__proto__') return false
        if (array && key === 'length') continue
        if (array && key !== String(i)) return false
        const a = Object.getOwnPropertyDescriptor(left, key)!
        const b = Object.getOwnPropertyDescriptor(right, key)!
        if (!a.enumerable || !b.enumerable || !a.writable || !b.writable || !a.configurable || !b.configurable || !('value' in a) || !('value' in b)
            || !samePluginData(a.value, b.value, seen)) return false
    }
    return true
}

export function applyPluginCharacterUpdate<T>(current: T, incoming: T): T {
    if (!current || !incoming || typeof current !== 'object' || typeof incoming !== 'object') return incoming
    let keys: string[]
    try {
        keys = Object.keys(current)
        const nextKeys = Object.keys(incoming)
        if (Object.getPrototypeOf(current) !== Object.prototype || Object.getPrototypeOf(incoming) !== Object.prototype
            || Reflect.ownKeys(current).length !== keys.length || Reflect.ownKeys(incoming).length !== nextKeys.length
            || keys.length !== nextKeys.length || keys.some((key, i) => key !== nextKeys[i] || key === '__proto__')) return incoming
        if (keys.some(key => {
            const a = Object.getOwnPropertyDescriptor(current, key)!
            const b = Object.getOwnPropertyDescriptor(incoming, key)!
            return !('value' in a) || !('value' in b) || !a.writable || !b.writable || !a.configurable || !b.configurable
        })) return incoming
        if (!samePluginData((current as any).chats, (incoming as any).chats)) return incoming
    } catch {
        return incoming
    }
    // Do not write chats or replace the character: either invalidates the active-chat save effect.
    for (const key of keys) {
        if (key !== 'chats') (current as any)[key] = (incoming as any)[key]
    }
    return current
}
