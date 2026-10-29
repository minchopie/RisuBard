import { afterEach, describe, expect, it, vi } from 'vitest'
import { aesGcmWithZeroIv, sha256Digest } from './secureCrypto'

const text = (value: string) => new TextEncoder().encode(value)

async function withoutSubtle<T>(run: () => Promise<T>): Promise<T> {
    vi.stubGlobal('crypto', { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) })
    try {
        expect(globalThis.crypto.subtle).toBeUndefined()
        return await run()
    } finally {
        vi.unstubAllGlobals()
    }
}

describe('secureCrypto fallback for insecure contexts', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('matches Web Crypto output without crypto.subtle', async () => {
        const key = await sha256Digest(text('risupreset'))
        const payload = text('누렁이 프리셋 payload')
        const native = new Uint8Array(await aesGcmWithZeroIv('encrypt', payload, key))

        const fallbackKey = await withoutSubtle(() => sha256Digest(text('risupreset')))
        expect(new Uint8Array(fallbackKey)).toEqual(new Uint8Array(key))

        const fallbackEncrypted = await withoutSubtle(() => aesGcmWithZeroIv('encrypt', payload, key))
        expect(new Uint8Array(fallbackEncrypted)).toEqual(native)

        const decrypted = await withoutSubtle(() => aesGcmWithZeroIv('decrypt', native, key))
        expect(new TextDecoder().decode(decrypted)).toBe('누렁이 프리셋 payload')
    })
})
