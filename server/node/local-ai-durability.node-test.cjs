const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const { createLocalAI } = require('./local-ai.cjs');

test('POSIX startup sync failure preserves unreferenced files without blocking settings', { skip: process.platform === 'win32' }, async t => {
    const root = await fs.mkdtemp(join(tmpdir(), 'risubard-startup-sync-'));
    const directory = join(root, 'local-ai');
    await fs.mkdir(directory);
    const selected = '00000000-0000-0000-0000-000000000001.gguf';
    const prior = '00000000-0000-0000-0000-000000000002.gguf';
    await fs.writeFile(join(directory, selected), 'selected');
    await fs.writeFile(join(directory, prior), 'prior');
    await fs.writeFile(join(directory, 'settings.json'), JSON.stringify({ enabled: true, context: 4096, output: 512,
        model: { file: selected, name: 'test.gguf', sha256: 'a'.repeat(64) } }));
    const realOpen = fs.open.bind(fs);
    t.mock.method(fs, 'open', async (file, ...args) => {
        const handle = await realOpen(file, ...args);
        if (file === directory) t.mock.method(handle, 'sync', async () => { throw new Error('injected startup sync failure'); });
        return handle;
    });
    const service = createLocalAI({ dataRoot: root, executable: process.execPath });
    t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
    assert.match((await service.status()).error, /이전 모델 파일을 보존/);
    assert.deepEqual((await fs.readdir(directory)).filter(n => n.endsWith('.gguf')), [selected, prior]);
    t.mock.restoreAll();
    assert.equal((await service.settings({ enabled: false, context: 4096, output: 512 })).enabled, false);
});

for (const retainedSettings of ['previous', 'current']) {
    test(`POSIX post-rename sync failure preserves both models for ${retainedSettings} durable settings`, { skip: process.platform === 'win32' }, async t => {
        const root = await fs.mkdtemp(join(tmpdir(), 'risubard-model-sync-'));
        const directory = join(root, 'local-ai');
        const options = { dataRoot: root, executable: process.execPath,
            spawnProcess: (_file, _args, opts) => spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], opts),
            fetchImpl: async () => Response.json({ default_generation_settings: { n_ctx: 4096 } }),
        };
        const services = [];
        t.after(async () => { for (const service of services) await service.close(); await fs.rm(root, { recursive: true, force: true }); });
        const service = createLocalAI(options); services.push(service);
        const model = Buffer.alloc(1024); model.write('GGUF'); model.writeUInt32LE(3, 4);
        const upload = () => service.importModel(Readable.from([model]), { bytes: model.length, name: 'test.gguf' });
        await upload();
        const before = await fs.readFile(join(directory, 'settings.json'), 'utf8');
        let directorySyncs = 0;
        const realOpen = fs.open.bind(fs);
        t.mock.method(fs, 'open', async (file, ...args) => {
            const handle = await realOpen(file, ...args);
            if (file === directory) {
                directorySyncs++;
                if (directorySyncs === 2) t.mock.method(handle, 'sync', async () => { throw new Error('injected directory sync failure'); });
            }
            return handle;
        });
        const status = await upload();
        assert.equal(directorySyncs, 2);
        assert.match(status.error, /저장 확정/);
        const after = await fs.readFile(join(directory, 'settings.json'), 'utf8');
        assert.notEqual(JSON.parse(before).model.file, JSON.parse(after).model.file);
        assert.equal((await fs.readdir(directory)).filter(n => n.endsWith('.gguf')).length, 2);
        await service.close();
        t.mock.restoreAll();
        const chosen = retainedSettings === 'previous' ? before : after;
        await fs.writeFile(join(directory, 'settings.json'), chosen);
        const restarted = createLocalAI(options); services.push(restarted);
        assert.equal((await restarted.status()).model.sha256, JSON.parse(chosen).model.sha256);
        assert.deepEqual((await fs.readdir(directory)).filter(n => n.endsWith('.gguf')), [JSON.parse(chosen).model.file]);
        assert.deepEqual(await fs.readFile(join(directory, JSON.parse(chosen).model.file)), model);
    });
}
