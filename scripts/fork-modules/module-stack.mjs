#!/usr/bin/env node
// Assemble the existing fork without moving runtime code or touching an installed app/data directory.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, mkdtempSync, readdirSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { finishWorkdir, readKeepNames } from './cleanup-workdirs.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const folder = 'docs/fork-modules';
const configPath = `${folder}/features.json`, manifestPath = `${folder}/manifest.json`;
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
const save = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, data); };
const saveJson = (path, data) => save(path, JSON.stringify(data, null, 2) + '\n');
const copy = (from, to) => { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); };
export const normalizeHostText = bytes => bytes.toString('utf8').replace(/\r\n/g, '\n');
const hostHash = bytes => sha(normalizeHostText(bytes));
const split = text => text.split('\0').filter(Boolean);

export function ownership(config) {
    const owners = new Map();
    for (const module of config.modules) for (const kind of ['hosts', 'files']) for (const path of module[kind]) {
        if (owners.has(path)) throw new Error(`Duplicate owner: ${path}`);
        owners.set(path, { module: module.id, kind });
    }
    return owners;
}
export function assertCoverage(config, paths) {
    const owners = ownership(config);
    const adapters = (config.compatibility ?? []).flatMap(x => x.patches.map(p => p.path));
    const packaging = path => config.tooling.includes(path) || adapters.includes(path) || path === manifestPath || /^docs\/fork-modules\/patches\/[a-z-]+\.patch$/.test(path);
    const missing = paths.filter(path => !owners.has(path) && !packaging(path));
    if (missing.length) throw new Error('Unowned fork changes:\n' + missing.join('\n'));
    return owners;
}
function inventory(config) {
    const paths = [...split(git(repo, 'diff', '--no-renames', config.base, '--name-only', '-z')), ...split(git(repo, 'ls-files', '--others', '--exclude-standard', '-z'))];
    const owners = assertCoverage(config, paths);
    return [...owners].map(([path, owner]) => {
        const data = readFileSync(join(repo, path));
        return { path, ...owner, sha256: sha(data), contentSha256: owner.kind === 'hosts' ? hostHash(data) : sha(data), bytes: data.length };
    });
}
// Actual file headers only (line-anchored); an added body line that merely contains "diff --git" is never a header.
export function patchHeaders(text) {
    if (text.includes('\r')) throw new Error('Patch must use LF line endings');
    const headers = [...text.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map(([, before, after]) => ({ before, after }));
    if (!headers.length || headers.length !== (text.match(/^diff --git /gm) ?? []).length) throw new Error('Unrecognized patch headers');
    return headers;
}
export function assertPatchScope(text, allowed) {
    for (const { before, after } of patchHeaders(text)) if (before !== after || !allowed.includes(before)) throw new Error(`Patch outside module ownership: ${before} -> ${after}`);
}
function patch(work, path, allowed) {
    assertPatchScope(readFileSync(path, 'utf8'), allowed);
    git(work, 'apply', '--check', '--whitespace=nowarn', path);
    git(work, 'apply', '--whitespace=nowarn', path);
}
function commit(work) {
    git(work, 'add', '-u');
    git(work, '-c', 'user.name=RisuBard module verifier', '-c', 'user.email=module-verifier@localhost', 'commit', '-qm', 'module stage', '--allow-empty');
}
function verifyHooks(work, transfer) {
    for (const [path, spec] of Object.entries(transfer.integration.files)) for (const hook of spec.hooks) {
        if (!new RegExp(hook).test(readFileSync(join(work, path), 'utf8'))) throw new Error(`Missing transfer hook: ${path}: ${hook}`);
    }
}
export function assertPayload(source, destination, expected) {
    if (sha(readFileSync(source)) !== expected) throw new Error(`Source changed: ${source}`);
    if (existsSync(destination) && sha(readFileSync(destination)) !== expected) throw new Error(`Upstream file collision: ${destination}`);
}
export function selectPatch(manifest, targetSha, id, original) {
    const adapter = (manifest.compatibility ?? []).find(x => x.targetSha === targetSha)?.patches.find(x => x.module === id);
    if (!adapter) return original;
    if (!original?.sha256 || adapter.sourceSha256 !== original.sha256) throw new Error(`Stale compatibility adapter: ${id}`);
    return adapter;
}
export const payloadPath = (manifest, targetSha, path) => (manifest.compatibility ?? []).find(x => x.targetSha === targetSha)?.payloadTargets?.[path] ?? path;

// Target-only hosts: upstream files that exist only at one reviewed target commit (never in the base) and are edited by that
// target's adapter alone. Declared per adapter as { path, sha256 } with the upstream bytes; they are not inventory inputs, are
// never copied as payloads, and never widen the scope of the base or of any other target.
export function targetHostsOf(adapter) {
    const list = adapter?.targetHosts ?? [];
    if (!Array.isArray(list)) throw new Error(`Invalid target-only host list: ${adapter?.module}`);
    return list.map(entry => {
        if (!entry || typeof entry.path !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? '')) throw new Error(`Target-only host needs path and upstream sha256: ${adapter?.module}`);
        const path = entry.path;
        if (path !== path.trim() || !path.includes('/') || isAbsolute(path) || /^[A-Za-z]:|\\|\0|(^|\/)\.\.?(\/|$)|\/\//.test(path)) throw new Error(`Target-only host path escapes or is malformed: ${path}`);
        return { path, sha256: entry.sha256 };
    });
}
export const adapterScope = (hosts, adapter) => [...hosts, ...targetHostsOf(adapter).map(x => x.path)];
export const baseHasIn = (cwd, base) => path => { try { git(cwd, 'cat-file', '-e', `${base}:${path}`); return true; } catch { return false; } };
// Shared by generate and verify: every declaration is well formed, singly owned (no ordinary host/file, no second adapter of the
// same target), absent from the base and actually modified by its adapter. Returns the flat declaration list for agreement checks.
export function assertTargetOnlyHosts(config, { baseHas, patchText } = {}) {
    const owners = ownership(config), ids = new Set(config.modules.map(m => m.id)), targets = new Set(), out = [];
    for (const entry of config.compatibility ?? []) {
        if (targets.has(entry.targetSha) || targets.has(entry.tag)) throw new Error(`Duplicate compatibility target: ${entry.tag}`);
        targets.add(entry.targetSha); targets.add(entry.tag);
        const modules = entry.patches.map(p => p.module);
        if (new Set(modules).size !== modules.length) throw new Error(`Duplicate adapter module at ${entry.tag}`);
        const perTarget = new Map();
        for (const p of entry.patches) for (const host of targetHostsOf(p)) {
            if (p.module === 'transfer-integration' || !ids.has(p.module)) throw new Error(`Target-only host owner is not a feature module: ${p.module}`);
            if (owners.has(host.path)) throw new Error(`Target-only host already owned by ${owners.get(host.path).module}: ${host.path}`);
            if (perTarget.has(host.path)) throw new Error(`Target-only host owned twice at ${entry.tag}: ${host.path}`);
            perTarget.set(host.path, p.module);
            if (baseHas && baseHas(host.path)) throw new Error(`Target-only host exists in the base; register it as an ordinary host: ${host.path}`);
            if (patchText && !patchHeaders(patchText(p)).some(h => h.before === host.path && h.after === host.path)) throw new Error(`Target-only host is not modified by its adapter: ${host.path}`);
            out.push({ tag: entry.tag, targetSha: entry.targetSha, module: p.module, path: host.path, sha256: host.sha256 });
        }
    }
    return out;
}
// features.json (reviewed source config) and manifest.json (generated) must declare the same target-only hosts: a manifest cannot
// widen, repoint or drop a declaration on its own. Returns the validated declarations of the source config.
export function assertTargetOnlyAgreement(config, manifest, options = {}) {
    const declared = assertTargetOnlyHosts(config, options);
    if (JSON.stringify(declared) !== JSON.stringify(assertTargetOnlyHosts(manifest))) throw new Error('Target-only host declarations differ between features and manifest; run generate');
    return declared;
}
// The selected target checkout must hold exactly the reviewed upstream bytes; checked before the first apply and again after removal.
export function assertTargetBytes(work, adapter) {
    return targetHostsOf(adapter).map(host => {
        const file = join(work, host.path);
        if (!existsSync(file)) throw new Error(`Target-only host missing at this target: ${host.path}`);
        if (sha(readFileSync(file)) !== host.sha256) throw new Error(`Target-only host bytes differ from the reviewed upstream: ${host.path}`);
        return host;
    });
}

export function generate({ keepWorkdir = false } = {}) {
    const config = json(join(repo, configPath)), inputs = inventory(config);
    const transfer = json(join(repo, config.transferManifest));
    if (transfer.upstream.base.sha !== config.base) throw new Error('Transfer and full stack bases differ');
    const keepNames = readKeepNames({ outputRoots: [] });
    const work = mkdtempSync(join(tmpdir(), 'risubard-stack-generate-'));
    let failed = true;
    try {
        git(repo, 'clone', '-q', '--shared', '--no-checkout', repo, work);
        git(work, 'checkout', '-q', '--detach', config.base);
        patch(work, join(repo, transfer.integration.patch), Object.keys(transfer.integration.files)); commit(work);
        const manifest = { schema: 1, base: config.base, upstream: config.upstream,
            transfer: { path: transfer.integration.patch, sha256: sha(readFileSync(join(repo, transfer.integration.patch))) },
            inputs, modules: [], tooling: [], compatibility: [] };
        for (const module of config.modules) {
            for (const path of module.hosts) save(join(work, path), normalizeHostText(readFileSync(join(repo, path))));
            const diff = git(work, 'diff', '--binary', '--no-ext-diff', '--no-renames', 'HEAD', '--', ...module.hosts);
            const entry = { id: module.id, name: module.name, hosts: module.hosts, files: module.files, patch: null };
            if (diff.trim()) {
                const path = `${folder}/patches/${module.id}.patch`;
                save(join(repo, path), diff); entry.patch = { path, sha256: sha(Buffer.from(diff)) };
            } else if (existsSync(join(repo, `${folder}/patches/${module.id}.patch`))) save(join(repo, `${folder}/patches/${module.id}.patch`), '');
            commit(work); manifest.modules.push(entry);
        }
        // Rebuilding the original base must reproduce every existing host change, including shared hunks.
        for (const input of inputs.filter(x => x.kind === 'hosts')) {
            if (hostHash(readFileSync(join(work, input.path))) !== input.contentSha256) throw new Error(`Host reconstruction differs: ${input.path}`);
        }
        verifyHooks(work, transfer);
        const targetOnly = assertTargetOnlyHosts(config, { baseHas: baseHasIn(repo, config.base), patchText: p => readFileSync(join(repo, p.path), 'utf8') });
        manifest.compatibility = (config.compatibility ?? []).map(entry => ({ ...entry, patches: entry.patches.map(p => {
            const original = p.module === 'transfer-integration' ? manifest.transfer : manifest.modules.find(x => x.id === p.module)?.patch;
            if (!original?.sha256 || p.sourceSha256 !== original.sha256) throw new Error(`Stale compatibility adapter: ${p.module}`);
            assertPatchScope(readFileSync(join(repo, p.path), 'utf8'), p.module === 'transfer-integration' ? Object.keys(transfer.integration.files) : adapterScope(manifest.modules.find(x => x.id === p.module).hosts, p));
            return { ...p, sha256: sha(readFileSync(join(repo, p.path))) };
        }) }));
        manifest.tooling = config.tooling.map(path => ({ path, sha256: sha(readFileSync(join(repo, path))) }));
        saveJson(join(repo, manifestPath), manifest);
        failed = false;
        return { result: 'PASS', files: inputs.length, targetOnlyHosts: targetOnly.length, modules: manifest.modules.map(x => ({ id: x.id, hosts: x.hosts.length, files: x.files.length, patch: x.patch?.path })), work };
    } finally { finishWorkdir(work, { failed, keepWorkdir, keepNames }); }
}

function checkedSource(manifest, config) {
    const current = inventory(config);
    if (JSON.stringify(current) !== JSON.stringify(manifest.inputs)) throw new Error('Source inventory changed; review ownership and run generate');
    assertTargetOnlyAgreement(config, manifest, { baseHas: baseHasIn(repo, config.base), patchText: p => readFileSync(join(repo, p.path), 'utf8') });
    for (const target of manifest.compatibility ?? []) for (const adapter of target.patches) {
        selectPatch(manifest, target.targetSha, adapter.module, adapter.module === 'transfer-integration' ? manifest.transfer : manifest.modules.find(x => x.id === adapter.module)?.patch);
    }
    for (const entry of [manifest.transfer, ...manifest.modules.flatMap(x => x.patch ? [x.patch] : []), ...manifest.tooling, ...(manifest.compatibility ?? []).flatMap(x => x.patches)]) {
        if (sha(readFileSync(join(repo, entry.path))) !== entry.sha256) throw new Error(`Artifact changed: ${entry.path}; regenerate after review`);
    }
}
function run(work, command, args) {
    // Only fixed checked-in test commands use a Windows .cmd shell; git paths and refs always use execFileSync.
    return spawnSync(command, args, { cwd: work, encoding: 'utf8', shell: process.platform === 'win32' && command === 'pnpm', maxBuffer: 64 << 20, timeout: 1800_000 });
}
// Compare source paths/bytes before dependencies or build output are created; file modes are not covered.
export function sourceSnapshot(work) {
    const entries = [];
    const walk = dir => {
        for (const item of readdirSync(join(work, dir), { withFileTypes: true })) {
            if (!dir && item.name === '.git') continue;
            const path = dir ? `${dir}/${item.name}` : item.name;
            if (item.isDirectory()) walk(path);
            else entries.push([path, sha(readFileSync(join(work, path)))]);
        }
    };
    walk('');
    return JSON.stringify(entries.sort(([a], [b]) => a.localeCompare(b)));
}
export function reverseAssembly(work, patches, originals) {
    for (const path of [...patches].reverse()) {
        git(work, 'apply', '--reverse', '--check', '--whitespace=nowarn', path);
        git(work, 'apply', '--reverse', '--whitespace=nowarn', path);
    }
    for (const [path, bytes] of originals) {
        const target = resolve(work, path), rel = relative(work, target);
        if (!rel || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) throw new Error(`Copy outside isolated checkout: ${path}`);
        if (bytes === null) unlinkSync(target);
        else save(target, bytes);
    }
}

export function verify({ target = 'base', full = false, logs = 'tmp/fork-module-check' } = {}) {
    const config = json(join(repo, configPath)), manifest = json(join(repo, manifestPath));
    const transfer = json(join(repo, config.transferManifest));
    const work = mkdtempSync(join(tmpdir(), 'risubard-stack-verify-'));
    const evidence = resolve(repo, logs); mkdirSync(evidence, { recursive: true });
    let originalSnapshot;
    const originals = new Map(), copies = new Map();
    const copyInput = (from, path) => {
        const target = join(work, path);
        if (!originals.has(path)) originals.set(path, existsSync(target) ? readFileSync(target) : null);
        copies.set(path, from);
        copy(from, target);
    };
    const report = { target, work, result: 'RUNNING', steps: [], targetSha: null,
        manifestSha256: sha(readFileSync(join(repo, manifestPath))), startedAt: new Date().toISOString(), node: process.version, patches: [], targetOnlyHosts: [] };
    const apply = (id, original, allowed) => {
        const selected = selectPatch(manifest, report.targetSha, id, original);
        // A target-only host is read from the checked-out upstream and must match the reviewed bytes before anything touches it.
        const targetHosts = assertTargetBytes(work, selected);
        patch(work, join(repo, selected.path), adapterScope(allowed, selected));
        report.patches.push({ module: id, path: selected.path, sha256: selected.sha256, allowed, targetHosts });
        report.targetOnlyHosts.push(...targetHosts.map(host => ({ module: id, ...host, upstreamBytesVerified: true })));
        return `${selected.path}\nSHA-256: ${selected.sha256}` + targetHosts.map(host => `\ntarget-only host ${host.path} upstream SHA-256 ${host.sha256} verified`).join('');
    };
    const step = (name, action) => {
        process.stderr.write(`[fork-modules] ${name}\n`);
        try { const detail = action() ?? ''; save(join(evidence, name + '.log'), String(detail)); report.steps.push({ name, ok: true }); }
        catch (error) { save(join(evidence, name + '.log'), [error.message, error.stdout, error.stderr].filter(Boolean).join('\n')); report.steps.push({ name, ok: false }); throw error; }
    };
    try {
        step('source-inventory', () => { checkedSource(manifest, config); return `${manifest.inputs.length} sources; all hashes match`; });
        step('checkout', () => {
            if (target === 'base') { git(repo, 'clone', '-q', '--shared', '--no-checkout', repo, work); git(work, 'checkout', '-q', '--detach', config.base); }
            else {
                git(work, 'init', '-q'); git(work, 'remote', 'add', 'origin', config.upstream);
                git(work, 'fetch', '-q', '--depth', '1', 'origin', `refs/tags/${target}:refs/tags/${target}`);
                git(work, 'checkout', '-q', '--detach', `${target}^{commit}`);
            }
            report.targetSha = git(work, 'rev-parse', 'HEAD').trim();
            const expected = manifest.compatibility.find(x => x.tag === target);
            if (expected && expected.targetSha !== report.targetSha) throw new Error(`Reviewed tag changed: ${target}`);
            originalSnapshot = sourceSnapshot(work);
            return report.targetSha;
        });
        step('transfer-integration', () => apply('transfer-integration', manifest.transfer, Object.keys(transfer.integration.files)));
        for (const module of manifest.modules) step(module.id, () => {
            const applied = module.patch ? apply(module.id, module.patch, module.hosts) : 'No residual patch';
            for (const path of module.files) {
                const entry = manifest.inputs.find(x => x.path === path);
                const destination = payloadPath(manifest, report.targetSha, path);
                assertPayload(join(repo, path), join(work, destination), entry.sha256);
                copyInput(join(repo, path), destination);
            }
            return `${applied}\n${module.hosts.length} host paths; ${module.files.length} payload files`;
        });
        step('tooling', () => {
            for (const entry of [...manifest.tooling, { path: manifestPath }, ...manifest.modules.flatMap(x => x.patch ? [x.patch] : []), ...(manifest.compatibility ?? []).flatMap(x => x.patches)]) copyInput(join(repo, entry.path), entry.path);
        });
        step('preservation', () => {
            verifyHooks(work, transfer);
            const specificProbes = manifest.compatibility.find(x => x.targetSha === report.targetSha)?.probes ?? {};
            const probesByFile = structuredClone(transfer.verify.upstreamFeatureProbes);
            for (const [path, probes] of Object.entries(specificProbes)) probesByFile[path] = [...(probesByFile[path] ?? []), ...probes];
            for (const [path, probes] of Object.entries(probesByFile)) {
                const original = git(work, 'show', `HEAD:${path}`), updated = readFileSync(join(work, path), 'utf8');
                for (const probe of probes) {
                    if (specificProbes[path]?.includes(probe) && !original.includes(probe)) throw new Error(`Invalid upstream probe: ${path}: ${probe}`);
                    if (original.includes(probe) && !updated.includes(probe)) throw new Error(`Lost upstream feature: ${path}: ${probe}`);
                }
            }
            let exact = 0;
            for (const input of manifest.inputs) {
                if (input.kind === 'hosts' && report.targetSha !== manifest.base) continue;
                const data = readFileSync(join(work, input.kind === 'hosts' ? input.path : payloadPath(manifest, report.targetSha, input.path))), actual = input.kind === 'hosts' ? hostHash(data) : sha(data);
                if (actual !== input.contentSha256) throw new Error(`Reconstruction mismatch: ${input.path}`);
                exact++;
            }
            return report.targetSha === manifest.base
                ? `${exact} reconstructed files verified (${manifest.inputs.filter(x => x.kind === 'hosts').length} hosts compare text with CRLF normalized; all ${manifest.inputs.filter(x => x.kind === 'files').length} payloads byte-identical)`
                : `${exact} payloads byte-identical. Hosts retain upstream differences: checked patch scope, transfer hooks and ${Object.values(probesByFile).flat().length} upstream probes; no host byte-equality claim. ${report.targetOnlyHosts.length} target-only host(s) verified against reviewed upstream bytes (not counted as inputs).`;
        });
        step('removal-reapply', () => {
            const assembled = sourceSnapshot(work);
            reverseAssembly(work, report.patches.map(p => join(repo, p.path)), originals);
            if (sourceSnapshot(work) !== originalSnapshot) throw new Error('Removal differs from original source paths/bytes');
            for (const item of report.patches) {
                assertTargetBytes(work, item); // removal must have restored the reviewed upstream bytes before the same adapter is reapplied
                patch(work, join(repo, item.path), adapterScope(item.allowed, item));
            }
            for (const [path, from] of copies) copy(from, join(work, path));
            if (sourceSnapshot(work) !== assembled) throw new Error('Reapplication differs from assembled source paths/bytes');
            return `${report.patches.length} patches reversed and reapplied; source paths/bytes match. File modes and runtime/data compatibility are separate checks.`;
        });
        if (full) {
            step('toolchain', () => {
                const result = run(work, 'pnpm', ['--version']);
                if (result.status !== 0) throw new Error('Cannot read pnpm version');
                report.pnpm = result.stdout.trim(); return `Node ${report.node}\npnpm ${report.pnpm}`;
            });
            const commands = [
                ['install', 'pnpm', ['install', '--frozen-lockfile', '--prefer-offline']],
                ['module-tool-tests', process.execPath, ['--test', 'scripts/fork-modules/module-stack.node-test.mjs', 'scripts/fork-modules/cleanup-workdirs.node-test.mjs', 'scripts/fork-modules/workdir-lifecycle.node-test.mjs']],
                ['node-tests', process.execPath, ['--experimental-strip-types', '--test', ...split(git(work, 'ls-files', '--cached', '--others', '--exclude-standard', '-z')).filter(path => /\.node-test\.(?:ts|mjs|cjs)$/.test(path) && !path.startsWith('scripts/fork-modules/'))]],
                // Bound competing fsync-heavy files; each test retains its own concurrent writers and timeout.
                ['server-tests', 'pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.config.server.ts', '--maxWorkers', '4']],
                ['client-tests', 'pnpm', ['exec', 'vitest', 'run', '--testTimeout', '30000', '--maxWorkers', '4']],
                ['compat-tests', 'pnpm', ['exec', 'vitest', 'run', '--config', 'vitest.config.compat.ts']],
                ['typecheck', 'pnpm', ['check']],
                ['public-boundary', 'pnpm', ['check:public-boundary']],
                ['build', 'pnpm', ['build']],
            ];
            for (const [name, command, args] of commands) step(name, () => {
                const result = run(work, command, args), output = (result.stdout ?? '') + (result.stderr ?? '');
                if (result.status !== 0) throw Object.assign(new Error(`${name} exit ${result.status}: ${result.error ?? ''}`), { stdout: output });
                return output;
            });
        }
        checkedSource(manifest, config);
        report.result = full ? 'PASS' : 'STRUCTURAL_PASS';
    } catch (error) { report.result = 'FAIL'; report.error = String(error.message); }
    report.finishedAt = new Date().toISOString();
    saveJson(join(evidence, 'report.json'), report);
    // report.work is a reusable checkout, not just a diagnostic label. Clean it only through cleanup-workdirs.
    console.error(`[workdir] kept (${report.result === 'FAIL' ? 'failed' : 'report-reference'}): ${work}`);
    return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const command = process.argv[2];
    try {
        const value = flag => { const i = process.argv.indexOf(flag); return i < 0 ? undefined : process.argv[i + 1]; };
        const result = command === 'generate' ? generate({ keepWorkdir: process.argv.includes('--keep-workdir') }) : command === 'verify' ? verify({ target: value('--target'), full: process.argv.includes('--full'), logs: value('--logs') }) : null;
        if (!result) throw new Error('Usage: module-stack.mjs generate | verify --target base|vX.Y.Z [--full] [--logs path] [--keep-workdir]');
        console.log(JSON.stringify(result, null, 2)); if (result.result === 'FAIL') process.exitCode = 1;
    } catch (error) { console.error(error.message); process.exitCode = 1; }
}
