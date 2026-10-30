# Fable 5.1 · xhigh 기기 내 AI 2차 검수

실제 종료0/is_error=false/modelUsage claude-fable-5-1. 원본 tmp/offline-native/fable-review-2.json.

# Round 2 review — remaining findings

Scope: supplied source and tests only. No tool use. Claims about ARM64/WebView behaviour are treated as unverified until the pending runtime evidence arrives.

## Proved defects (from code reading; not covered by the supplied tests)

### D1. `nativeRequest` falls back to TCP `localhost:80` when the engine dies mid-relay

`relay()` builds `nativeRequest` with `socketPath: endpoint`, evaluated at *each call*. `endpoint` is cleared asynchronously by the child's `close` handler (and by `stop()`). `ready()` only guards the first instant; after it resolves there are three sequential native calls (`/apply-template` → `/tokenize` → completion) plus the streaming pipe, and any number of concurrent relays that already passed `ready()`.

If the engine exits in that window (realistic on a phone: LMK/OOM kill during prompt evaluation, which is exactly when memory peaks), `endpoint` becomes `undefined` and Node's `http.request('http://localhost/…', { socketPath: undefined, … })` connects over TCP to `localhost:80`, carrying `Authorization: Bearer <key>` and the full prompt body. Consequences:

- The user gets a raw English Node error (`connect ECONNREFUSED 127.0.0.1:80`) instead of a localized "engine stopped" message; nothing in the UI explains that the next request will relaunch the model.
- It contradicts the A12 intent ("no key sent to shared loopback"). The key is per-start and the engine is dead, so the leak is practically harmless on Android where nothing listens on :80, but on a developer machine with a local web server the prompt text itself would be delivered to it.

Fix: after `await ready()`, snapshot `const socket = endpoint` and throw `failure('모델 실행이 중단됐어요. 다시 시도하면 모델을 다시 불러와요.', 503)` whenever `socket`/`endpoint` is falsy before each native call; also map `ECONNREFUSED`/`ECONNRESET`/`EPIPE`/`ENOENT` from `fetchImpl` to the same 503. No test exercises an engine death after `ready()`.

### D2. `/apply-template` and `/tokenize` pre-flight errors are mis-reported

```js
const template = await templated.json();
if (!templated.ok || typeof template.prompt !== 'string') throw failure('이 모델이 대화 형식을 처리하지 못했어요.', 422);
```

Two issues, both certain from the code:

1. `.json()` runs before the status check. A non-JSON upstream body (e.g. a plain-text 503 or a connection cut mid-body) surfaces as a 500 `Unexpected token …` rather than a meaningful message.
2. Every non-OK status (400 bad messages, 503 loading/sleep transition, 500) is collapsed into "this model can't handle the chat format" (or "couldn't count tokens" for `/tokenize`), discarding llama-server's `error.message`. After an idle unload, a transient 503 would be presented as a permanent model incompatibility, and a genuinely malformed request would be blamed on the model.

Fix: check `ok` first, parse `error?.message` when present, pass 503 through as 503 with a "준비 중" message, and reserve 422 for 400-class template failures. The fake engine always returns 200 for these routes, so the supplied tests cannot catch this.

### D3. Upload size-overrun error cannot reach the client

In `importModel`, the verifier rejects with "모델 파일 크기가 달라졌어요" while the request body is still streaming. `stream/promises.pipeline` then destroys every stream in the chain, including `req`; `IncomingMessage._destroy` on an incomplete request destroys the underlying socket. By the time `route()` catches the error, `res.destroyed` is true and the JSON body is dropped. The WebView sees `TypeError: Failed to fetch` instead of the Korean message; the settings page then shows that generic text. The service-level test asserts the thrown error (`'크기'`) but no HTTP-level test asserts delivery.

Impact is minor (the file is cleaned up and the old model is preserved, which *is* tested). If the message matters, drain/ignore the remainder (`req.resume()` with a byte cap) instead of destroying, or accept the generic failure and document it. Note this also means A15's "error response closes unconsumed upload socket" is proved only for errors thrown *before* `pipeline` starts (statfs, header validation, busy); whether Chrome/WebView actually reads such an early response while still sending a multi-GB body is a browser behaviour not covered by any supplied test (see R5).

### D4. Any token count starts (or wakes) the engine

`tokenizer.encode()` unconditionally routes to `tokenizeGGUFModel` when `localAI.enabled`, and `relay('/tokenize')` calls `ready()`. Therefore every `encode()` call anywhere in the app (character/lorebook editors, token counters, memory maintenance, not just `sendChat`) will spawn llama-server with the full model if it is not running, block up to 180 s on that HTTP call, and hold `requests > 0` so settings/import return 409 "모델 준비나 응답 생성이 끝난 뒤" during that time. Combined with the 120 s idle unload this can produce load/unload churn from UI browsing alone, which is a memory/battery cost on a tablet. Also proved: with no model selected, `encode()` rejects with the 409 "choose a model" text rather than degrading.

This is a consequence of design decisions you have stated are deliberate (fresh default enabled, 409 guidance), so I list it as proved behaviour needing a product decision rather than a bug: either (a) serve `/tokenize` without `ready()` when the engine is not running by falling back to an approximate client-side count, or (b) accept and document that counting loads the model. Whether existing UI callers tolerate a rejecting `encode()` is not provable from the supplied code (see R4).

## Unverified risks (cannot be settled from supplied material; the runtime evidence should cover them)

### R1. Idle sleep + the new `/apply-template`-first path

The earlier emulator run proved idle unload → `/v1/chat/completions` works. Round 2 changed the first request after idle to `/apply-template` then `/tokenize`. The supplied `server-context.cpp` excerpt shows both handlers touching `ctx_server.vocab` directly with no sleep guard, while `get_models` explicitly says ctx_server must not be used during sleep. Whether wake-up is implemented in HTTP middleware (safe) or only in the task queue (unsafe for these two handlers: dangling vocab → crash/503) is not visible in the excerpts. The repeat run must include: generate → wait >120 s → generate again, and confirm no 422/502/500 and no engine restart in logs. If it fails, D2 will mislabel it.

### R2. Unix socket path length

`path.join(directory, 'engine.sock')` must stay under cpp-httplib's `sizeof(sun_path)` (108 bytes) or `bind_to_port` fails, llama-server exits, and `start()` reports the misleading "GGUF 호환성과 여유 메모리를 확인해 주세요" 503. `/data/user/0/app.risubard.personal.offline.debug/files/` already consumes ~55 bytes before `savePath` and `/local-ai/engine.sock` (21). The debug applicationId is the longest case, so a passing debug-build private-socket run on the emulator is sufficient evidence; the Windows tests use named pipes and prove nothing here. Consider a shorter socket name or a `/data/local` check with an explicit error.

### R3. Orphan GC runs at construction, before port ownership

`createLocalAI` is invoked at `server.cjs` module load, and `initialized` immediately deletes `.part` files and unreferenced `.gguf`. The `server.cjs:7640` comment shows a second instance can exist briefly after losing the port race. If that loser runs module-level code while the owner is mid-import, it can delete the owner's `.part` (import then fails at `rename` with a raw ENOENT) or the already-renamed `.gguf` before `persist` (owner loads it via mmap, persists a reference to a deleted file, model missing after restart). Whether Android ever runs two Node processes against the same `savePath` is not shown. Cheap mitigation: defer GC until the server has bound (`embedded.ready`/`listening`), or take an exclusive lock file.

### R4. `encode()` rejection tolerance in existing UI

See D4. The user-observed "main UI used before model import" suggests callers cope, but the supplied code does not show them; unhandled-rejection noise in token counters remains unverified.

### R5. Early error responses during a large upload

For pre-stream errors (507 space, 409 busy, 400 header), `route()` sends the JSON then destroys `req` after `finish`. Chrome frequently reports `ERR_CONNECTION_RESET`/`Failed to fetch` when a server responds and closes before the body finishes uploading. No supplied test exercises `/model` over HTTP. The 507 path is the likely one on a real phone; it should be demonstrated with a large file and nearly-full storage, or the client message should not rely on reading the body.

### R6. Minor hardening (no action required to ship)

- `socketFetch`: `new Response(body, {status})` throws for 1xx/204/205/304 inside the `http.request` callback, which would be an uncaught exception in the server process. llama-server does not emit these for our routes; a try/catch around construction removes the theoretical crash.
- `LocalAISettings.svelte` snapshots `context`/`output` at mount; if `refreshLocalAI()` updates `localAI` later, inputs show stale values.
- `relay` reports "모델을 준비 중이에요" when `closed`; "앱을 다시 열어 주세요" (as in `idle()`) is the accurate text.

## Claims vs supplied tests

Backed by supplied tests (fake engine over real process + HTTP): A3 (clamp/invalid body/caps), A4 (template token counting, overflow 422 via `context-full`), A6 (startup error leaves `enabled: true`), A7 (orphan GC only with valid settings; path-like record → `model: null`, note the test writes an *invalid* record so `settingsValid=false` — the "corrupt config preserves models" branch is exercised only indirectly), A8/A9 (settings 409 during stream, disconnect → `busy` false, restart on demand), A11 (missing executable), A12 only on the Windows named-pipe branch, A13 only via fake `/props` echoing `--ctx-size` (the real clamp is shown in `n_ctx_slot()` source; actual 422 on a small-train-ctx model is untested).

Proved by code reading only (no test): A1 (bootstrap catch), A5 (abort on destroy + warning text), A10 (`result.error ??` fallbacks), A14 (`multimodals` → `fail`, `noRetry`, no fallback list, tools stripped), A15 (only the pre-stream case; see D3/R5), `useServerJob` gating and `fallBackModels=[]` in `request.ts`.

Not tested anywhere: engine death after `ready()` (D1), non-OK `/apply-template`/`/tokenize` (D2), HTTP-level upload error delivery (D3/R5), Unix socket bind on Linux (R2), sleep→template path (R1), concurrent instance GC (R3).

## Items I did not re-litigate

Per your round-2 instructions: 409 choose-model guidance for the fresh default, navigation abort during import, attachment rejection, and client-side output reservation (`inputTokenLimit` only subtracts `maxResponseTokens` when `requiredWikiMessage`; the server-side clamp now bounds the consequence, at worst a short reply near the context edge). The `llama-owner-main.cpp` PDEATHSIG/parent check, `verify-local-engine.mjs` pinning, the separate `applicationId`, and `useLegacyPackaging` for an executable `.so` are consistent with the stated goals as far as the supplied files show.

## Bottom line

No blocking defect in the supplied round-2 source. D1 is the one I would fix before the physical ARM64 run because it is the most likely real-device failure mode (engine OOM) and currently produces a confusing error and an unintended loopback TCP request. D2 should be fixed alongside it so that R1, if it fails on device, is reported accurately. D3/D4 are product-level choices. R1–R3 are what the pending private-socket runtime evidence needs to demonstrate explicitly; I will not treat the earlier APK22 run as covering them.