// Packaging boundary (Codex review 04): the runtime closure that nas-sync-vault.cjs needs from src/ts/preset/adapter must be
// listed in BOTH packaging paths, and a staged copy of exactly those listed parts must load the sync modules under Node.
import { test, expect } from 'vitest'
import { mkdtemp, rm, cp, readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname, resolve, relative, sep } from 'node:path'

const repo = resolve(__dirname, '..', '..')
const read = (p: string) => readFile(join(repo, p), 'utf8')
/** Runtime (non-type) relative imports, followed transitively from an entry file. */
async function runtimeClosure(entry: string): Promise<string[]> {
    const seen = new Set<string>(), queue = [entry]
    while (queue.length) {
        const file = queue.shift()!; if (seen.has(file)) continue; seen.add(file)
        const source = await read(file)
        for (const m of source.matchAll(/^import\s+(type\s+)?([\s\S]*?)\s+from\s+'(\.[^']+)'/gm)) {
            if (m[1]) continue // `import type` is erased by sucrase
            const target = join(dirname(file), m[3]).replace(/\\/g, '/') + '.ts'
            if (existsSync(join(repo, target))) queue.push(target)
        }
    }
    return [...seen].sort()
}
async function androidParts() { const m = /for \(const part of \[([^\]]+)\]\)/.exec(await read('scripts/android/package-runtime.mjs')); return [...m![1].matchAll(/'([^']+)'/g)].map(x => x[1]) }
async function releaseParts() { const m = /path: \|\r?\n([\s\S]*?)\r?\n\s+retention-days/.exec(await read('.github/workflows/release.yml')); return m![1].split(/\r?\n/).map(l => l.trim().replace(/\/$/, '')).filter(Boolean) }

test('the adapter runtime closure of the vault is exactly what both packaging lists ship', async () => {
    const closure = await runtimeClosure('src/ts/preset/adapter/buildRequest.ts')
    expect(closure).toEqual(['src/ts/preset/adapter/auth.ts', 'src/ts/preset/adapter/buildRequest.ts', 'src/ts/preset/adapter/error.ts', 'src/ts/preset/adapter/vertexEndpoint.ts'])
    const android = await androidParts(), release = await releaseParts()
    for (const file of closure) { expect(android).toContain(file); expect(release).toContain(file) }
    expect([...android.filter(p => p.startsWith('src/ts/preset'))].sort()).toEqual(closure) // nothing more than the closure; product file order is not asserted
    expect([...release.filter(p => p.startsWith('src/ts/preset'))].sort()).toEqual(closure)
    // Every src/ require of the real implementation (resolved from ITS folder, never a hardcoded prefix) must be inside the shipped closure.
    const vaultFile = 'server/node/transfer-sync/nas-sync-vault.cjs', vault = await read(vaultFile)
    const srcRequires = [...vault.matchAll(/require\('(\.[^']+)'\)/g)].map(m => relative(repo, resolve(dirname(join(repo, vaultFile)), m[1])).split(sep).join('/')).filter(p => p.startsWith('src/'))
    expect(srcRequires.length).toBeGreaterThan(0)
    for (const file of srcRequires) expect(closure).toContain(file)
})

test('a staged copy of only the listed runtime parts (Android list AND Windows release list) loads the sync modules through the real folder and the old-path shims, and resolves a model-preset endpoint', async t => {
  // Android: the part list plus the workspace package the script copies through its `roots` (copyPackage) — the full service closure
  // (risubard-source-workspace.ts → packages/risubard-core) must load, not only the three leaf modules. Release: the artifact list as is.
  const lists = { android: [...(await androidParts()).filter(p => ['server/node', 'shared/play-set', 'src/ts/risubard', 'package.json'].includes(p) || p.startsWith('src/ts/preset/adapter/')), 'packages/risubard-core'],
      release: (await releaseParts()).map(p => p.replace(/\/$/, '')).filter(p => ['server', 'packages/risubard-core', 'shared/play-set', 'src/ts/risubard', 'package.json'].includes(p) || p.startsWith('src/ts/preset/adapter/')) }
  expect(lists.release).toEqual(expect.arrayContaining(['server', 'packages/risubard-core'])); expect(lists.android).toContain('server/node')
  for (const [name, parts] of Object.entries(lists)) {
    const stage = await mkdtemp(join(tmpdir(), `bard-sync-stage-${name}-`))
    t.onTestFinished(() => rm(stage, { recursive: true, force: true }))
    for (const part of parts) { await mkdir(dirname(join(stage, part)), { recursive: true }); await cp(join(repo, part), join(stage, part), { recursive: true, filter: f => !/\.test\.ts$|\.node-test\.ts$/.test(f) }) }
    expect(existsSync(join(stage, 'src/ts/preset/adapter/buildRequest.ts'))).toBe(true); expect(existsSync(join(stage, 'src/ts/preset/types.ts'))).toBe(false)
    const probe = `
        const vault = require(${JSON.stringify(join(stage, 'server/node/transfer-sync/nas-sync-vault.cjs'))});
        const remote = require(${JSON.stringify(join(stage, 'server/node/transfer-sync/nas-sync-remote.cjs'))});
        const store = require(${JSON.stringify(join(stage, 'server/node/transfer-sync/nas-sync-store.cjs'))});
        // The old-path shims shipped in the same stage must resolve to these very objects (server.cjs requires the old paths).
        const shims = ['nas-sync-vault', 'nas-sync-remote', 'nas-sync-store', 'nas-sync-service', 'transfer-remote', 'play-set-service', 'nas-route', 'transfer-windows', 'transfer-secrets'].every(n => require(${JSON.stringify(join(stage, 'server/node'))} + '/' + n + '.cjs') === require(${JSON.stringify(join(stage, 'server/node/transfer-sync'))} + '/' + n + '.cjs'));
        const v = vault.createVault(Buffer.alloc(32, 7));
        const out = v.project({ modelPresets: [{ id: 'p', profileSnapshot: { schema: [{ key: 'endpointUrl', mapsTo: { target: 'custom', path: 'endpointUrl' } }, { key: 'apiKey', secret: true }], auth: { fields: [] }, endpoint: { kind: 'static', url: 'https://static.example' } }, userValues: { endpointUrl: 'https://override.example/v1', apiKey: 'FIXTURE-KEY' } }] });
        process.stdout.write(JSON.stringify({ origin: out.public.$syncSecrets[0].origin, leak: JSON.stringify(out.public).includes('FIXTURE-KEY'), remote: typeof remote.createSyncTransport, store: typeof store.createSyncStore, shims, service: typeof require(${JSON.stringify(join(stage, 'server/node/nas-sync-service.cjs'))}).createNasSyncService }));`
    const output = execFileSync(process.execPath, ['-e', probe], { cwd: stage, env: { ...process.env, NODE_PATH: join(repo, 'node_modules') }, encoding: 'utf8', timeout: 60_000 })
    expect(JSON.parse(output), name).toEqual({ origin: 'https://override.example', leak: false, remote: 'function', store: 'function', shims: true, service: 'function' })
  }
})
