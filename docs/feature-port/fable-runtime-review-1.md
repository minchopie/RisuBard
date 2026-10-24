# Fable runtime prototype review

Model claude-fable-5-1; effort xhigh; before device installation.

# RisuBard 안드로이드 임베디드 런타임 1차 게이트 리뷰

도구·파일 편집 없이 제공된 소스와 대화 증거만으로 검토했습니다. `server.cjs` 원문, `dist` 클라이언트, `runtime-lock.json`, 리소스(`AppTheme`), `RuntimeInstrumentation`은 미제공이므로 관련 사항은 "주장/미검증"으로 분류합니다.

## 1. MUST 대조

| 요구 | 판정 | 근거 |
|---|---|---|
| Node≥22.12 standalone, Termux/원격 없음 | 설계 확인 / 실행은 `--version`만 측정 | lock 24.21.0, `verify-node`의 `com.termux` 검사, `nativeLibraryDir` exec |
| loopback | 확인 | `host='127.0.0.1'`, `ready()`가 비-loopback이면 throw, 테스트 커버 |
| 설치 고유 자격증명 + 기존 login/session/JWT | 클라 측 확인 / 서버 측 주장 | 32B random → `__password` → `/api/login` → `/api/session` |
| 네이티브 부트스트랩 x-session-id 없음 | 확인 | 두 요청 모두 해당 헤더 없음 |
| 자격증명 복구 시 데이터 보존 | 확인(삭제 경로 없음) / 복구 범위 구멍(N-1) | `InstallCredential`, `unpack`은 `runtime/` 내부만 삭제 |
| applicationId 분리 | 확인(디버그는 `.debug` 접미) | 구 USB 앱 ID는 미제공 → 미대조 |
| APK 코드 ≠ user-data | 확인 | `files/runtime/<sha>/` vs `files/user-data/` |
| Windows/기본 동작 유지 | 확인 | `host` undefined → `listen(port, undefined, cb)`는 Node `normalizeArgs`가 string만 host로 채택하므로 `listen(port, cb)`와 동일 |

## 2. 차단 — 설치 전 수정/확인

**B-1. 시작 실패 후 "다시 시도" 영구 고착 (`EmbeddedServer.start`)**
`process = builder.start()` 이후 `origin = ...` 이전에 예외(90s 타임아웃, `require(actualPort == port)`, ready JSON 파싱)가 나면 `process`는 살아있고 `origin == null`. 다음 호출은 `process?.isAlive != true`가 false라 재시작 블록을 건너뛰고 `checkNotNull(origin)`에서 "Required value was null." 앱 프로세스를 죽이기 전까지 복구 불가.
재현: ready 기록이 90s 넘게 지연되는 상황(B-2 경로 불일치가 정확히 이것) → "내부 서버 시작 시간 초과" → 버튼 → ISE.
수정: 블록을 try/catch로 감싸 실패 시 `process?.destroyForcibly(); process = null; origin = null` 후 rethrow(또는 재시작 조건에 `|| origin == null`).

**B-2. (확인 필수) `savePath === RISUBARD_DATA_ROOT`인지**
Android는 `user-data/.android-server.json`, `user-data/__password`를 가정. 요약은 `ready(server, savePath)`와 "dataRoot/__password"로 이름이 갈립니다. 업스트림 RisuAI는 `savePath = cwd/save`. 어느 하나라도 하위 디렉터리면 타임아웃(→B-1 고착) 또는 로그인 실패. 제공 증거로는 판별 불가.

**B-3. (확인 필수) 패키징된 `runtime.zip` 데스크톱 스모크**
`roots`가 수작업 목록이고 JWT/쿠키 파싱 라이브러리가 없습니다. `server.cjs`가 `jsonwebtoken`/`jose`/`cookie` 류를 require하면 MODULE_NOT_FOUND로 즉시 종료 → "내부 서버 시작 실패". `PORT` 반영, `OPEN_BROWSER`, 안드로이드에서 실패하는 호출(`os.userInfo()` 등)도 미검증. 기존 테스트 2건은 `embeddedRuntime()` 단위만 커버.
권장 게이트: zip을 임시 폴더에 풀고 Windows에서 `RISUBARD_EMBEDDED_ANDROID=1 RISUBARD_DATA_ROOT=<tmp> PORT=<n> node server/node/server.cjs` → ready 파일 생성 → `/api/login`(JSON) → `/api/session`(risu-auth, x-session-id 없음) Set-Cookie → 쿠키로 `/api/test_auth` JWT → `/api/self-update` 409. 통과하면 ARM 바이너리와 WebView만 남습니다. Gradle `assembleDebug` 성공 보고도 아직 없습니다.

## 3. 비차단 — 기록 후 다음 단계

- **N-1 복구 범위**: `android.security.KeyStoreException`(ProviderException→RuntimeException), `IllegalStateException`, `load()`의 IOException은 catch 밖 → 데이터는 안전하나 복구 대신 시작 실패. 복호 단계를 `catch (e: Exception)`로, `deleteEntry`도 try로.
- **N-2 고아 노드/이중 서버**: ready 파일의 `pid` 미사용. AMS가 binderDied 시 cgroup kill을 하므로 보통 고아 없음(확신도 중). 생기면 같은 user-data에 서버 2개. 저비용 가드: 시작 시 기존 ready의 pid를 `Process.killProcess`(같은 UID만 가능) 후 삭제. 설치 후 검증: 강제 크래시 후 `adb shell ps -A | grep libnode`.
- **N-3 unpack 성능**: 파일마다 `fd.sync()` + 에셋 2회 읽기(첫 `DigestInputStream`은 `reset()`으로 무효). 첫 실행 수십 초~분, 진행 표시 없음. `.complete`만 sync, 스트림을 drain해 1회 해시로.
- **N-4** 구 `runtime/<sha>` 미정리 → 업데이트마다 누적.
- **N-5** 노드 사망 후 재연결 UI 없음(panel GONE 고정). main-frame `onReceivedError` 또는 watchdog으로 panel 복귀.
- **N-6** `DownloadListener` 없음 → 백업/카드 export(`<a download>`, blob) 불가. 이번 게이트 범위 밖이나 체감 제한으로 명시.
- **N-7** `usesCleartextTraffic=true` 전역. `network_security_config`로 127.0.0.1 한정 가능하나 사용자 LAN http LLM 엔드포인트 허용 여부가 결정 사항.
- **N-8** 포트 고정은 best-effort. 충돌 시 origin 변경 → WebView localStorage/IndexedDB 분리. 드묾.
- **N-9** Back 키가 앱 종료. **N-10** 로그 파일 무제한. **N-11** 재시도 연타 시 `/api/login` rate-limit 429 가능.
- **N-12** 통합 테스트 공백: embedded 409, x-session-id 없는 `/api/session`의 writer 미등록 단언 없음(B-3가 임시 대체).
- **N-13** `allowBackup=false`로 충분하나 Android 12+ D2D는 `dataExtractionRules` 권장. Keystore 키는 이전 불가라 자격증명은 재발급, user-data는 보존 → 결과적으로 무해.
- **N-14** `allowContentAccess=false` + `onShowFileChooser`: 업로드는 브라우저 프로세스 경로라 동작 예상이나 기기에서 PNG 카드 import로 검증.
- 참고: `__password` 평문 사본이 user-data에 있어 Keystore 래핑은 보안 이득이 거의 없음(데스크톱과 동일 모델, 허용 가능). `extractNativeLibs`/`useLegacyPackaging`/`keepDebugSymbols` 조합은 적절.

## 4. 판정

- 경계 설계(loopback, 자격증명, 코드/데이터 분리, 데스크톱 보존)는 코드 수준에서 요구 충족.
- **설치 전 필수**: B-1 수정, B-2 확인, B-3 스모크 통과(+`assembleDebug` 성공). 이 세 가지 완료 시 4K 프로토타입 디버그 설치 게이트 통과 권고.
- **릴리스 전체 불승인**: 16KiB 미해결(현 차단 구조는 의도와 일치), 다운로드/전송 미구현, N-1/N-2/N-5 미처리.