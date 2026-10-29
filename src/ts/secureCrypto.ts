import { gcm } from '@noble/ciphers/aes.js'
import { sha256 } from '@noble/hashes/sha2.js'

// crypto.subtle exists only in a Secure Context (HTTPS/localhost). NodeOnly is
// often opened over plain HTTP by LAN IP, so fall back to pure JS there.
function getSubtle(): SubtleCrypto | undefined {
    return globalThis.crypto?.subtle
}

function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
    if (data instanceof Uint8Array) return data
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    return new Uint8Array(data)
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export async function sha256Digest(data: ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer> {
    const subtle = getSubtle()
    if (subtle) return subtle.digest('SHA-256', toBytes(data) as BufferSource)
    return toArrayBuffer(sha256(toBytes(data)))
}

export async function aesGcmWithZeroIv(
    mode: 'encrypt' | 'decrypt',
    data: Uint8Array,
    rawKey: ArrayBuffer,
): Promise<ArrayBuffer> {
    const iv = new Uint8Array(12)
    const subtle = getSubtle()
    if (subtle) {
        const key = await subtle.importKey('raw', rawKey, 'AES-GCM', false, ['encrypt', 'decrypt'])
        return mode === 'encrypt'
            ? subtle.encrypt({ name: 'AES-GCM', iv }, key, data as BufferSource)
            : subtle.decrypt({ name: 'AES-GCM', iv }, key, data as BufferSource)
    }
    const cipher = gcm(new Uint8Array(rawKey), iv)
    return toArrayBuffer(mode === 'encrypt' ? cipher.encrypt(data) : cipher.decrypt(data))
}
