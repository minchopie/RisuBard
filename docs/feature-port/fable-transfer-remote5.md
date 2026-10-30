# Fable 전송 검수 — remote5

실제 모델: claude-fable-5-1; effort=xhigh; is_error=false.
입력 사본·해시·원문: `tmp/fable-readonly-remote5/`. 읽기 전용 검수이며 실기기 승인이나 전체 무결함 보증이 아니다.

I've read all twelve supplied files. Here is the review.

**Verdict: no confirmed blocker in the remote scope.** Every follow-up claim matches the code, and I found no direct regression in the changed paths.

**Verified against the code**

- **Explicit reset only.** `transfer-secrets.cjs:51-56` encrypts an empty vault first, copies the old ciphertext to `transfer-secrets.recovery-<uuid>.dat` with `COPYFILE_EXCL`, tolerates only ENOENT, then writes. `set(kind, null)` still goes through `load()`, so a corrupt or wrong-key vault rejects clearing (`transfer-secrets.cjs:57-62`, test at `transfer-remote.test.ts:34-38`). The UI gates the call behind `alertConfirm` at `TransferPanel.svelte:138`, and `dispatch` resets both kinds regardless of the path kind (`transfer-remote.cjs:264`).
- **Legacy conflict flow.** `conflictSha` is returned only when `promptConflict === true`; every other caller still gets the throw (`transfer-remote.cjs:247-250`). With `replaceSha`, the server still downloads and re-validates the prior blob, checks chat and card identity, and refuses if the live SHA differs (`transfer-remote.cjs:245-252`). The PUT carries `sha: previous.sha`, so GitHub enforces it a second time, and nothing deletes or force-pushes. The client confirms before sending `replaceSha` (`playTransfer.ts:142-144`).
- **USB receive terminal states.** `cancelled` and `failed` both throw out of the poll loop (`TransferPanel.svelte:112`); the send poller matches (`transferNative.ts:62`).
- **Missing config before network.** `folder(c.url)` and `repoInfo(c)` run before any fetch in all NAS and GitHub operations; the test at `transfer-remote.test.ts:43-48` uses a throwing fetch.
- **Listing overflow** points at the GitHub website (`transfer-remote.cjs:167`).
- **Query credential masking.** The name-based pass at `logs.cjs:181-186` runs before the value-shape patterns, decodes percent-encoded names, and keeps the encoded name in output. The request-log test asserts both the detail row and the on-disk JSONL (`request-logs.test.ts:81-91`), and the URL is masked before the 2048-char slice (`request-logs.cjs:83`).
- **Android key.** Env key is read and deleted once in `createTransferSecrets`; the protector closes over the bytes with no module-level cache (`transfer-secrets.cjs:38-40`).

**Non-blocking notes**

- Query-name masking is exact-match. Names such as `x-api-key`, `client_secret`, `id_token`, or Azure SAS `sig` pass through. This is not a regression since there was no name-based masking before. A minimal hardening is a suffix test on the decoded name, for example:

```js
/(?:^|[-_.])(?:key|token|secret|password|passwd|auth|authorization|signature|sig|credential)$/
```

- `reset-credentials` relies on the UI confirmation alone, while `finish` and `hold-recovery` also require `confirmed: true` in the body. Requiring the same flag server-side would make the endpoint consistent, but it is not required by the stated goal.
- `requireContinuation` treats a same-length chat with any non-message field change as a conflict, so a reroll will prompt. That matches the stated "edited or diverged" design.
