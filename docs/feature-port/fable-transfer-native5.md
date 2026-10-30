# Fable 전송 검수 — native5

실제 모델: claude-fable-5-1; effort=xhigh; is_error=false.
입력 사본·해시·원문: `tmp/fable-readonly-native5/`. 읽기 전용 검수이며 실기기 승인이나 전체 무결함 보증이 아니다.

Verdict: no confirmed defect in either test-only correction. The Android fix is correct and the pass is genuine. The Windows retry is bounded and does not weaken the eight-held assertion. One test-side gap remains worth closing, detailed below.

**Android, `RuntimeInstrumentation.kt:116`.** `callActivityOnNewIntent` is a public Instrumentation API that reaches the override through `performNewIntent`, on the main thread inside `runOnMainSync`. With an ACTION_MAIN intent the guard at `MainActivity.kt:232` returns before touching the buffer, and the re-check on the next line proves it. The recreated instance can only reach the inbox through the saved-state path at `MainActivity.kt:49`, because the launch intent carries no content URI and the old instance's page flag was forced false before `recreate()`. The monitor is registered after the first launch, so it can only match the relaunch. The reported pickerRecovery result is a true positive.

**Windows, `transfer-windows.test.ts:49-60`.** The retry is scoped to ENOENT and EBUSY, capped at about one second per socket, and stops once a socket is held. The hold still keeps all eight open for the full window and checks the child's exit code afterwards, so a fatal exit at the ninth instance still fails. A dead or crashed helper exhausts the retry and throws. No false positive in the stress assertion itself.

**Remaining gap: the test cannot see a product-spawned duplicate helper.** The comment at line 50 attributes ENOENT to a pipe still being disposed, but the server opens the next listener immediately after accept at `PlaySetService.cs:278-283`, before the RPC body runs. ENOENT means zero pipe instances existed, which in this helper only happens during the 250 ms backoff at line 281 or before the first listener is up. The product client's reaction to that same condition is not a plain retry. On a failed connect, `transfer-windows.cjs:24-35` spawns a second helper on the same pipe name, owned by the calling process. The test's `start()` readiness is the identity file plus a fixed 150 ms sleep, which on restart does not confirm a listener exists. If any of the five product RPCs or the post-restart identity calls hit that window, a duplicate helper answers, every assertion passes, and the duplicate lingers until vitest exits. Two test-only additions make this detectable:

```ts
// hoist `pipe` above start(); probe the listener instead of sleeping 150 ms
const probe = () => new Promise<void>((yes, no) => { const s = connect(pipe); s.once('connect', () => { s.destroy(); yes() }); s.once('error', no) })
// in start(), after identity.dpapi exists:
for (let n = 0; n < 100; n++) { try { await probe(); return } catch { await new Promise(r => setTimeout(r, 50)) } }
throw new Error('Broker did not listen')

// after expect(child!.exitCode).toBe(0): nothing else may still answer the pipe
await expect(probe()).rejects.toMatchObject({ code: 'ENOENT' })
```

**Minor.** Node's libuv handles ERROR_PIPE_BUSY internally by waiting up to 30 s on the pipe, so the EBUSY branch is effectively unreachable and a busy condition surfaces as a long block then ETIMEDOUT. Harmless under the 60 s test timeout.
