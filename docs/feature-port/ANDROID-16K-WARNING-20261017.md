# Android 16KB 호환성 경고 — 2026-10-17

## 요청과 원인

사용자 화면의 오류는 `lib/arm64-v8a/libnode.so`의 `LOAD` 세그먼트 정렬 실패다. 초기 실기기 프로토타입에 사용한 ARM64 Node에는 4,096바이트 정렬 세그먼트가 세 개 있다. 현재 내부 APK16의 자체 빌드 Node는 ARM64·x86_64 모두 16,384바이트 정렬이다.

실기기 설치 보류 전에 설치한 프로토타입과 이후 로컬 APK를 구분한다. 이번에는 실기기를 조회하거나 설치하지 않았으므로 스크린샷만으로 현재 설치 파일의 SHA-256이나 장치 커널의 페이지 크기를 확정하지 않는다. 오류 내용은 보존한 초기 바이너리의 결함과 일치한다.

Android 공식 지침은 사전 빌드 네이티브 라이브러리도 16KB에 맞게 다시 빌드하고 실제 16KB 환경에서 실행하도록 안내한다. 경고를 숨기는 manifest 속성이나 debuggable 변경은 적용하지 않았다.

출처: https://developer.android.com/guide/practices/page-sizes

## 최소 수정

- 기존 자체 Node 빌드의 `max-page-size=16384`, `common-page-size=16384`와 검증된 ARM64·x86_64 산출물을 사용한다. 이번 작업에서 Node를 다시 빌드하지 않았다.
- `android-app/app/build.gradle.kts`에 `preDebugBuild → verifyRuntimeForDebug` 의존성을 추가했다. 기존 `verify-runtime.mjs`가 `app/src/main`의 실제 ZIP 해시·네이티브 파일 집합·바이너리 해시·ABI·16KB LOAD 정렬을 검사한다.
- 실제 Fable 1차 검수의 링크 경로 우회 지적을 재현했다. `verify-runtime.mjs`와 단독 `verify-node.mjs` 모두 CLI 진입 판별에 호출 경로/모듈 경로의 `realpath`를 사용하도록 수정했다. Windows junction을 통한 4KB 거부·16KB 허용을 회귀 검사로 남겼다.
- release 빌드의 웹 빌드 → 재패키징 → 검증 순서는 유지한다.
- README에서 초기 4KB 프로토타입은 현재 debug·release 빌드 모두 통과하지 못한다고 명시했다.
- 사용자 기기의 앱 데이터는 건드리지 않았으며, 앱 실행 코드·서명·manifest도 수정하지 않았다.

## 재현과 검증

실제 Gradle 설정과 검증 스크립트를 복사한 격리 fixture에 최소 ELF를 넣고 해시도 함께 갱신했다. 제품의 실제 라이브러리는 바꾸지 않았다.

| 검사 | 결과 | 근거 |
|---|---|---|
| 수정 전 4KB fixture / `preDebugBuild` | 잘못 통과 — 검사 연결 누락 재현 | `tmp/android-16k-warning/gate-4k-before.log` |
| 수정 후 같은 4KB fixture | `LOAD segment must support 16384-byte pages`로 거부 | `tmp/android-16k-warning/gate-4k-after.log` |
| 수정 후 16KB fixture | 통과 | `tmp/android-16k-warning/gate-16k-after.log` |
| 런타임 단위 검사 | 기존3개 및 링크 경로 회귀1개, 총4개 통과 | `tmp/android-16k-warning/link-final.log` |
| 링크 경로 검사 재현 | 두 CLI 모두 수정 전 4KB 무음 통과, 수정 후 거부·16KB 허용 | `tmp/android-16k-warning/link-before.log`, `node-link-before.log`, `link-final.log` |
| 실제 초기 ARM64 바이너리 | 보존 아카이브의 ELF `efde9d…`를 격리 경로에서 검사해 정렬 실패로 거부 | `tmp/android-16k-warning/old-real-binary-rejected.log` |
| 실제 준비된 런타임 검증 | 두 ABI 통과 | `tmp/android-16k-warning/runtime-verification.log` |
| 실제 `assembleDebug assembleDebugAndroidTest` | 최종 CLI 수정 뒤에도 검사 task 실행 후 빌드 성공 | `tmp/android-16k-warning/apk-reviewed-build.log` |
| release task 연결 | dry-run에서 기존 웹 빌드 → 패키징 → 검증 → preReleaseBuild 순서 유지 | `tmp/android-16k-warning/release-task-graph.log` |
| 최종 APK 내부 파일 | CRC·해시·양 ABI LOAD 정렬·RELRO 끝 정렬·소스/빌드497파일 일치 | `tmp/android-16k-warning/apk-verification.json`, `apk-source-verification.json`, `verification-summary.json` |
| ZIP 정렬·서명 | `zipalign -c -P 16 -v 4`와 APK v2 서명 검증 통과 | `tmp/android-16k-warning/apk-zipalign.log`, `apk-signature.log` |
| API36 x64 에뮬레이터 재실행 | 페이지 크기16,384, 설치 APK 해시 일치, instrumentation 성공 | `tmp/android-16k-warning/emulator-page-size.log`, `emulator-installed-apk.log`, `emulator-instrumentation.log` |

현재 APK의 네이티브 항목은 ARM64·x86_64 `libnode.so` 두 개뿐이며 모두 압축 상태다. `useLegacyPackaging=true`, `extractNativeLibs=true`를 유지한다. ZIP 검사만으로 ELF 호환성을 판단하지 않고 내부 바이너리도 별도 검사했다.

에뮬레이터에서는 인증·자격정보 복구·이미지·Lua·모의 스트리밍·Wiki·저장·백업 보존 검사가 통과했다(`persistedRuns=4`). 실제 제공자 요청이나 물리 기기 전송을 시험한 결과는 아니다.

## 파일과 공동 검수

- 현재 내부 APK: `android-app/app/build/outputs/apk/debug/app-debug.apk`
- SHA-256: `b3ef9accbfd54de39316ba03a72047c1891c2cb74b86477d220bc5eabbda2d09`
- 빌드 검사를 추가한 뒤에도 APK16과 바이트 단위로 동일하다. `apk17-build.log`는 후속 빌드 시도의 이름이며 새 앱 판본을 뜻하지 않는다.
- 이전 APK와 시험 APK 사본은 `tmp/apk16-emulator/`에 보존돼 있다.
- 실제 Fable 5.1·xhigh 1차는 조건부 수용이며, 링크 경로 우회와 README 표현을 지적했다. 우회는 실제 재현 후 수정했고 검사 범위/실패 지점 문구도 교정했다. 현재 검사 대상은 `src/main`이고 최종 APK 내부 파일 전수 검사는 별도라는 경계를 유지한다.
- 1차에 제출되지 않았던 실제 전체 빌드 로그·에뮬레이터 페이지 크기·설치 파일 해시도 2차 입력에 포함했다. 보존 APK16·최종 빌드·실제 에뮬레이터 설치 파일의 해시가 일치한다(`tmp/android-16k-warning/apk-reviewed-hashes.json`).
- 실제 2차 응답의 모델 식별은 `claude-fable-5-1`, `is_error=false`다. **판정은 범위 내 수용: 1차 확정 결함 해소, 새로 입증된 결함 없음.** 원문은 `fable-16k-warning-review-1.md`, `fable-16k-warning-review-2.md`에 보존했다. 검토자는 제출 소스·기록을 읽었으며 직접 빌드나 기기 조작을 수행하지 않았다.
- 2차 제출19파일과 최종 작업본의 해시 일치를 확인했다(`tmp/android-16k-warning/review-input-checks-final.json`). 과거 1차 입력 기록은 그 시점의 스냅샷으로 보존하며, 이후 수정본과 같다고 표시하지 않는다.
- 비차단 메모도 유지한다. 파일 경로가 아닌 `argv[1]`을 주는 특수 eval 호출이나 CJS `require()`는 현재 호출자가 아니며 지원을 추가하지 않았다. flavor 추가나 debug/release 동시 패키징은 별도 검증 대상이다. 짧은 원시 로그의 기기/파일 연결은 실행 절차 및 `verification-summary.json`과 함께 읽어야 한다. 실제 ARM64 기기 승인은 요청하거나 받은 것이 아니다.

## 남은 경계

물리 태블릿·스마트폰 설치와 조작은 사용자 요청에 따라 보류했다. 최종 ARM64 실행 및 해당 기기에서 경고가 사라지는지는 다음 업데이트 후 확인해야 한다. 기존 설치본은 이 코드 변경만으로 바뀌지 않는다. 정식 서명·전체 기능 통합·기기간 전송 검증·릴리즈는 완료하지 않았다.
