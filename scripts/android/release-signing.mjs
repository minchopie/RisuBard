// Production signing key for app.risubard.personal — created once, kept outside the repository.
//
//   node scripts/android/release-signing.mjs create     (JAVA_HOME required; refuses to overwrite)
//   node scripts/android/release-signing.mjs show       (prints the non-secret certificate fingerprint)
//
// Layout (default %LOCALAPPDATA%\RisuBard\release-signing, override RISUBARD_RELEASE_SIGNING_DIR):
//   risubard-release.jks   PKCS12 keystore, RSA 4096, alias risubard-release
//   store-pass.dpapi       the random store/key password, Windows DPAPI (current user) protected
//   fingerprint.txt        alias + certificate SHA-256 (not secret)
// The password never appears on a command line, in a log or in source: keytool reads it from the
// environment (-storepass:env) and Gradle receives it only as a child-process environment variable.
// Losing the keystore or the password means app.risubard.personal cannot be updated in place: keep an
// offline copy of both outside this PC's DPAPI (which no other machine/account can decrypt).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { dpapi } = createRequire(join(root, 'package.json'))('./server/node/transfer-secrets.cjs');
export const ALIAS = 'risubard-release';
export const PASS_ENV = 'RISUBARD_RELEASE_STORE_PASS';
export const signingDir = () => process.env.RISUBARD_RELEASE_SIGNING_DIR
    || (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'RisuBard', 'release-signing') : null);
export const keystorePath = () => join(signingDir(), 'risubard-release.jks');
const passFile = () => join(signingDir(), 'store-pass.dpapi');
const keytool = () => {
    if (!process.env.JAVA_HOME) throw new Error('JAVA_HOME (JDK 17) is required');
    return join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'keytool.exe' : 'keytool');
};
const run = (args, env, capture = false) => {
    // English labels so the summary parses on a localized Windows; the password still travels only via the environment.
    const r = spawnSync(keytool(), ['-J-Duser.language=en', ...args], { env, stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' });
    if (r.status !== 0) throw new Error('keytool failed: ' + args[0]);
    return r.stdout;
};

/** Store password from protected storage; returned only to be placed in a child environment. */
export async function loadStorePassword() {
    if (!existsSync(passFile())) throw new Error('No protected release password at ' + passFile() + ' (run: release-signing.mjs create)');
    return (await dpapi(readFileSync(passFile()), true)).toString('utf8');
}
/** Certificate fingerprint lines from keytool (no secrets). */
export function certificateSummary(password) {
    const out = run(['-list', '-v', '-keystore', keystorePath(), '-alias', ALIAS, `-storepass:env`, PASS_ENV], { ...process.env, [PASS_ENV]: password }, true);
    const pick = label => out.split(/\r?\n/).find(l => l.trim().startsWith(label))?.trim() ?? `${label} (not found)`;
    return [`alias: ${ALIAS}`, pick('Owner:'), pick('Valid from:'), pick('SHA256:')].join('\n');
}

async function create() {
    const dir = signingDir(), store = keystorePath();
    if (!dir) throw new Error('RISUBARD_RELEASE_SIGNING_DIR or LOCALAPPDATA is required');
    if (existsSync(store) || existsSync(passFile())) throw new Error('Release signing material already exists in ' + dir + '; never overwritten');
    mkdirSync(dir, { recursive: true });
    const password = randomBytes(32).toString('base64url');
    const protectedPass = await dpapi(Buffer.from(password, 'utf8'), false);
    if ((await dpapi(protectedPass, true)).toString('utf8') !== password) throw new Error('DPAPI round-trip failed');
    writeFileSync(passFile(), protectedPass, { flag: 'wx' });
    run(['-genkeypair', '-keystore', store, '-storetype', 'PKCS12', '-alias', ALIAS, '-keyalg', 'RSA', '-keysize', '4096',
        '-validity', '10950', '-dname', 'CN=RisuBard Release, O=RisuBard', `-storepass:env`, PASS_ENV, `-keypass:env`, PASS_ENV],
        { ...process.env, [PASS_ENV]: password });
    const summary = certificateSummary(password) + `\ncreated: ${new Date().toISOString()}\nkeystore: ${store}\n`;
    writeFileSync(join(dir, 'fingerprint.txt'), summary);
    console.log(summary);
    console.log('Back up the keystore AND the password (password manager / offline) — the DPAPI copy only opens on this Windows account.');
}

const command = process.argv[2];
if (command === 'create') await create();
else if (command === 'show') console.log(certificateSummary(await loadStorePassword()));
else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) { console.error('usage: release-signing.mjs create|show'); process.exit(2); }
