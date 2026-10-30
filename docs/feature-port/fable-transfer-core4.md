# Fable 전송 검수 — core4

실제 모델: claude-fable-5-1; effort=xhigh; is_error=false.
입력 사본·해시·원문: `tmp/fable-readonly-core4/`. 읽기 전용 검수이며 실기기 승인이나 전체 무결함 보증이 아니다.

Review complete. I found four confirmed defects in the core scope (one serious when it triggers, one medium, two low housekeeping leaks), plus two lower-confidence notes. The append, dedup, fingerprint symmetry, and publication idempotency logic itself checked out.

## Confirmed defects

**1. A retained recovery has no exit and blocks both boot and every save.** When `finish` decides the saved chat does not match the plan, it throws and keeps the plan (server/node/play-set-service.cjs:265-268, and :296 for the confirmed-but-unsaved case). From there nothing can resolve it:
- `cancel` refuses any record that still has a plan (play-set-service.cjs:314).
- The restart scan re-arms the fence from any record with a plan (:44), and `assertWrite` then rejects every untokened write with 423 (:55-61).
- On the client, `recoverTransfers` rethrows (src/ts/playTransfer.ts:115-119) straight out of `loadData`, which fails the startup stage and never sets the loaded store (src/ts/bootstrap.ts:94, 204-207). The app never reaches the UI.
- A field that is absent after the save round-trip makes both checks throw an opaque `Non-JSON record` instead of the mismatch message, because `canonical` rejects `undefined` (shared/play-set/protocol.ts:38).

Reproduction: the existing test path (prepare, arm, push, save, alter one field of the saved chat, restart). After that, boot fails every time, `/cancel` returns 400, and all writes return 423. The trigger requires a real mismatch, which the supplied code only produces synthetically, but the absence of an escape hatch is unconditional.

Minimal fix: add an explicit, user-confirmed abandon on the server that drops the plan (releasing the fence through `write`), removes staging, keeps `incoming.risuplay`, and marks the record failed with the mismatch reason. Make `recoverTransfers` catch per record, report via `transferStatus`, and let boot continue so the user can reach that action. For committed-phase mismatches a "publish anyway" option is reasonable, since the Wiki and slot contents do not depend on the chat's exact bytes.

**2. The fence's 423 is treated as writer-lock loss by the client.** `authFetch` dispatches `risu-session-deactivated` on any 423 (src/ts/storage/nodeStorage.ts:425-427); the fence returns 423 from `checkActiveSession` (server/node/server.cjs:2020-2021). Windows where an ordinary autosave hits this in a single-device flow:
- The whole `exportSet` duration, which hashes every asset and Wiki file.
- `prepare`, since the client only sets `transferTransaction` after `arm` (playTransfer.ts:84).
- The tail of `finish`: `write(record)` clears the active transaction (:302) before staging cleanup and the response, while the client clears its token only in `finally` (playTransfer.ts:101). A tokened write in that gap fails `token !== activeTransaction`.
- Any time a retained recovery exists (defect 1).

Also, the run-time re-check inside `queueStorageOperation` (:146) rejects with `error.status = 423`, but the generic handler ignores it and answers 500 (:7626-7629). Minimal fix: set a `code` on the fence error, include it in the 423 body, have the client dispatch the deactivation event only when that code is absent, and make the error handler honour `err.status`.

**3. A failed `prepare` leaks its staging directory.** Staging is created at :170, but every error from archive open, `bardFingerprints`, or `applyCharacterChats` (:171-179) happens before the plan is written at :185. The catch calls `finish`, which returns early with no plan (:258-261) and never removes the directory; `cancel` deletes only the three archive files (:316). Reproduction: ingest an archive whose character name matches two local characters and call prepare without targets. Fix: remove `staging` recursively in the catch block.

**4. An export with missing assets leaves an orphan transfer directory.** The directory is created at :101-102; the early return at :127 writes no record. `list` tolerates it (:67) but nothing cleans it up. Fix: remove `dir` when returning without a record (a flag checked in the existing `finally` works, since `work` lives inside it).

## Lower-confidence notes

- `/api/remove` is a write route without `checkActiveSession` (server.cjs:4297), so it escapes both the session lock and the fence. The boot asset sweep `cleanChunks` (bootstrap.ts:188-190) runs through it 5 s after load, and the trusted auto-receive poll starts at 3 s. If auto asset cleanup is enabled, keys installed by `arm` (:248-252) are referenced by no saved chat yet and can be swept before the DB save lands. Depends on `getUncleanables`, which is not supplied. Adding `checkActiveSession` there matches every other write route.
- Test gap: the HTTP test flushes with full materialization, while the client uses `mode=canonical`, which invalidates the compatibility cache (:1147-1149). Startup reads canonical when `index/sidebar.json` exists (:1076), so the path looks right, but it is not exercised with a restart.
- `state.json` embeds every added chat in full and is rewritten synchronously six times per import with read-back checksum and `.bak` copy. Multi-MB chats will stall the event loop.

## Verified as correct

- Fingerprint symmetry for A to B to A: relink and `bardFingerprints` both process Markdown first, seed slot hash maps from the current workspace, strip `risuTransferMedia`/`risuTransferSource`, exclude the saved-files list, and normalise slot ids to a constant.
- Publication is idempotent across ENOSPC retries: owner marker with `.bak`/`.sha256` cleanup, exclusive page copy with hash check on EEXIST, lstat guard before rename.
- The fence is checked at enqueue and again at run time, transfer routes are exempt, and `/api/db/flush` only persists already-fenced cache, so it cannot smuggle a write.
- Dedup matches on `risuTransferSource` first, then on registry generations; duplicate mode records a transaction marker without pushing a generation, so no second Wiki or slot copy is produced.
