// Signed production APK (normal RisuBard, app.risubard.personal) + verification, from existing pieces:
//   Gradle assembleRelease (web build → runtime packaging → 16 KiB verification → signed APK),
//   aapt badging, apksigner verify, zipalign -P 16 from ANDROID_HOME build-tools, ELF inspection of every packaged
//   libnode.so, the packaged runtime ZIP (hash vs assets/runtime.sha256, CRC of every entry, entries compared with the
//   workspace sources they were staged from).
//
//   node scripts/android/release-build.mjs [outDir] [--verify-only]   (--verify-only re-checks the APK already in outDir)
// Env: JAVA_HOME (JDK 17), ANDROID_HOME (SDK with build-tools), RISUBARD_GRADLE (gradle launcher path).
// The store password is read from protected storage and handed to Gradle only as a child-process environment variable.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { ALIAS, PASS_ENV, certificateSummary, keystorePath, loadStorePassword } from './release-signing.mjs';
import { inspectElf } from './verify-node.mjs';
import { parseBadging, parseSignerOutput } from './apk-report.mjs';
import { runTool } from './windows-exec.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const yauzl = createRequire(join(root, 'package.json'))('yauzl');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const verifyOnly = process.argv.includes('--verify-only');
const outDir = resolve(process.argv.slice(2).find(a => !a.startsWith('--')) ?? join(root, 'tmp', `production-${version}`));
const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
for (const name of ['JAVA_HOME', 'ANDROID_HOME', 'RISUBARD_GRADLE']) if (!process.env[name]) throw new Error(name + ' is required');
const buildTools = (() => {
    const dir = join(process.env.ANDROID_HOME, 'build-tools');
    const versions = readdirSync(dir).filter(v => /^\d+\.\d+\.\d+$/.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!versions.length) throw new Error('No build-tools under ' + dir);
    return join(dir, versions.at(-1));
})();
const exe = name => process.platform === 'win32' ? name + '.exe' : name;
const tool = (file, args, extraEnv = {}) => {
    const r = runTool(file, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: { ...process.env, ...extraEnv } });
    return { ok: r.status === 0, out: (r.stdout ?? '') + (r.stderr ?? '') };
};
const readEntries = async (zipPath, onEntry) => {
    const zip = await yauzl.openPromise(zipPath, { lazyEntries: true });
    try { for await (const entry of zip.eachEntry()) { const chunks = []; for await (const c of await zip.openReadStreamPromise(entry)) chunks.push(c); await onEntry(entry, Buffer.concat(chunks)); } }
    finally { zip.close(); }
};

mkdirSync(outDir, { recursive: true });
const password = await loadStorePassword();
const env = { RISUBARD_RELEASE_KEYSTORE: keystorePath(), RISUBARD_RELEASE_KEY_ALIAS: ALIAS, [PASS_ENV]: password };
const apk = join(outDir, `RisuBard-${version}.apk`);
if (!verifyOnly) {
    const gradle = runTool(process.env.RISUBARD_GRADLE, ['assembleRelease', '--console=plain'], {
        cwd: join(root, 'android-app'), stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', env: { ...process.env, ...env },
    });
    writeFileSync(join(outDir, `RisuBard-${version}-gradle.log`), (gradle.stdout ?? '') + (gradle.stderr ?? ''));
    if (gradle.status !== 0) throw new Error('gradle assembleRelease failed (see gradle log)');
    const built = join(root, 'android-app/app/build/outputs/apk/release/app-release.apk');
    if (!existsSync(built)) throw new Error('Signed APK not found: ' + built);
    copyFileSync(built, apk);
} else if (!existsSync(apk)) throw new Error('--verify-only: no APK at ' + apk);

// Verification — every check recorded, any failure fails the run.
const report = { version, apk: `RisuBard-${version}.apk`, sha256: sha256(readFileSync(apk)), checks: {} };
const scratch = mkdtempSync(join(tmpdir(), 'risubard-apk-'));
try {
    // aapt cannot open a non-ASCII workspace path ("Illegal byte sequence"); it reads an identical copy in the ASCII temp dir.
    const asciiApk = join(scratch, 'app.apk'); copyFileSync(apk, asciiApk);
    report.checks.asciiCopy = { sha256Equal: sha256(readFileSync(asciiApk)) === report.sha256 };
    if (!report.checks.asciiCopy.sha256Equal) throw new Error('Temporary APK copy differs from the output APK');
    // Identity from the APK's own manifest, not from assumptions.
    const badging = tool(join(buildTools, exe('aapt')), ['dump', 'badging', asciiApk]);
    writeFileSync(join(outDir, `RisuBard-${version}-badging.log`), badging.out);
    report.identity = parseBadging(badging.out);
    report.checks.identity = { ok: badging.ok && report.identity.applicationId === 'app.risubard.personal' && report.identity.versionName === version && report.identity.versionCode > 1 && !report.identity.debuggable };
    const certs = tool(join(buildTools, 'apksigner.bat'), ['verify', '--print-certs', '-v', apk]);
    writeFileSync(join(outDir, `RisuBard-${version}-sign.log`), certs.out);
    const expectedFingerprint = certificateSummary(password).match(/SHA256:\s*([0-9A-F:]+)/i)?.[1]?.replace(/:/g, '').toLowerCase();
    const signer = parseSignerOutput(certs.out);
    report.checks.signature = { ...signer, matchesReleaseKey: !!signer.certSha256 && signer.certSha256 === expectedFingerprint, ok: certs.ok };
    const align = tool(join(buildTools, exe('zipalign')), ['-c', '-P', '16', '-v', '4', apk]);
    writeFileSync(join(outDir, `RisuBard-${version}-align.log`), align.out);
    report.checks.zipalign16k = { ok: align.ok && /Verification succes?sful/i.test(align.out) };
    // Native libraries and the packaged runtime, read back from the APK itself.
    const expectedNode = JSON.parse(readFileSync(join(root, 'android-app/app/src/main/assets/runtime-binaries.json'), 'utf8'));
    const natives = {}, assets = {};
    await readEntries(apk, async (entry, bytes) => {
        const m = entry.fileName.match(/^lib\/([^/]+)\/libnode\.so$/);
        if (m) { const elf = inspectElf(bytes); natives[m[1]] = { sha256: sha256(bytes), machine: elf.machine, matchesRuntimeLock: sha256(bytes) === expectedNode[m[1]]?.sha256, pageAligned16k: true }; }
        if (entry.fileName.startsWith('assets/runtime')) assets[entry.fileName] = bytes;
    });
    report.checks.natives = natives;
    report.checks.nativesOk = Object.keys(natives).sort().join() === Object.keys(expectedNode).sort().join() && Object.values(natives).every(n => n.matchesRuntimeLock);
    const runtimeZip = assets['assets/runtime.zip'], runtimeHash = assets['assets/runtime.sha256']?.toString('utf8').trim();
    const zipFile = join(scratch, 'runtime.zip'); writeFileSync(zipFile, runtimeZip);
    const sources = { compared: 0, mismatched: [], missing: [], skipped: 0 };
    let entries = 0, crcFailures = 0;
    await readEntries(zipFile, async (entry, bytes) => {
        entries++;
        if (crc32(bytes) !== entry.crc32) crcFailures++;
        if (entry.fileName.endsWith('/')) return;
        // Entries mirror the staging layout; node_modules, notices and the probe came from installed packages / fixed files.
        if (entry.fileName.startsWith('node_modules/') || entry.fileName.startsWith('android-app/')) { sources.skipped++; return; }
        const local = join(root, entry.fileName);
        if (!existsSync(local)) { sources.missing.push(entry.fileName); return; }
        sources.compared++;
        if (sha256(readFileSync(local)) !== sha256(bytes)) sources.mismatched.push(entry.fileName);
    });
    report.checks.runtime = { entries, crcFailures, hashMatchesAsset: !!runtimeZip && sha256(runtimeZip) === runtimeHash, sources,
        ok: entries > 0 && crcFailures === 0 && !!runtimeZip && sha256(runtimeZip) === runtimeHash && sources.compared > 0 && sources.mismatched.length === 0 && sources.missing.length === 0 };
} finally { rmSync(scratch, { recursive: true, force: true }); }
report.ok = report.checks.identity.ok && report.checks.signature.ok && report.checks.signature.v2 && report.checks.signature.matchesReleaseKey && report.checks.zipalign16k.ok && report.checks.nativesOk && report.checks.runtime.ok;
writeFileSync(join(outDir, 'apk-verification.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.ok) throw new Error('APK verification failed');
