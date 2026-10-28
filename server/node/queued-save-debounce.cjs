'use strict';

// The single writer may refuse a queued run before `persist` starts: the transfer/NAS write gate
// (queueStorageOperation → assertWrite) answers 423 `NAS_SYNC_BUSY` / `TRANSFER_BUSY` while an apply
// is armed or an exclusive sync step runs. That is a deferral, not a persist failure — the dirty cache
// is still in memory — so the save is rescheduled instead of being reported through `onError`.
// Only those gate codes are deferred, and only when `persist` never started; anything `persist` throws
// (a genuine I/O failure) still goes to `onError`.
const GATE_CODES = new Set(['NAS_SYNC_BUSY', 'TRANSFER_BUSY']);
const deferredByGate = error => error?.status === 423 && GATE_CODES.has(error?.code);

function createQueuedSaveDebounce({ timers, queue, delay, onError, onDeferred }) {
    function arm(key, persist, attempt) {
        if (timers[key]) clearTimeout(timers[key]);
        let started = false;
        const timer = setTimeout(() => {
            queue(async () => {
                // A flush, full write or newer timer may have superseded us while
                // waiting for the single writer. Capture the write scope only now.
                if (timers[key] !== timer) return;
                started = true;
                try {
                    await persist();
                } finally {
                    if (timers[key] === timer) delete timers[key];
                }
            }).catch(error => {
                if (started || !deferredByGate(error)) { onError(error); return; }
                // Refused before persist began. Retry only while this timer is still the pending save:
                // a flush, full write or newer timer that superseded it already covers the cache, and a
                // late gate error about it must neither persist again nor surface a warning.
                if (timers[key] !== timer) return;
                if (onDeferred) onDeferred(error, attempt + 1);
                arm(key, persist, attempt + 1);
            });
        }, delay);
        timers[key] = timer;
    }
    return function schedule(key, persist) { arm(key, persist, 0); };
}

module.exports = { createQueuedSaveDebounce };
