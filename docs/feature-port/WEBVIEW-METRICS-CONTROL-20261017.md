# API36 WebView 통계 스레드 종료 분리 시험

## 확인한 사실

APK24에서 WebView 렌더러가 실행43초 후 SIGSEGV로 종료됐다. 당시 llama 자식은 없었으며 앱 부모와 Node는 살아 있었다. 기존 `onRenderProcessGone`이 화면을 다시 만들었고 모델/저장 채팅은 유지됐다. 원인을 환경으로 단정하지 않고 분리 시험을 했다.

- 환경: 내부 emulator-5572, API36/x86_64/16KiB, WebView133.0.6943.137, Android kernel6.6.66-android15-8-gd0c43a640eab-ab13812146.
- 대조 앱: `tmp/webview-control`의 빈 HTML WebView. RisuBard 웹 코드·Node·llama 라이브러리 없음. 소스는 기존 MainActivity.java7줄이며 변경하지 않았다.
- 첫 대조군198초에서는 재현되지 않았다. 이는 발생하지 않는다는 증거가 아니었다.
- 공식 ART 소스의 통계 보고는 임의 session ID를 표본화한다. 해당 에뮬레이터의 `runtime_native/metrics.reporting-mods`는2였다.
- 내부 에뮬레이터의 userdebug ADB 진단 권한으로 이 값만 임시100으로 바꾸어 빈 WebView를 다시 실행했다. 다른 앱 코드나 샌드박스 정책은 바꾸지 않았다.
- 대조군 렌더러도8초 후 `Metrics Backgro` 스레드에서 SIGSEGV로 종료했다. 원래 앱 종료와 **14개 스택 프레임의 주소·심볼·Build ID가 모두 동일**했다. `libmonochrome`, `KernelSupportsUffd`, `StatsdBackend::ReportCounter`, `MetricsReporter` 경로다.
- 값2, 별도로 시도했던 빈 `dalvik.vm.metrics.reporting-mods` 속성, ADB shell UID2000을 모두 복원했다. 대조 앱을 종료했고 Offline을 재시작했다. 물리 기기는 사용하지 않았다.

이 결과는 해당 종료 경로가 RisuBard/로컬 AI 없이도 발생하는 **시험 환경의 Android·WebView 호환 문제**임을 분리한다. 모든 네이티브 종료나 실제 ARM64 기기 안정성까지 설명하거나 보증하지 않는다. 최상단 Chromium 주소의 정확한 심볼/수정 커밋은 확인하지 않았다. 테스트 통계 기능을 끄는 우회는 제품에 넣지 않았다.

## 근거

원본 및 대조: `tmp/offline-native/apk24-renderer-crash.log`, `control-forced-metrics-logcat.txt`, `webview-crash-control-comparison.json`(14/14, equal=true). 원래 설정과 복원: `metrics-device-config-before.json`, `metrics-control-before.json`, `metrics-restored.json`. 로그는 합성 내부 시험이며 공개 릴리즈에 원본 minidump를 싣지 않는다.

코드 대조 출처: [ART 통계 reporter](https://android.googlesource.com/platform/art/+/refs/heads/android16-release/runtime/metrics/reporter.cc), [ART 통계 플래그](https://android.googlesource.com/platform/art/+/refs/heads/android16-release/libartbase/base/flags.h), [ART statsd](https://android.googlesource.com/platform/art/+/refs/heads/android16-release/runtime/metrics/statsd.cc). 해당 시점 읽은 사본은 tmp/offline-native/art-*에 있다. Chromium 샌드박스와의 세부 상호작용은 아직 추론이며 위 실제 대조 결과와 구분한다.
