# Fable 전송 검수 — native4

실제 모델: claude-fable-5-1; effort=xhigh; is_error=false.
입력 사본·해시·원문: `tmp/fable-readonly-native4/`. 읽기 전용 검수이며 실기기 승인이나 전체 무결함 보증이 아니다.

**Verdict: one confirmed defect, in the test, not the guard.** The MainActivity guard is correct. The new RuntimeInstrumentation line does not compile, so the new assertion has not been exercised.

**Guard, MainActivity.kt:225-235: no defect.** The extraction matches PlaySetController.receiveIntent at lines 328-333 exactly. A launcher ACTION_MAIN yields a null URI, so the scheme check fails and the method returns before touching the buffer. A buffered picker result or file intent survives the launcher tap. A file:// URI is dropped, which keeps the content-only trust boundary. Only VIEW/SEND content URIs reach dispatch or the buffer, as before.

**Confirmed defect, RuntimeInstrumentation.kt:116: compile error.**
- The variable is statically typed as Activity, since it comes from startActivitySync and waitForMonitorWithTimeout.
- Activity.onNewIntent is protected. RuntimeInstrumentation is not an Activity subclass and is not in package android.app, so the direct call is rejected by both Java and Kotlin rules.
- The same file already uses reflection for the equally protected onActivityResult at line 93, which is consistent with this.

Reproduction: build the androidTest source set. Expected error:

```
RuntimeInstrumentation.kt:116: Cannot access 'onNewIntent': it is protected in 'Activity'
```

Consequence: the androidTest APK does not build, so the assertion at line 117 and the pickerRecovery report cannot have run against this version.

Minimal fix, replace line 116 with the public Instrumentation API that exists for this purpose:

```kotlin
callActivityOnNewIntent(activity, Intent(Intent.ACTION_MAIN))
```

Reflection in the style of line 93 would also work. Line 117 itself is logically correct once the call compiles. It asserts the buffered URI is unchanged after the ACTION_MAIN, which the guard guarantees.

**Pre-existing note, not a defect of this change.** The untyped getParcelableExtra inserts a checkcast to Uri at the call site. A hostile ACTION_SEND carrying a non-Uri Parcelable in EXTRA_STREAM throws ClassCastException. That crash was already reachable through receiveIntent and now surfaces one frame earlier in onNewIntent. Unchanged behavior, out of scope.
