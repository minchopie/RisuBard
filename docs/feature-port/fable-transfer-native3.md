# Fable 전송 검수 — native3

실제 모델: claude-fable-5-1; effort=xhigh; is_error=false.
입력 사본·해시·원문: `tmp/fable-readonly-native3/`. 읽기 전용 검수이며 실기기 승인이나 전체 무결함 보증이 아니다.

**Verdict: no confirmed defect in either fix.** Both the intent-gating predicate and the delivered-receipt poll behave correctly in every sequence I traced, and the two bridge tests exercise the intended paths.

**Predicate fix, MainActivity.kt:82-89 and :225-229**

- The three dispatch sites use one predicate, and the inner `local()` checks in `PlaySetController.receiveIntent` and `receive` read the same volatile flag on the same thread, so a dispatched intent can never be silently dropped by a mismatched gate.
- The drain in onPageFinished nulls the buffer only after handing off, and runs on the main thread, so there is no double delivery between onPageFinished and onNewIntent.
- Recreate and process restore are safe. Line 49 restores the buffer from the bundle and ignores the launch intent when a bundle exists, so a consumed launch intent is never replayed. Retry resets the flag before the new load and onPageStarted re-arms it, so the window is only the loadUrl latency.
- Draining after a main-frame load error still works because the native inbox path does not depend on the page.

**Poll fix, transferNative.ts:57-79**

- Exactly one timer chain exists per generation. The delivered branch schedules once whether status succeeds, returns non-applied, or throws. Terminal states return without scheduling.
- Every store write after an await is guarded by the generation check, including the applied write at line 69 and the catch at line 71. A stale generation can only fall through to a poll that exits immediately.
- A failed `.send` leaves the generation unbumped, so the previous transfer's poll keeps running. That is the right behavior.
- Test 2 genuinely verifies the fix: it asserts the second status call and the applied transition after the 2 s timer.

**Two minor notes, not defects**

- `onNewIntent` else-branch overwrites a still-buffered transfer intent. If launchMode is singleTask or singleTop, a launcher tap during server startup replaces a pending share with an ACTION_MAIN intent, which `receiveIntent` later discards. Minimal fix: only assign the buffer when the action is VIEW or SEND with a content URI, or make the buffer a list.
- While the receiver is unreachable, the status text alternates every 2 s between "전달 완료 · 가져오기 대기" at line 66 and the catch message at line 71. Minimal fix: set line 66 only when the current status text is not already a delivered-class message.
