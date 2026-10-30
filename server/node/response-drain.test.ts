// Loopback proof for the keep-alive fix: an ignored response that is destroyed takes its socket with it (one TCP connection per
// request); one that is drained to its end returns the socket to the agent pool. Plain HTTP on 127.0.0.1 — the socket semantics
// are the same as for the HTTPS request helper, which this file does not exercise (it refuses non-HTTPS by design).
import { test, expect } from 'vitest'
import http from 'node:http'
import { once } from 'node:events'
const { drain } = require('./transfer-remote.cjs')

async function server(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
    const s = http.createServer(handler); let connections = 0
    s.on('connection', () => connections++)
    s.listen(0, '127.0.0.1'); await once(s, 'listening')
    const port = (s.address() as any).port
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
    const send = (method = 'PUT', body = 'abc') => new Promise<http.IncomingMessage>((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, method, agent, headers: { 'content-length': String(Buffer.byteLength(body)) } }, resolve); r.on('error', reject); r.end(body) })
    return { send, connections: () => connections, close: () => { agent.destroy(); s.close() } }
}

test('drained ignored responses reuse one keep-alive connection; destroyed ones open a new connection per request', async () => {
    const s = await server((req, res) => { req.resume(); req.on('end', () => { res.writeHead(201, { 'content-length': '0' }); res.end() }) })
    try {
        for (let i = 0; i < 6; i++) { const res = await s.send(); res.destroy(); await new Promise(r => setTimeout(r, 10)) }
        expect(s.connections()).toBe(6) // the churn the sync remote used to cause per MKCOL/PUT/MOVE/DELETE
        for (let i = 0; i < 6; i++) await drain(await s.send())
        expect(s.connections()).toBe(7) // six more requests over a single additional connection
        // A small ignored body (e.g. an HTML 405 page) is read through and the socket still reused.
        const t = await server((req, res) => { req.resume(); req.on('end', () => { res.writeHead(405, { 'content-type': 'text/html' }); res.end('<html>exists</html>') }) })
        try { for (let i = 0; i < 3; i++) await drain(await t.send('MKCOL', '')); expect(t.connections()).toBe(1) } finally { t.close() }
    } finally { s.close() }
})

test('drain rejects an oversized ignored body (and destroys it) and an aborted response, never hanging', async () => {
    const big = await server((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-length': '64' }); res.end('x'.repeat(64)) }) })
    try {
        const res = await big.send()
        await expect(drain(res, 16)).rejects.toThrow('Remote response exceeds size limit'); expect(res.destroyed).toBe(true)
        expect((await drain(await big.send(), 64)).readableEnded).toBe(true) // exactly at the limit is fine
    } finally { big.close() }
    const cut = await server((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-length': '1000' }); res.write('partial'); setTimeout(() => res.socket?.destroy(), 20) }) })
    try { await expect(drain(await cut.send())).rejects.toThrow() } finally { cut.close() }
})
