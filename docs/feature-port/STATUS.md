# RisuBard 기능 이식 진행 기록

기준: 0.9.71 / 64ebfb2397188ae30f88dd2e8b25747192ccbb4b. 브랜치 codex/risubard-feature-port. 정식 릴리즈 승인서가 아니다.

**2026-10-17 최신: 사용자가 설치 보류를 해제하고 원격 USB 연결을 승인했다. TB710FU·SM-S938N에 일반/Offline 후보33을 설치하고 실제 Wi-Fi 전송·중복 방지·재시작·Offline 생성·받은 기억/저장 슬롯 복원을 확인했다.** 실사용에서 발견한 비선택 캐릭터 채팅 저장 누락을 수정하고 실제 Opus 5.5/xhigh 코드 검수를 받았다. 상세 근거·미완료·설치 해시는 [DEVICE-QA-20261017.md](DEVICE-QA-20261017.md). 아래 이전 시각의 HOLD/미완료는 이력이며, 정식 릴리즈 미완료는 유지한다.

- GOAL: USB 앱1.4.1과 Windows 전송기 기능을 RisuBard에 통합해 검수 후 배포.
- MUST: PC·Termux 없는 독립 APK, 별도 앱 ID, 선택 채팅의 BardWiki·저장 슬롯, 실제 외부 모델 공동 검수. 현재 사용자 지정 모델은 Opus5.5/xhigh이며 이전 Fable 검수 기록은 보존한다.
- KEEP: 기존 카드·채팅·앱·페르소나, 같은 캐릭터에는 채팅 추가, 수정본 별도 보존, 전역 API/설정/화면 유지, 이어하기 팝업 없음.
- VERIFY: 실행 기반 → 파일 왕복/중단 복구 → 전체 통합 → 실기기/배포 파일. 필수 단계 전 정식 게시 금지.

## 현재 단계

| 영역 | 확인한 상태 | 미완료 |
|---|---|---|
| 계획 공동 검수 | 실제 Fable 계획3차 승인 | 구현 성공 승인은 아님 |
| 독립 APK | Node24.21.0 ARM64 초기4KiB판을 두 기기 앱 UID에서 실행, 서버/인증/이미지/Lua/스트리밍/합성 저장·재시작·키보드·회전 확인 | 최신 저장 수정과 새 ARM 바이너리 물리 검증 |
| 16KiB | 자체 ARM64/x64 빌드·ELF 정렬·양 ABI 패키지 검사 통과, API36 x64 16KiB 에뮬레이터 APK16 실행 통과 | 최종 ARM64 바이너리 실행은 실기기 보류에 따라 미검증 |
| 저장 복구 | 재시작 직후 채팅→patch 손실 재현/수정, 실패·외부 편집·종료/실제 서버 재시작26경우 통과, 덮어쓸 복구 판본을 별도 보존 | Fable 실행 기반12차 해당 수정 수용; 복구 안내 UI·실제 큰 DB/기기 검증 미완료 |
| 전송 파일 | 공통 v1 코어 재사용, v2 Wiki/슬롯/공용 페이지 캡처·ZIP 스트리밍·검증 | 다른 기기 ID·근거·페이지해시·receipt 재연결, 영속 수신 저널, 앱 UI 연결 |
| 반복 전송 | 그림/프롬프트/갤러리 A→B→C→A 및 선택 범위를 확장했다가 원래 기기로 돌아온 채팅 중복 방지 검사 | v2는 기억 저널 완성 전 가져오기를 명시적으로 거부. host hydration·새 ID 기억 왕복은 미완료 |
| 호환 이식 | 로어3곳, Android Gemini/Google·HTML 교착 수정, 네이티브 fetch 바인딩과 WebView logcat 경계 재현/수정, 실제 Wasmoon 한글 경로 수정 | 실제 제공자 요청, 임베딩 등 남은 비교, Fable 호환4차 해당 수정 수용; 전체 통합 검수 대기 |
| 기기 연결/전송 | 기존 소스·규칙 대응표 작성 | Wi-Fi/USB/NAS/GitHub/공유·Windows 전송기 통합 |
| NAS 자동 동기화 (2026-10-20, Fable 5.1 작성·Codex 검수 01–30) | 저장 기반 개정 그래프·비밀값 전용 금고·WebDAV 전송·정규 투영/적용/복구·전경 코디네이터·전송 화면 UI·신뢰 채널 키 공유(X25519 봉인, 코드 입력 없음)·no-backup 배치·복원 계보. 서버 14파일 133개·클라이언트 33파일 440개 픽스처 통과, svelte-check 0오류. 사용 안내 [NAS-SYNC-USER-GUIDE.md](NAS-SYNC-USER-GUIDE.md), 인계 `tmp/nas-sync-review-20261020-XHomfx/FABLE-MILESTONE-4.md` | 실 NAS·실기기·실제 백업 미검증, 프로덕션 빌드 미실행(사용자 보류), Android 네이티브 빌드 미실행(`RISUBARD_NO_BACKUP_DIR` 한 줄만 추가) |
| 배포 | 미실행 | 필수 검사·실기기·최종 공동 검수·서명/버전·배포물 |

현재 앱은 app.risubard.personal.debug 프로토타입이며 정식 app.risubard.personal 배포본은 아니다. 기존 app.risumobile.usb와 데이터 영역이 다르다.

05:28 후속 자체 검수: `/api/db/stats/characters`의 늦은 초기 조회가 동시에 승인된 새 채팅을 덮는 경우를 HTTP로 추가 재현했다(tmp/runtime10-concurrent-repro.log). 초기 읽기 완료 후 이미 채팅 저장소가 만들어졌으면 덮지 않도록 수정했고 집중22개가 통과했다(tmp/runtime10-concurrent-fixed.log). 이 추가 수정은 APK13과 실행10차 Fable 제출 뒤에 생겼으므로 다음 패키지·재검수 대상이다.

**05:33 추가 발견 — 장시간 안정성 미통과:** APK13 UI 프로세스가 실행112초 뒤 MemoryInfra 스레드의 SIGTRAP으로 종료됐다. 스택은 에뮬레이터 Android15/API35의 WebView124.0.6367.219 `libmonochrome_64.so`를 가리키며, 앞선 내부 APK에서도 같은 프레임의 종료 기록이 있다. 짧은 instrumentation 성공을 장시간 실행 성공으로 해석하지 않는다. 현재 RisuBard/Node가 없는 빈 WebView 대조군과 별도 Android16 16KiB 환경을 준비해 원인을 분리 중이며, 아직 환경 문제로 확정하지 않았다. 원본 진단은 tmp/apk13-native-crash.log와 tmp/apk13-process-crash.log에 보존한다.

## 최신 내부 검사 (2026-10-17 06:16)

| 검사 | 결과 | 근거 |
|---|---|---|
| 전체 클라이언트 | 4,713통과 / 6생략 | tmp/client-suite-ports4.log |
| 전체 서버 | 1,183통과 / 3생략, maxWorkers4 | tmp/server-suite-runtime13.log |
| 기존 호환성 | 94통과 / 5생략 | tmp/compat-suite-internal12.log |
| 타입 / 웹 빌드 | 오류0·기존 CSS경고8 / 통과 | tmp/typecheck-ports4.log, tmp/web-build-ports4.log |
| 공통 전송 | 116통과, 다섯 공통 구현 모듈의 strict TypeScript 종료0 | tmp/transfer8-boundary-fixed.log; 전 단계는 tmp/transfer7-verification.json |
| ZIP / 기억 | 8+18=26통과, 시험 이름 포함 | tmp/transfer8-bound-memory-final.log (마지막 URI 수정 뒤 재검사) |
| 번역 후속 검사 | 19통과, 실제 WebView native fetch 데이터 URL 검사 통과 | tmp/ports3-fetch-fixed.log, tmp/emulator13-fetch-console.json |
| 저장 실패 HTTP | 26통과, 외부 변경본·실패한 앱 사본 보존, 실제 서버 재시작·읽기/patch 순서 검사 | tmp/server-suite-runtime13.log, tmp/runtime11-fixed.log |
| 런타임 산출물 검사 | 양 ABI 16KiB·APK ZIP/바이너리 해시·497파일 대조·zipalign·debug 서명 검증 | tmp/apk16-file-verification.json, tmp/apk16-source-verification.json, tmp/apk16-signature.log |
| 공개 경계 | 통과 | scripts/check-public-boundary.mjs 종료0 |

앞선 실패 기록도 유지한다. R8 전체 서버의 두 스텁 불일치와 R9 graceful-shutdown fixture의 새 함수 누락은 원래 단언을 유지해 수정했다. Windows 로그 sidecar rename EPERM 1건 뒤에는 로그 구현 변경 없이 단독 및 전체 재검사가 통과했다. 최신 동시 실행에서는 painter 저장 검사 하나가30초 시간 초과됐으며, 제품 코드나 제한 시간을 바꾸지 않고 maxWorkers4 전체 재검사1,165개가 통과했다(tmp/server-suite-runtime10.log, tmp/server-suite-runtime10-recheck.log). 일시 실패의 원인이 확정됐다고 표시하지 않는다. 실제 Google/Gemini/NAS 요청 성공으로 위 결과를 해석하지 않는다.

APK13 SHA-256: f29626b0a20fc79646bb33d04ba1b01312c8cf2c5be7525c64005530f3055ff4. 현재 저장·번역/Lua 소스와 최종 ARM64/x64 16KiB 바이너리를 포함한다. x64 16KiB 에뮬레이터에서 인증 복구·연결 재시도·이미지/Lua/모의 스트리밍/Wiki·반복 저장(persistedRuns7), 실제 기본 경로 백업 쓰기, 복구 파일 목록/링크 거부/ContentResolver 복사/원본 보존, 비어 있지 않은 구 런타임 백업 보존과 빈 백업 디렉터리 정리를 확인했다(tmp/emulator16k-apk13-instrumentation.log). 합성 console 메시지는 DevTools에 도달하고 logcat에는 없었으며 기본 fetch Gate도 데이터 URL을 읽었다. APK12 두 파일은 tmp/apk12-emulator/에 mapping과 함께 보존했다. 시스템 파일 선택창 실제 클릭 및 최종 ARM64 실행은 미검증이다. debug 서명의 내부 시험판이며 출시 APK가 아니다.

## 공동 검수와 남은 작업

실제 모델 식별은 claude-fable-5-1이며 xhigh로 요청했다. 실행 기반11차 지적을 재현하고 수정했고, 실행12차는 두 수정이 정확하며 새 데이터 손실 경로나 회귀를 찾지 않았다고 판정했다. 넓은 fallback catch·시험 하니스와 기존 복구 경계에 대한 별도 가설은 실제 검수 원문에 보존했다. 전송9차는 URI 경계 수정의 차단 결함이 없으며 호환4차는 해당 fetch/console 수정을 수용했다. 전체 기능 승인은 아니다. 각 실제 응답은 fable-*-review-*.md, 최신 대응은 FABLE-R11-RESPONSE.md, FABLE-TRANSFER8-RESPONSE.md, FABLE-PORTS3-RESPONSE.md에 있다. 제출 파일의 해시는 tmp/fable-*-review-*.input-hashes.json에 기록한다. 결과 전 승인으로 표시하지 않는다.

전송 원본 DB/저장 슬롯은 변경하지 않는다. 선택 밖 갤러리·요청 프롬프트는 전송 사본에서 제외하고 이유를 표시한다. 필수 이미지 누락은 숨기거나 임의 다운로드하지 않는다. 동일 ID로 새 프로세스에서 저장 슬롯의 과거 Wiki와 채팅을 불러온 내부 시험은 통과했지만, 새 수신 ID·앱 UI·물리 전송은 별도 미완료다.

아직 커밋·푸시·릴리즈하지 않았다. 전체 기능 대응은 FEATURE-MAP.md, 저장 필드 조사는 BARD-FIELD-INVENTORY.md를 따른다.


05:50 내부 후속: R10의 고아 저널 후속 저장과 blob/canonical 혼합 판본을 재현 후 수정했다. `commitTransaction`은 준비된 저널이 남으면 새 저장을 거부하고, 구 저널은 생성 시각 순서로 복구한다. direct-lane CFC 복구도 원래 저장 관찰자를 유지한다. 서버 전체1,177/3생략, 전송114/기억25 및 shared strict0 결과를 각각 기록했다. API35 빈 WebView도 동일 MemoryInfra 네이티브 스택으로 종료됐고, API36 WebView133에서는 같은 메모리 덤프 명령이 빈 앱과 RisuBard 양쪽에서 성공했다. 따라서 API35 시험 환경의 문제를 분리했으나 모든 Android 환경 안정성으로 일반화하지 않는다.

APK14 SHA-256: e8e8381cb266bccae1a46a53ab1912d3263d68b8c672f671c8ef6178f8f661b4. 포함 소스/웹 빌드497파일 일치(tmp/apk14-source-verification.json), API36 instrumentation 통과(persistedRuns2), 설치된 APK 해시를 직접 비교한 WebView fetch/console 검사 통과(tmp/apk14-webview-probe.json). 이후 전송6차의 자유 텍스트 URL·ID 없는 채팅·페이지 진단 경로 수정은 아직 APK14에 포함되지 않았으므로 최종 시험판은 재빌드해야 한다. 실기기 조작은 전혀 재개하지 않았다.

05:58 전송7차 공동 검수 후속: Fable은 앞선 네 수정의 적합성을 확인하고 낮은 심각도의 추가2건을 지적했다. URI(data/file/blob/프로토콜 상대주소)를 로컬 assets로 잘못 추정하는 경우와 중복 페이지 크기 충돌의 경로 누락을 실제 테스트로 재현해 수정했다. 현재 공통115개·ZIP/기억26개 통과, 다섯 공통 구현 모듈의 strict TypeScript 오류0. before/after 전체 입력 해시 및 실행 증거: tmp/transfer7-verification.json. 전송8차 재검수 중이다. APK15 내부 패키징 진행, 실기기 설치/정식 릴리즈 보류.

APK14에서 실제 Android 시스템 파일 선택창을 통한 합성 카드 JSON 가져오기, 제어된 강제 종료·재시작 후 자료 보존, 세로 키보드 위 입력칸을 확인했다. tmp/emulator36-saf-qa.json. 이 결과는 일반 카드 경로의 확인이고 risuplay v2/기기간 전송 성공이 아니다.

06:06 최신 APK16: SHA-256 b3ef9accbfd54de39316ba03a72047c1891c2cb74b86477d220bc5eabbda2d09, runtime ZIP0c8df30e1464372b8885c5c9c7fe9ed1675cf57f8e9ad8031df3789c33f8d497. APK15는 새 저장 후속 수정 이전 산출물로 보존만 했으며 에뮬레이터에도 설치하지 않았다. APK16의 현재 소스/웹빌드497파일 일치, 양ABI16KiB/서명검사 통과. emulator-5572의 in-place 업데이트 뒤 최초 설치 시각·UID10213 유지, 합성 카드 보존. instrumentation persistedRuns3 및 데이터 URL fetch/console 검사 통과(tmp/emulator36-apk16-instrumentation.log, tmp/apk16-webview-probe.json). 실제 제공자 요청·최종 ARM64·기기간 전송은 미검증.


06:16 내부 검사 정리: 실제 Fable 실행12차 is_error=false/modelUsage=claude-fable-5-1, 결과 원문 fable-runtime-review-12.md. 실행12/전송9/호환4 제출 파일 전체의 현재 해시가 일치한다(tmp/final-internal-review-input-checks.json). 최신 URI 수정 뒤 ZIP/기억26개 재검사 통과. APK16 가로 키보드(viewport122px/입력칸 bottom107.24px), 실제 toolbar 스와이프, Home→복귀 동일PID/초안 보존 추가 확인. 검사한 APK16 두 파일은 tmp/apk16-emulator/mapping.json과 함께 보존. 읽기용 중간 보고서는 INTERNAL-TEST-RESULTS-20261017.md. 전체 통합·물리 기기·정식 배포 미완료와 설치 HOLD는 유지한다.

## 2026-10-17 16KB 경고 후속

사용자 스크린샷의 ARM64 libnode LOAD 정렬 실패는 초기 4KB 프로토타입 바이너리와 일치한다. 이번에 debug 빌드에도 실제 런타임 검사를 연결했다. 4KB fixture는 수정 전 통과/수정 후 거부, 16KB fixture는 통과했다. 실제 Fable 1차의 Windows 링크 경로 우회 지적을 두 CLI에서 재현 후 realpath 비교로 수정했고, 회귀 포함4개 통과. 실제 초기 ARM64 바이너리도 검사에서 거부했다. 최종 APK 빌드는 검사 task 실행 후 성공했으며 APK16과 해시가 동일하다. API36 x64 16KB 에뮬레이터에서 같은 설치 파일을 재검사해 성공(persistedRuns4). **실제 Fable 5.1·xhigh 2차는 1차 확정 결함 해소·새 입증 결함 없음으로 범위 내 수용했다.** ARM64 실행과 물리 설치는 HOLD 유지. 근거와 검수 한계는 `ANDROID-16K-WARNING-20261017.md` 및 `fable-16k-warning-review-2.md`를 따른다.


## 2026-10-17 Offline 공통 기반 후속

사용자가 offline 버전도 요청했다. AI 실행 위치(기기 자체·같은 Wi-Fi PC·생성 없이 자료 열람) 답변은 대기 중이다. 기존 글꼴/수식을 로컬 자료로 포함했고, 새 TTF가 기존 스트리밍 ZIP에서 손상되는 문제를 재현해 기존 yazl/Node zlib로 수정했다. ZIP 전수 압축 해제/CRC gate와 실제 실패 표본 회귀 포함5개 통과. 실제 Fable 5.1·xhigh 1차/2차 검수는 각 제출 범위 내 수락, 확정 코드 결함 없음. 비차단 문서 정정과 inflate/yazl 오류 테스트를 보강해 자체 확인했다.

내부 APK18은 API36 x64 16KiB 에뮬레이터의 비행기 모드/통신OFF에서 시작·합성 첫 메시지·글꼴·TURN0 슬롯 생성/재시작/불러오기 통과. 일반 게임 대화·비어 있지 않은 기억·AI 생성 증거가 아니다. 최종 내부 APK20은 고지2파일만 달라진 후보(567파일 대조·ZIP/ELF/서명/정렬 통과)이며 설치하지 않았다. APK18→20의 외부 ZIP 항목도 직접 대조해 DEX/매니페스트/리소스/네이티브 바이트가 동일함을 확인했다. 내부 후보16/18/19/20은 각각 보존했다. 물리 기기 HOLD/정식 배포 미완료 유지. 상세는 OFFLINE-STATUS-20261017.md와 tmp/offline-version/의 기록을 따른다.

## 2026-10-17 태블릿 채팅 폭

기본 채팅 테마에서 기존 isMobile(휴대폰·Android 태블릿)이면 본문 최대 폭과 넓은 화면의 추가 패딩을 제거해 좌우1rem 여백을 사용하고 입력창도 가용 폭으로 확장했다. 제품 변경은 Chat.svelte/DefaultChatScreen.svelte 두 파일뿐. PC 너비 설정과 저장값·다른 테마·제작자 코멘트 박스·키보드 처리는 유지한다.
실제 Chromium 컴포넌트 렌더21조합: 390/600/800/1280/1600px 모바일의 세 폭 설정에서16px/16px, 수평 넘침 없음; PC1280/1920 세 설정과 작은 모바일은 전후 동일. 기존15회귀 통과, 타입0오류/기존8경고, 웹·APK 빌드 통과. 실제 Fable5.1xhigh 범위 내 승인·확정 코드결함0, 제출9파일 최종해시 일치. 코멘트 박스 별도폭 권고는 범위 밖으로 보존, DBState값 검사는 디스크영속검사로 과장하지 않는다.
내부APK21 sha256 2f344d3666038ac61780f165b8694da5c3e6134635855971f10a5154176b5969,567파일대조/ZIP/양ABI16KiB/서명/정렬 통과. tmp/tablet-width/apk21-final에 별도보존. 물리설치/새APK기기실행/정식배포 없음. 상세 TABLET-WIDTH-20261017.md와 fable-tablet-width-review-1.md. 전체통합 및 offline AI 결정 대기 상태는 그대로다.

## 2026-10-17 Android 기기 내 Offline AI

사용자 답변으로 태블릿·스마트폰 자체 실행이 확정되어 위의 AI 위치 결정 대기는 해소됐다. 별도 `RisuBard Offline`/`app.risubard.personal.offline.debug` 내부 APK에 고정 llama.cpp의 ARM64/x64 16KiB 엔진을 넣었다. 처음 단일 GGUF 모델을 가져온 뒤 메인/보조/모듈 AI 요청과 토큰 계산을 기기 안에서 처리한다. 온라인 설정과 일반판 데이터는 유지하고 자동 온라인 fallback은 없다. 가중치는 APK에 포함하지 않는다.

최신 내부 APK25 SHA-256 `e23e32d311cedd9925ba4c73596bb1259688bbbe4c627f964336f67bee9d2339`, `tmp/offline-native/apk25/`에 매핑과 보존. 소스/웹568파일·ZIP·4개ELF16KiB·서명/정렬·에뮬레이터 설치본 해시 일치. 모델 SAF 가져오기/교체·저장/재시작·모드 전환 저장값 보존·합성 SSE 오류 표시 확인. 앞선 APK22~24에서는 통신OFF 실제 영어/한국어 생성·취소/재시도·TURN1 저장 슬롯 불러오기·부모 강제 종료 시 엔진 정리·유휴 뒤 재생성을 확인했다. 실행한 판본별 기록은 OFFLINE-ON-DEVICE-20261017.md를 따른다.

자체 최신 서버10/클라이언트101/산출물6 검사 통과, 타입0오류·기존8경고, 웹/Offline 빌드 통과. 전체 클라이언트4715/서버1189는 앞선 변경 단계의 기록이며 최종 변경 후 전체 재실행으로 표시하지 않는다. 실제 Fable5.1xhigh 1~3차를 거쳐 지적을 재현·수정했고 4차 검수 진행 중이다.

APK24의 Metrics Background SIGSEGV는 코드 없는 빈 WebView에서 동일14프레임으로 재현해 API36/WebView133 시험 환경 문제로 분리했다. 진단 설정·ADB 권한은 복원했다. WEBVIEW-METRICS-CONTROL-20261017.md 참조. 최종 ARM64 실행·발열/속도/배터리·장문 게임 품질·장시간 안정성은 미검증이다. 물리 기기 설치 HOLD, 전체 기능 이식/전송/정식 릴리즈 미완료는 유지한다. 커밋·푸시·게시 없음.


### 기기 내 Offline APK27 후속

실제 Fable5차가 모델 교체/손상 설정/온라인 자동 대체 방지 수정을 수용했고 추가로 지적한 시작 GC 실패를 수정 전 재현 후 처리했다. 정리 실패는 경고, 초기화 불가 시 명시적 온라인 선택만 세션 한정 허용하며 미저장을 안내한다. 최신 서버11/실제 Linux POSIX3/클라이언트136/산출물6 통과, 타입0오류·기존8경고. 실제6차 재검수는 진행 중이다.

내부 최신 Offline APK27 SHA-256 f90608675db3abc82f021afb91113a3dab6da0c19d33dcde514ebd9ae738e1a6; 일반판 8ab663654687ba48600e2f6af23ca47e09f679dc0b125cf3352e0618844a3c46. 소스/빌드568파일·CRC·양ABI16KiB·Offline 서명/정렬 통과. 내부 Android에서 정리 실패와 저장소 권한 장애를 실제 유도하고 사용자 전환·설정/권한 원복·기존채팅/모델 보존을 확인했으며 통신OFF에서 TURN13 생성에 성공했다. 실제6차/최종승인 결과는 아직 받지 않았다. 상세 OFFLINE-ON-DEVICE-20261017.md.

BardWiki 분석은 시험문맥4096보다 큰 프롬프트4785(추정)로422 실패, 성공으로 세지 않는다. 긴 MGE/기억 품질·실제 ARM64 속도/발열/배터리·전체 통합/전송/정식 릴리즈는 미완료. 로컬 생성 중 렌더러 종료 시 진행출력 복구는 보장하지 않는다. 물리 기기 설치 HOLD 유지.


## 기기 내 Offline APK28 최종 내부 검사 — 2026-10-17

실제 Fable5.1·xhigh 총7차 검수 완료. 마지막3개 수정은 소스/시험과 일치하며 차단 수준 결함·직접 회귀는 발견되지 않았다. 경미한 경고 문구/우선순위와 상태 조회 실패의 기본 모드 의미는 최종 평가에 기록했다. 앞선4~6차 진행 중 표시는 당시 이력이며 현재 검수 대기는 없다.

최신 Offline APK28 SHA-256 a7efb18c6f404bab0b99ee8ec3c3ec3de285f6d2031fad2b0343840f3b9425bb,161403919바이트; runtime ZIP367dba77fa5444038c8f176f2bcb5b38485d248a2aa17daae3092ba1ded22d84. 일반판 회귀28은 d29ba8267c52437e4206689526ddba8f0bdd737306ff1ad9cbbda239d398d004이며 설치하지 않았다. 양판568소스/웹빌드 일치·ZIP CRC·16KiB, Offline 서명/정렬 통과. 서버12·클라이언트139·실제 LinuxPOSIX3(skip0)·산출물6, 타입0오류/기존8경고·빌드 통과.

내부 에뮬레이터에만 APK28을 업데이트했다. 상태 GET 무응답에도 기존 채팅 접근/기기 내 모드를 유지하고 응답 복원 후 모델 표시가 회복됐다. 실제 로컬 모델로 통신OFF TURN14 한국어 생성을 확인했다. 설치 해시·UID/최초 설치 시각·모델 설정 보존 확인, 시험용 설정/권한/통신과 자체 포워딩 정리 완료. 물리 기기 설치 HOLD 유지.

기록: docs/feature-port/OFFLINE-ON-DEVICE-20261017.md, FABLE-OFFLINE-DEVICE-FINAL-ASSESSMENT.md, fable-offline-device-review-7.md. 증거: tmp/offline-native/apk28-final-chat.json, apk28-installed-proof.json, apk28-cleanup.json. 물리 ARM64 실행/속도/발열/배터리·긴 MGE/BardWiki 품질·전체 기능 이식/전송/정식 릴리즈는 미완료다. 시험4096문맥의 BardWiki422와 진행 중 생성 journal 미지원은 그대로 명시한다.

## 2026-10-17 전송 통합 내부 검사 후속

공통 v2를 앱 UI·Node 저장·BardWiki·슬롯·NAS/GitHub·Android/Windows 네이티브 전송에 연결했다. 최신 검증과 한계는 TRANSFER-INTEGRATION-20261017.md, 사용 흐름은 TRANSFER-USER-GUIDE.md를 따른다. 클라이언트4,730/6생략, 서버1,214/4생략, 공통116, 실제Windows IPC/HTTP 재시작·충돌·회복·65MiB Java/C# 상호운용 통과. APK29 일반/Offline와 Windows 내부 패키지 준비, API36 x64 에뮬레이터 및 실제 Chromium UI 확인. Fable 최종 읽기 전용 검수 진행 중. 물리 기기 설치/실계정/정식 게시 보류, 미완료 범위를 숨기지 않는다.

## 2026-10-17 전송 이식 내부 검수 완료 — 후보31

공통 .risuplay v2, BardWiki/저장 슬롯/참조 자료, 기존 캐릭터에 채팅만 추가, 파일/NAS/GitHub/Android·Windows Wi-Fi·USB·공유 연결, 영속 대기열·중단 복구를 이식했다. 요청 로그·백업·페르소나는 기존 흐름을 재사용하고 실제 UI로 검사했다. 기존 카드/대화/API/현재 화면은 보존한다.

자체 검사 후 실제 Fable5.1·xhigh 읽기 전용 검수10건에서 확인된 문제를 수정·재검사했다. 최종 core6/remote5/native5는 각 범위의 추가 확정 회귀·차단 문제를 발견하지 않았고, 검토한 현재43개 파일은 입력 해시가 일치한다. 비차단 의견의 판단과 근거는 FABLE-TRANSFER-FINAL-ASSESSMENT.md에 남겼다. 앞선 이 문서의 미완료/대기 표시는 해당 시점의 이력이다.

서버1220/4skip·클라이언트4733/6skip(마지막 전달 상태 수정2개 별도 재검사)·공통116 통과, 타입0오류/기존8경고. 일반/Offline APK31와 Windows 포터블 ZIP·전송기, 사용 안내·검수 기록·SHA-256 준비. 각APK580개 소스 대조/CRC/allELF16KiB/sign/align, Windows33755개파일해시/CRC·실제IPC·중복프로세스차단·독립시작, API36 x64 내부 실행/공유URI재생성/Offline 통신OFF 실제생성 통과.

최신 기준: TRANSFER-INTEGRATION-20261017.md, FABLE-TRANSFER-FINAL-ASSESSMENT.md, TRANSFER-USER-GUIDE.md. 산출물 tmp/transfer-build31/README.md와 SHA256SUMS.txt. 물리 TB710FU/SM-S938N 설치/최종ARM64·실Wi-Fi/USB/QuickShare·실NAS/GitHub·긴MGE품질은 보류/미검증. 커밋·푸시·정식게시 없음. 사용자기기/개인대화/계정은 변경하지 않았다.

## 2026-10-17 설정만 초기화·선택 이전 완료

후속 설치/실기기 결과는 DEVICE-QA-20261017.md의 후보33 기록이 위 후보31 설치 보류 상태를 대체한다. 이어 사용자가 설정만 초기화하도록 범위를 확정하여, 두 기기의 일반/Offline 네 앱에 각각 기존 USB 앱의 API·모듈·플러그인·프리셋을 이전했다. 기존 캐릭터·채팅·페르소나·기억·슬롯·Offline 모델과 원본 USB 앱은 보존했다. 네 앱 재시작 후 이전/초기화 필드 불일치0, 각 이미지134개 SHA 확인. 태블릿 이미지 별칭은 동일 모듈의 스마트폰 바이트를 배포 원본 해시와 확인해 복구했으며 스마트폰 선택적 모듈 아이콘1개는 원본부터 누락이다.

실제 Opus5.5/xhigh 유효 검수3건 후 마지막 판정은 설정 적용·저장·검사 시점의 재시작 유지 범위에서 확인된 차단 문제 없음이다. 이후 사용자가 추가한 캐릭터는 그대로 두었고 재초기화하지 않았다. API/모델 생성·플러그인 전체 동작은 이번 작업에서 미검증. 세부 범위/근거는 SETTINGS-MIGRATION-20261017.md, 실제 최종 검수는 OPUS-SETTINGS-20261017.md. 제품 소스/APK 변경·새 설치·커밋·푸시·릴리즈 없음.


## 2026-10-17 구조·MGE 로어 검토와 로컬 AI 작업 종료

사용자가 GitHub/온라인 구조 검토와 MGE 로어 리뷰를 요청하고 로컬 AI를 포기한다고 결정했다. GGUF/llama.cpp 추론판의 추가 개발·모델 선택·성능 시험을 종료한다. 앞으로 일반판/온라인 API에 집중한다. 기존 Offline 앱·모델·캐릭터·대화 및 앱 구동용 Node 서버/오프라인 자료 열람은 보존했다.

공개 포크/상류 main은0.9.71/64ebfb23으로 확인했다. 기존 로어·선택적Grimoire·BardWiki 경로를 구분하고 배포1.2.27/미배포1.3.0 후보를 검사했다. 태블릿 저장본은 캐릭터 loreSettings 부재/legacy모드이며 전역8,000→800초기화가 확인됐다.12조합 시험은 예산64,000과 재귀false에서 상시19개를 모두 선택했으며64,000/재귀true는14개였다. 기존 설정 이전 검증은 저장/재시작만 확인했고 이 의미 손실을 놓쳤다.

최종 내부8검사 통과(12조합 포함), 실제 Opus5.5/xhigh 두 차례 검수 완료. 핵심 결론의 근거를 지지했고 인과관계·장면 로어 누락·기기 사례 부재·특성화 검사 범위의 지적을 반영했다. 수정/실기기 성공 승인은 아니다. Grimoire 단순전환의 정규식/상시 누락, 기존 메타데이터 이행, Wiki 입력 봉투 경계도 기록했다. 제품 소스/로어/기기 설정 변경·설치·릴리즈는 없다. 현재 기기 설정/실제 요청/모델 플레이·설정 부재 시작 경로는 미검증. 기준: LORE-COMPATIBILITY-20261017.md, OPUS-LORE-COMPATIBILITY-20261017.md.
