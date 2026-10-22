// In-process WebDAV fixture for nas-sync tests: enforces parent existence (409), If-None-Match (412), Overwrite:F (412),
// Depth:1 PROPFIND multistatus. Paths are stored exactly as the URL encodes them, like a real server would.
import { Readable } from 'node:stream'

export interface DavRequest { method: string; path: string; headers: Record<string, string> }
export type DavHook = (request: DavRequest) => any
export function fixtureDav(base = 'https://nas.invalid/home/RisuAI/') {
    const basePath = new URL(base).pathname
    const dirs = new Set<string>(['']), files = new Map<string, Buffer>(), log: string[] = [], hooks: DavHook[] = []
    const rel = (url: string) => { if (!url.startsWith(base)) throw new Error('outside base: ' + url); return url.slice(base.length).replace(/\/+$/, '') }
    const parent = (p: string) => p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''
    const respond = (statusCode: number, body: Buffer | string = '', headers: Record<string, string> = {}) => Object.assign(Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)]), { statusCode, headers })
    const collect = async (body: any) => { if (!body) return Buffer.alloc(0); const chunks: Buffer[] = []; for await (const c of body) chunks.push(Buffer.from(c)); return Buffer.concat(chunks) }
    const header = (headers: Record<string, string>, name: string) => Object.entries(headers).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1]
    async function fetch(url: string, { method = 'GET', headers = {} as Record<string, string>, body }: any = {}) {
        const path = rel(url); log.push(`${method} ${decodeURIComponent(path)}`)
        for (const hook of hooks) { const r = await hook({ method, path, headers }); if (r) { await collect(body); return r } }
        switch (method) {
            case 'MKCOL': if (dirs.has(path) || files.has(path)) return respond(405); if (!dirs.has(parent(path))) return respond(409); dirs.add(path); return respond(201)
            case 'PUT': { const data = await collect(body); if (!dirs.has(parent(path))) return respond(409); if (header(headers, 'If-None-Match') === '*' && files.has(path)) return respond(412); files.set(path, data); return respond(201) }
            case 'GET': return files.has(path) ? respond(200, files.get(path)!) : respond(404)
            case 'DELETE': return files.delete(path) || dirs.delete(path) ? respond(204) : respond(404)
            case 'MOVE': { const dest = rel(header(headers, 'Destination')!); if (!files.has(path)) return respond(404); if (!dirs.has(parent(dest))) return respond(409); const existed = files.has(dest); if (existed && header(headers, 'Overwrite') === 'F') return respond(412); files.set(dest, files.get(path)!); files.delete(path); return respond(existed ? 204 : 201) }
            case 'PROPFIND': {
                await collect(body)
                if (!dirs.has(path) && !files.has(path)) return respond(404)
                const entry = (p: string, dir: boolean) => `<D:response><D:href>${basePath}${p}${dir ? '/' : ''}</D:href><D:propstat><D:prop><D:resourcetype>${dir ? '<D:collection/>' : ''}</D:resourcetype></D:prop></D:propstat></D:response>`
                const children = [...[...dirs].filter(d => d && parent(d) === path && d !== path).map(d => entry(d, true)), ...[...files.keys()].filter(f => parent(f) === path).map(f => entry(f, false))]
                return respond(207, `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${entry(path, dirs.has(path))}${children.join('')}</D:multistatus>`)
            }
            default: return respond(405)
        }
    }
    const paths = () => [...files.keys()].map(p => decodeURIComponent(p)).sort()
    return { fetch, files, dirs, log, hooks, base, paths, secrets: { get: async () => ({ url: base, username: 'fixture', password: 'fixture-password' }) } }
}
