import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve, join, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractNodeBinary, hashFile } from './verify-node.mjs';
import { writeRuntimeArchive, verifyRuntimeArchive } from './runtime-archive.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const stage = await fs.mkdtemp(join(root, 'tmp/android-runtime-'));
const assets = join(root, 'android-app/app/src/main/assets');
const require = createRequire(join(root, 'package.json'));
const prototype = process.argv.includes('--allow-4k-prototype');
const roots = ['express', 'compression', 'node-html-parser', 'express-rate-limit', 'ws', 'wasm-vips',
    'fast-json-patch', 'msgpackr', 'fflate', 'sucrase', 'compression-streams-polyfill', '@aws-crypto/sha256-js', '@dqbd/tiktoken', 'wasmoon', 'yauzl', 'yazl'];
const installed = new Map();
const included = file => !/\.(test|node-test|bench\.test)\.|\.map$/.test(file)
    && !file.split(/[\\/]/).includes('node_modules');

async function copyPackage(name, from = require, parent = stage) {
    let pkgFile;
    try { pkgFile = from.resolve(name + '/package.json'); }
    catch {
        let dir = dirname(from.resolve(name));
        while (true) {
            const candidate = join(dir, 'package.json');
            try { if (JSON.parse(await fs.readFile(candidate, 'utf8')).name === name) { pkgFile = candidate; break; } } catch {}
            if (dirname(dir) === dir) throw new Error('Cannot resolve package: ' + name);
            dir = dirname(dir);
        }
    }
    const pkg = JSON.parse(await fs.readFile(pkgFile, 'utf8'));
    const top = installed.get(name);
    if (top?.version === pkg.version) return;
    const destination = join(top ? parent : stage, 'node_modules', name);
    if (destination === top?.path) throw new Error('Dependency collision: ' + name);
    if (!top) installed.set(name, { version: pkg.version, path: destination });
    await fs.mkdir(dirname(destination), { recursive: true });
    await fs.cp(dirname(pkgFile), destination, { recursive: true, dereference: true,
        filter: file => included(relative(dirname(pkgFile), file)) });
    const local = createRequire(pkgFile);
    for (const child of Object.keys(pkg.dependencies || {})) await copyPackage(child, local, destination);
}

try {
    await fs.mkdir(assets, { recursive: true });
    for (const name of roots) await copyPackage(name);
    // src/ts/preset/adapter/*: runtime closure of resolveEndpointUrl used by server/node/nas-sync-vault.cjs (type-only imports erased).
    for (const part of ['dist', 'server/node', 'shared/play-set', 'src/ts/risubard', 'src/ts/preset/adapter/buildRequest.ts', 'src/ts/preset/adapter/auth.ts', 'src/ts/preset/adapter/error.ts', 'src/ts/preset/adapter/vertexEndpoint.ts', 'packages/risubard-core', 'package.json', 'LICENSE', 'NOTICE.md', 'android-app/notices', 'scripts/android/runtime-probe.cjs']) {
        await fs.mkdir(dirname(join(stage, part)), { recursive: true });
        await fs.cp(join(root, part), join(stage, part), { recursive: true, filter: included });
    }
    const lock = JSON.parse(await fs.readFile(join(root, 'scripts/android/runtime-lock.json'), 'utf8'));
    const binaries = {};
    for (const [abi, item] of Object.entries(lock.architectures)) {
        const cache = join(root, 'tmp/android-node');
        const lib = join(root, 'android-app/app/src/main/jniLibs', abi);
        await fs.mkdir(lib, { recursive: true });
        binaries[abi] = await extractNodeBinary(join(cache, item.archiveArch + '.tar.xz'),
            `nodejs-v${lock.version}-android-${item.archiveArch}/bin/node`, join(lib, 'libnode.so'),
            item.sha256, abi === 'arm64-v8a' ? 183 : 62, prototype ? 4096 : 16384);
        console.log(abi, binaries[abi]);
    }

    const destination = join(assets, 'runtime.zip');
    await writeRuntimeArchive(stage, destination);
    await verifyRuntimeArchive(destination);
    await fs.writeFile(join(assets, 'runtime.sha256'), await hashFile(destination));
    await fs.writeFile(join(assets, 'runtime-binaries.json'), JSON.stringify(binaries, null, 2));
    await fs.writeFile(join(assets, 'runtime.properties'), `releaseCompatible=${!prototype}\n`);
    console.log('Runtime package:', basename(stage), (await fs.stat(destination)).size, 'bytes');
} catch (error) {
    console.error(`[workdir] kept (failed): ${stage}`);
    throw error;
}
try { await fs.rm(stage, { recursive: true, force: true }); }
catch (error) { console.error(`[workdir] kept (cleanup failed): ${stage}; ${error.message}`); }
