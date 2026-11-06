# 기존 기능 → RisuBard 통합 대응표

기준: USB 앱 1.4.1 코드 a2641e7d(인계 문서 포함 작업 사본 0dd5b1d3), RisuBard 64ebfb23.
2026-10-17 전송 통합 후속: 아래 최신 행과 `TRANSFER-INTEGRATION-20261017.md`, `FABLE-TRANSFER-FINAL-ASSESSMENT.md`를 우선한다. 아래 과거 시점의 대기 기록은 이력이며, 물리 기기/실계정/정식 배포 완료와 내부 검사를 구분한다.
`기존` 경로는 USB 저장소, `대상` 경로는 RisuBard 저장소 기준이다.
이 표의 재사용 결정은 소스 조사 결과이며, 별도 시험 결과가 없는 행은 동작 검증 완료가 아니다.

| 기능 | 기존 구현 | 대상 / 통합 방식 | 검증 상태 |
|---|---|---|---|
| 독립 Android 앱 | android-app Kotlin WebView·파일 선택·IME 처리 | android-app, 서버 코드는 런타임 버전 폴더, 사용자 자료는 별도 user-data | APK7 두 기기 실행·키보드·회전 통과. APK13 양 ABI 16KiB 파일 검사와 x64 에뮬레이터 통과. 이후 실기기는 보류 |
| 최초 앱 인증 | 기존 Node 로그인·세션 쿠키·JWT | InstallCredential + EmbeddedServer; 원래 /api/login → /api/session, 쓰기 잠금은 WebView 소유 | PC 패키지 자동 인증 성공, 네이티브 bootstrap 후 writer state=free |
| 스트리밍 묶음·검증 | shared/play-set/protocol.ts, nativeArchive.ts; Java/C# PlaySetArchive | 공통 TypeScript v2 확장 + 서버 스트리밍 파일 경로 | 공통116개 통과. 서버 수신/내보내기·실제 UI 파일 왕복 연결 완료. 물리 전송은 보류 |
| 캐릭터·채팅 추가, 중복 수신 | shared/play-set/characterChats.ts, apply.ts | characterPackage.ts의 내부 가져오기 함수 + 명시적 ID 연결, 기존 importTransaction 확장 | 기존 클라이언트 저장 경로 연결. 원래 카드/대화/선택 보존·UI 새 대화 추가·중복 방지 통과 |
| BardWiki 현재 기억 | 구 앱에 해당 파일 형식 없음 | server/node/risubard-memory-workspace.ts, memory-fork.ts, memory-runtime.cjs | play-set-relink.cjs/fingerprint.cjs: 수신 ID 연결·비어 있지 않은 Wiki A→B→A 중복/수정본 구분·canonical 재시작 통과 |
| 저장 슬롯·공용 페이지 | 구 앱에 해당 파일 형식 없음 | risubard-memory-save.ts, memory-save-store.ts; sourceChatId로 선별, SHA-256 페이지 재사용 | 수신 ID/페이지 해시 연결 후 기존 memory runtime의 실제 슬롯 불러오기 통과. 물리 기기 UI 불러오기는 보류 |
| 저장·복구 대기열 | shared/play-set/importer.ts + appRuntime.ts | 서버 영속 기록 + 기존 ImportTransaction/NodeStorage canonical flush, 클라이언트 시작 시 회복 | play-set-service.cjs + playTransfer.ts 연결. 실제 HTTP canonical 저장/flush/재시작·다른 탭과 오래된 토큰423·중간 ENOSPC 복구 통과 |
| NAS WebDAV | Android NasTransfer.kt, shared/play-set/nas.ts, pc_nas.rs | Node 서비스로 이식, 기존 URL·리다이렉트·경로·해시 규칙 보존 | transfer-remote.cjs로 이식. 모의 WebDAV 임시 PUT→검증→MOVE/손상/리다이렉트 통과. 실 NAS 미검증 |
| NAS 자동 동기화 | (신규) | server/node/nas-sync-{core,vault,store,remote,manifest,projection,service,share}.cjs + src/ts/nasSync.ts·nasSyncCoordinator.ts·nasSyncUi.ts, TransferPanel 3절, 대화 화면 인라인 복원 안내. 같은 NAS 연결 정보 재사용, 키 공유는 등록 Wi-Fi/USB 수신함(X25519 봉인)만, 식별자·금고 키는 no-backup 디렉터리 | 픽스처: 서버 133·클라이언트 440 통과(루프백 WebDAV·실제 server.cjs 자식 프로세스). 실 NAS·실기기·프로덕션 빌드 미검증. 안내 NAS-SYNC-USER-GUIDE.md |
| GitHub JSON 백업 | GitHubChatUpload.kt, privateMobileGitHubUpload.ts, desktop-transfer | 8MiB JSON 호환 유지; v2는 100,000,000바이트 미만, 임시 파일·스트리밍, 고정 판본 검증 | v2 <100,000,000바이트·기존 JSON8MiB/chat-uploads 연결. 모의 고정 판본·충돌·이전 백업 보존 통과. 실 계정 미검증 |
| Wi-Fi 기기 검색·등록 | PlaySetNetwork.kt, Java J-PAKE; C# PlaySetPairing/Discovery/Transport | Java/C# 프로토콜 재사용; 앱 서버와 별도 리스너·개인 키 저장 | 네이티브 코드 연결. JVM↔C# 루프백65MiB/J-PAKE/TLS/해제/heartbeat 통과, Android WebView 실제 등록 RPC 통과. 물리 검색/등록은 보류 |
| USB·내장 ADB | UsbPlaySetServer.kt, UsbPlaySetWire.kt; UsbAdbTransport.cs | 기존 PIN 없는 USB 유지, helper는 파일 전달, 앱이 적용 | 새 앱 전용 소켓과 helper IPC 연결. 내장 ADB self-contained Windows 빌드 및 에뮬레이터 USB listener 시작 통과. 물리 USB 양방향은 보류 |
| 개별 채팅·페르소나 전송 | privateMobileChatSync.ts, PersonaTransfer.ts; Windows MainForm | 기존 JSON/PNG와 RPT1 호환 메뉴·helper 유지 | Windows 구 JSON/PNG/RPT1 메뉴 보존, Core12검사 통과. RisuBard 기존 가져오기 보존. 물리 호환 왕복 보류 |
| 시스템 공유·파일 열기 | PlaySetController.kt, FileProvider, receiveIntent | 신규 앱 ID FileProvider와 content URI → 서버 수신 대기열 | 새 FileProvider/Intent/SAF·서버 수신 목록 연결, 공유창 열림과 전달 완료 구분. APK 빌드 통과; 실제 공유 전달 미검증 |
| 비밀정보 보호 | GitHubTokenStore.kt, NasSettingsStore.cs, native settings | Android Keystore / Windows DPAPI 재사용 | Android Keystore + AES-GCM / Windows DPAPI 구현. 실제 DPAPI 왕복, 암호문·다른 키 거부 통과. 사용자 계정 설정은 미변경 |
| 통합 전송 화면 | shared/play-set/설정 UI + play-set UI patch | 대화 선택 → 방법 선택 → 보내기/받기, 방법과 별개 진행 상태 | 대화 선택→방법→보내기/받기 연결. Chromium 파일 왕복·오류·방법 전환·새로고침 후 수신 목록·취소·390/800/1280px 확인 |
| 요청 로그 | advanced-request-log.patch, RequestLogController.kt | RisuBard RequestLogs.svelte + requestLog.ts + server/node/request-logs.cjs 우선 | 실제 Chromium 목록/상세·URL/헤더 마스킹과 서버 검사 통과. 최종 Android 터치 접근은 설치 후 확인 |
| 백업·복구 | backuplocal.ts, native SAF writer, cold storage | SystemBackup.svelte, Node 파일 저장·백업 경로 우선; Android 파일 선택·내보내기 연결 | 실제 전체 백업 다운로드·디코딩과 내부 Android ContentResolver 복구 내보내기 통과. 물리 대용량 복원은 보류 |
| 페르소나 PNG | persona.ts + persona-transfer.patch | RisuBard src/ts/persona.ts 기존 PNG 읽기/쓰기 보존 | 실제 PNG 내보내기/다시 가져오기와 내용 보존 통과. 물리 호환 왕복은 보류 |
| Google 번역 폭주 방지 | privateMobileGoogleTranslate.ts gate + tests | translator/translator.ts의 기존 Node 경로와 비교, 빠진 직렬화·실패 backoff만 이식 | Android 직렬화·backoff·실패 캐시 방지·HTML 교착 수정. 데스크톱 기존 오류 동작 보존. 현재 전체 클라이언트4,713개 통과/6생략. 실제 WebView native fetch 호출 수정 검증. 실제 Google 요청은 미실행 |
| Gemini 마지막 model 턴 | privateMobileGeminiRequest.ts + tests | 기존 함수를 재사용, Android UA에서 추가 매개변수 적용 뒤 호출 | 함수·실제 요청 preview·기존 thinking 9개 검사 통과. 일반 브라우저 끝말/미응답 함수 호출 유지. 실제 API 호출은 미실행 |
| 임베딩·Gemini 통신 | privateMobileDirectFetch.ts | globalApi.svelte.ts의 Node proxy fallback 우선 | 기존 Node proxy 경로 사용. 전체 클라이언트4730/서버1214 통과. 실제 제공자 임베딩·Gemini 호출 미실행 |
| 로어 검색 교정 | risuai-lore-search.patch | process/lorebook.svelte.ts: 검색 깊이 음수 slice와 keys 변이 교정 | 4개 실패 재현 후 원본 패치 3곳 이식. 관련 41개 검사 통과. Bard 검색 구현 유지 |
| Lua 실행 최적화 | luaScriptSupportsMode + ASCII bootstrap, tablet-chat.patch | scriptings.ts의 기존 VM cache·권한 fingerprint 유지하며 동등 여부 검사 | 실제 Wasmoon 한글 argv 경로 abort 재현, ASCII bootstrap 한 줄 이식 후 통과. 동적 hook을 놓치는 구 정규식 선별은 미이식. APK13 에뮬레이터 Lua 실행 통과 |
| 본문 폭·좌우 여백·하단 입력 | android-chat-width/composer/tablet-chat.patch | Chat.svelte, DefaultChatScreen.svelte, Android IME insets | 태블릿 폭 21조합과 기존 키보드 에뮬레이터 검사 통과, 이번 전송 화면은390/800/1280px 확인. 최신 물리 IME/회전 보류 |
| Windows 프로필·인스턴스 | MGE Fix Tauri profile + pc_bridge.rs, C# PlaySetService.cs | RisuBard portable의 data root/lock/launcher + 별도 앱 연결 | app.risubard.personal/data root별 IPC. 한글·ß 경로/부모 종료/재시작 ID 보존·self-contained helper·포터블 서버 시작 통과 |
| 업데이트·배포 | 기존 release scripts | RisuBard release.yml 파일명 유지, check/download 모두 minchopie/RisuBard | 확인/다운로드 minchopie/RisuBard로 변경. workflow에 shared/play-set와 Windows helper/내장 ADB 추가. 로컬 패키지 검사 통과; CI/게시 미실행 |

## 현행 남은 실사용 검증

- APK7에서 Android 앱 UID의 서버·필수 모듈·이미지·Lua·스트리밍·합성 자료 복원·회전·키보드는 통과. 이후 저장 경로 수정과 최종 앱의 실기기 검증은 사용자 다음 설치 요청까지 보류.
- 후보31 양 ABI 16KiB 파일 검사·x64 에뮬레이터 실행은 통과. 최종 ARM64 실행은 실기기 설치 보류 때문에 미검증(앞서 확인한 두 실기기는 4KiB).
- 구 앱 → 새 앱, 새 앱 ↔ 새 앱의 실제 기기 전송 후 기억 조회/저장 슬롯 불러오기. 서버 내부 canonical 재시작·슬롯 불러오기는 별도로 통과했다.
- 동일 이름 다중 후보, 중복/수정본, 자료 누락/손상, 취소/재시도, 공간 부족·중단 복구의 실제 기기 UI. 해당 내부 표본 검사는 통합 기록을 따른다.
- 각 단계의 물리 앱 강제 종료, ACK 유실·네트워크 전환과 장시간 대기. 내부 오류 주입/프로세스 재시작 표본 통과를 모든 조합 통과로 확대하지 않는다.
- 태블릿·스마트폰·Windows Wi-Fi/USB/Quick Share 양방향과 실제 NAS/GitHub 계정. 65MiB Java/C# 루프백과 모의 원격 계약 검사는 통과했다.
- 최신 실기기의 키보드·회전·버튼 접근·본문 폭, Windows 구 호환 메뉴의 실제 왕복.
- 실제 GitHub의 8MiB 초과·상한·충돌 시 이전 백업 보존. 경계값·고정 판본·실패 보존 모의 검사는 통과했다.
- Offline ARM64 속도/발열/배터리, 긴 MGE/BardWiki의 모델 문맥/품질. 내부 4096문맥 표본의 422 한계는 유지한다.
- CI 실행, 정식 태그/배포 서명/게시. 전체 내부 검사와 공동 검수 결과는 최신 최종 평가를 따른다.

2026-10-17 05:50 후속: APK14/API36 16KiB 실행·메모리 진단 및 소스497파일 대조 통과. API35 WebView124 네이티브 종료는 코드 없는 대조 앱에서도 재현됐다. APK14 뒤의 전송 URL/ID 없는 채팅/진단 경로 수정은 다음 패키지 대상이다. 저장 서버 전체1,177/3생략, 공통114·ZIP/기억25·shared strict0. Fable 실행11차/전송7차 검수 중이며 호환4차는 해당 수정 범위의 추가 결함이 없었다. 실기기/전체 기능/정식 배포 완료는 아니다.

2026-10-17 06:06: 표의 후속 상태는 STATUS.md 최신 표를 우선한다. 공통116/ZIP·기억26/전체 서버1183통과3생략. 실행12차 Fable 검수 진행, 전송9차 해당 URI 수정 차단0건, 호환4차 해당 수정 수용. APK16 양ABI16KiB/소스497파일 대조와 API36 instrumentation 통과. 시스템 SAF 합성 카드 가져오기·재시작·세로IME는 APK14에서, 내부 업데이트 후 같은 카드 보존은 APK16에서 확인. 물리 기기는 보류.

06:16 후속: 실행12차 Fable 검수도 해당 두 수정 수용, 새 데이터 손실/회귀 발견 없음. 전체 통합 승인 아님. 마지막 URI 수정 이후 ZIP/기억26개 재검사 통과. APK16 가로IME·실제 도구 모음 스와이프·백그라운드 복귀 확인. 상세: INTERNAL-TEST-RESULTS-20261017.md와 RUNTIME-UI-QA.md.
