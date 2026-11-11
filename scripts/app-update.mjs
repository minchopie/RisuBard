import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
const require = createRequire(import.meta.url);
const core = require('../server/node/app-update/core.cjs');
const { ZipFile } = require('yazl');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command, destination, dataRoot] = process.argv.slice(2);

function files(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(item => {
        const name = path.join(directory, item.name);
        if (item.isSymbolicLink()) throw new Error('Linked release input');
        return item.isDirectory() ? files(name) : [name];
    });
}
function runtimeFingerprint() {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const hash = createHash('sha256').update(JSON.stringify({ dependencies: pkg.dependencies, engines: pkg.engines }));
    const workflow = fs.readFileSync(path.join(root, '.github/workflows/release.yml'), 'utf8');
    hash.update(JSON.stringify([...workflow.matchAll(/NODE_VERSION="([^"]+)"/g)].map(match => match[1])));
    const fixed = ['pnpm-lock.yaml', 'scripts/android/runtime-lock.json', 'scripts/android/package-runtime.mjs', 'server/node/data-root-lock.cjs', 'server/node/data-root.cjs',
        'android-app/app/build.gradle.kts', 'android-app/app/src/main/AndroidManifest.xml'];
    const inputs = [...fixed.map(file => path.join(root, file)), ...files(path.join(root, 'server/node/app-update')).filter(file => !file.endsWith('runtime.json')),
        ...files(path.join(root, 'android-app/app/src/main/java'))];
    for (const file of inputs.sort()) hash.update(path.relative(root, file).replaceAll('\\', '/')).update(fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n'));
    return { schema: 1, fingerprint: hash.digest('hex') };
}
async function pack(out) {
    fs.mkdirSync(out, { recursive: true });
    const runtime = runtimeFingerprint();
    fs.writeFileSync(path.join(root, 'server/node/app-update/runtime.json'), JSON.stringify(runtime, null, 2) + '\n');
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const server = fs.readFileSync(path.join(root, 'server/node/server.cjs'), 'utf8');
    for (const hook of ["require('./app-update/bootstrap.cjs').start(__filename)", "require('./app-update/bootstrap.cjs').ownsDataRoot(processDataRoot)", "require('./app-update/bootstrap.cjs').ready()"])
        if (!server.includes(hook)) throw new Error('Missing startup update hook: ' + hook);
    const temporary = path.join(out, 'code.zip');
    if (fs.existsSync(temporary)) throw new Error('Build output exists');
    const zip = new ZipFile();
    zip.on('error', error => zip.outputStream.destroy(error));
    const done = pipeline(zip.outputStream, fs.createWriteStream(temporary, { flags: 'wx' }));
    done.catch(() => {});
    const included = ['package.json', ...core.CODE_ROOTS.flatMap(dir => files(path.join(root, dir)).map(file => path.relative(root, file).replaceAll('\\', '/')))];
    for (const name of included) {
        if (/\.(test|node-test|bench\.test)\.|\.map$/.test(name) || name.startsWith('server/node/app-update/') || name.startsWith('server/node/ssl/')
            || ['server/node/data-root-lock.cjs', 'server/node/data-root.cjs'].includes(name)) continue;
        core.codePath(name); zip.addFile(path.join(root, name), name, { compressionLevel: 6 });
    }
    zip.end(); await done;
    const sha256 = await core.hashFile(temporary);
    const release = { schema: 1, version: pkg.version, runtime: runtime.fingerprint, sha256, bytes: fs.statSync(temporary).size,
        file: `RisuBard-code-${pkg.version}-${sha256}.zip` };
    core.validateRelease(release);
    const target = path.join(out, release.file);
    if (fs.existsSync(target)) throw new Error('Immutable release already exists');
    fs.renameSync(temporary, target);
    fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(release, null, 2) + '\n');
    console.log(JSON.stringify(release));
}
if (command === 'fingerprint') {
    const result = runtimeFingerprint();
    fs.writeFileSync(path.join(root, 'server/node/app-update/runtime.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(result.fingerprint);
} else if (command === 'pack' && destination) await pack(path.resolve(destination));
else if (command === 'publish' && destination && dataRoot) {
    const folder = path.resolve(destination), release = core.validateRelease(JSON.parse(fs.readFileSync(path.join(folder, 'latest.json'), 'utf8')));
    const remote = await require('../server/node/app-update/remote.cjs').connect(path.resolve(dataRoot));
    if (!remote) throw new Error('No saved NAS connection');
    await remote.publish(release, path.join(folder, release.file));
    console.log(`NAS app code ${release.version}: uploaded and downloaded hash verified`);
} else throw new Error('Usage: node scripts/app-update.mjs fingerprint | pack <output> | publish <output> <existing-data-root>');
