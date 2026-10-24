# Fable 5.1 xhigh · 실제 4차 검수

실제 CLI 종료 0, is_error=false. 변경 소스와 합성 검증 자료만 제공.

# Fourth-round review — on-device local AI follow-up changes

Scope: the four R3 fixes and their regression surface, judged only from the supplied source/tests/evidence. Not a release opinion; WebView SIGSEGV remains unassigned and nothing here touches it.

## Fix-by-fix assessment

**1. Stale limits on mode toggle (LocalAISettings.svelte)** — Correct. `configure(enabled, false)` refreshes first and sends `localAI.context/output`, not the form; Apply sends the form. The `$effect` sync is safe: it only *reads* `localAI.*`, so typing into the inputs cannot re-trigger it and there is no loop. Before/after evidence matches the code (4096/512 → 2048/128). Side effects, by design: toggling discards unsaved limit edits; the toggle's target `enabled` is computed at click time, before the refresh (harmless with a single writer session).

**2. Corrupt settings → PUT no longer persists `model: null`** — Correct and proven by the before log (`promise resolved … busy:true … model:null`) vs. after. `settingsUnreadable` gates `settings()` with 409; GC skips `.gguf` when `settingsValid` is false; `.part` is always removed. Model file and the `{broken` file are preserved (test asserts both).

**3. Power-loss ordering** — The data-file side is right: `.part` fsync → rename → POSIX directory fsync → engine trial start → settings persist. Retention of the superseded model plus startup GC against the *durable* settings makes both outcomes consistent (old settings survive → old model usable, new file GC'd; new settings survive → old file GC'd). Before log confirms the old code deleted the prior model immediately (`ENOENT … a7acd69a….gguf` at test line 173).

**4. SSE error frames (parseChatStreamDelta)** — Correct for the llama-server shape `{error:{code,message,type}}`; `streamChatRequest`'s catch passes `ModelPresetAdapterError` through unchanged, so status/kind survive. Both 400 and 500 reproduced before (`done:true, value:undefined`) and pass after. Journal replay shares the parser as claimed.

Also confirmed against supplied source: `shouldRetryAuth` only matches three app strings, so a native `{error:{…}}` 400/401 object cannot clear the app session; `localAI.close()` is in `shutdownGracefully`; `/api/local-ai/model` bypasses `express.raw`; `text/event-stream` is excluded from compression; `requestTimeout = 0`; `createLocalAI` runs after `acquireDataRootLock`.

## Confirmed defects / behavior changes (with trigger)

**A. Superseded models accumulate until the next process start (new this round).** Trigger: import model A, then B (then C…) in one app session. Each prior `.gguf` stays on disk (`importModel` deletes nothing after commit; only startup GC does). On a phone this is N× model size with no UI to see or reclaim it, and the only reclaim path is restarting the Node process — the next import then fails 507 "저장 공간이 부족해요" for a reason the user cannot fix from the app. Root cause is that `persist()` fsyncs the tmp file but not the directory after `rename`, which is why deferred deletion was needed. Reusing the same directory-fsync step after the settings rename and then deleting the superseded file immediately would give the same power-loss guarantee without accumulation (keep startup GC as the backstop).

**B. Corrupt-settings recovery is a dead end without a GGUF file.** Trigger: unreadable `settings.json` (or a valid file with a malformed model record). `config` stays at the default `enabled: true, model: null`, PUT is 409, so the user lands in "기기 내 AI 사용" with no model, every chat request fails 409, and they cannot switch back to online until a *successful* import. This is fail-closed (consistent with "no automatic online fallback") but is a full loss of chat until the user can produce a GGUF. In the "valid limits, bad record" subcase the user's previously valid `enabled/context/output` are also discarded and replaced by defaults on the next import. Low probability given atomic persist; decide whether this is accepted and documented, or whether a mode/limits write should be permitted with a persisted GC-skip marker.

**C. Live-stream semantics changed for every OpenAI-compatible preset, not just local AI.** An `error` frame arriving after partial content now aborts the generation with an adapter error (previously a silently truncated "success"). Intended, but it is a cross-provider behavior change; whether partial text is preserved for the user on error is not visible in the supplied source.

**D. Harness flakiness (test evidence, not product).** The one test that exercises the real `socketFetch` path failed in the before run with undici `bad port` from `app.listen(0)`; it passes on rerun. The R3 explanation (OS-chosen ephemeral port in fetch's bad-port list) is plausible but the port is not shown in the log. As written, the proof of the real-socket path is rerun-dependent; the harness should reject/retry bad-list ports.

## Unverified risks (not proved from supplied files)

- Journal replay: `decodeStreamingJournalDetailed` now throws on a recorded error frame. Whether `recoverTerminalJob` claims such a job or retries it every boot is not in the excerpt; the 101-test run shows no error-frame journal case.
- Fallback policy: 5xx SSE errors become kind `server` (`fallbackEligible: true`), the same as the relay's existing 503/502 HTTP errors and mid-stream `res.destroy()` → `network`. Whether the request pipeline can switch to an online fallback preset while local AI is enabled is outside the supplied source — nothing reviewed here introduces a fallback, but the goal is not proven by these files alone.
- Non-numeric `error.code` (e.g., OpenAI string codes with `type: invalid_request_error`) maps to 500/`server` → retryable; `error: false` or `error: {}` would now abort a stream. No known provider emits these, but the parser is global.
- Settings toggles themselves lack a directory fsync, so a just-saved mode change can be lost on power loss in either direction (including online→local reverting to online). Small window.
- Importing while `enabled: false` leaves a running (later sleeping) engine and shows "이제 인터넷 없이 대화할 수 있어요" although the mode is still online — status line is accurate; message is misleading.
- Prior scope, unchanged: a client cancel during the 180 s engine start does not stop the load, so settings stay 409 until it finishes; Windows named-pipe `--host` for a real llama-server is unverified (irrelevant to Android).

## Verdict (this scope only)

The four R3 items are fixed as described, with before/after reproduction for each, and none of them reduces data safety: no path deletes a referenced model, chats are untouched, and no online fallback is introduced. Two new consequences should be resolved or explicitly accepted before this scope is called closed: **A** (unbounded model accumulation between restarts — a real on-device storage problem with a simple fix) and **B** (corrupt-config lockout). The SSE change is correct but is a cross-provider semantic change; its journal-replay and fallback-policy interactions remain unverified. Install/release HOLD stands; nothing here supports a stability claim.
