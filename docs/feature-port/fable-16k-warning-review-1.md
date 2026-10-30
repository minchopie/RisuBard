# 16KiB 경고 수정 검토 결과 (읽기 전용, 제공 자료만 근거)

## 총평

- 경고 원인(ARM64 `libnode.so`의 4KiB LOAD 정렬)은 제공된 ELF 비교로 확정되고, APK `b3ef9a…` 내부 바이트의 두 ABI 모두 LOAD p_align=16384로 교체된 것도 자료로 뒷받침된다.
- 디버그 게이트(`verifyRuntimeForDebug` → `preDebugBuild`) 배선은 fixture 로그(4K 거부 / 16K 통과)로 입증된다.
- 단, 게이트 스크립트에 **무음 통과 경로**가 하나 있고, 증거 묶음에는 실제 `assembleDebug` 로그·에뮬레이터 페이지 크기 기록이 빠져 있다. ARM64 신 바이너리 런타임은 0회 실행(보류 준수)이라 “16KiB에서 돈다”는 말은 할 수 없다.

---

## A. 입증된 결함 (코드 판독으로 확정)

### A-1. [중간] `verify-runtime.mjs` CLI 가드의 무음 통과 경로
- 근거: 마지막 블록 `if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))`. Node는 메인 모듈 경로를 `--preserve-symlinks-main` 없이는 realpath로 해석하므로, 프로젝트가 junction/심볼릭 링크/8.3 단축명 경로로 호출되면 `argv[1]`(호출 경로) ≠ `import.meta.url`(실경로)이 되어 본문이 **전혀 실행되지 않고 exit 0**으로 끝난다. Gradle `Exec`는 종료 코드만 보므로 게이트가 “성공”으로 기록된다.
- README가 Windows 한글 경로 우회로 junction을 안내하고(SDK 경로 대상이지만), 현재 프로젝트 경로 자체에도 한글이 포함돼 있어(`gate-4k-after.log`의 `%EB%A7%88…`) 비현실적 시나리오가 아니다. 제공된 로그에서는 직접 경로로 호출되어 실제 출력(`Verified 16KiB runtime`)이 찍혔으므로 **이번 증거에서 발현되지는 않았다.**
- 최소 수정(택1, 둘 다 권장):
  1. 스크립트: 가드를 `realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))`로 교체(`node:fs`에서 `realpathSync` import 1줄 추가).
  2. Gradle: `verifyRuntimeForDebug`/`ForRelease`에 `standardOutput` 캡처 후 `doLast`에서 `Verified 16KiB runtime:` 문자열 부재 시 `throw GradleException`. 종료 코드가 아닌 실제 검증 출력에 성공을 결속시킨다.

### A-2. [낮음] 게이트 검사 대상이 `src/main/jniLibs`/`assets` 원본에 한정
- 근거: `verifyRuntime(root)`는 `app/src/main` 하위만 읽는다. `src/debug/jniLibs`, 의존성 AAR의 `.so`, 병합 산출물(`merged_native_libs`)이나 최종 APK는 보지 않는다. 현재 APK에 네이티브 항목이 둘뿐인 것은 `apk-native-entries.json`으로 확인되나, 이는 게이트가 보장하는 것이 아니라 별도 사후 검사 결과다.
- 목표 범위(런타임 `libnode.so`의 4K 유입 차단)에는 부합하므로 결함이라기보다 README의 “모든 네이티브 파일” 표현이 과하다. 최소 수정: README에 “`src/main/jniLibs` 기준”을 명시. APK 내 `lib/**/*.so` 전수 검사는 별도 작업으로 분리.

### A-3. [낮음] README 실패 지점 오기술
- “이전 4KiB 캐시를 넣으면 빌드가 실패한다”: 캐시 `tmp/android-node/*.tar.xz`를 바꾸면 게이트가 아니라 `package-runtime.mjs`의 `Runtime archive hash mismatch`(lock 해시)에서 실패한다. 게이트가 잡는 것은 `jniLibs`에 들어간 4KiB `libnode.so`(해시 JSON을 맞춰 넣어도 `inspectElf`가 거부 — 테스트 3번째 케이스로 입증). 문구를 “4KiB `libnode.so`를 jniLibs에 넣으면”으로 교정.

### A-4. [낮음] 작업 이름 문자열 결합
- `tasks.matching { it.name == "preDebugBuild" }`는 flavor가 추가되면(`preFreeDebugBuild`) 아무 경고 없이 비활성화되고, closure 매칭은 전체 태스크를 실체화한다. 현 구성(flavor 없음)에서는 동작이 로그로 확인됐으니 지금 바꿀 필요는 없다. 기록만 남긴다.

---

## B. 입증되지 않은 위험 · 증거 공백 (결함 아님, 미검증)

1. **실제 `assembleDebug assembleDebugAndroidTest` 콘솔 로그 미제출.** `:app:verifyRuntimeForDebug` → `Verified 16KiB runtime: [ 'arm64-v8a', 'x86_64' ]` → `:app:packageDebug` 순서를 보여주는 로그가 묶음에 없다. `runtime-verification.log`는 단독 실행인지 Gradle 출력인지 구분 불가. 게이트 실행은 fixture(`preDebugBuild` 단독 호출, tiny ELF)로만 입증됐다.
2. **x64 “16KiB 에뮬레이터” 페이지 크기 미기록.** `emulator36-apk16-instrumentation.log`에는 `node v24.21.0 x64`가 돌았다는 것만 있고 `getconf PAGESIZE` 류 값이 없다. 4K 정렬 PIE는 16K 커널에서 exec가 실패하므로 실행 성공 자체가 간접 증거이긴 하나, 그 전제(에뮬레이터가 16K)가 로그 안에 없다. 권장: `runtime-probe.cjs` 출력 JSON에 `pageSize`(예: `getconf PAGESIZE` 결과) 필드 추가.
3. **에뮬레이터 로그 ↔ APK `b3ef9a…` 연결 미기록.** 로그에 APK/바이너리 SHA가 없다. “바이트 동일”은 요약 진술이며 전·후 두 번의 해시 기록이 묶음에 없다.
4. **실제 구 바이너리(`efde9d…`)를 게이트에 직접 통과시킨 로그 없음.** fixture는 128바이트 합성 ELF. 코드상 첫 LOAD(p_align 4096 < 16384)에서 즉시 거부되는 것은 확정적이지만 직접 증거는 아니다.
5. **ARM64 신 바이너리 런타임 0회.** 실기기 보류·ARM64 에뮬레이터 미실행. 아래 C-3의 정적 계산은 일관되나 런타임 증거를 대체하지 않는다.
6. **디버그·릴리스 동시 호출 시 순서 비결정.** `verifyRuntimeForDebug`와 `packageRuntimeForRelease`가 같은 미선언 파일(`assets/*`, `jniLibs/*`)을 읽고/쓴다. 한 invocation에 둘을 섞으면 검증 시점과 패키징 시점의 바이트가 다를 수 있다. 권장: 동시 호출 금지 또는 `verifyRuntimeForDebug { mustRunAfter(packageRuntimeForRelease) }`. 기존 구조의 위험이며 이번 diff가 새로 만든 것은 아니다.
7. **디버그 빌드의 신규 전제조건.** 이제 `node`가 PATH에 없으면 디버그 빌드도 실패한다(fail-closed, 의도에 부합). `jniLibs`가 없는 신규 체크아웃에서는 ENOENT 원문 에러로 실패해 메시지가 불친절하지만 안전 측면 문제는 없다.

---

## C. 세부 확인

### C-1. 릴리스 빌드 무변경 여부
- `build.gradle.diff` 기준 추가된 5줄은 디버그 태스크 1개 + `preDebugBuild` 배선만이며, `buildWebForRelease → packageRuntimeForRelease → verifyRuntimeForRelease → preReleaseBuild` 체인 라인은 그대로다. 태스크 이름 충돌 없음. **정적으로 무변경.** `assembleRelease` 실행 증거는 없고, 제약(no release)상 실행하지 않은 것이 맞다.

### C-2. 디버그 전제조건이 실제로 도는가
- fixture: 변경 전 `preDebugBuild UP-TO-DATE`로 통과(`gate-4k-before.log`) → 변경 후 동일 4K fixture가 `verifyRuntimeForDebug FAILED … LOAD segment must support 16384-byte pages`(`gate-4k-after.log`), 16K fixture는 `Verified 16KiB runtime: [ 'arm64-v8a' ]` 후 `preDebugBuild` 실행(`gate-16k-after.log`). 배선·거부·수용 모두 입증.
- Exec 태스크에 입력/출력 선언이 없어 매 빌드 재실행된다(게이트로서 바람직; 비용은 `runtime.zip` + 약 95MB×2 바이너리를 매번 전량 해시).
- 실제 전체 빌드에서의 실행은 B-1대로 미제출.

### C-3. LOAD/RELRO/패키징 증거가 한정 주장을 지지하는가
- **구 바이너리 원인 확정:** `oldPrototype` LOAD 4개 중 3개 p_align=4096. LOAD#1 끝(59,497,252)과 LOAD#2 vaddr(59,502,592)이 16K 페이지(≈[59,490,304, 59,506,688)) 하나를 공유 → 16K 페이지 환경에서 RX/RW가 같은 페이지에 걸려 로드 불가. 스크린샷 문구(“LOAD segments not aligned”)와 정합. 설치 패키지 SHA는 재판독 전이므로 이미지로부터 단정하지 않는다.
- **신 ARM64:** 3 LOAD 모두 p_align=16384. `inspectElf`의 합동 조건(offset ≡ vaddr mod 16384)도 수치로 확인: LOAD#2 vaddr−offset=16,384, LOAD#3 =32,768. LOAD#1 끝(93,766,976)은 페이지 5723, LOAD#2 시작(93,783,360)은 페이지 5724 → 페이지 공유 없음. LOAD#2 끝 95,043,584 = 16384×5801(경계), LOAD#3 시작 95,059,968 = 16384×5802(경계). GNU_RELRO [93,783,360, 95,036,944)를 페이지 반올림하면 정확히 LOAD#2 매핑 안에 머문다. `-z max-page-size=16384 -z common-page-size=16384` 결과와 일관.
- **신 x86_64:** 동일 패턴(LOAD#2 끝 97,042,432=16384×5923, LOAD#3 시작 97,058,816=16384×5924, RELRO 반올림 LOAD#2 내). 이 ABI는 에뮬레이터 실행 로그 존재(페이지 크기 미기록은 B-2).
- **패키징:** 두 항목 모두 compression=8(압축) + `extractNativeLibs=true/useLegacyPackaging=true`. 압축 네이티브는 설치 시 추출되므로 16K 요건은 ELF 정렬만이고 그것은 충족. `zipalign -P16`은 비압축 `.so`에만 의미가 있어 통과 자체는 약한 증거다(틀린 것은 아님). v2 서명 검증 통과는 APK 무결성 증거이지 16K 증거는 아니다.
- **결론:** “APK `b3ef9a…` 안의 두 `libnode.so`는 16K 호환 LOAD 레이아웃이며, 디버그 빌드는 `src/main/jniLibs`의 4K `libnode.so`를 거부한다”까지는 지지된다. 그 이상(ARM64 16K 기기에서 실행 성공)은 지지되지 않는다.

### C-4. 실기기 vs 에뮬레이터
- **에뮬레이터(x86_64, API 36):** 신 x64 바이너리 실행 성공 로그 있음. 페이지 크기 자체는 로그에 없음(B-2).
- **실기기(ARM64 태블릿·폰):** APK7(구 4K ARM64)이 설치된 것으로 알려져 있고 재판독 없음. 스크린샷이 `lib/arm64-v8a`를 지목하므로 ARM64 대상(실기기 또는 ARM64 에뮬레이터)에서 나온 경고라는 추론은 되나, 어느 기기·어느 SHA인지는 자료로 특정 불가. 보류 유지 중이므로 **그 기기에서 보이는 경고는 새 APK가 설치되기 전까지 사라지지 않는다** — 이는 경고를 숨기는 문제가 아니라 설치본이 바뀌지 않았다는 사실 기술이다. 실기기 없이 경고 소멸을 확인하려면 Android Studio APK Analyzer로 `b3ef9a…`를 열어 16KB 검사 결과를 기록하는 방식이 있다(제공 자료엔 없음).

---

## D. 범위 수용

**조건부 수용.** 이번 작업의 명시 목표(경고 원인 제거 + 디버그 APK로의 4K 런타임 유입 차단)는 코드·바이트·fixture 증거로 뒷받침되며, 릴리스 체인·앱 데이터·실기기에 손대지 않았다는 제약도 diff 기준 지켜졌다.

수용 조건:
1. A-1 무음 통과 경로를 막을 것(스크립트 realpath 비교 또는 Gradle stdout 마커 검사, 어느 쪽이든 수 줄).
2. A-3 README 문구 교정, A-2의 “src/main/jniLibs 기준” 명시.
3. 증거 묶음에 실제 `assembleDebug` 콘솔 로그(게이트 실행 라인 포함)와 가능하면 에뮬레이터 페이지 크기 출력을 추가. 이것은 코드 변경이 아닌 기록 보강이다.

수용하지 않는 서술:
- “ARM64 16KiB 런타임 검증 완료” — 미실행.
- “모든 네이티브 라이브러리가 게이트로 보장됨” — 게이트는 `src/main/jniLibs`만 본다.
- 스크린샷의 설치본이 특정 SHA라는 단정.

본 검토는 제공된 소스·로그·JSON만 판독했고, 어떤 빌드·추출·기기 조작도 수행하지 않았다.