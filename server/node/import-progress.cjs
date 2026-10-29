'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const context = new AsyncLocalStorage();
const tasks = new Map();
function task(id) {
    if (!tasks.has(id)) {
        for (const [key, value] of tasks) {
            if (tasks.size < 64) break;
            if (!value.listeners.size) tasks.delete(key);
        }
        tasks.set(id, { listeners: new Set(), latest: null, sentAt: 0, sentStage: '' });
    }
    return tasks.get(id);
}
function withImportProgress(id, work) { return context.run(id, work); }
function reportImportProgress(stage, completed, total, detail) {
    const id = context.getStore();
    if (!id) return;
    const state = task(id);
    const now = Date.now();
    const row = { type: 'progress', stage, updatedAt: now };
    if (Number.isFinite(completed)) row.completed = completed;
    if (Number.isFinite(total) && total > 0) row.total = total;
    if (detail) row.detail = String(detail).split(/[\\/]/).pop().slice(0, 180);
    state.latest = row;
    if (state.sentStage === stage && now - state.sentAt < 150 && completed !== total) return;
    state.sentStage = stage;
    state.sentAt = now;
    for (const listener of state.listeners) { try { listener(row); } catch {} }
}
function listen(id, listener) {
    const state = task(id);
    state.listeners.add(listener);
    if (state.latest) listener(state.latest);
    return () => state.listeners.delete(listener);
}
function stream(id, req, res) {
    if (task(id).listeners.size >= 4 || [...tasks.values()].filter(t => t.listeners.size).length >= 32) {
        res.statusCode = 429; res.end(); return;
    }
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = row => {
        if (res.destroyed || res.writableLength > 65536) return;
        res.write(JSON.stringify(row) + '\n');
        // Disk transactions are synchronous. Do not leave progress corked until
        // the transaction returns to the event loop, possibly minutes later.
        // Node 24.22+ auto-corks the response itself, not only its socket.
        while (res.writableCorked > 0) res.uncork();
        res.socket?.uncork();
    };
    send({ type: 'heartbeat' });
    const stop = listen(id, send);
    const timer = setInterval(() => send({ type: 'heartbeat' }), 5000);
    timer.unref?.();
    res.once('close', () => { clearInterval(timer); stop(); });
}
module.exports = { withImportProgress, reportImportProgress, listen, stream };
