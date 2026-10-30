# Fable 5.1 — R8→R9 runtime data-preservation review (read-only, supplied material only)

No tools were run, no files touched. Everything below is from the supplied source and logs. Nothing here is a release approval; physical installs stay on HOLD.

## 0. Verdict

- R9 fixes the two items R8 reproduced (§2-A post-full-write dead end, §3-1 partial-publish self-classification). Both are **proved** by the supplied repro→fix logs and the source matches the claims.
- I did not execute anything, so I report one **new source-determined defect** (not executed, deterministic path through supplied code only) that I treat as a blocker for the "acknowledged chat writes are preserved" claim until a one-case repro either confirms or disproves it: **`/api/patch` on a cold cache discards an in-memory `fullChatStore` that already holds an acknowledged chat write** (§3). It is not an R9 regression; R8 missed it.
- The remaining in-process blocked external-edit journal case is a correct *hold*, not a resolution (§4): it blocks every storage endpoint including the review GET, and the hold expires at restart, where `recoverTransactions` runs unobserved and replaces the hand-edited target (kept only in single-slot `.bak`).
- Full server suite is **not green**: 1155 pass / 1 fail / 3 skip; the failure is a Windows rename EPERM in `logs.test` (non-runtime scope), and the recheck log is summary-only (4 passed, no names). Client suite has no current-source run. APK remains pre-R7.

## 1. R8 items — R9 status

| R8 | Status | Basis |
|---|---|---|
| §2-A cache-less pending chat + external edit → 500/409 | **Fixed for the post-full-write path (proved)**; **not fixed for the never-loaded path** | `tmp/runtime8-repro.log` shows the two failures (`accept`: "merge baseline is unavailable", `keep`: "no loaded state"); `tmp/runtime8-fixed-final.log` shows both passing. Source: `/api/write` success block no longer does `delete dbCache[DB_HEX_KEY]` ("Retain the merged cache as the baseline…"). The `resolve` `!dbCache` branch is unchanged, so a server with **no `/api/read`/`/api/write`/`/api/patch` yet in this process** (restart with an open tab) still reaches `adoptExternallyChangedCanonicalProjection`'s `liveFilesPendingWrites && !fresh.previous` throw (accept → 500) and the 409 "reload" (keep). The test only covers `externalDecision` after a prior full write. |
| §3-1 partial publish → "external" / "Invalid or duplicate canonical directory" | **Reproduced and fixed (proved)** | Repro log: `publish/chat`, `publish/flush` fail with "Invalid or duplicate canonical directory"; fixed log: all 12 `fault×action` cases pass. Source: `persistCanonicalProjection` catch sets `pendingCanonicalRecovery = save` and calls `recoverFailedCanonicalTransaction()` (recovery under `observeWrites(save, …)` then `save.settle()`); `queueStorageOperation` retries it before every queued op; shutdown passes `recover=false` and wraps the retry in its own try so the emergency backup still runs. `file-store.recoverTransactions` now runs `assertTargetsUnobserved` on unpublished replace targets. |
| §3-2 client ETag contract | **Verified by source read (no execution)** | `NodeStorage.setItem` throws `ConflictError(currentEtag)` on 409; `persistTrackedChanges` full-write catch → `rebaseTrackedLocalChangesOnLatestServerDb(conflictErr.currentEtag)` → `/api/read` (server flush with `adoptExternal:true` retries the retained failed-write state) → merge → `'retry'`. On a 500 the client throws the string `"setItem Error"`, retries with the old etag, gets 409 (server `dbEtag` advanced to the failed payload's etag), rebases. While the disk is still failing, `/api/read` flush 500s → `getItem Error: …` → backoff → `alertError` after `savetrys > 4`. Coherent; no loss path. |
| §3-3 kvSet ok / canonical fail / kill | Unchanged, acknowledged | — |
| §3-4 backup inventory recursion | **Withdrawn** | `CANONICAL_BACKUP_DIRECTORIES` is a fixed list without `backups`; `publishBackupRestore` replaces only those dirs. (Note: `trash/` is included, so `trash/shutdown-recovery/*.bin` travels in backups — desirable.) |
| §3-5 `accept(acceptedRevision)` after `settle()` nulls `acceptedFiles` | Unchanged nit | — |
| §3-6 stability test uses `isEnabled:()=>true` | Unchanged | — |
| §2-B `/api/external-edit/start` always 409 | Unchanged — pending UI integration | `liveCharacterFiles.isEnabled()` is always false; `toggleExternalEditMode` will always surface `externalEditModeFailed`. Not a data issue. |
| `live-files-http` missing from logs | **Closed** | Both `legacy`/`v3` pass in `tmp/server-suite-runtime9-final.log`. |

## 2. Proved by supplied execution evidence

1. **§2-A post-write path**: `uncached-chat-flush-http` `false/'accept'` and `false/'keep'` pass; the asserted outcomes (pending chat kept, unrelated chat kept, `desc` per decision) match the handler path `resolve` → `applyExternal`/`backup` → `acknowledge` → `persistDbCacheWithChats(..., {externalRevision})`.
2. **§3-1**: `full-write-failure-http` 12/12 (`kv|canonical|publish|publish-delayed × chat|flush|shutdown`). For `publish/*`, the mechanism is the in-catch recovery (without it, the next commit hits the half-published directory mapping — exactly the repro error).
3. **Unit guard**: `canonical-projection-sync.test` "a journal retry preserves a later external edit instead of publishing over it" — `recoverTransactions` under the original observer throws `CANONICAL_FILES_CHANGED`, `desc` stays `external`. (It does not assert the journal file still exists; add that.)
4. Shutdown paths: `shutdown-recovery-http`, `shutdown-flush-failure-http`, `graceful-shutdown` all pass against the new `queueStorageOperation(…, false)` + inner try shape.

## 3. New defect — source-determined, not executed by me

**`/api/patch` cold-cache load replaces `fullChatStore`, dropping an acknowledged chat write.**

Path (all in supplied `server.cjs`):
- `saveChatContentHandler` → `ensureChatStore()` (builds the store from disk if null) → `fullChatStore.get(chaId).set(chatId, chatData)` → 200, `liveFilesPendingWrites = true`, 5 s debounce.
- `/api/patch` → `if (!dbCache[filePath]) { const fileContent = kvGet(...); if (fileContent) { decoded = …; initChatStore(decoded); dbCache[filePath] = … } }`. `initChatStore` starts with `fullChatStore = new Map()`. The acknowledged chat object is gone. This runs **before** the hash check, so the outcome is identical on 200 and 409.
- Debounced `persistDbCacheWithChats` then reassembles from the reset store and writes the disk chat. The client's `persistTrackedChanges` does not re-send chat-content before its same-call full-write fallback, so a 409 does not rescue it either.

When `dbCache` is absent in a running server: after process start before any `/api/read` (server restart with an already-open tab — the session lock explicitly permits "first write adopts … server restarted mid-session"; on Android the shim restarts the server on connection-refused), after `invalidateDbCache()` without a page reload, after a stub-flag-loss abort. The client's normal cycle is chat-content POST then `/api/patch` within milliseconds, so the first chat save in that state is the one lost. `kvGet('database/database.bin')` effectively never returns null while canonical exists (compat wrapper `rebuild('read')`), so the load block does execute.

Mitigation that exists today: chat-content payloads are whole-chat, so the next save of the *same* chat before tab close/reload restores the content. If the user sends one message and leaves, it is lost silently.

Exact repro (one more case in `uncached-chat-flush-http`, no new infrastructure): seed as today (canonical + compat blob, no `missingCache` marker), start the server, **do not** call `/api/read`; POST `/api/chat-content/one/0` with `updated` (expect 200); POST `/api/patch` with `{patch:[], expectedHash:'incorrect'}` (expect 409 — accept either status); POST `/api/db/flush?mode=canonical`; reopen the repository and assert `characters[0].chats[0]` equals `updated`. Under the current source it should equal the original `chat`. This is the existing `patchFirst:true` case with the two requests swapped.

Minimal fix: in the `/api/patch` load block, `if (!fullChatStore) initChatStore(decoded);` (or `await ensureChatStore()` before seeding `dbCache` from `decoded`). Every other load site either flushes first (`prepareDatabaseRead`) or is a full reset (`invalidateDbCache` callers).

Classification: deterministic through supplied code; I have no execution evidence, so it is "needs one repro" — but it is squarely in the runtime-preservation scope and I would not describe the track as closed until it is run. Not an R7/R8/R9 regression; R9's cache retention happened to close the post-full-write instance of the same hazard, which is why R8's analysis (mine) missed the intra-cycle form.

## 4. Judgment — the in-process blocked external-edit journal case

State: a transaction failed mid-publish, immediate recovery failed (or had not happened), and before the next successful recovery another program rewrote a file that is an **unpublished replace target** of that journal.

What the code does (source-determined, not executed as an HTTP case):
- `queueStorageOperation` runs `recoverFailedCanonicalTransaction()` first; `recoverTransactions` → `assertTargetsUnobserved` throws `CANONICAL_FILES_CHANGED` (path in message); the operation never runs; `pendingCanonicalRecovery` stays set. Every queued endpoint 500s: `/api/read`, `/api/patch`, `/api/write`, chat-content, `/api/db/flush`, **and `GET /api/external-changes` and `resolve`**, so the review UI cannot open. Non-queued endpoints (`/api/db/stats`, lock-status, external-edit status) do not report the condition. The client's save path drops the message (`"setItem Error"`, `"saveChatContent error: 500"`); only a reload's `/api/read` shows `getItem Error: Canonical file changed during transaction: …`.
- Both versions are intact while the process lives: the hand-edited file on disk, the app state in `dbCache`/`fullChatStore`, the journal in `.journal/`.
- Graceful shutdown: recovery throws (caught), flush returns early (`externalChangesAwaitingReview()` true, since the revision moved), `liveFilesPendingWrites` → recovery file written, exit 1. Good.
- **Restart**: `createLiveFileMonitoring` → `recoverTransactions(dataRoot)` with no observer (`assertTargetsUnobserved` returns immediately when `writeObserver` is null) → `publishTransaction` → `matchesChecksum` false → `preserveBackup(target)` then rename staged → target, sidecar refreshed. The hand edit survives only as `<file>.bak`, which the next publish of that file overwrites. Then `loadExternalChanges()` sees revision ≠ accepted and adopts the app's staged bytes as "external". R9 states "startup journal recovery retains its existing behavior", so this is known; I am recording that it contradicts the fail-closed intent across a restart.
- Whether the user can unblock by reverting the hand edit depends on what `repository.getFileFingerprint` hashes (content vs. stat) — not supplied, unknown.

Judgment: acceptable as a defensive hold for a double fault (transaction failure + edit of an unpublished target), not a resolution. Not a runtime blocker on its own, because the app's journal content is also in the retained cache/shutdown recovery file (the journal is not needed to preserve app data; it is needed to leave the tree consistent). Two things are missing: (1) a non-queued status signal the UI can show ("storage blocked: `<path>` changed outside; restore it or stop the server"), and (2) an explicit startup policy for replace targets whose bytes ≠ sidecar (the external-edit signature), with an HTTP case that records whichever behaviour is chosen. Variant to note: if the fallback inside `writeCanonicalProjection` (`repository.recoverPendingTransactions?.()` after a direct-lane partial publish) is what throws `CANONICAL_FILES_CHANGED`, the catch skips `pendingCanonicalRecovery` (code check) and only settles — the journal then has no in-process retry at all until restart.

## 5. Unverified risks (not asserted as defects)

1. **Unobserved recovery via compat-cache rebuild (low, 4–5 conditions).** `attachCompatibilityCache.rebuild` calls `repository.recoverPendingTransactions?.()` with no observer. It is reachable from **unqueued** routes when the blob is absent (deferred mode after `compatibilityCache.invalidate()`): `/api/db/stats` (`kvListWithSizes('')` → `materialize`), `/api/list` with empty prefix, GET chat-content via `ensureChatStore`→`kvGet`. If `pendingCanonicalRecovery` is set, this replays the journal bypassing the external-edit guard (same `.bak` outcome as restart), and the pending `save` never learns of those writes, so its later `settle()` classifies the app's own files as external → spurious review (accept/keep both app state; no loss). Suggest routing rebuild's recovery through the server-level recovery or skipping it when a pending save exists.
2. **Shutdown fallback can throw (low).** With `dbCache` absent, the emergency backup uses `stripChatsFromDb(userDataRepository.exportLegacyDatabase())`; on a half-published tree this is the same call that produced "Invalid or duplicate canonical directory". If it throws, no recovery file is written (`exitCode = 1`, "Shutdown recovery error"). Suggest a chats-only fallback (`fullChatStore` serialized alone) when the export throws.
3. **`publish-delayed` does not discriminate.** Pre-fix (`tmp/runtime8-delayed-repro.log`) and post-fix outcomes are identical whether or not the `recoverTransactions` ENOSPC hook is active (chat/flush remove the marker first; shutdown ends in exit 1 + recovery file either way; nothing is logged in the swallowed `catch {}`). The hook is probably effective (preload patches module exports before any consumer requires them), but the test cannot fail if it is inert. Add an assertion (journal still present after the 500 while the marker is on, or a logged recovery-failure line — currently none is emitted).
4. **Single-slot `.bak`.** Any version "preserved" by `preserveBackup` lasts one further write of that file. Relevant to §4 and risk 1.
5. **Windows rename EPERM** (`logs.test`, `replaceAtomic` → `renameSync`). Out of runtime-data scope, but the same primitive publishes canonical sidecars/journals; a transient EPERM mid-publish is now exactly the path R9's in-catch recovery handles. A bounded retry on EPERM in `replaceAtomic` would reduce how often that path is exercised. Observation only.
6. Harness note (unchanged from R8): the `persistCanonicalProjection` extraction in `canonical-projection-sync.test` runs under sloppy `with(deps)`; its catch now references `pendingCanonicalRecovery`/`recoverFailedCanonicalTransaction`, reachable only for `errorStage === 'transaction'` with a non-CFC error — not hit today, would be a swallowed ReferenceError if extended.

## 6. Evidence assessment

- `runtime8-repro.log`: 4 failures as claimed (2 uncached, 2 publish). `runtime8-fixed-final.log`: 58/58, and the per-file composition (file-store 28, canonical-projection-sync 12, shutdown-recovery 1, shutdown-flush-failure 1, uncached 4, full-write 12) sums to 58.
- `server-suite-runtime9-final.log`: 1155 pass / 1 fail / 3 skip; +8 vs the prior 1147 matches the new cases (6 full-write + 2 uncached). The one failure is `logs.test` EPERM on `state.json.sha256` rename under concurrent processes. **Not a green suite.** `server-logs-recheck.log` shows only "4 passed" with no test names — accepted per your statement, but weak as evidence.
- Client: `globalApi.svelte.ts` and `nodeStorage.ts` now supplied in full; the slice anchors used by `serverDbFlush.test.ts` and `immediateSave.test.ts` all exist in this source, but there is **no execution log for the current client source**.
- APK11: unchanged, pre-R7; `finalSourceVerified:false`; new emulator build pending; physical HOLD.
- Not covered by any supplied execution: §3 (cold-cache patch reset), §4 as an HTTP scenario (block → shutdown → restart replay), §5.1–5.3, the never-loaded §2-A path, browser-side ETag retry.

## 7. Gates (unchanged unless noted)

Clean full server run (or a documented, isolated `logs.test` Windows flake with names in the recheck log); client suite on current source; post-R9 APK rebuild + instrumentation; ARM64 16 KiB build; physical device (HOLD) and SAF picker manual; large-DB shutdown timing; desktop recovery-file guidance UI (also relevant to §4's `.bak`); external-edit mode UI (§2-B) either removed or re-gated. **New:** §3 repro before calling acknowledged-chat preservation closed.

## 8. Recommended order

1. Run the §3 one-case repro; if it reproduces, apply `if (!fullChatStore) initChatStore(decoded)` in `/api/patch` and keep the case.
2. Add an HTTP case for §4 (publish fault → hand-edit an unpublished target → assert all storage endpoints 500 with the path in the body, file intact, shutdown recovery file present) and decide/record startup behaviour for externally edited targets; add a non-queued status signal.
3. Tighten `publish-delayed` (§5.3) and add the journal-exists assertion to the unit case.
4. Seed `dbCache` in `resolve`'s `!dbCache` branch (R8's original suggestion) to close the never-loaded §2-A path, plus a case without a prior `/api/write`.
5. Evidence: client suite on current source; server rerun with `logs.test` named; then post-R9 APK.
