'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 24 * 60 * 60 * 1000;
// Personal fork: automatic deletion is off unless RISUBARD_TRASH_RETENTION_DAYS opts in, so trash that existed
// before this release is never removed by an upgrade alone.
const DEFAULT_RETENTION_DAYS = 0;
// Holds the pending recovery journal, which must outlive its age; the fork's interrupted-transaction and
// shutdown recovery copies are recovery data too and are never swept.
const KEEP = new Set(['live-files-recovery', 'transaction-recovery', 'shutdown-recovery']);

function retentionDays(env = process.env) {
    const raw = env.RISUBARD_TRASH_RETENTION_DAYS;
    if (raw === undefined || raw === '') return DEFAULT_RETENTION_DAYS;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_RETENTION_DAYS;
}

// A renamed folder keeps the mtime it had before it was moved here, so the
// newest of the timestamps stands in for when it entered the trash.
function entryAge(stat, now) {
    return now - Math.max(stat.mtimeMs, stat.ctimeMs, stat.birthtimeMs);
}

// Removes top-level entries of <dataRoot>/trash older than `days`. Returns the
// removed entry names; days <= 0 disables the cleanup.
async function cleanupTrash(dataRoot, { days = DEFAULT_RETENTION_DAYS, now = Date.now(), logger } = {}) {
    if (!(days > 0)) return [];
    const trashRoot = path.join(dataRoot, 'trash');
    let names;
    try { names = await fs.promises.readdir(trashRoot); } catch { return []; }
    const removed = [];
    for (const name of names) {
        if (KEEP.has(name)) continue;
        const target = path.join(trashRoot, name);
        try {
            const stat = await fs.promises.lstat(target);
            if (entryAge(stat, now) < days * DAY_MS) continue;
            await fs.promises.rm(target, { recursive: true, force: true });
            removed.push(name);
        } catch (error) {
            logger?.warn?.(`[Trash] Could not remove ${name}: ${error?.message ?? error}`);
        }
    }
    return removed;
}

module.exports = { cleanupTrash, retentionDays, DEFAULT_RETENTION_DAYS };
