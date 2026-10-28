// server/node/<name>.cjs are one-line shims over server/node/transfer-sync/<name>.cjs: same object, so server.cjs, the memory runtime
// and every test keep their old paths while packaging (release.yml server/, package-runtime.mjs server/node) includes the module folder.
import { test, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const MODULE = ['nas-route', 'nas-sync-core', 'nas-sync-manifest', 'nas-sync-projection', 'nas-sync-remote', 'nas-sync-service', 'nas-sync-share', 'nas-sync-store', 'nas-sync-vault',
    'play-set-archive', 'play-set-fingerprint', 'play-set-memory', 'play-set-relink', 'play-set-service', 'transfer-remote', 'transfer-secrets', 'transfer-windows']

const IMPLEMENTATIONS = [...MODULE, 'nas-sync-reconcile']

test('every legacy shim shares its implementation; the module folder includes its internal reconcile helper', () => {
    for (const name of MODULE) {
        const shim = require(`./${name}.cjs`), impl = require(`./transfer-sync/${name}.cjs`)
        expect(shim).toBe(impl)
        expect(readFileSync(join(__dirname, `${name}.cjs`), 'utf8')).toMatch(new RegExp(`module\\.exports = require\\('\\./transfer-sync/${name}\\.cjs'\\);`))
    }
    expect(readdirSync(join(__dirname, 'transfer-sync')).filter(f => f.endsWith('.cjs')).map(f => f.replace(/\.cjs$/, '')).sort()).toEqual([...IMPLEMENTATIONS].sort())
    // The implementation never reaches back through a shim (no self-import cycles): module-internal requires stay inside the folder.
    for (const name of IMPLEMENTATIONS) {
        const source = readFileSync(join(__dirname, 'transfer-sync', `${name}.cjs`), 'utf8')
        for (const m of source.matchAll(/require\('(\.\.?\/[^']+)'\)/g)) {
            const target = m[1]
            if (target.startsWith('./')) expect(IMPLEMENTATIONS).toContain(target.replace(/^\.\//, '').replace(/\.cjs$/, ''))
            else expect(target).toMatch(/^\.\.\/(file-store\.cjs|risubard-[a-z-]+\.ts)$|^\.\.\/\.\.\/\.\.\/(shared\/play-set|src\/ts\/(risubard|preset\/adapter))\//)
        }
    }
})
