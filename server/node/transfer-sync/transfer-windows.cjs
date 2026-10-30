'use strict';
const net = require('node:net');
const fs = require('node:fs');
const { join, resolve } = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');

function createWindowsTransfers(dataRoot, applicationRoot, executable) {
    const helper = executable || join(applicationRoot, 'RisuAI-Chat-Transfer.exe');
    const instance = createHash('sha256').update(resolve(dataRoot)).digest('hex').toUpperCase().slice(0, 16);
    const pipe = '\\\\.\\pipe\\RisuBard.PlaySet.' + instance + '.' + require('node:os').userInfo().username.replaceAll('\\', '_');
    const available = () => process.platform === 'win32' && fs.existsSync(helper);
    let starting;
    function connect(timeout = 1000) {
        return new Promise((yes, no) => {
            const socket = net.connect(pipe);
            const timer = setTimeout(() => socket.destroy(new Error('전송기 연결 시간 초과')), timeout);
            socket.once('error', error => { clearTimeout(timer); no(error); });
            socket.once('connect', () => { clearTimeout(timer); yes(socket); });
        });
    }
    async function socket() {
        if (!available()) throw new Error('동봉된 Windows 전송기를 찾을 수 없어요.');
        try { return await connect(); } catch {}
        if (!starting) starting = (async () => {
            const app = join(applicationRoot, 'RisuBard.exe');
            const child = spawn(helper, ['--risubard-service', resolve(dataRoot), '--owner', String(process.pid), ...(fs.existsSync(app) ? [app] : [])], { windowsHide: true, stdio: 'ignore', detached: true });
            let failure; child.on('error', error => { failure = error; }); child.unref();
            for (let attempt = 0; attempt < 100; attempt++) {
                if (failure) throw new Error('Windows 전송기를 실행하지 못했어요.');
                try { const probe = await connect(100); probe.destroy(); return; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
            }
            throw new Error('Windows 전송기를 시작하지 못했어요.');
        })().finally(() => { starting = null; });
        await starting; return connect();
    }
    async function call(op, args = {}) {
        const bytes = Buffer.from(JSON.stringify({ op, args }));
        if (bytes.length > 12 * 1024 * 1024) throw new Error('Transfer command too large');
        const stream = await socket();
        return new Promise((yes, no) => {
            let buffered = Buffer.alloc(0), length = 0;
            stream.setTimeout(120000, () => stream.destroy(new Error('Windows 전송기 응답이 멈췄어요.')));
            stream.on('error', no); stream.on('end', () => no(new Error('Windows 전송기 연결이 종료됐어요.')));
            stream.on('data', chunk => {
                buffered = Buffer.concat([buffered, chunk]);
                try {
                    while (buffered.length >= (length || 4)) {
                        if (!length) { length = buffered.readInt32BE(0); buffered = buffered.subarray(4); if (length < 1 || length > 12 * 1024 * 1024) throw new Error('Invalid transfer response'); }
                        if (buffered.length < length) break;
                        const result = JSON.parse(buffered.subarray(0, length).toString('utf8')); buffered = buffered.subarray(length); length = 0;
                        if (result.pending) continue;
                        stream.destroy(); if (result.error) no(new Error(result.error)); else yes(result.value); return;
                    }
                } catch (error) { stream.destroy(); no(error); }
            });
            const prefix = Buffer.alloc(4); prefix.writeInt32BE(bytes.length); stream.write(prefix); stream.write(bytes);
        });
    }
    const allowed = new Set(['identity', 'capabilities', 'network.start', 'network.devices', 'network.registration', 'network.forget', 'network.pair', 'network.send', 'network.progress', 'network.status',
        'usb.start', 'usb.devices', 'usb.send', 'usb.receive', 'usb.progress', 'usb.status', 'inbox.list', 'inbox.accept', 'state.write', 'bard.export', 'file.share']);
    async function dispatch(op, args = {}) {
        if (!allowed.has(op) || op === 'state.write' && args.key !== 'queue') throw new Error('Unsupported native command');
        return call(op, args);
    }
    return { available, dispatch };
}
module.exports = { createWindowsTransfers };
