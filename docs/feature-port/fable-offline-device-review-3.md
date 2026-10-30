# 실제 Fable 5.1 · xhigh 기기 내 AI 3차 검수

실행 종료0, is_error=false, modelUsage=claude-fable-5-1. 제출한 코드/시험 범위의 원문이며 전체 제품·실기기·릴리즈 승인이 아니다.

**Scope.** I reviewed only the attached `local-ai.cjs`, its test file, the Svelte settings page, `data-root-lock.cjs`, the two `server.cjs` excerpts, the two llama.cpp excerpts, the `MainActivity.kt` excerpt, and the logs/JSON. Anything else (client `localAIRequest`, store init, body-parser limits, native watchdog, SIGTERM shutdown) is treated as unseen.

## D1 — engine death after template

Fix is sound as written. `relay` snapshots `socket`/`authenticationKey` after `ready()`; every `nativeRequest` re-checks `socket !== endpoint || authenticationKey !== key`. Because the Unix path is constant (`engine.sock`), the path comparison only detects "endpoint cleared"; the per-start random `key` is what distinguishes a restarted engine. `start()` reassigns `key` before the new child is ready and `ready()` blocks on `starting`, so a stale snapshot cannot be reused across a restart. Death that races ahead of the `'close'` event is covered by the `ECONNREFUSED/ECONNRESET/EPIPE/ENOENT/ERR_STREAM_PREMATURE_CLOSE → 503` mapping; `socketFetch` rejects on missing path. All the check-then-set sequences (`busy`, `requests++`, `idle()`) are synchronous after the same `await initialized`, so I found no interleaving gap.

Evidence note: the kill-mode test injects `fetchImpl`, so the relay-level guard is tested, but the bottom-level `socketFetch` rejection and the ECONN* mapping are verified only by code reading — no test drives a real dead socket through production `socketFetch`. Also the two "before" logs come from two orderings of the test (lines 189–191 differ), i.e. they are isolated reproductions, not one unchanged test — acceptable, but say so.

## D2 — 503 / non-JSON upstream

`nativeJSON` now parses first, then maps: 503 → Korean 503, other non-OK → upstream message with 502/422, unparsable 200 → 502. Correct for the two preparatory calls. Caveat (provable): the final `nativeRequest(target, body)` is **passed through verbatim** — status and body — so a llama.cpp error on the completion itself reaches the client as `{error:{code,message,type}}` (or, with `stream:true`, as an SSE `error` frame under HTTP 200), not as `{error: string}`. Whether the client handles that shape, and whether a forwarded 401/423 from the engine could be misread as app auth/session failure, is unverified (client code not attached). Reachability of the 401 case is low because the key is env-injected and the pre-check already excludes stale keys.

## D3 / D4

D3: confirmed limitation. `pipeline(req, …)` destroys `req` on verifier failure, which tears down the socket, so the route's `res.destroyed` branch correctly gives up on JSON. The UI's `TypeError` → Korean message is a reasonable cover; it will also fire for any other network-level failure, which is fine. D4: disclosed in the UI; `tokenize` relay does call `ready()` and may spawn the engine during browsing. Accepted limitation.

## R1 / R3

R1: the attached source proves `post_apply_template` and `post_tokenize` go through `create_response()` with default `bypass_sleep=false`, so `wait_until_no_sleep()` precedes vocab access. The `/v1/chat/completions` handler and the model-reload path that re-sets `vocab` are not attached, so "vocab valid after wake" is plausible but not proved from evidence.

R3: the lock is acquired at line 21, before `createLocalAI` at ~4498. The excerpt does not show that `savePath` is inside `processDataRoot`; if it is (likely), GC is single-process. Lock logic itself is fine. One Android-specific residual: a stale `owner.json` whose PID is reused by a **same-UID** process (e.g. a later llama child) makes `isProcessAlive` true → spurious `DATA_ROOT_IN_USE` and no server until that PID exits. Low probability, startup-blocking when it happens.

## Confirmed (non-blocking) issues

1. **Settings page sends stale limits on toggle.** `context`/`output` are `$state` initialized once from `localAI.*` and never re-synced after `refreshLocalAI()`. `configure()` always PUTs them, including on the enable/disable button. If the store is populated after mount or changed elsewhere, toggling silently overwrites the saved context/output. Behavior is provable from the component; actual impact depends on store init (unseen).
2. **No server-side timeout on native calls.** `/apply-template`, `/tokenize`, and the completion have only the client-abort signal; a hung engine hangs the request until the user cancels. `/props` has 1 s. Limitation, not crash.
3. **`running: true` while the engine sleeps.** `endpoint` is not cleared on idle sleep (process alive), so status/UI say "running" although the model is unloaded. Cosmetic.
4. **Corrupt `settings.json` path can end in deletion of the copied model.** Init keeps the orphan (`settingsValid=false`, test proves), but any subsequent PUT persists `model: null`, and the next init GC removes the orphan. The user's original source file is untouched; no "re-adopt" recovery exists. Limitation; settings writes are tmp+fsync+rename so corruption needs an external cause.
5. **Upstream error passthrough** (see D2) — shape/status contract with client unverified.

No defect found that violates the MUSTs in the attached code: there is no online fallback path in `local-ai.cjs`; relay returns 409 when disabled; model/settings preservation is enforced by `committed` + atomic rename and covered by tests (including the new mid-stream cancel and corrupt-config tests).

## Unverified risks

- **Durability ordering on power loss.** No directory fsync after `rename(part→gguf)`, `rename(tmp→settings.json)`, or before `rm(previous)`. On a crash-only event this is safe (GC handles orphans). On power loss within the write-back window, the `rm previous` could become durable before the settings rename, leaving settings pointing at a deleted file and the new file orphaned (then GC'd). Narrow, filesystem-dependent (f2fs vs ext4), not tested. Hardening: `fs.open(directory)` + `sync()` after renames, or defer `rm previous` to the next init GC.
- **Body-parser limit** for `/chat/completions` and `/tokenize` (long lore/chats) — depends on `express.json()` config in `server.cjs`, not attached.
- **Shutdown path**: whether `server.cjs` calls `localAI.close()` on SIGTERM, and whether the native `RISUBARD_PARENT_PID` watchdog reaps the child after a force-kill — unseen; APK22/23 force-kill results are the only evidence.
- **180 s readiness deadline** on slow eMMC with multi-GB models is a product boundary that physical ARM64 has not exercised.
- `socketFetch` uses `request.once('error', …)`; modern Node guards against a second `'error'` on `ClientRequest`, so I don't claim a crash, but `on` would be the defensive form.

## WebView renderer SIGSEGV (APK24)

Outside the reviewed code. Frames (`libmonochrome` + `libart` `KernelSupportsUffd`/`MetricsReporter`, Metrics Background thread) are Chromium/ART internals; the ART symbol is its userfaultfd probe, which is plausibly emulator-kernel/WebView-version dependent — but that is consistency, not attribution. The app side behaved as designed: `onRenderProcessGone` destroyed and `recreate()`d, server-side data survived. Note the limitation that `recreate()` discards unsaved in-page state. Keep the blank-WebView control; also record emulator WebView package version/kernel so a physical run can be compared. No llama child was running, so this does not implicate the local-AI path.

## Assessment

D1/D2 fixes are correct and the regression evidence (1 failed → 8 passed, two separate pre-fix failure modes) matches the code. Remaining items are limitations or unverified integration points, not blocking defects in the attached code. Before a physical ARM64 run I would (a) add one test that drives production `socketFetch` against a killed real fake engine (covers the bottom-level guard and ECONN mapping), (b) fix the stale-limits toggle in the settings page, and (c) decide on directory fsync for the import/persist sequence. Installation and release remain on hold as stated; nothing here supports claiming long-run stability.
