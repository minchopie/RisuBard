# Fable 전송 검수 — native2

실제 모델: claude-fable-5-1; effort=xhigh; is_error=false.
입력 사본·해시·원문: `tmp/fable-readonly-native2/`. 읽기 전용 검수이며 실기기 승인이나 전체 무결함 보증이 아니다.

Review complete. I read the five fixes in MainActivity, PlaySetController, PlaySetService, Program.cs, transfer-windows.cjs, transferNative.ts, the two tests, and the instrumentation.

**Verdict: the five fixes are correct and I found no blocking defect.** One minor lifecycle gap remains in the intent-buffering area, plus two non-blocking notes.

**Minor defect: an incoming share intent can still be dropped during a reconnect window.**
The three delivery sites do not use the same predicate. The picker result in `onActivityResult` gates on `transfers != null && transferPageLocal`, which matches what `receiveIntent` checks internally. But `onNewIntent` at `MainActivity.kt:227` gates on `webView.url` instead, and the drain at `MainActivity.kt:87` nulls the buffer regardless of whether `receiveIntent` consumed it.
Reproduction: page loaded, tap "다시 시도". The new controller sets `transferPageLocal = false` and if the cookie callback reports not accepted, no reload happens, so the flag stays false. Share a .risuplay to the app now. `webView.url` is still local, so `receiveIntent` is called, returns early on the flag, and the file is silently dropped. The same race hits the drain if the old page finishes while the flag is false.
Minimal fix: use one predicate everywhere. In `onNewIntent`, replace the url test with the same `transfers != null && transferPageLocal` check, else buffer. In `onPageFinished`, only clear the buffer when the flag is true, or make `receiveIntent` return a Boolean and clear on true. Severity is low because the user can re-share, but it is the same class of loss the fix targeted.

**Confirmed working:**
- **Picker buffering across recreation.** Save/restore via the bundle is correct, the fresh-launch intent is only replayed when there is no saved state, and the drain runs on the real local page. The URI grant survives recreation because it is bound to the ActivityRecord, so the restored intent stays readable. No duplicate path: the buffer is cleared synchronously at drain.
- **SAVE_FILE null controller.** Both branches end in the retry toast, and the export under play-transfer is preserved. Note the picker already created an empty target document on the retry path. Persisting the handle in the activity would let the save complete instead. Optional.
- **Executor rejection.** Outer and inner rejections are swallowed and the inner one removes the heartbeat. `destroyed` is set before the WebView is torn down and all reply posts check it, so no post to a dead bridge.
- **Windows pipe retry.** ERROR_PIPE_BUSY from the constructor maps to a plain IOException, so the catch covers it. Cancellation inside the retry delay still surfaces as OperationCanceledException and is filtered to a clean exit in Program.cs. Non-IO failures still crash, which is acceptable. Side effect during saturation: the Node client's one-second connect timeout spawns a duplicate helper that exits on the Local mutex, then probes for ten seconds. Benign.
- **Poll 'unknown' state.** Honest wording, test matches. Non-blocking note: a single failed `.status` probe after `delivered` stops polling permanently and overwrites the delivered state. Android closes its receiver on `onStop`, so a phone with its screen off makes this the common path after a successful Wi-Fi send. Minimal improvement: wrap only the `.status` call in its own try/catch, keep `delivered`, and continue polling.

**Instrumentation test.** The monitor approach is valid: relaunch goes through `postPerformCreate`, which matches monitors, so `waitForMonitorWithTimeout` returns the recreated instance. The test uses a same-app FileProvider URI, so it does not exercise cross-app grant survival. Document that as a scope limit. Result is still awaiting the build, so I make no pass claim.

**Not re-reviewed:** EmbeddedServer, TransferCredential, cryptography, core recovery.
