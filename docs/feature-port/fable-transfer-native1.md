# Fable 전송 검수 — native1

실제 모델: claude-fable-5-1; effort=xhigh; is_error=false.
입력 사본·해시·원문: `tmp/fable-readonly-native1/`. 읽기 전용 검수이며 실기기 승인이나 전체 무결함 보증이 아니다.

Review complete. I read all 12 supplied files. The core-scope server files (play-set-service.cjs, server.cjs, file-store) are not in this directory, so the append/recovery/fingerprint/write-fencing findings below cover only the client side in playTransfer.ts.

## Confirmed defects

**1. Android picker results are dropped after activity recreation** (`android-app/app/src/main/java/app/risubard/personal/MainActivity.kt:184-185`, medium)
`transfers` is only assigned inside the async callback of `connect()` at `MainActivity.kt:136`. When the activity is recreated while a system picker is open (configuration change, or process death under memory pressure), Android delivers the pending result before `onResume`, and the posted callback cannot have run yet. So `transfers?.receive(uri)` for OPEN_FILE is a silent no-op and the chosen file is lost. For SAVE_FILE the designed fallback toast in `saveResult` is never reached because `transfers` is null. The code already handles this for request 102 via `onSaveInstanceState`, but not for the two PlaySetController requests.
Repro: enable "Don't keep activities", trigger `file.open` from the page, pick a file. Nothing is queued and no toast appears.
Minimal fix: buffer the result like `receivedIntent` and deliver it once the controller exists.
```kotlin
private var pendingOpen: Uri? = null
// onActivityResult:
if (requestCode == PlaySetController.OPEN_FILE && resultCode == RESULT_OK) data?.data?.let { uri -> transfers?.receive(uri) ?: run { pendingOpen = uri } }
if (requestCode == PlaySetController.SAVE_FILE) transfers?.saveResult(...) ?: Toast.makeText(this, "저장할 파일을 다시 선택해 주세요.", Toast.LENGTH_LONG).show()
// connect(), right after `transfers = PlaySetController(...)`:
pendingOpen?.let { uri -> transfers?.receive(uri); pendingOpen = null }
```

**2. Windows helper crashes when the pipe instance cap is hit** (`desktop-transfer/src/RisuAI.ChatTransfer.WinForms/PlaySetService.cs:276`, low-medium)
The `NamedPipeServerStream` constructor is outside the try block. Each `Serve` holds its instance for the whole command, and the 15 s heartbeats keep Node waiting indefinitely, so slow commands such as `network.pair`, `usb.devices` or `network.status` accumulate. When 8 instances are busy the ninth constructor call throws IOException ("all pipe instances are busy"). That escapes `Run`, is not matched by the OperationCanceledException filter in Program.cs, and terminates the helper, losing every in-flight transfer and the in-memory progress map. Node then reports "전송 작업을 찾을 수 없습니다" on the next poll.
Minimal fix: move construction inside the try so the existing IOException branch backs off and retries.
```csharp
NamedPipeServerStream pipe;
try { pipe = new NamedPipeServerStream(instancePipeName, PipeDirection.InOut, 8, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
      await pipe.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false); }
catch (IOException) { pipe?.Dispose(); await Task.Delay(250, cancellationToken).ConfigureAwait(false); continue; }
```

**3. Teardown race can kill the Android process** (`PlaySetController.kt:200-201`, low)
`destroy()` shuts down `executor` and the network executors, but a request already dequeued on `controlExecutor` then calls `executor.execute(work)`, which throws RejectedExecutionException on a pool thread. Android's default handler terminates the process. The window is the gap between `destroy()` and an in-flight 3 s inbox poll.
Minimal fix: guard the dispatch.
```kotlin
try { if (...) networkControlExecutor.execute(work) else if (...) work.run() else executor.execute(work) }
catch (_: java.util.concurrent.RejectedExecutionException) { main.removeCallbacks(heartbeat) }
```

## Checked and found sound

- **openPicker exception propagation** (`PlaySetController.kt:38-46`): IllegalStateException from the destroyed check and ActivityNotFoundException both reach the RPC error reply. Only nit: `catch (error: Exception)` leaves the future incomplete on a non-Exception Throwable, which would block the single archive worker forever while heartbeats keep the client waiting. Use `Throwable`.
- **Parent-owned helper shutdown** (`Program.cs:8-21`): cancellation flows from WaitForExitAsync through `Run` to the filtered catch with exit code 0, including when the parent exits during service construction. A faulted wait also cancels, which is fail-safe. Pipe name and instance hash derivation match between Node and C#.
- **Android loopback RPC**: origin, main-frame and local checks are correct, heartbeat and completion both run on the main thread so there is no race, and the inbox dedup under the static lock survives controller replacement.
- **Client-side core flow**: arm precedes the fence, the fence precedes the save, and recovery verifies the committed hashes before finish. No duplicate path found on the client.

## Minor notes

- `sendNative` stops polling on the first error and leaves the store at `sending` (`src/ts/transferNative.ts:71`). Set a failed state there.
- `recoverTransfers` aborts on the first mismatching record, leaving later records unprocessed (`src/ts/playTransfer.ts:116`).
- `versionCode = 1` is fixed in `android-app/app/build.gradle.kts:14`. Upgrading an installed build will need a bump once installation resumes.
