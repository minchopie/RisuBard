import { hashLocalJson, type Json, type Manifest } from './protocol.ts';

export type ImportMode = 'new' | 'duplicate' | 'update' | 'branch';
export interface Generation {
  setId: string; revision: string; parent: string | null; instanceId: string;
  /** Hash of normalized, locally persisted gameplay content at the last successful import. */
  appliedHash: string; manifest: Manifest; ids: Record<string, string>;
}
export interface Decision { mode: ImportMode; previous?: Generation }
export async function decideImport(manifest: Manifest, generations: Generation[], current: (g: Generation) => Promise<Json>): Promise<Decision> {
  const candidates = generations.filter(g => g.setId === manifest.setId);
  // Re-receiving an old revision must not overwrite locally edited gameplay.
  if (candidates.some(g => g.revision === manifest.revision)) return { mode: 'duplicate' };
  const heads = candidates.filter((g, index) => !candidates.slice(index + 1).some(next => next.instanceId === g.instanceId));
  const parent = heads.filter(g => manifest.ancestors.includes(g.revision)).sort((a, b) => manifest.ancestors.indexOf(a.revision) - manifest.ancestors.indexOf(b.revision));
  const incomingChats = new Set(manifest.items.filter(i => i.kind === 'chat').map(i => i.id));
  for (const previous of parent) {
    // A partial selection is not a deletion command; keep the old graph as a separate playable set.
    if (previous.manifest.items.some(i => i.kind === 'chat' && !incomingChats.has(i.id))) continue;
    if (await hashLocalJson(await current(previous)) === previous.appliedHash) return { mode: 'update', previous };
  }
  return { mode: candidates.length ? 'branch' : 'new' };
}

export type QueueState = 'received' | 'verified' | 'waiting' | 'applying' | 'applied' | 'failed' | 'cancelled';
export interface QueueEntry {
  id: string; fileHandle: string; state: QueueState; receivedAt: number;
  trustedDevice: string | null; error?: string; transaction?: string; result?: string;
}
export interface Journal {
  id: string; queueId: string; phase: 'prepared' | 'committed';
  /** Opaque durable snapshot handle; never a full DB embedded in a log. */
  restoreHandle: string; result?: string;
  entry?: QueueEntry;
}
export interface ImportStore {
  readQueue(): Promise<QueueEntry[]>;
  writeQueue(entries: QueueEntry[]): Promise<void>;
  readJournal(): Promise<Journal | null>;
  writeJournal(journal: Journal | null): Promise<void>;
}
export interface ImportHost {
  /** Includes response generation, startup, other import and account-storage state. */
  busy(): boolean;
  /** Verify and prepare all dependencies without modifying active DB/settings. */
  prepare(fileHandle: string): Promise<{ restoreHandle: string; duplicate: boolean }>;
  /** Atomically acquire the app import lock; throw ImportBusy if generation started meanwhile.
   * Apply in memory, await actual durable app save; include tx marker in that same save. */
  apply(fileHandle: string, transaction: string): Promise<string>;
  /** Read committed marker from durable application storage, not in-memory state. */
  committed(transaction: string): Promise<string | null>;
  /** Restore only transaction-owned records, preserving unrelated application data. */
  restore(restoreHandle: string): Promise<void>;
  /** Release prepared application staging only; preserve the incoming archive for retries. */
  discard?(fileHandle: string): Promise<void>;
  recoveryState?(pending: boolean): void;
}
export class ImportBusy extends Error {}
/** One foreground consumer. Store operations must be atomic and durable. No queue expiry. */
export class ImportQueue {
  private running = false;
  private serial: Promise<void> = Promise.resolve();
  private store: ImportStore;
  private host: ImportHost;
  constructor(store: ImportStore, host: ImportHost) { this.store = store; this.host = host; }
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.serial.then(fn);
    this.serial = next.then(() => undefined, () => undefined);
    return next;
  }
  enqueue(entry: QueueEntry): Promise<void> {
    return this.exclusive(async () => {
      const queue = await this.store.readQueue();
      if (queue.some(e => e.id === entry.id)) return;
      if (entry.state !== 'received') throw new Error('Invalid incoming state');
      queue.push(entry); await this.store.writeQueue(queue);
    });
  }
  private update(id: string, patch: Partial<QueueEntry>): Promise<void> {
    return this.exclusive(async () => {
      const queue = await this.store.readQueue();
      const entry = queue.find(e => e.id === id);
      if (!entry) throw new Error('Queue entry not found');
      if (entry.state === 'cancelled') return;
      Object.assign(entry, patch); await this.store.writeQueue(queue);
    });
  }
  cancel(id: string): Promise<void> {
    return this.exclusive(async () => {
      const queue = await this.store.readQueue();
      const entry = queue.find(e => e.id === id);
      if (!entry || (await this.store.readJournal())?.queueId === id || entry.state === 'applying' || entry.state === 'applied') throw new Error('Cannot cancel this item');
      entry.state = 'cancelled'; await this.store.writeQueue(queue);
      await this.host.discard?.(entry.fileHandle);
    });
  }
  async recover(): Promise<boolean> {
    const journal = await this.store.readJournal();
    if (!journal) { this.host.recoveryState?.(false); return true; }
    this.host.recoveryState?.(true);
    if (!(await this.store.readQueue()).some(e => e.id === journal.queueId)) {
      if (!journal.entry || journal.entry.id !== journal.queueId) throw new Error('Recovery queue entry is missing; journal retained');
      await this.enqueue({ ...journal.entry, state: 'received' });
    }
    const result = await this.host.committed(journal.id);
    if (result !== null) {
      await this.update(journal.queueId, { state: 'applied', result });
    } else {
      try { await this.host.restore(journal.restoreHandle); }
      catch (error) {
        if (!(error instanceof ImportBusy)) throw error;
        await this.update(journal.queueId, { state: 'waiting' });
        return false; // Retain journal and retry automatically once generation releases the app.
      }
      await this.update(journal.queueId, { state: 'waiting', transaction: undefined });
    }
    await this.store.writeJournal(null);
    this.host.recoveryState?.(false);
    return true;
  }
  async drain(): Promise<void> {
    if (this.running || this.host.busy()) return;
    this.running = true;
    try {
      if (!await this.recover()) return;
      for (const candidate of await this.store.readQueue()) {
        if (!['received', 'verified', 'waiting'].includes(candidate.state)) continue;
        if (this.host.busy()) return;
        try {
          const prepared = await this.host.prepare(candidate.fileHandle);
          await this.update(candidate.id, { state: 'verified' });
          if (this.host.busy()) { await this.update(candidate.id, { state: 'waiting' }); return; }
          const transaction = crypto.randomUUID();
          // Claim only if cancellation did not race validation.
          const claimed = await this.exclusive(async () => {
            const queue = await this.store.readQueue();
            const entry = queue.find(e => e.id === candidate.id)!;
            if (entry.state === 'cancelled') return false;
            entry.state = 'applying'; entry.transaction = transaction;
            await this.store.writeJournal({ id: transaction, queueId: entry.id, phase: 'prepared', restoreHandle: prepared.restoreHandle, entry: { ...entry } });
            await this.store.writeQueue(queue); return true;
          });
          if (!claimed) { await this.host.discard?.(candidate.fileHandle); continue; }
          const result = await this.host.apply(candidate.fileHandle, transaction);
          if (await this.host.committed(transaction) !== result) throw new Error('Application save not confirmed');
          await this.store.writeJournal({ id: transaction, queueId: candidate.id, phase: 'committed', restoreHandle: prepared.restoreHandle, result, entry: candidate });
          await this.update(candidate.id, { state: 'applied', result, error: undefined });
          await this.store.writeJournal(null);
        } catch (error) {
          if (error instanceof ImportBusy) {
            // Admission lost to generation before mutation. Keep the journal/staging until a safe poll,
            // rather than trying rollback while the generation still owns the application.
            this.host.recoveryState?.(true);
            await this.update(candidate.id, { state: 'waiting' });
            return;
          }
          // If save succeeded just before interruption, recovery acknowledges it instead of reapplying.
          if (!await this.recover()) return;
          const entry = (await this.store.readQueue()).find(e => e.id === candidate.id)!;
          if (entry.state !== 'applied' && entry.state !== 'cancelled') await this.update(candidate.id, { state: 'failed', error: String(error) });
          await this.host.discard?.(candidate.fileHandle);
        }
      }
    } finally { this.running = false; }
  }
  async retry(id: string): Promise<void> {
    await this.exclusive(async () => {
      const queue = await this.store.readQueue();
      const entry = queue.find(e => e.id === id);
      if (!entry || entry.state !== 'failed') throw new Error('Not a failed item');
      entry.state = 'waiting'; delete entry.error; await this.store.writeQueue(queue);
    });
  }
}
