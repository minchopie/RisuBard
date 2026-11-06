# Fable 5.1 — R9→R10 runtime data-preservation review (read-only, supplied material only)

No tools were run, nothing was touched. Everything below is derived from the supplied excerpts (server line positions as given), the complete files, and the logs. This is a scoped runtime review; it is not a release, integration, or device approval. Physical devices stay on HOLD.

## 0. Summary

- **No new confirmed regression** in the four focus areas. Every R9 item the response claims fixed is matched by the source and by a discriminating repro→fix log pair (§1).
- One **source-determined defect at the file-store primitive level** (deterministic through `file-store.cjs` alone, not executed by me): an orphaned prepared journal that is replayed after a *later* successful commit silently regresses the overlapping files to the older staged snapshot; the newer bytes survive only in `trash/transaction-recovery/`. Server reachability depends on the acknowledged direct-lane CFC variant and on any untracked `commitTransaction` caller (§2).
- The double-fault hold is correctly fail-closed in-process and now durably archival across restart; the **server-boot half of "shutdown/restart" is still not executed by any supplied test** (the new process in the test calls `recoverTransactions` directly, not `server.cjs`) (§3, §6).
- Server suite: green at `maxWorkers 4` (1165/0/3). The full-concurrency run has one load-sensitive failure (painter timeout); R9's run had a different one (logs EPERM). Client/typecheck/build/archive logs are referenced by the response but **not in this bundle** (§6).

## 1. R9 items — R10 status

| R9 | Status | Basis (source + evidence) |
|---|---|---|
| §3 `/api/patch` cold-cache load resets `fullChatStore` | **Fixed, proved** | `tmp/runtime9-cold-repro.log` shows exactly the predicted loss (`false / true` case: "Acknowledged without read" missing) plus the two `coldStart` 500/409 cases; `tmp/runtime9-cold-fixed.log` 61/61 and both full-suite logs pass all 7 cases. Source: `ensureChatStore` (l.648) now seeds `dbCache[DB_HEX_KEY]` from the same decoded object after `initChatStore`; `/api/patch` (l.4741) load block does `if (!fullChatStore) initChatStore(decoded)`. Both are necessary: the seed makes the patch skip the load block in the normal cycle; the guard protects the deletion paths (stub-flag-loss abort, `applyPatch` failure) where `dbCache` is absent but the store is live. |
| §2-A never-loaded external accept/keep | **Closed for the reachable path** | Any acknowledged write (`/api/write`, `/api/patch`, chat-content) now leaves `dbCache` populated, so `resolve` (l.3701) takes the review branch; `coldStart accept/keep` prove it. The `!dbCache` branch is unchanged and still reachable only after `delete dbCache[filePath]` (stub-flag-loss in `persistDbCacheWithChats` l.845, or patch-apply failure) with `liveFilesPendingWrites` still true → accept 500 "merge baseline unavailable", keep 409. That is a hold, not loss (shutdown recovery file still written). Not asserted by any test. |
| §4 blocked journal — in-process hold | **Unchanged by design**, now HTTP-tested | `full-write-failure-http` `publish-delayed / external`: GET `/api/external-changes` and `POST /api/db/flush?mode=canonical` 500 with the path in the body; target bytes intact. Correct: marker removed before these requests, so the 500 is from `assertTargetsUnobserved` under the retained `save` observer, not the ENOSPC hook. |
| §4 restart replaces hand edit, `.bak` only | **Fixed for recovery replays, proved** | `preserveRecoveryRevision` runs only when `options.recovering`; keyed by `(journal.id, sha256(path\0digest))`, writes `mapping.json`, copies with checksum verification, idempotent on retry. `file-store.test` "keeps an external revision durably…" (archive survives a later `.bak` rotation; second recovery adds nothing) and "leaves the target and journal intact if its recovery copy cannot be saved" (ENOSPC on the copy → target `external-b`, journal retained, retry publishes). `tmp/runtime9-recovery-repro.log` shows both failing pre-fix (no `transaction-recovery` dir; mock never fired). Normal commit path remains single-slot `.bak` — stated by the response, and the asymmetry is real: `a.json`'s pre-crash revision in the same test lives only in `.bak`. |
| §5.1 compat rebuild recovers unobserved | **Fixed, proved at unit level** | `attachCompatibilityCache.rebuild` → `recover()`; server registers `setRecoveryHandler(() => pendingCanonicalRecovery ? recoverFailedCanonicalTransaction() : repository.recoverPendingTransactions())`. Unit case throws CFC through `kvListWithSizes()`, target intact, journal retained; pre-fix log: `setRecoveryHandler is not a function`. The response's note that the first fixture (new preset file) did not exercise the guard is consistent with `unchanged()` returning true when `before.files[file]` is undefined — newly created paths are not guarded (see §4.4). Server wiring is source-verified only; no HTTP case drives an unqueued route into the handler. |
| §5.2 shutdown export fallback may throw | **Unchanged, narrower** | With `ensureChatStore` seeding `dbCache`, the fallback `stripChatsFromDb(exportLegacyDatabase())` (l.7648) is reached only via the deletion paths above. Still no chats-only fallback. |
| §5.3 `publish-delayed` nondiscriminating | **Fixed** | `expect(.journal json).toHaveLength(1)` immediately after the 500 — would fail if the `recoverTransactions` hook were inert (in-catch recovery would finish the journal, as the plain `publish` cases do). |
| §5.5 Windows rename EPERM | Did not recur in either R10 run; `logs.test` passes in both. Primitive unchanged (no retry). |
| §5.6 harness `with(deps)` | Unchanged; still only reachable for `errorStage === 'transaction'` non-CFC, not hit by either extracted case. |
| §3-5 `accept(revision)` nulls `acceptedFiles`, §3-6, §2-B | Unchanged nits / acknowledged UI gate. |

## 2. Source-determined defect (not executed by me)

**`file-store.cjs`: an older prepared journal replayed after a later successful commit regresses the live files.**

Deterministic path, supplied source only:
1. `atomicWriteFile(root,'x.json','v0')`; `commitTransaction(root,[{a.json:'a1'},{x.json:'x1'}],{failAfterPublish:1})` → `a.json` published, `x.json` staged, journal J1 remains.
2. `commitTransaction(root,[{x.json:'x2'}])` — `commitTransaction` never inspects `.journal`; `assertTargetsUnobserved` returns when there is no observer; J2 publishes `x.json='x2'` and is cleaned up.
3. `recoverTransactions(root)` → J1: `matchesChecksum(x.json, digest(x1))` false → `preserveRecoveryRevision` archives `'x2'` → `preserveBackup` → rename staged → **`x.json = 'x1'`**.

So the primitive's "restart cannot replay an older snapshot" guarantee (the comment in `writeCanonicalProjection`'s fallback states exactly this intent) rests entirely on *every* caller recovering before committing. Two further observations: `recoverTransactions` sorts journals by UUID filename, not `createdAt`, so with two pending journals the final state is order-random; and the archive makes this non-lossy but silent.

Server reachability — tied to the **acknowledged** direct-lane CFC variant, now with a sharper consequence than R9 §4 stated: direct lane fails mid-publish (J1) → fallback's `recoverPendingTransactions()` throws CFC under the observer → `persistCanonicalProjection` catch sees `code === 'CANONICAL_FILES_CHANGED'` at `errorStage === 'transaction'` → skips `pendingCanonicalRecovery = save`, calls `save.settle()` (partial sentinel) → J1 orphaned. Later saves are blocked by `externalChangesAwaitingReview()`, but `resolve` → `persistDbCacheWithChats('external-review',{externalRevision})` → `writeCanonicalProjection` full-sync → J2 commits over J1's paths (character metadata / messages). The next `recoverTransactions` — at server start, or in-process via the compat rebuild handler's `else` branch — replays J1 over J2. Any untracked `commitTransaction` caller (background `scheduleModuleSync`, imports, restores — not supplied) would create the same orphan class.

Minimal mitigation: `commitTransaction` refuses (or recovers first) when `.journal` holds a prepared journal; `recoverTransactions` orders by `createdAt`. Repro: the three-step unit case above; it should fail on current source with `x.json === 'x1'`.

Classification: proved by reading at the primitive level; not executed; server-level reachability unverified and bounded by the acknowledged variant.

## 3. Double-fault hold, shutdown, restart — judgment

In-process: every queued endpoint 500s with the path (`queueStorageOperation` retries first); tested for the review GET and canonical flush. **New consequence of the §5.1 fix:** when the compatibility blob is absent (deferred mode), unqueued legacy readers now also 500 — `/api/db/stats` (l.6353 → `kvSize`/`kvListWithSizes` → `materialize` → `rebuild` → handler → CFC), `/api/list('')`, and GET chat-content via `ensureChatStore`. Fail-closed is the right direction, but the hold is now wider and there is still no non-queued status signal (response: acknowledged, not implemented).

Shutdown: `recoverFailedCanonicalTransaction()` throws inside the inner try → exit 1 → `liveFilesPendingWrites` → complete attempted snapshot in `trash/shutdown-recovery/`. Proved (`publish-delayed/external`, and the three `*/shutdown` cases).

Restart: proved **only** as `node -e recoverTransactions(root)` — external bytes archived with `mapping.json`, journal gone, `exportLegacyDatabase()` equals `incoming`. Not exercised: `server.cjs` boot (`createLiveFileMonitoring` → recovery; what happens if it throws), and the stale accepted revision → first `/api/read` → `adoptSettledExternalProjection()` → `reconcileCanonicalProjection({externalEditing:true})` silently adopts the app's own bytes as "external". The response's "both versions durably retained" is accurate; "UI recovery guidance remains a gate" is accurate.

Verdict on the hold: correct defensive behaviour for a double fault; durability now adequate; discoverability (trash-only, no signal) is the remaining gap, and it is the acknowledged UI boundary, not a regression.

## 4. Unverified risks (not asserted as defects)

1. **Blob-ahead-of-canonical restart hybrid** (extends acknowledged §3-3). After `/api/write` with `kvSet` succeeded and canonical failed, then exit (graceful flush fails under the same fault): blob = attempted, canonical = old. On restart `prepareDatabaseRead` (l.4059) prefers canonical → `dbCache` old metadata; the first chat GET/POST → `ensureChatStore` reads the **blob** → `fullChatStore` = attempted chats. Next persist reassembles old metadata + attempted chat bodies and writes both stores. No loss (recovery file), but a silent partial resurrection, and the read lane and the hydrate lane disagree on the source of truth. If no `/api/read` happens first (resumed tab), the seeded `dbCache` comes from the blob and the failed write is fully resurrected. Outcome depends on request order. Suggest `ensureChatStore` hydrate from the same source the startup lane uses when `canonicalProjectionReady`, or compare revisions.
2. **Unqueued `ensureChatStore` seeding `dbCache`.** If GET chat-content (not supplied) is unqueued and calls `ensureChatStore`, it can now assign `dbCache[DB_HEX_KEY]` concurrently with a queued `prepareDatabaseRead` that awaits inside the flush; last writer wins. Worst case I can derive: a spurious patch 409 → rebase. Cannot verify without the route.
3. **Archive growth.** `recoverTransactions` always passes `recovering:true`, so every in-process retry (including the ordinary transient-EPERM path) archives the app's own previous revisions under `trash/transaction-recovery/`. `trash/` is in the backup directory list per R8/R9; whether this subtree is excluded or swept is not in the supplied source.
4. **Unguarded newly created paths.** `save.unchanged()` returns true when `before.files[file]` is undefined; an externally created file at a path the journal will create is replaced (archived on recovery replays, `.bak` otherwise). Low likelihood (stable-ID paths); the response's own fixture correction confirms the behaviour.
5. **`delete-character` replays are unconditional and unarchived** in recovery (`fs.rmSync` recursive); edits made inside that directory after the crash vanish. Whether a trash copy exists from an earlier step is not supplied.
6. **Dangling `mapping.json`.** It is written before the copy; a crash between leaves a mapping with no `original`. Self-heals on retry if the target is unchanged; otherwise a stale mapping remains (not loss).
7. **Startup recovery throw path.** `preserveRecoveryRevision` and the checksum guards can throw at boot; the boot handler's behaviour is not supplied.

## 5. Acknowledged boundaries (not regressions) — accuracy check

- Non-queued status UI / recovery browser: correctly described as not implemented; the §5.1 fix slightly widens the silent hold (see §3).
- Direct-lane CFC fallback variant: correctly described as unfixed; §2 above adds the regression consequence and a deterministic primitive-level repro.
- "A new Node process completes the journal": true for the primitive; the server boot path is not what the test runs.
- "Normal commit path is unchanged": accurate; single-slot `.bak` remains there.
- Large DB, ARM64, SAF, release signing, transfer/UI: not claimed, not evidenced here.

## 6. Evidence assessment

- `runtime9-cold-repro.log` 3 failures exactly as predicted; `runtime9-cold-fixed.log` 61/61 (file-store 5+… — composition plausible, not individually counted). `runtime9-recovery-repro.log` 3 discriminating pre-fix failures (ENOENT on the archive dir, mock never fired, missing setter). `runtime9-recovery-http-final.log` 13/13 incl. `external`. Timeline 05:10→05:21 consistent.
- `server-suite-runtime10.log`: 1164 pass / 1 fail / 3 skip at default concurrency; failure is `painter-save-flush` timeout at 30 s with its own printed timings `fullFlushMs 1959 / canonicalFlushMs 3141` under load — canonical-only flush was *slower* than full flush there; the recheck shows `225 / 208` (parity). Observation only; relevant to the large-DB timing gate.
- `server-suite-runtime10-recheck.log`: 1165 pass / 3 skip, 102 files + 1 skipped (bench). Green at `maxWorkers 4`. Two consecutive default-concurrency runs each had one different load-sensitive failure (R9 EPERM, R10 timeout): a flake class, not a product defect, but the suite is not reproducibly green at default concurrency on this machine.
- Client 4713/6, typecheck, web build, transfer4-memory: **logs referenced, not supplied** — unverified here.
- APK13: `apk13-file-verification.json` shows both ABIs with 16 KiB load alignment and v2-only (debug) signature. Nothing in the bundle links `runtimeZipSha256` to the reviewed server source; provenance JSON says x64 emulator passed, ARM64 runtime pending physical HOLD; response says emulator instrumentation in progress. "Built from this tree" is asserted, not evidenced.

## 7. Scoped verdict

R9's blocker (§3) is closed with discriminating evidence; recovery archival and observer routing are implemented as claimed and proved at unit/HTTP level; the double-fault hold behaves as designed and is now durable across restart. No regression was found in the supplied current source for the focus areas. Open against the "acknowledged writes are preserved" claim: the primitive-level orphan-journal replay (§2) and the blob/canonical hybrid on restart (§4.1), both source-determined and both bounded by already-acknowledged failure classes; neither loses bytes, both can silently change which bytes are live. Not a release or integration approval.

## 8. Remaining evidence gates (ordered)

1. Unit case for §2 (J1 crash → J2 commit → recover → assert `x.json` unchanged) and the chosen fix (refuse/recover-first in `commitTransaction`, `createdAt` ordering).
2. HTTP case extending `publish-delayed/external`: start `server.cjs` on the retained root, assert boot completes the journal, archive present, what the first `/api/read` returns and the accepted-revision outcome; add `kv` and `canonical` restart variants to expose §4.1.
3. Direct-lane CFC fallback repro (acknowledged) with the resolve→J2 path.
4. Supply client/typecheck/build/archive logs for the current source; document `maxWorkers 4` as the required server-suite setting or make the painter case load-robust.
5. APK13: source↔bundle manifest, emulator instrumentation result, then ARM64 physical (HOLD).
6. Non-queued hold status signal (now also needed for `/api/db/stats` in deferred mode), recovery-file and `transaction-recovery` guidance, §2-B re-gating.
7. Trash retention/backup policy for `transaction-recovery`; large-DB flush timing under contention.
