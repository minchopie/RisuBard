// Self-test of the upstream check tool's pure parts (scripts/transfer-sync/check-upstream.mjs): hunk parsing, anchor selection,
// reviewed exclusions (additions only — a matching removal is a hard failure), renumbering, and that a required hook missing from
// the kept hunks is reported, never filtered away silently.
import { test, expect } from 'vitest'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const tool = () => import(pathToFileURL(join(__dirname, '../../scripts/transfer-sync/check-upstream.mjs')).href)

const diff = [
    'diff --git a/x.js b/x.js', '--- a/x.js', '+++ b/x.js',
    '@@ -1,3 +1,5 @@', ' a', '+const localAI = 1', '+const nasSync = create()', ' b', ' c',
    '@@ -10,2 +12,3 @@', ' d', '+unrelatedFeature()', ' e',
    '@@ -20,3 +23,2 @@', ' f', '-const old = nasSync.x', ' g',
].join('\n')

test('parse → select → render: anchors keep module hunks, exclusions drop proximity additions, renumbering stays consistent', async () => {
    const { parseDiff, selectHunks, renderHunks } = await tool()
    const [file] = parseDiff(diff)
    expect(file.hunks).toHaveLength(3)
    const { kept, dropped } = selectHunks(file.hunks, { anchors: ['nasSync'], excludeAdded: ['localAI'] }, 'x.js')
    expect(kept).toHaveLength(2); expect(dropped).toHaveLength(1); expect(dropped[0].lines).toContain('+unrelatedFeature()')
    expect(kept[0].lines).toEqual([' a', '+const nasSync = create()', ' b', ' c']) // localAI addition removed
    const rendered = renderHunks(kept)
    expect(rendered[0]).toBe('@@ -1,3 +1,4 @@')   // 3 old lines, +1 kept addition
    expect(rendered.indexOf('@@ -20,3 +21,2 @@')).toBeGreaterThan(0) // second kept hunk shifted by the +1 of the first
    expect(file.hunks[0].lines).toContain('+const localAI = 1') // input not mutated
})

test('block exclusions remove a whole added method, rewrites fix mixed lines exactly, and context is re-trimmed so the hunk no longer depends on lines it does not change', async () => {
    const { parseDiff, selectHunks, renderHunks } = await tool()
    const text = [
        'diff --git a/y.ts b/y.ts', '--- a/y.ts', '+++ b/y.ts',
        '@@ -5,6 +5,14 @@', ' k1', ' k2', ' k3',
        '+    async otherFeature(path) {', '+        if (!ok(path)) throw new Error()', '+        return this.go(path)', '+    }', '+',
        '+    async transferRequest(path) {', '+        return this.authFetch(path)', '+    }',
        '+function queue(op, recover = true) {', ' k4', ' k5', ' k6',
    ].join('\n')
    const [file] = parseDiff(text)
    const spec = { anchors: ['transferRequest', 'queue\\('], excludeAddedBlocks: [{ from: '^\\s{4}async otherFeature\\(', to: '^\\s{4}\\}$' }], rewriteAdded: [['function queue(op, recover = true) {', 'function queue(op) {']] }
    const { kept } = selectHunks(file.hunks, spec, 'y.ts', 1)
    expect(kept).toHaveLength(1)
    expect(kept[0].lines).toEqual([' k3', '+', '+    async transferRequest(path) {', '+        return this.authFetch(path)', '+    }', '+function queue(op) {', ' k4'])
    expect(kept[0].oldStart).toBe(7); expect(kept[0].oldCount).toBe(2) // leading k1,k2 and trailing k5,k6 trimmed to one context line each
    expect(renderHunks(kept)[0]).toBe('@@ -7,2 +7,7 @@')
    // A block that never closes, a block whose start matches a removal, and a rewrite that does not apply are all hard failures.
    expect(() => selectHunks(file.hunks, { ...spec, excludeAddedBlocks: [{ from: '^\\s{4}async otherFeature\\(', to: 'never-matches' }] }, 'y.ts', 1)).toThrow(/never closed|runs past/)
    expect(() => selectHunks(file.hunks, { ...spec, rewriteAdded: [['function queue(op, recover = true) {', 'function queue(op, recover = true) {']] }, 'y.ts', 1)).toThrow(/rewrite did not apply/)
})

test('an exclusion that would drop a REMOVAL is refused (host behaviour must never change silently)', async () => {
    const { parseDiff, selectHunks } = await tool()
    const [file] = parseDiff(diff)
    expect(() => selectHunks(file.hunks, { anchors: ['nasSync'], excludeAdded: ['old'] }, 'x.js')).toThrow(/removed line/)
})

test('a required hook that no kept hunk adds is reported as missing (no silent filtering)', async () => {
    const { parseDiff, selectHunks } = await tool()
    const [file] = parseDiff(diff)
    const { kept } = selectHunks(file.hunks, { anchors: ['nasSync'] }, 'x.js')
    const keptAdded = kept.flatMap(h => h.lines.filter(l => l.startsWith('+')).map(l => l.slice(1))).join('\n')
    const hooks = ['nasSync = create', 'unrelatedFeature\\(']
    expect(hooks.filter(h => !new RegExp(h).test(keptAdded))).toEqual(['unrelatedFeature\\('])
})
