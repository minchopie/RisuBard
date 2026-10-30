# Fable runtime review 3 (claude-fable-5-1, xhigh)

도구·파일 편집 없이 제공된 원문과 두 JSON 증거만으로 대조했습니다. `server.cjs`는 diff만, `shutdownGracefully` 본문·`risubard-memory-routes`(view 응답 형태)·프런트 저장 경로는 미제공이므로 해당 부분은 "미검증"으로 둡니다.

## 1. D1–D6 수정 타당성 (전부 소스로 확인)

| ID | 판정 | 근거 |
|---|---|---|
| D-1 | **해소** | `EmbeddedServer.stop()` ≈L104–118: `try/catch(InterruptedException)/finally { process=null; origin=null }`. 인터럽트 시 `destroyForcibly`+재인터럽트+재throw도 올바름. |
| D-2 | **해소** | diff `if (!embedded.enabled) server.once('listening', …--cleanup…)`. |
| D-3 | **해소(부작용 허용 범위)** | `catch (_: Exception)` + `deleteEntry`를 별도 try로. 단, `key()`의 일시적 Keystore 오류(부팅 직후 등)도 "손상"으로 간주해 자격증명을 회전시킴 → 서버 재시작만 발생, 사용자자료 무관. 주석의 보장("user data … intact")과 일치. |
| D-4 | **해소** | `start()` ≈L87–98: 인증 성공 후 `runtime/` 아래 `[a-f0-9]{64}(\.part)?` 중 active 제외 삭제, 심링크·canonical parent 가드 있음. `Files.walk` 기본 심링크 미추적. 동기 삭제가 워커에서 돌아 첫 기동이 길어지는 건 허용 범위. |
| D-5 | **해소** | `onDestroy`가 `!rendererGone`만 조건으로 항상 `destroy()`. `onRenderProcessGone`→`recreate()` 경로와 이중 파괴 없음. |
| D-6 | **해소** | `require(actualPort == port) { "포트가 변경됐어요…" }`, 429 분기 메시지. |
| D-7 | **코드 변경 없음, 빌드로 해결 중** | `package-runtime.mjs`의 `prototype ? 4096 : 16384`가 전 ABI 공통인 건 양 ABI 모두 16K로 빌드되면 문제 없음. → §6 미검증. |

## 2. 패키지 ZIP/ELF 해시검사 판정 — 타당

- **ZIP 전체 해시 1회 계산**: `unpack()` ≈L132–149는 `DigestInputStream` 위에 `ZipInputStream`을 올리고, `nextEntry==null` 후 `hashed.read(remaining)` drain. `ZipInputStream`의 pushback 선독 바이트도 이미 `hashed`를 통과했으므로 각 바이트가 정확히 1회 해시됨. 패키징 측 `hashFile(destination)`은 `close` 후 전체 파일 → 일치. 이전 N-3(2회 읽기) 종결.
- **순서 안전**: 추출→해시 비교→`.complete`(fsync)→`renameTo`. 스테이지는 `.complete`+rename 전까지 참조되지 않고 실패 시 삭제. zip-slip 가드(`canonicalFile` + `startsWith(stage + separator)`) 정확.
- **릴리즈 게이트**: `verify-runtime.mjs`가 ZIP 해시, `jniLibs` 디렉터리 집합 == `runtime-binaries.json` 키, ABI별 `libnode.so` 단독, 바이너리 해시, `inspectElf(16384)`, machine 매핑을 재검사. review-2의 "runtime.properties만 신뢰" 지적이 해소됨(`runtime.properties`는 이제 소비처 없음, 무해).
- **inspectElf 기준**: `p_align ≥ 16K && p_offset ≡ p_vaddr (mod 16K)` — 커널 요건과 일치. (경미한 보강: `alignment % pageSize === 0`. 정상 툴체인 출력은 2의 거듭제곱이라 실질 오수용 없음.)
- **extractNodeBinary**: archive 해시→`.part`로 추출→ELF/ABI 검사→rename, `finally rm(.part)`. 기존 바이너리 보존 테스트와 일치. 단 추출이 ZIP 생성 **전**에 수행되므로 한 ABI만 실패하면 `jniLibs`는 갱신되고 `runtime-binaries.json`은 구버전 → 게이트가 "Node hash mismatch"로 올바르게 fail-closed.
- 테스트 3종(hash/ABI/extra lib/malformed) 커버리지는 코드 경로와 일치.

**게이트 공백(§5 C-2)**: 무결성(자기일관)만 검사하고 **신선도·출처**는 검사하지 않음.

## 3. stdin EOF 소유권 — 구현·검증 확인

- Java: `ProcessBuilder` 기본 `Redirect.PIPE`로 stdin 파이프 유지, `stop()`에서 `outputStream.close()`로 EOF 송신 후 5s→SIGTERM→2s→SIGKILL. 다른 자식(probe)은 libcore가 fd>2를 닫으므로 write end 누출 없음.
- Node: `watchOwner`가 `stdin.once('end'/'error')`+`resume()`; 테스트 3번이 `stdin.end()`→exit 0 확인. Java 프로세스 사망(커널 fd 닫힘)도 동일 경로. ppid 폴링 아님 — 확인.
- 잔여(미검증): (a) EOF→`shutdownGracefully` 진행 중 5s 뒤 SIGTERM이 또 들어오면 재진입 — `shutdownGracefully` 본문 미제공; (b) 강제 종료·AMS process-group kill은 SIGKILL이라 EOF 경로 자체가 실행되지 않음 → §5 C-1, §7 내구성 항목의 전제.

## 4. 키보드 실측 판정

- **폰(SM_S938N) 통과 인정**: 닫힘 855 → 세로 555 → 가로 198에서 `innerHeight == visualViewport.height ≈ css var == body`, 입력창 bottom(540/184/800)이 모두 뷰포트 안. 수정 전 증상(body 855/입력 800 고정)이 사라졌고 원인 가설(`--risu-height-size` 고정)이 실측으로 확정됨.
- 테스트 보강도 확인: 브라우저 비포커스(BODY) 회귀 가드 + resize→rAF→apply 경로 검사 추가됨(review-2 권고 반영).
- 관찰(결함 아님): 가로 `Math.round(198.57)=199px` > innerHeight 198 → 1px 초과. 브라우저 경로 공유라 변경 권고하지 않음.
- **태블릿(TB710FU) 미해결 유지**: 기록된 viewport 값이 모두 전체 높이(1240/760)라 IME 인셋이 WebView를 줄인 사실 자체가 없음. "IME shown" 보고와 스크린샷 불일치는 하드웨어 키보드 연결/`show_ime_with_hard_keyboard=0`/플로팅 IME 중 하나일 가능성이 높음. 수정 코드의 전제(WebView가 IME 인셋만큼 줄어듦)가 태블릿에서 증명되지 않은 상태. 키보드가 안 뜨면 vv.height==innerHeight라 회귀 위험은 없음.

## 5. 확정 결함 (코드 근거, 기기 불필요)

| ID | 위치 | 트리거 / 결과 | 최소 수정 | 심각도 |
|---|---|---|---|---|
| **C-1** | `server/node/data-root-lock.cjs` ≈L24 `isProcessAlive`: `return error?.code !== 'ESRCH'` | 강제 종료(SIGKILL)로 `user-data/.risubard-server.lock/owner.json`이 남음(정상, 다음 기동에서 ESRCH→격리 — 증거로 확인). 그러나 그 PID를 **다른 UID 프로세스**가 재사용 중이면 `process.kill(pid,0)`→`EPERM`→"생존"→`DATA_ROOT_IN_USE`→Node 종료→"내부 서버 시작 실패". 재시도로 복구 불가(해당 프로세스 종료 또는 앱 데이터 삭제까지). Android는 pid_max 32768에 프로세스 churn이 커서 PC보다 발생 확률이 유의미. `.android-server.json`의 `pid`는 미사용(N-2). | 임베디드일 때 EPERM을 비생존으로: `return error?.code !== 'ESRCH' && !(process.env.RISUBARD_EMBEDDED_ANDROID === '1' && error?.code === 'EPERM');` 근거: 앱 UID에서 신호 가능한 프로세스만 우리 서버일 수 있음. PC 경로 불변. (Java 측 lock 선삭제는 구 Node의 graceful 종료와 겹칠 수 있어 비권장.) 잔여: 같은 UID의 새 앱 프로세스가 그 PID를 받는 극저확률 케이스. | **중(릴리즈 전 필수)** |
| **C-2** | `android-app/app/build.gradle.kts` `verifyRuntimeForRelease` + `scripts/android/verify-runtime.mjs` | `server.cjs`/`dist`/`src/ts/risubard` 수정 후 `package-runtime.mjs`를 다시 돌리지 않고 `assembleRelease`/`bundleRelease` → ZIP==sha256 자기일관만 검사하므로 **통과**, 구버전 서버가 릴리즈에 포함. 이번 라운드(APK7 수동 재패키징)가 그 의존을 보여줌. 또 `runtime-lock.json`의 archive sha와 `runtime-binaries.json`의 연결이 없어 출처 검증도 없음. | (a) `preReleaseBuild → verifyRuntimeForRelease → packageRuntimeForRelease`(플래그 없는 `package-runtime.mjs` Exec) 의존 추가, 또는 (b) package-runtime이 `git rev-parse HEAD`+dirty 여부와 lock archive sha를 `runtime-binaries.json`에 기록하고 verify-runtime이 현재 HEAD·lock과 대조. (b)가 빌드 시간에 유리. | 낮~중(게이트) |
| **C-3** | `EmbeddedServer.start()` ≈L70–85 (login/session 블록) | Node 프로세스가 살아있지만 리스너가 닫혔거나 세션 생성이 실패하면 예외만 던지고 `stop()` 안 함 → 이후 모든 `connect()` 재시도가 같은 프로세스를 재사용 → 앱 프로세스 종료 전까지 복구 불가. (`onReceivedError`→다시 시도 경로가 이 상태에 빠짐) | `java.net.ConnectException`(ECONNREFUSED)만 `stop(); throw`. **타임아웃·429는 재시작 금지**(대형 저장 중 read timeout 5s를 넘길 수 있어 살아있는 서버를 죽이면 더 나쁨). | 낮음 |

경미 권고(결함 분류 안 함): `unpack()` ≈L151 — `.complete` 없는 `target`이 외부 요인으로 존재하면 `renameTo` 영구 실패(rename 전 `target.deleteRecursively()`); `MainActivity.connect()` catch가 `error.message`(ENOSPC 등 원문)를 그대로 노출; `package-runtime.mjs`의 `tmp/android-runtime-*` 스테이지 미삭제 및 fflate 기본 mtime으로 ZIP 비결정(재패키징마다 해시가 바뀌어 기기에서 전량 재추출); `stop()`의 5s graceful 한도가 대형 flush보다 짧을 수 있음(`stop()`은 자격증명 회전·기동 실패 경로에서만 호출).

**새 서버 라우트 probe(테스트 전용) 검토**: 상용 코드 영향 없음. 단 (1) `inlay/runtime-probe-image`, wiki 문서(`runtime-probe-character`), `user-data/runtime-probe-preservation.txt`가 디버그 앱(`.debug` applicationId) user-data에 잔류, 정리 없음; (2) `view` 응답에 markdown 본문 포함을 전제(§6-3).

## 6. 미검증 게이트

1. **16K(D7)**: ARM64·x86_64 모두 `-z max-page-size=16384` 빌드 → `runtime-lock.json` version/sha 갱신 → 플래그 없는 패키징 → `verify-runtime` 통과 → 16K 에뮬레이터 instrumentation. 양 ABI가 bionic 외 공유 라이브러리를 요구하게 되면 "libnode.so 단독" 게이트와 충돌하므로 DT_NEEDED 확인 필요(현재 검사 없음).
2. **태블릿 키보드**: `settings put secure show_ime_with_hard_keyboard 1`(또는 하드 키보드 분리) 후 `dumpsys window | grep InputMethod`로 IME 창 가시 확인 → 5값(innerHeight/vv.height/`--risu-height-size`/body/textarea bottom) 기록. 현재 증거 없음.
3. **APK7 wiki 라우트 probe**: 미재검. 더불어 "host now viewIncludesBody=true"가 **서버 `view` 응답 형태 변경**이라면 KEEP(PC/browser) 범위의 제품 변경이므로 자체 단위 테스트와 기존 클라이언트 영향 확인이 필요 — diff 미제공이라 판정 불가.
4. **sucrase 로드 TypeScript 의존**: `src/ts/risubard`의 `svelte`/`uuid`/`markdown-it` import 파일이 서버 경로에서 도달 가능하면 APK에서 MODULE_NOT_FOUND(roots 미포함). `packages/risubard-core`를 bare specifier로 require하는 곳이 있으면 동일. 정적 grep(`server/node/**` 비상대 require·import) 미실시. BardWiki/save-slot WebView 왕복은 notVerified 유지.
5. **`shutdownGracefully`**: 재진입 안전성, 디바운스 중인 저장을 flush하는지 — 본문 미제공.
6. **다운로드/blob**(`DownloadListener` 없음), 뒤로가기 시 초안 보존, LMK 상황의 process-group kill 여부 — 증거 없음.
7. 증거 JSON은 APK `25c97eda…`에 결속; APK7은 어떤 항목도 재검되지 않음. 전송 v2 미착수 변동 없음.

## 7. 런타임 단계 판정

- **단계: 디버그/내부 dogfood(폰) 유지. 릴리즈 후보 진입 불가.**
- 코드 게이트가 실제로 막고 있는 것(의도대로): 4K 프로토타입 → `verify-runtime` 거부, 루프백/업데이트/터널 409, writer 잠금 free, user-data 삭제 경로 없음, zip-slip·해시·DEBUG-only probe.
- 릴리즈 전 닫아야 할 것: D7 양 ABI 16K(미통과) · **C-1** · 태블릿 키보드 · APK7 wiki probe(+`view` 변경 범위 확인) · **C-2**(freshness) · §6-4 정적 확인.
- **결정 필요 항목(결함 아님, 제품 결정)**: `chat-content 200 → 즉시 강제 종료` 손실은 PC와 같은 디바운스 계약이지만, Android에서는 서버가 UI 프로세스와 함께 SIGKILL될 수 있어 PC에선 무해한 창이 사용자 가시 손실로 바뀜(Home 자동 flush 미관측으로 확인). 계약을 유지하려면 "Android에서는 canonical flush 전 종료 시 마지막 메시지가 유실될 수 있음"을 문서화하고, 완화하려면 `RisuBardAndroid/` UA 게이트로 `pagehide`/`visibilitychange` 시 canonical flush(브라우저 경로 불변, viewportHeight와 같은 패턴) 또는 임베디드 모드 디바운스 단축 중 하나를 별도 검증과 함께 선택. 이번 라운드 범위 밖.