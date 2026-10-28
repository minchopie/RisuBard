'use strict';

const fs = require('node:fs/promises');
const { createWriteStream } = require('node:fs');
const { constants } = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const os = require('node:os');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { setTimeout: delay } = require('node:timers/promises');

const MODEL_FILE = /^[a-f0-9-]{36}\.gguf$/;
function failure(message, status = 400) { return Object.assign(new Error(message), { status }); }
function engineStopped() { return failure('모델 실행이 중단됐어요. 다시 시도하면 모델을 다시 불러와요.', 503); }
function socketFetch(url, { socketPath, signal, headers, method = 'GET', body } = {}) {
    if (!socketPath) return Promise.reject(engineStopped());
    return new Promise((resolve, reject) => {
        const request = http.request(url, { socketPath, signal, headers, method }, response => {
            try { resolve(new Response(Readable.toWeb(response), { status: response.statusCode, headers: response.headers })); }
            catch (error) { response.destroy(); reject(error); }
        });
        request.once('error', reject);
        request.end(body);
    });
}
function validateSettings(value) {
    if (!value || typeof value.enabled !== 'boolean' || !Number.isInteger(value.context) || value.context < 128 || value.context > 32768
        || !Number.isInteger(value.output) || value.output < 1 || value.output >= value.context) {
        throw failure('문맥은 128~32768, 최대 응답은 문맥보다 작은 양의 정수로 설정해 주세요.');
    }
    return { enabled: value.enabled, context: value.context, output: value.output };
}

function createLocalAI({ dataRoot, executable = process.env.RISUBARD_LOCAL_ENGINE, spawnProcess = spawn, fetchImpl = socketFetch }) {
    const directory = path.join(dataRoot, 'local-ai');
    let config = { enabled: true, context: 4096, output: 512, model: null };
    let child, starting, endpoint, key, initializationError, busy = false, requests = 0, closed = false, lastError = '';
    let preserveUnlinkedModels = false;
    const controllers = new Set();
    const initialized = (async () => {
        if (!executable) return;
        let settingsValid = true;
        try {
            const saved = JSON.parse(await fs.readFile(path.join(directory, 'settings.json'), 'utf8'));
            config = { ...validateSettings(saved), model: null };
            preserveUnlinkedModels = saved.preserveUnlinkedModels === true;
            if (saved.model && (!MODEL_FILE.test(saved.model.file) || typeof saved.model.name !== 'string'
                || !/^[a-f0-9]{64}$/.test(saved.model.sha256))) throw new Error('Invalid local model record');
            config = { ...validateSettings(saved), model: saved.model ?? null };
        } catch (error) {
            if (error.code !== 'ENOENT') { settingsValid = false; preserveUnlinkedModels = true; lastError = '기기 내 AI 설정을 읽지 못했어요. 모델을 다시 선택해 주세요.'; }
        }
        // A broken engine must not discard a previously saved explicit mode choice.
        try { await fs.access(executable, constants.X_OK); }
        catch { throw failure('기기 내 AI 실행 파일을 열지 못했어요. 앱 설치 파일을 확인해 주세요.', 503); }
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        let collectModels = settingsValid && !preserveUnlinkedModels;
        if (collectModels) {
            try { await syncDirectory(); }
            catch { collectModels = false; lastError = '저장 확정을 확인하지 못해 이전 모델 파일을 보존했어요.'; }
        }
        // Cleanup is optional; an undeletable leftover must not disable a usable model.
        for (const name of await fs.readdir(directory)) {
            if (/^[a-f0-9-]{36}\.part$/.test(name)
                || (collectModels && MODEL_FILE.test(name) && name !== config.model?.file)) {
                try { await fs.rm(path.join(directory, name), { force: true }); }
                catch { lastError ||= '일부 임시 모델 파일을 정리하지 못했어요. 저장 공간을 확인해 주세요.'; }
            }
        }
    })().catch(error => { initializationError = error; lastError = error.message; });

    async function syncDirectory() {
        if (process.platform === 'win32') return;
        const handle = await fs.open(directory, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
    }
    async function persist(next, preserve = preserveUnlinkedModels) {
        const temporary = path.join(directory, 'settings.json.tmp');
        const handle = await fs.open(temporary, 'w', 0o600);
        try { await handle.writeFile(JSON.stringify({ ...next, preserveUnlinkedModels: preserve })); await handle.sync(); } finally { await handle.close(); }
        await fs.rename(temporary, path.join(directory, 'settings.json'));
        config = next;
        preserveUnlinkedModels = preserve;
        try { await syncDirectory(); return true; }
        catch {
            lastError = '설정은 반영됐지만 저장 확정을 확인하지 못했어요. 저장 공간을 확인하고 다시 적용한 뒤 앱을 다시 열어 주세요.';
            return false;
        }
    }
    async function status() {
        await initialized;
        return { available: Boolean(executable), ...config, model: config.model && {
            name: config.model.name, bytes: config.model.bytes, sha256: config.model.sha256,
        }, running: Boolean(endpoint), busy: busy || requests > 0, error: lastError };
    }
    async function stop() {
        const current = child;
        endpoint = undefined;
        if (!current || current.exitCode !== null || current.signalCode !== null) return;
        const exited = new Promise(resolve => current.once('close', resolve));
        current.kill('SIGTERM');
        const timer = setTimeout(() => current.kill('SIGKILL'), 3000);
        try { await exited; } finally { clearTimeout(timer); if (child === current) child = undefined; }
    }
    async function start(model = config.model, settings = config, signal) {
        if (!model) throw failure('먼저 AI 설정에서 GGUF 모델 파일을 선택해 주세요.', 409);
        // Android apps share loopback ports; the private directory excludes other apps.
        const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\risubard-${randomUUID()}` : path.join(directory, 'engine.sock');
        if (process.platform !== 'win32') await fs.rm(socketPath, { force: true });
        key = randomBytes(32).toString('hex');
        const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('LLAMA_')));
        env.LLAMA_API_KEY = key;
        env.RISUBARD_PARENT_PID = String(process.pid);
        const current = spawnProcess(executable, [
            '-m', path.join(directory, model.file), '--host', socketPath,
            '--alias', 'risubard-local', '--ctx-size', String(settings.context), '--parallel', '1',
            '--threads', String(Math.min(4, os.availableParallelism())), '--batch-size', '256', '--ubatch-size', '128',
            '--no-webui', '--no-slots', '--no-context-shift', '--sleep-idle-seconds', '120',
        ], { env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
        child = current;
        let spawnError;
        current.on('error', error => { spawnError = error; });
        current.stderr.resume(); // Native diagnostics may contain prompts; do not log them.
        current.once('close', () => { if (child === current) { child = undefined; endpoint = undefined; } });
        try {
            const deadline = Date.now() + 180000;
            while (Date.now() < deadline) {
                signal?.throwIfAborted();
                if (closed || spawnError || current.exitCode !== null || current.signalCode !== null) {
                    throw failure('모델을 실행하지 못했어요. GGUF 호환성과 여유 메모리를 확인해 주세요.', 503);
                }
                try {
                    const response = await fetchImpl('http://localhost/props', {
                        socketPath,
                        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(1000),
                    });
                    if (response.ok) {
                        const props = await response.json();
                        const context = props.default_generation_settings?.n_ctx;
                        if (Number.isInteger(context) && context < settings.context) {
                            throw failure(`모델의 실제 문맥 한도는 ${context} 토큰이에요. 문맥과 최대 응답을 줄여 주세요.`, 422);
                        }
                        endpoint = socketPath; lastError = ''; return;
                    }
                    await response.body?.cancel();
                } catch (error) { if (error.status) throw error; }
                await delay(150);
            }
            throw failure('모델 준비 시간이 초과됐어요. 더 작은 GGUF 모델이나 문맥을 사용해 주세요.', 503);
        } catch (error) { await stop(); lastError = error.name === 'AbortError' ? '모델 준비를 취소했어요.' : error.message; throw error; }
    }
    async function ready() {
        if (endpoint) return;
        if (!starting) starting = start().finally(() => { starting = undefined; });
        await starting;
    }
    function idle(manualOnline = false) {
        if (initializationError && !manualOnline) throw initializationError;
        if (closed) throw failure('앱을 다시 열어 주세요.', 503);
        if (busy || requests || starting) throw failure('모델 준비나 응답 생성이 끝난 뒤 다시 시도해 주세요.', 409);
    }
    async function settings(value) {
        await initialized; idle(value?.enabled === false); busy = true;
        try {
            const next = { ...validateSettings(value), model: config.model };
            await stop(); lastError = '';
            if (initializationError) {
                config = next;
                lastError = '기기 내 AI 초기화 오류로 이번 실행에서만 온라인 설정을 사용해요. 저장하지 못했으므로 앱을 다시 열면 이전 모드로 돌아가요.';
            } else await persist(next);
            return await status();
        } finally { busy = false; }
    }
    async function importModel(stream, { bytes, name, signal }) {
        await initialized; idle();
        if (!Number.isSafeInteger(bytes) || bytes < 24 || typeof name !== 'string' || name.length > 240 || !name.toLowerCase().endsWith('.gguf')) {
            throw failure('단일 GGUF 모델 파일을 선택해 주세요.');
        }
        busy = true;
        const id = randomUUID(), temporary = path.join(directory, id + '.part'), destination = path.join(directory, id + '.gguf');
        let committed = false;
        try {
            const space = await fs.statfs(directory, { bigint: true });
            if (space.bavail * space.bsize < BigInt(bytes) + 64n * 1024n * 1024n) throw failure('모델을 복사할 저장 공간이 부족해요.', 507);
            let received = 0, header = Buffer.alloc(0);
            const hash = createHash('sha256');
            const verifier = new Transform({ transform(chunk, encoding, callback) {
                received += chunk.length;
                if (received > bytes) return callback(failure('모델 파일 크기가 달라졌어요.'));
                if (header.length < 8) header = Buffer.concat([header, chunk.subarray(0, 8 - header.length)]);
                hash.update(chunk); callback(null, chunk);
            } });
            await pipeline(stream, verifier, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }), { signal });
            if (received !== bytes || header.length !== 8 || header.toString('ascii', 0, 4) !== 'GGUF'
                || ![2, 3].includes(header.readUInt32LE(4))) throw failure('완전한 GGUF v2/v3 파일이 아니에요.');
            const handle = await fs.open(temporary, 'r+');
            try { await handle.sync(); } finally { await handle.close(); }
            signal?.throwIfAborted();
            await fs.rename(temporary, destination);
            await syncDirectory();
            const model = { file: id + '.gguf', name: path.basename(name), bytes, sha256: hash.digest('hex') };
            await stop();
            await start(model, config, signal);
            signal?.throwIfAborted();
            const previous = config.model;
            const durable = await persist({ ...config, model }, false); committed = true;
            // A post-rename sync failure must retain both files, including the newly referenced one.
            if (durable && previous) await fs.rm(path.join(directory, previous.file), { force: true }).catch(() => {});
            return await status();
        } finally {
            try {
                if (!committed) { await stop(); await fs.rm(destination, { force: true }); }
                await fs.rm(temporary, { force: true });
            } finally { busy = false; }
        }
    }
    async function relay(req, res, target) {
        await initialized;
        if (initializationError) throw initializationError;
        if (!config.enabled) throw failure('기기 내 AI 사용이 꺼져 있어요.', 409);
        if (busy || closed) throw failure('모델을 준비 중이에요. 잠시 뒤 다시 시도해 주세요.', 409);
        const abort = new AbortController();
        const cancel = () => { if (!res.writableEnded) abort.abort(); };
        res.once('close', cancel); controllers.add(abort); requests++;
        try {
            await ready(); abort.signal.throwIfAborted();
            const socket = endpoint, authenticationKey = key;
            let body = target === '/tokenize' ? { content: req.body?.content, add_special: false } : req.body;
            if (target === '/tokenize' && typeof body.content !== 'string') throw failure('토큰 계산할 문자열이 필요해요.');
            const nativeRequest = (route, payload) => {
                if (!socket || socket !== endpoint || authenticationKey !== key) throw engineStopped();
                return fetchImpl('http://localhost' + route, {
                    socketPath: socket,
                    method: 'POST', headers: { Authorization: `Bearer ${authenticationKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload), signal: abort.signal,
                });
            };
            const nativeJSON = async (response, message) => {
                const value = await response.json().catch(error => { if (error instanceof SyntaxError) return null; throw error; });
                abort.signal.throwIfAborted();
                if (response.status === 503) throw failure('모델을 준비 중이에요. 잠시 뒤 다시 시도해 주세요.', 503);
                if (!response.ok) throw failure(typeof value?.error?.message === 'string' ? value.error.message : message, response.status >= 500 ? 502 : 422);
                if (!value) throw failure(message, 502);
                return value;
            };
            if (target !== '/tokenize') {
                if (!body || typeof body !== 'object' || Array.isArray(body) || !Array.isArray(body.messages)) throw failure('대화 메시지가 필요해요.');
                const requested = body.max_tokens ?? body.max_completion_tokens ?? config.output;
                if (!Number.isSafeInteger(requested) || requested <= 0) throw failure('최대 응답은 양의 정수여야 해요.');
                body = { ...body, max_tokens: Math.min(requested, config.output) };
                delete body.n_predict; delete body.max_completion_tokens;
                // Measure the actual model template before reserving the remaining output budget.
                const templated = await nativeRequest('/apply-template', body);
                const template = await nativeJSON(templated, '모델의 대화 형식 응답을 읽지 못했어요.');
                if (typeof template.prompt !== 'string') throw failure('모델의 대화 형식 응답이 올바르지 않아요.', 502);
                const tokenized = await nativeRequest('/tokenize', { content: template.prompt, add_special: true });
                const tokens = await nativeJSON(tokenized, '대화의 실제 토큰 수를 확인하지 못했어요.');
                if (!Array.isArray(tokens.tokens)) throw failure('대화의 실제 토큰 수가 올바르지 않아요.', 502);
                const remaining = config.context - tokens.tokens.length - 1;
                if (remaining < 1) throw failure('모델 문맥을 넘었어요. 문맥을 늘리거나 보낼 대화·로어를 줄여 주세요.', 422);
                body.max_tokens = Math.min(body.max_tokens, remaining);
            }
            const response = await nativeRequest(target, body);
            res.status(response.status).set('Content-Type', response.headers.get('content-type') || 'application/json');
            res.set('Cache-Control', 'no-store');
            if (response.body) await pipeline(Readable.fromWeb(response.body), res, { signal: abort.signal });
            else res.end();
        } catch (error) {
            if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ENOENT', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code ?? error.cause?.code)) throw engineStopped();
            throw error;
        } finally { requests--; controllers.delete(abort); res.off('close', cancel); }
    }
    function registerRoutes(app, { auth, activeSession }) {
        const route = (handler, write = true) => async (req, res) => {
            try {
                if (!await auth(req, res)) return;
                if (write && !activeSession(req, res)) return;
                if (!executable && write) throw failure('이 빌드에는 기기 내 AI 엔진이 없어요.', 404);
                await handler(req, res);
            } catch (error) {
                if (res.headersSent || res.destroyed) { res.destroy(); return; }
                if (!req.complete) { res.set('Connection', 'close'); res.once('finish', () => req.destroy()); }
                res.status(error.code === 'ENOSPC' ? 507 : error.status || 500).json({ error: error.message });
            }
        };
        app.get('/api/local-ai', route(async (_req, res) => res.json(await status()), false));
        app.put('/api/local-ai', route(async (req, res) => res.json(await settings(req.body))));
        app.post('/api/local-ai/model', route(async (req, res) => {
            if (req.headers['content-type'] !== 'application/octet-stream') throw failure('GGUF 파일 형식이 필요해요.');
            const abort = new AbortController();
            const cancel = () => { if (!res.writableEnded) abort.abort(); };
            res.once('close', cancel); controllers.add(abort);
            try {
                const result = await importModel(req, { bytes: Number(req.headers['x-model-size']),
                    name: decodeURIComponent(req.headers['x-model-name'] || ''), signal: abort.signal });
                res.json(result);
            } finally { controllers.delete(abort); res.off('close', cancel); }
        }));
        app.post('/api/local-ai/chat/completions', route((req, res) => relay(req, res, '/v1/chat/completions')));
        app.post('/api/local-ai/tokenize', route((req, res) => relay(req, res, '/tokenize')));
    }
    async function close() { closed = true; for (const abort of controllers) abort.abort(); await stop(); }
    return { status, settings, importModel, relay, registerRoutes, close };
}
module.exports = { createLocalAI, validateSettings };
