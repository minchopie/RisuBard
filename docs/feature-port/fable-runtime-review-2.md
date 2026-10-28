# Fable runtime review 2

Model claude-fable-5-1; effort xhigh; actual source and device evidence.

도구·파일 편집 없이, 제공된 원문 코드와 두 JSON 증거만으로 대조했습니다. `server.cjs`는 발췌만, `data-root.cjs`·`data-root-lock.cjs`·`styles.css`·`sessionLock` 구현은 미제공이므로 그 부분은 "동작 증거로만 확인" 또는 "미검증"으로 표기합니다.

## 1. 이전 차단 항목 종결 판정

| 항목 | 판정 | 근거 |
|---|---|---|
| B-1 시작 실패 고착 | **해소(주경로)** / 잔여 위험 낮음 → D-1 | `builder.start()` 직후 `try { … } catch (Exception) { stop(); throw }`로 감쌈. `check`/`require`/`JSONException`/`InterruptedException` 모두 Exception → `stop()`에서 `process=null; origin=null`. 재시도 시 재시작 블록 재진입 확인. |
| B-2 `savePath === RISUBARD_DATA_ROOT` | **동작 증거로 확인** (소스 미확인) | `savePath = processDataRoot = resolveDataRoot()`, `embedded.ready(server, savePath)`, `passwordPath = join(savePath,'__password')`. 실기기 `EmbeddedServer.start`가 반환되려면 `.android-server.json`이 `files/user-data`에 생겨야 하고 `/api/login`이 `user-data/__password`로 성공해야 하므로 두 경로 일치가 실증됨. `data-root.cjs` 원문은 미제공. |
| B-3 패키지 ZIP 스모크 | **통과** | 저장소 밖 루트, session 200, cookieAuth success, writer free, stderr 빈 문자열. `assembleDebug` 성공 + 두 기기 side-by-side 설치. |

B-1~B-3 완료 조건은 충족. 다만 B-3 스모크와 기기 probe는 **기동 경로**만 덮습니다. 라우트 안의 지연 `require()`(비상대 모듈)가 `roots` 14개 밖이면 해당 기능 호출 시점에 MODULE_NOT_FOUND가 납니다 → §5.

## 2. 신규 수정: `viewportHeight.ts` (키보드 열림 시 본문 855/입력창 800)

**원인 분석 타당성 — 타당(높은 확신).**
- APK는 `adjustResize` + API30 인셋 패딩으로 WebView View 자체가 줄어 레이아웃 뷰포트가 555가 됨(`innerHeight 555` 관측이 이를 확인). 이 경우 `100dvh`도 555가 되므로 body가 855로 남는 유일한 설명은 `--risu-height-size`가 855px로 고정된 것.
- 고정 경위: 로드 시 포커스 없음 → 초기 `apply()`가 855px 기록 → 키보드로 `visualViewport.resize` 발생 시 `activeElement`가 TEXTAREA → skip → 갱신 안 됨. 코드 흐름과 증상이 정확히 일치.

**재현 조건:** APK(UA에 `RisuBardAndroid/` 포함), 포커스 없이 로드 완료 후 아무 TEXTAREA/INPUT 포커스 → IME 표시. `getComputedStyle(document.documentElement).getPropertyValue('--risu-height-size')`가 `innerHeight`와 다름. 키보드 닫으면 증상 소멸(비포커스 resize에서 갱신됨).

**최소 수정 적정성 — 적정.** 변경은 UA 판정 1줄 + 조건 `!embeddedAndroid &&` 1곳. 브라우저 경로는 `embeddedAndroid=false`이면 식이 원래와 동일하므로 KEEP(기존 브라우저 동작) 코드상 보존. UA 토큰은 `MainActivity`가 기본 UA 뒤에 덧붙이므로 기존 `/Android/` 판정에도 영향 없음.

**잔여 위험·테스트 공백(수정 자체의 결함은 아님):**
- 단위 테스트는 `installDynamicViewportHeight()` 직접 호출 시 초기 `apply()`만 검사. `resize` 리스너 → `requestAnimationFrame` → `apply` 경로는 미검사. 또 브라우저 **비포커스** 시 1회 설정되는 기존 동작의 회귀 가드가 없음(`apply`가 항상 return해도 현재 테스트 통과). 최소 보강: `activeElement`를 매개변수화해 `['browser, body focused', 'Mozilla/5.0 Android', BODY, 1]` 케이스 추가.
- `scale !== 1` 가드는 유지되므로 뷰포트 meta가 없거나 태블릿에서 wide viewport로 scale≠1이면 변수가 전혀 설정되지 않음 → 그 경우엔 `100dvh` 폴백이 작동해 오히려 문제 없음. 두 기기 모두 재검사 권장(증상이 난 기기와 안 난 기기가 다를 수 있음).

**실기기 미검증 게이트(새 APK):** chrome://inspect에서 키보드 열림/닫힘·세로/가로·분할화면 각 상태로 `[innerHeight, visualViewport.height, --risu-height-size, body 높이, textarea bottom]` 5값 기록, 모두 일치해야 통과. 특히 `visualViewport.height === innerHeight`(WebView가 레이아웃만 줄이고 비주얼을 한 번 더 줄이지 않는지)를 확인하면 원인 추정이 확정됩니다.

## 3. 확정 결함(코드 근거, 기기 불필요)

| ID | 위치 | 내용 / 재현 | 최소 수정 | 심각도 |
|---|---|---|---|---|
| D-1 | `EmbeddedServer.stop()` | `waitFor`가 `InterruptedException`을 내거나 `outputStream.close()`가 IOException을 내면 `process=null; origin=null`이 실행되지 않아 B-1 상태로 회귀, 원래 예외도 가려짐. 재현: 워커 스레드 인터럽트(현재 `shutdown()`은 인터럽트하지 않아 실사용에선 거의 발생 안 함) | `process?.let{…}`를 `try/finally`로, `finally { process = null; origin = null }` | 낮음 |
| D-2 | `server.cjs` listening 훅 | `portable-update.cjs --cleanup`을 `spawn(process.execPath…, detached)`하는 훅이 발췌상 `embedded.enabled`/`deploymentType` 게이트 없음 → Android에서 매 기동 후 Node 프로세스 1개 추가 생성, `TMPDIR=cacheDir`(로그·probe 결과 위치)에서 정리 로직 실행 | `if (!embedded.enabled)`로 감싸기(발췌가 부분이라 상위 조건 유무 확인 필요) | 낮음~중 |
| D-3 | `InstallCredential.getOrCreate()` | 복구 catch가 `GeneralSecurityException`/`IllegalArgumentException`만. `ProviderException`(RuntimeException), `IllegalStateException`, `android.security.KeyStoreException`(Exception 직계), `load()`의 IOException은 통과 → 데이터는 안전하나 "복구" 대신 시작 실패. 기기 시험은 `deleteEntry → AEADBadTagException` 경로만 검증 | 복호 블록을 `catch (e: Exception)`로, 내부 `deleteEntry`도 try로(N-1 그대로) | 낮음(데이터 영향 없음) |
| D-4 | `EmbeddedServer.unpack()` | 구 `runtime/<sha>` 미삭제 → APK 갱신마다 수백 MB 누적(N-4). 코드에 정리 경로 없음 | `renameTo(target)` 성공 후 `base.listFiles()` 중 이름 ≠ expected 삭제 | 낮음(릴리즈 전 필수) |
| D-5 | `MainActivity.onDestroy()` | `!isChangingConfigurations` 분기로 WebView를 보존하지만 보존 메커니즘(`onRetainNonConfigurationInstance` 등)이 없어 locale/fontScale 등 미처리 config 변경 시 WebView 누수 | `rendererGone`만 조건으로 두고 항상 `destroy()` | 낮음 |
| D-6 | `EmbeddedServer.start()` | `require(actualPort == port)` 실패 시 사용자에게 "Failed requirement." 노출; `/api/login` 429(rate-limit)도 "내부 서버 인증 실패"로 표시(N-11). 매 `connect()`가 재로그인하므로 재시도 연타 시 발생 가능 | 메시지 지정, 429 분기 | 낮음 |
| D-7 | `scripts/android/package-runtime.mjs` | `inspectElf(binary, prototype ? 4096 : 16384)`가 `lock.architectures` **전부**에 적용됨. 16KiB 검증용 에뮬레이터는 Windows 호스트상 x86_64이므로, ARM64만 16K로 재빌드하면 `--allow-4k-prototype` 없는 패키징이 x86_64 항목에서 실패하고, 플래그를 넣으면 `releaseCompatible=false`로 떨어져 검증 의미가 사라짐 | x86_64도 `-z max-page-size=16384` 빌드 추가, 또는 lock에 ABI별 pageSize 필드 | **중(검증 경로 차단)** |

참고(결함 아님): `stop()`→Node 정상 종료 대기 5s+2s 동안 워커 스레드 블록은 설계대로. `ServerSocket` 프로브 후 Node 바인드까지의 포트 레이스는 재시도로 자가 복구(랜덤 포트 폴백) → origin 변경 시 localStorage 분리(N-8) 유지.

## 4. 코드상 차단(현재 코드가 실제로 막고 있는 것)

- 릴리즈 빌드: `preReleaseBuild → verifyRuntimeForRelease`가 `releaseCompatible=true` 요구. 4K 프로토타입은 `false` → 릴리즈 불가. 단, 이 게이트는 패키징 스크립트 산출물(`runtime.properties`)을 신뢰하며 `jniLibs/*/libnode.so`를 재검사하지 않음.
- 16K 정렬: `inspectElf`가 `p_align ≥ pageSize && offset ≡ vaddr (mod pageSize)` — 커널 요건과 일치하는 올바른 기준.
- 루프백: `ready()`가 비-127.0.0.1이면 throw(테스트 커버). `/api/self-update`, `/api/tunnel/start` → 인증 전 409. `UPDATE_CHECK_DISABLED = embedded.enabled || …`.
- Writer 잠금: `/api/session`은 `x-session-id` 문자열일 때만 `register`; 네이티브 부트스트랩은 미전송 → `lock-status` free 실증.
- 자료 보존: 삭제 경로는 `runtime/*.part`와 `.android-server.json`만. `user-data` 삭제 코드 없음.
- 무결성: ZIP 전체 SHA-256(central directory 포함, drain 루프로 1회 해시 — 이전 N-3의 2회 읽기 해소), zip-slip 가드, probe는 `BuildConfig.DEBUG` 필수.

## 5. 미검증 게이트(증거 없음 또는 부분)

1. **키보드 수정 실기기 확인** — §2 절차. 현재 "빌드 PASS·단위 2건 PASS"만.
2. **WebView UI 상호작용 정식 증거** — `runtime-device-checks.json`도 notVerified. 다만 키보드 버그 보고 자체가 WebView 로드·쿠키 네비게이션·채팅 화면 동작의 간접 증거. 파일 선택(PNG 카드 import), `<a download>`/blob 저장 불가(N-6, `DownloadListener` 없음)는 여전히 미확인.
3. **probe 범위의 한계** — image/Lua/streaming/msgpack은 **별도 Node 프로세스**의 probe 스크립트에서 통과한 것. `server.cjs`의 `getVips()`·이미지 라우트·BardWiki 경로(`@aws-crypto/sha256-js`, `@dqbd/tiktoken`, sucrase로 `src/ts/risubard` 로드)는 앱 UID에서 실행 증거 없음. "actual chat/database persistence"도 notVerified. 강제 종료 1→2는 probe 마커 + `EmbeddedServer.start` 재기동(stale lock 복구 포함)만 입증.
4. **지연 `require` 완전성** — `server/node/**.cjs`와 `packages/risubard-core`에서 비상대 `require(`를 grep해 `roots`와 대조하는 정적 확인이 아직 없음(도구 없이는 판별 불가).
5. **16KiB** — 에뮬레이터 PAGE_SIZE=16384 확인만. 커스텀 Node 미완 + D-7의 x86_64 공백. 빌드 후 `inspectElf(…,16384)` 통과 → lock의 version/sha 갱신 → `--allow-4k-prototype` 제거 패키징 → 16K 에뮬레이터에서 instrumentation 통과가 순서.
6. **고아/이중 서버(N-2)** — ready의 `pid` 미사용, 코드 가드 없음. AMS process-group kill로 실무상 희박하나 미실증.
7. 백그라운드↔포그라운드 전환, 저장 공간 부족, 평문 LAN 허용 여부(N-7 `usesCleartextTraffic` 전역) 결정, `--cleanup` 프로세스의 cacheDir 접근 범위(D-2).
8. `data-root.cjs`, `data-root-lock.cjs` 원문 미제공 — B-2는 행동 증거만.
9. `FEATURE-MAP.md` 1행 "기기 설치 전 검수 중"은 현 증거와 불일치(문서 동기화 필요, 이번엔 편집 없음).

## 6. 판정

- **B-1/B-2/B-3 종결**: 인정. 디버그 설치 게이트는 통과 상태 유지.
- **키보드 수정**: 원인 진단·최소 수정·브라우저 보존 모두 코드 수준에서 적정. **실기기 재검사 전까지는 미검증 게이트**이며, 수정 코드 자체의 확정 결함은 없음. 단위 테스트에 브라우저 비포커스 회귀 가드 추가 권고.
- **지금 고칠 가치가 높은 것**: D-7(16K 검증 경로 자체를 막음), D-2(Android 불필요 프로세스), D-1(B-1 잔여, 두 줄). D-3/D-4/D-5/D-6은 릴리즈 전 정리 항목.
- **전체 릴리즈**: 요청 범위 밖이며, 현 코드 게이트(§4)가 의도대로 차단 중. 16KiB·전송 v2·다운로드·N-2·Wi-Fi 대기 상태 변동 없음.
