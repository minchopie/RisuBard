import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('chunked chat hydration connections', () => {
    it('serves authenticated bounded pages with existing chat-id checks', () => {
        const server = readFileSync('server/node/server.cjs', 'utf8')
        expect(server).toContain("require('./chat-content-page.cjs')")
        expect(server).toContain("app.get('/api/chat-content/:chaId/:chatIndex/page'")
        expect(server).toContain('createChatContentPage(chat, req.query.offset, req.query.limit)')
        expect(server).toContain("Chat ID mismatch — index may have shifted")
    })

    it('assembles bounded page responses and retains the legacy endpoint fallback', () => {
        const storage = readFileSync('src/ts/storage/nodeStorage.ts', 'utf8')
        expect(storage).toContain('assembleChatContentPages')
        expect(storage).toContain('/page?offset=')
        expect(storage).toContain('CHAT_CONTENT_TRANSFER_PAGE_SIZE')
        expect(storage).toContain('fetchFullChatContent')
    })
})


it('keeps the client page size within the existing server cap and concurrency at four', () => {
    const storage = readFileSync('src/ts/storage/nodeStorage.ts', 'utf8')
    const server = readFileSync('server/node/chat-content-page.cjs', 'utf8')
    const clientLimit = Number(storage.match(/CHAT_CONTENT_TRANSFER_PAGE_SIZE = (\d+)/)?.[1])
    const serverLimit = Number(server.match(/MAX_CHAT_CONTENT_PAGE_SIZE = (\d+)/)?.[1])
    expect(clientLimit).toBeGreaterThan(0)
    expect(clientLimit).toBeLessThanOrEqual(serverLimit)
    expect(storage).toContain('CHAT_CONTENT_TRANSFER_CONCURRENCY = 4')
})
