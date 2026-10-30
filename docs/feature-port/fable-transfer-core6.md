# Fable 전송 검수 — core6

실제 모델: claude-fable-5-1; effort=xhigh; is_error=false.
입력 사본·해시·원문: `tmp/fable-readonly-core6/`. 읽기 전용 검수이며 실기기 승인이나 전체 무결함 보증이 아니다.

All three corrections and both prior source questions are now verified against the supplied snapshots. No further reads are needed.

**Verdict: no confirmed actionable regression from the three corrections.** Data, error propagation, and locking semantics are preserved. Three non-blocking notes follow.

**1. exportSet ready journal ordering** is correct in `server/node/play-set-service.cjs:135-140`. The ready record is written only after recordExport and bardFingerprints return, and `recorded` flips true only on the same line. Any throw from either step, or from the state write itself, leaves `recorded` false, so the finally removes the whole fresh export directory and never another record. A concurrent list() skips the directory while state.json is absent because ENOENT is tolerated at line 67. The new test's fault fires only once export.risuplay exists and only on export-work paths, so it exercises exactly the claimed window, and the readFile spy reaches the service because it uses the same promises module object.

**2. prepare catch** at lines 235-240 calls the inner hoisted finish, not the exclusive wrapper, so there is no lane deadlock. Traced outcomes:
- Failure before the first state write: no persisted plan, finish is a no-op, staging removed, original error thrown.
- Failure during the first state write (the new ENOSPC test): only the rename to state.json is faulted, the backup rename passes through, disk keeps the waiting record, and activeTransaction is never set because write throws before line 52. Retry succeeds.
- Failure after the plan is persisted: the persisted plan has empty asset and inlay arrays, so the rollback branch deletes nothing installed, marks waiting, clears activeTransaction, and removes staging. If that rollback write fails, the throw skips the rm and the plan remains recoverable on restart.

**3. logs timeout** at `server/node/logs.cjs:21` is a constant change only. Since the timeout now equals the stale horizon, a waiter blocked by a live but hung holder reaches stale removal before giving up instead of failing at five seconds. The pid-grace test is unaffected.

**Prior questions confirmed.** expressErrorMiddleware calls next(err) on both branches and never writes a response at lines 452 and 467. checkWrite returns a passive pass for a fresh non-user-active session without touching active or lastWriteAt at `server/node/session-lock.cjs:81-85`.

**Non-blocking notes:**
- **Double-fault error masking.** If finish throws inside the prepare catch, the original preparation error is replaced. Minimal fix: wrap the finish call and rethrow with the original error attached as cause, so the client still sees the root failure.
- **Untested branch.** No new test covers a failure after the plan is persisted but before phase prepared, for example a fault in copyEntry or a memory rename during prepare. The existing restart-rollback test exercises the same finish branch, so this is a coverage gap, not a defect.
- **Stall budget.** Worst-case synchronous event-loop stall for a log write under cross-process contention rises from five to thirty seconds. The measured serial completion of the four-process test is roughly nine seconds against a fifteen-second vitest budget, so a slower disk will surface as a harness timeout rather than a lock timeout. Consider raising that test's budget above thirty seconds so a real lock timeout is observable.
