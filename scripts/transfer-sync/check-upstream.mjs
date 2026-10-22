#!/usr/bin/env node
// Transfer/sync module ↔ upstream RisuBard compatibility tool (no dependencies). Two commands:
//   node scripts/transfer-sync/check-upstream.mjs patch  [--out docs/transfer-sync/integration.patch] [--report <json>]
//     Regenerates the reviewed host-hook patch from manifest.upstream.base to the CURRENT worktree for manifest.integration.files:
//     a hunk is kept when any changed line matches one of that file's `anchors`; afterwards every `hooks` regex must be covered by
//     kept hunks or the command FAILS (a required host hook can never be filtered away silently). Dropped hunks are listed in the
//     report for review. New-side line numbers are recomputed so the patch is self-consistent.
//   node scripts/transfer-sync/check-upstream.mjs verify --target <tag|sha|latest> [--full] [--keep] [--report <json>] [--logs <dir>]
//     Isolated temp checkout of upstream at the target → copies manifest.module (dirs+files) from this repo → direct `git apply
//     --reject` of integration.patch (any rejected hunk = CONFLICT, listed; no 3-way merge: a shallow target has no base blobs) → every `hooks` regex must match the resulting host files → named upstream
//     features (`verify.upstreamFeatureProbes`) must still be present → `node --check` on the server module. With --full it also
//     runs `pnpm install`, the module server/client tests, svelte-check and `pnpm build` IN THE TEMP CHECKOUT. The result is PASS
//     only when every step passed; anything else is CONFLICT/FAIL with the failing step named. Nothing here touches this repo,
//     devices or remotes except read-only fetches.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, rmSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = JSON.parse(readFileSync(join(repo, 'docs/transfer-sync/manifest.json'), 'utf8'));
const args = Object.fromEntries(process.argv.slice(3).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : 'true'] : null).filter(Boolean));
const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] });
// pnpm/npx are .cmd shims on Windows (need a shell); git and node are real executables and get their arguments verbatim (paths with spaces).
const run = (cwd, cmd, a, opts = {}) => { const shell = process.platform === 'win32' && !/^(git|node)$/.test(cmd) && cmd !== process.execPath; const argv = shell ? a.map(x => /[\s"]/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x) : a; const r = spawnSync(cmd, argv, { cwd, encoding: 'utf8', shell, maxBuffer: 1 << 28, ...opts }); return { ok: r.status === 0, status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') + (r.error ? String(r.error) : '') }; };
const log = m => console.error('[transfer-sync] ' + m);

/** Parse `git diff` output into files → hunks (header + lines), keeping text verbatim. */
export function parseDiff(text) {
    const files = []; let file = null, hunk = null;
    for (const line of text.split('\n')) {
        if (line.startsWith('diff --git ')) { file = { header: [line], hunks: [] }; files.push(file); hunk = null; continue; }
        if (!file) continue;
        if (line.startsWith('@@')) { const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line); hunk = { oldStart: +m[1], oldCount: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newCount: m[4] === undefined ? 1 : +m[4], tail: m[5], lines: [] }; file.hunks.push(hunk); continue; }
        if (hunk) hunk.lines.push(line); else file.header.push(line);
    }
    return files;
}
const changed = hunk => hunk.lines.filter(l => /^[+-]/.test(l) && !l.startsWith('+++') && !l.startsWith('---')).map(l => l.slice(1));
const added = hunk => hunk.lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1));
/** Pure selection: keep hunks touching an anchor, drop reviewed proximity additions (never removals), report what was dropped. */
export function selectHunks(hunks, spec, file = '', context = 3) {
    const anchors = (spec.anchors ?? []).map(a => new RegExp(a)), exclude = (spec.excludeAdded ?? []).map(x => new RegExp(x)), kept = [], dropped = [];
    const blocks = (spec.excludeAddedBlocks ?? []).map(b => ({ from: new RegExp(b.from), to: new RegExp(b.to) })), rewrites = spec.rewriteAdded ?? [];
    const isAdd = l => l.startsWith('+') && !l.startsWith('+++'), isDel = l => l.startsWith('-') && !l.startsWith('---');
    for (const original of hunks) {
        const h = { ...original, lines: [...original.lines] };
        if (!changed(h).some(l => anchors.some(a => a.test(l)))) { dropped.push(h); continue; }
        const removedHit = h.lines.find(l => isDel(l) && (exclude.some(x => x.test(l.slice(1))) || blocks.some(b => b.from.test(l.slice(1)))));
        if (removedHit) throw new Error(`${file}: an exclusion matches a removed line; split the hunk by hand: ${removedHit.slice(0, 120)}`);
        const before = h.lines.length;
        // Reviewed exclusions of OTHER features' additions that git merged into a module hunk by proximity: single lines, or a
        // contiguous block of added lines from `from` through the first following line matching `to` (a whole function/method).
        const out = []; let skipping = null;
        for (const l of h.lines) {
            if (skipping) { if (!isAdd(l)) throw new Error(`${file}: excluded block runs past the added lines: ${l.slice(0, 120)}`); if (skipping.to.test(l.slice(1))) skipping = null; continue; }
            if (isAdd(l)) { const b = blocks.find(b => b.from.test(l.slice(1))); if (b) { skipping = b.to.test(l.slice(1)) ? null : b; continue; } if (exclude.some(x => x.test(l.slice(1)))) continue; } // patterns see the line without its +/- prefix
            out.push(l);
        }
        if (skipping) throw new Error(`${file}: excluded block never closed (to=${skipping.to})`);
        // Reviewed rewrites of mixed added lines (module text and another feature's text on one line): exact match, must apply.
        h.lines = out.map(l => { if (!isAdd(l)) return l; for (const [from, to] of rewrites) if (l.slice(1) === from) return '+' + to; return l; });
        for (const [from] of rewrites) if (h.lines.includes('+' + from)) throw new Error(`${file}: rewrite did not apply: ${from.slice(0, 80)}`);
        // Excluded additions may have been the only reason this hunk's context reached further lines (git merges nearby changes):
        // re-trim leading/trailing context to `context` lines so the hunk does not depend on host lines it no longer changes.
        if (h.lines.length !== before) {
            const isChange = l => /^[+-]/.test(l);
            const first = h.lines.findIndex(isChange), last = h.lines.length - 1 - [...h.lines].reverse().findIndex(isChange);
            const dropLead = Math.max(0, first - context), dropTail = Math.max(0, h.lines.length - 1 - last - context);
            h.lines = h.lines.slice(dropLead, h.lines.length - dropTail);
            h.oldStart += dropLead; h.oldCount -= dropLead + dropTail;
        }
        kept.push(h);
    }
    return { kept, dropped };
}
/** Re-number kept hunks so the patch is self-consistent after drops/exclusions. */
export function renderHunks(kept) {
    let delta = 0; const lines = [];
    for (const h of kept) {
        const plus = h.lines.filter(l => l.startsWith('+')).length, minus = h.lines.filter(l => l.startsWith('-')).length;
        lines.push(`@@ -${h.oldStart},${h.oldCount} +${h.oldStart + delta},${h.oldCount + plus - minus} @@${h.tail}`, ...h.lines);
        delta += plus - minus;
    }
    return lines;
}

function patch() {
    const out = resolve(repo, args.out ?? manifest.integration.patch), report = { base: manifest.upstream.base, files: {}, ok: true };
    const pieces = [];
    for (const [file, spec] of Object.entries(manifest.integration.files)) {
        const diff = git(repo, 'diff', '-U' + String(args.context ?? spec.context ?? manifest.integration.context ?? 3), '--no-color', '--src-prefix=a/', '--dst-prefix=b/', manifest.upstream.base.sha, '--', file);
        const parsed = parseDiff(diff)[0];
        const hooks = spec.hooks.map(h => new RegExp(h));
        const { kept, dropped } = selectHunks(parsed?.hunks ?? [], spec, file, Number(args.context ?? spec.context ?? manifest.integration.context ?? 3));
        const keptAdded = kept.flatMap(added).join('\n');
        const missing = spec.hooks.filter((_, i) => !hooks[i].test(keptAdded));
        // A hook that already exists unchanged at the base is fine; one that neither the base nor the kept hunks provide is a hard failure.
        const baseText = (() => { try { return git(repo, 'show', `${manifest.upstream.base.sha}:${file}`); } catch { return ''; } })();
        const reallyMissing = missing.filter(h => !new RegExp(h).test(baseText));
        report.files[file] = { kept: kept.length, dropped: dropped.map(h => ({ at: `-${h.oldStart},${h.oldCount}`, first: changed(h)[0]?.slice(0, 100) ?? '' })), hooksMissing: reallyMissing };
        if (reallyMissing.length) report.ok = false;
        if (!kept.length) continue;
        pieces.push([...parsed.header.filter(l => !l.startsWith('index ')), ...renderHunks(kept)].join('\n'));
    }
    if (!report.ok) { console.error(JSON.stringify(report, null, 1)); throw new Error('integration patch would omit required host hooks: ' + Object.entries(report.files).filter(([, r]) => r.hooksMissing.length).map(([f, r]) => f + ' → ' + r.hooksMissing.join(', ')).join('; ')); }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, pieces.join('\n') + '\n');
    // The generated patch must apply cleanly to the base it was generated from (self-consistency), checked in a scratch checkout.
    const scratch = mkdtempSync(join(tmpdir(), 'transfer-sync-base-'));
    try {
        git(scratch, 'init', '-q'); git(scratch, 'fetch', '-q', '--depth', '1', repo, manifest.upstream.base.sha); git(scratch, 'checkout', '-q', '--detach', 'FETCH_HEAD');
        const check = run(scratch, 'git', ['apply', '--check', out]); report.appliesToBase = check.ok; if (!check.ok) { report.ok = false; report.baseApplyError = check.out.slice(0, 2000); }
    } finally { rmSync(scratch, { recursive: true, force: true }); }
    if (args.report) writeFileSync(resolve(repo, args.report), JSON.stringify(report, null, 1));
    log(`patch: ${pieces.length} files, applies to base: ${report.appliesToBase}; dropped hunks: ${Object.values(report.files).reduce((n, r) => n + r.dropped.length, 0)} (review in report)`);
    if (!report.ok) throw new Error('patch does not apply to its own base');
    return report;
}

async function verify() {
    const target = args.target ?? manifest.upstream.verified.tag, full = args.full === 'true';
    const report = { target, steps: [], ok: true, result: 'FAIL' };
    const logs = args.logs ? resolve(repo, args.logs) : null; if (logs) mkdirSync(logs, { recursive: true });
    // Every step's FULL output is kept as a file (diagnostics); the JSON report carries a bounded excerpt plus the file name.
    // `raw` is the stage's complete output (written whole to <logs>/<step>.log); `summary` (optional) is the short excerpt for the JSON.
    const step = (name, ok, raw = '', summary = null) => { let file = null; if (logs) { file = join(logs, name.replace(/[^a-z0-9]+/gi, '-') + '.log'); writeFileSync(file, String(raw)); } const brief = String(summary ?? raw); report.steps.push({ name, ok, detail: brief.slice(0, 4000), rawBytes: String(raw).length, log: file }); if (!ok) report.ok = false; log(`${ok ? 'ok  ' : 'FAIL'} ${name}${brief && !ok ? ': ' + brief.split('\n')[0].slice(0, 160) : ''}`); return ok; };
    const work = mkdtempSync(join(tmpdir(), 'transfer-sync-verify-'));
    try {
        git(work, 'init', '-q'); git(work, 'remote', 'add', 'origin', manifest.upstream.repo);
        let ref = target;
        if (target === 'latest') { // the newest stable release tag (vX.Y.Z), never a moving branch head
            const tags = git(work, 'ls-remote', '--tags', '--refs', 'origin').split('\n').map(l => l.trim().split(/\s+/)[1]?.replace('refs/tags/', '')).filter(t => /^v\d+\.\d+\.\d+$/.test(t));
            tags.sort((a, b) => { const x = a.slice(1).split('.').map(Number), y = b.slice(1).split('.').map(Number); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
            if (!tags.length) throw new Error('no stable vX.Y.Z tag on upstream'); ref = tags.at(-1); report.resolvedTag = ref;
        }
        const tagLike = /^v\d/.test(ref);
        git(work, 'fetch', '-q', '--depth', '1', 'origin', tagLike ? `refs/tags/${ref}:refs/tags/${ref}` : ref);
        git(work, 'checkout', '-q', '--detach', tagLike ? `${ref}^{commit}` : 'FETCH_HEAD');
        report.targetSha = git(work, 'rev-parse', 'HEAD').trim(); log(`target ${target} = ${report.targetSha}`);
        // 1. module files
        const absent = [...manifest.module.dirs, ...manifest.module.files].filter(p => !existsSync(join(repo, p)));
        if (!step('module files exist in this repo', !absent.length, absent.join('\n'))) throw new Error('module files missing');
        for (const dir of manifest.module.dirs) cpSync(join(repo, dir), join(work, dir), { recursive: true, filter: s => !/node_modules|\.gradle|[\\/]build[\\/]|[\\/]bin[\\/]|[\\/]obj[\\/]/.test(s) });
        for (const file of manifest.module.files) { mkdirSync(dirname(join(work, file)), { recursive: true }); cpSync(join(repo, file), join(work, file)); }
        step('copy module files', true);
        // 2. host hooks via patch (direct apply; rejected hunks are reported as conflicts)
        // A shallow target has no base blobs, so no 3-way merge: plain apply with --reject writes <file>.rej for every hunk whose
        // context no longer matches upstream. Any .rej = CONFLICT (listed with the first lines of the rejected hunks).
        const apply = run(work, 'git', ['apply', '--reject', '--whitespace=nowarn', resolve(repo, manifest.integration.patch)]);
        const rejects = [];
        const walk = dir => { for (const e of readdirSync(dir, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name === '.git') continue; const p = join(dir, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith('.rej')) rejects.push(p); } };
        walk(work);
        const conflicts = rejects.map(p => ({ file: p.slice(work.length + 1).replace(/\\/g, '/').replace(/\.rej$/, ''), hunks: readFileSync(p, 'utf8').split('\n').filter(l => l.startsWith('@@')).length, first: readFileSync(p, 'utf8').split('\n').filter(l => /^[+-][^+-]/.test(l)).slice(0, 3).map(l => l.slice(0, 120)) }));
        report.conflicts = conflicts;
        if (!step('apply integration.patch', apply.ok && !conflicts.length, conflicts.length ? JSON.stringify(conflicts, null, 1) : apply.out)) throw new Error('integration patch did not apply');
        // 3. every required host hook present; named upstream features preserved
        const missing = [];
        for (const [file, spec] of Object.entries(manifest.integration.files)) { const text = existsSync(join(work, file)) ? readFileSync(join(work, file), 'utf8') : ''; for (const h of spec.hooks) if (!new RegExp(h).test(text)) missing.push(`${file}: ${h}`); }
        step('host hooks present', !missing.length, missing.join('\n'));
        const lost = [];
        for (const [file, probes] of Object.entries(manifest.verify.upstreamFeatureProbes ?? {})) { const text = existsSync(join(work, file)) ? readFileSync(join(work, file), 'utf8') : ''; const inTarget = (() => { try { return git(work, 'show', `HEAD:${file}`); } catch { return ''; } })(); for (const p of probes) if (inTarget.includes(p) && !text.includes(p)) lost.push(`${file}: ${p}`); }
        step('upstream features preserved', !lost.length, lost.join('\n'));
        // 4. syntax of the server module
        const bad = [];
        for (const f of readdirSync(join(work, 'server/node/transfer-sync')).filter(f => f.endsWith('.cjs'))) { const r = run(work, process.execPath, ['--check', join('server/node/transfer-sync', f)]); if (!r.ok) bad.push(f + ': ' + r.out.split('\n')[0]); }
        step('node --check server module', !bad.length, bad.join('\n'));
        if (full) {
            const install = run(work, 'pnpm', ['install', '--no-frozen-lockfile', '--prefer-offline'], { timeout: 1800_000 });
            if (!step('pnpm install', install.ok, install.out, install.out.split('\n').slice(-8).join('\n'))) throw new Error('install failed');
            const load = run(work, process.execPath, ['-e', `for (const f of require('fs').readdirSync('server/node/transfer-sync')) if (f.endsWith('.cjs')) require('./server/node/transfer-sync/' + f); console.log('loaded')`]);
            step('load server module', load.ok && /loaded/.test(load.out), load.out);
            const server = run(work, 'npx', ['vitest', 'run', '--config', 'vitest.config.server.ts', ...manifest.verify.serverTests], { timeout: 1800_000 });
            step('server module tests', server.ok, server.out, server.out.split('\n').filter(l => /Tests |Test Files|FAIL|×/.test(l)).join('\n'));
            const client = run(work, 'npx', ['vitest', 'run', ...manifest.verify.clientTests], { timeout: 1800_000 });
            step('client module tests', client.ok, client.out, client.out.split('\n').filter(l => /Tests |Test Files|FAIL|×/.test(l)).join('\n'));
            const types = run(work, 'npx', ['svelte-check', '--threshold', 'error'], { timeout: 1800_000 });
            step('svelte-check', types.ok, types.out, types.out.split('\n').filter(l => /found|Error/.test(l)).join('\n'));
            const build = run(work, 'pnpm', ['build'], { timeout: 1800_000 });
            step('pnpm build', build.ok, build.out, build.out.split('\n').slice(-5).join('\n'));
        } else step('full checks (install/tests/types/build)', true, 'SKIPPED (--full not given) — result is NOT a compatibility proof');
    } catch (error) { report.ok = false; report.error = String(error?.message ?? error).slice(0, 2000); }
    finally { if (args.keep === 'true') log('kept ' + work); else rmSync(work, { recursive: true, force: true }); }
    report.result = report.ok ? (full ? 'PASS' : 'PASS (structural only, no --full)') : (report.conflicts?.length ? 'CONFLICT' : 'FAIL');
    if (args.report) { mkdirSync(dirname(resolve(repo, args.report)), { recursive: true }); writeFileSync(resolve(repo, args.report), JSON.stringify(report, null, 1)); }
    log(`result: ${report.result}`);
    if (!report.ok) process.exitCode = 1;
    return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const command = process.argv[2];
    if (command === 'patch') patch();
    else if (command === 'verify') await verify();
    else { console.error('usage: check-upstream.mjs patch|verify (see header)'); process.exitCode = 2; }
}
