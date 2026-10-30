# Fable 전송 검수 — core5

실제 모델: claude-fable-5-1; effort=xhigh; is_error=false.
입력 사본·해시·원문: `tmp/fable-readonly-core5/`. 읽기 전용 검수이며 실기기 승인이나 전체 무결함 보증이 아니다.

**Verdict: no new blocker in this scope.** All four corrections are present in the pinned sources and behave as described. Two minor non-blocking hardening notes and one item I could not verify follow.

**1. Mismatch now confirms before autosave/plugins; hold retains everything and releases the fence.** Confirmed.
- Server mismatch throws before any publication: `server/node/play-set-service.cjs:267-270` runs ahead of `phase = 'committed'` (line 271), so pages and workspaces are never touched on a mismatch.
- Hold path `play-set-service.cjs:321-330` moves the plan to `retainedPlan`, performs no `fs.rm`, and calls `write()`. Line 53 then clears `activeTransaction` because the record has no plan and matches `activeRecord`. The constructor at line 44 only re-arms on `record.plan`, so a restart stays unfenced. `pending()` (331) excludes held records, and `prepare`/`exportSet` gates (100, 165) no longer block.
- Client `src/ts/playTransfer.ts:103-129` runs from `src/ts/bootstrap.ts:94`, before `loadPlugins` (128) and `saveDb` (185). On any failure it prompts; acceptance posts `/hold-recovery` with `confirmed: true`; rejection rethrows into the `loadData` catch, so boot stops with `loadedStore` still false. The route at line 365 rejects a hold without explicit confirmation.
- Tests cover it: service test lines 88-106 assert DB untouched, archive and staging present, pending empty, and a restarted service accepts untokened writes. Client test lines 59-72 assert confirm then hold-recovery.

**2. Missing expected field is a mismatch, not an undefined canonical.** Confirmed at `play-set-service.cjs:269` and `playTransfer.ts:116`, both checking `chat[field] === undefined` before hashing. Hash parity holds: the client's `hashLocalJson` and the server's `hash(canonical(x, true))` both SHA-256 the same sorted-key canonical string as UTF-8. The service test at lines 92-95 deletes `scriptstate` and gets "does not match".

**3. TRANSFER_BUSY distinguishes the fence from writer-lock loss; /api/remove fenced.** Confirmed.
- `assertWrite` sets `status 423` and `code 'TRANSFER_BUSY'` (`play-set-service.cjs:59`); `checkActiveSession` forwards both (`server/node/server.cjs:2019-2021`) and is now called on `/api/remove` (4301). The late error middleware at 7627-7630 maps the queued re-check at line 146 to 423 with the code.
- Client `src/ts/storage/nodeStorage.ts:425-428` only dispatches session-deactivated when the code is absent.
- The real HTTP test asserts 423 plus code on `/api/write` and `/api/remove`, canonical flush with the token, and a stale token after finish.

**4. Failed prepare and missing export clean only their own working directories.** Confirmed.
- `play-set-service.cjs:235-240`: with a persisted plan it calls the unwrapped inner `finish` (no exclusive-lane deadlock), whose rollback uses the on-disk plan (empty asset/inlay lists at the preparing phase) and removes staging; without a plan it removes staging directly. `removeInlay` tolerates never-installed inlays (`server.cjs:1764-1783`).
- `play-set-service.cjs:140`: `recorded ? work : dir`, and the missing-asset return at 127 precedes `write(record)`, so the whole unrecorded directory goes. Tests at lines 108-118 cover both.

**Non-blocking notes (minimal fixes):**
- **Orphan staging if the plan write itself fails.** If `write(record)` at line 186 throws, the in-memory `record.plan` is set but the disk record has none, so the catch calls `finish`, which is a no-op, and the staging directory is left behind. It is never fenced and never blocks a retry. Fix: in the catch, re-read the record and branch on the persisted plan, removing staging when none exists.
- **Export record written before the registry is computed.** Lines 135-138 write the ready record before `recordExport` and `bardFingerprints` run. If either throws, a sendable archive exists but the sender never gets or saves the generation, so a returned copy cannot match by registry at `shared/play-set/characterChats.ts:137` and would be appended again. Both calls are unlikely to throw. Fix: move `write(record); recorded = true` after line 138.

**Not verifiable from the supplied set:**
- `app.use(expressErrorMiddleware)` from logs.cjs runs before the 423-preserving handler at 7627, and logs.cjs is outside this directory. If it answers errors itself, only the rare race where the fence rises between the route check and the queued run would return 500 instead of 423. The client treats that as a plain save failure, not a session loss.
- Boot-time `/finish` and `/hold-recovery` POSTs pass through `sessionLock.checkWrite` without `x-user-active`. session-lock.cjs is not supplied, so I could not confirm a gesture-less first write from a freshly registered session is accepted when another device held the lock. The HTTP test uses one session id throughout and does not exercise this.
