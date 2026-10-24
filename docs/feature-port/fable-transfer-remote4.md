# Fable 전송 검수 — remote4

실제 모델: claude-fable-5-1; effort=xhigh; is_error=false.
입력 사본·해시·원문: `tmp/fable-readonly-remote4/`. 읽기 전용 검수이며 실기기 승인이나 전체 무결함 보증이 아니다.

Review complete. I read all seven supplied files plus the test file. Findings below, in my scope (remote transports, secrets, and the client transfer code). Native helper internals, the Android server side of the loopback RPC, and the core append/recovery server code are not in this directory, so I could not check openPicker exception propagation, parent-owned helper shutdown, or fingerprint/fencing logic beyond what the client calls imply.

**Confirmed defects**

1. **Secrets vault has no in-app reset once it cannot be decrypted.** `set` in `server/node/transfer-secrets.cjs:52` calls `load()` before applying the change, so `configure` with `clear: true` rejects just like `get` does. Repro: write garbage into `transfer-secrets.dat` (or encrypt under one Windows account and read under another), then dispatch `nas`/`configure` with `{ clear: true }`. Result: rejects, and every later `configure` also rejects because it reads `previous` first. The user has to delete the file by hand. Minimal fix: in `set`, when `value === null`, catch the load error and start from `{}`; an explicit clear is not a silent reset.

2. **Legacy GitHub upload locks a chat out permanently after any edit or regenerate.** `requireContinuation` at `server/node/transfer-remote.cjs:18` requires every previously backed-up message to deep-equal the new message at the same index, and refuses metadata-only changes when the count is unchanged. Repro: back up a chat, regenerate the last reply, back up again. Result: refused forever, even after appending more messages, because the index still differs. The error text blames the remote and tells the user to download and check, but there is nothing they can do afterwards. Minimal fix: accept an `overwrite` flag from the panel and skip the continuation check when set, keeping the previous Git history as the safety net.

3. **Windows USB receive loop never exits on a cancelled transfer.** The loop in `src/lib/Setting/Pages/TransferPanel.svelte:108` only breaks on `failed` or `delivered`. The send poll in `src/ts/transferNative.ts:62` already treats `cancelled` as terminal, so the helper can emit it. Result: the loop polls every second forever and `working` stays true, which disables the whole panel until reload. Minimal fix: treat `cancelled` like `failed` in the receive loop.

**Low severity**

- **Unconfigured NAS or GitHub operations give raw errors.** `nasList` at `transfer-remote.cjs:116` calls `folder(undefined)`, so the user sees `TypeError: Invalid URL`. GitHub operations send a request to `repos/undefined/` with `Bearer undefined` and report `HTTP 404`. Add a "save the connection settings first" guard after each `secrets.get`.
- **Env key capture is non-reentrant.** `createTransferSecrets` deletes `RISUBARD_TRANSFER_KEY` on every call, so a second store created in the same process on Android falls back to the throwing protector. Safe if the server constructs it exactly once; capture at module load if that is not guaranteed.
- **Listing overflow advice has no UI path.** The 1000-entry error at `transfer-remote.cjs:165` tells the user to pick a file in the repository, but the panel only downloads from the listing.

**Verified as sound**

- NAS upload stages to a `.part`, verifies SHA-256 by re-download, then MOVE with `Overwrite: F`, and only deletes its own temp on failure. Redirects are never followed with credentials.
- GitHub download pins commit and blob SHA, verifies size and hash in a Transform before ingest, and rejects public repositories. Upload streams base64 with an exact Content-Length and verifies the committed blob.
- `parseNasListing` treats hrefs as data only, rejects foreign origins, encoded slashes, DOCTYPE and ENTITY, and rebuilds requests from a validated basename.
- The Android bridge RPC matches replies by id, extends its timeout on `pending` keepalives, and rejects on bridge errors so picker or export failures surface in the status line.

**One thing to confirm in the unsupplied server.** The inbox loop at `src/ts/playTransfer.ts:145` imports before it calls `inbox.accept`. If `/native-import` is not idempotent for an already-imported id, a failed accept causes either a duplicate queue entry or a retry every three seconds that keeps overwriting the status line.
