# RisuBard 전송 통합 내부 검증 — 2026-10-17

작업 브랜치 `codex/risubard-feature-port`, 기준 `64ebfb23`.
사용자 요청: 남은 기능 이식과 실제 Claude 공동 검수. 태블릿·스마트폰 설치는 보류한다.
이 문서의 최신 검사 기준은 내부 후보31이다. 소스 이식과 내부 검사를 기록하며, 물리 기기·실계정 전송과 정식 릴리즈 완료를 뜻하지 않는다.

## 구현 범위

- 공통 `.risuplay v2`를 파일·NAS·GitHub·Wi-Fi·USB에 연결했다. 서버는 묶음·기억·슬롯을 처리하고, 채팅 적용은 기존 클라이언트 저장 경로가 수행한다.
- 같은 캐릭터에는 대화만 추가한다. 기존 카드·채팅·API·화면을 유지하며 팝업으로 이어하기를 요구하지 않는다.
- BardWiki/저장 슬롯의 새 ID 연결과 로컬 내용 지문을 구현했다. ID가 달라지는 A→B→A 왕복도 내용이 같으면 중복을 만들지 않는다. 기억을 수정한 수신본은 새 대화로 보존한다.
- 적용 계획 기록 → 에셋·기억 준비 → 채팅의 canonical 저장/flush → 기억 확정 순서로 처리한다. 저장된 채팅 해시가 다르면 덮어쓰거나 지우지 않고 복구 기록을 남긴다.
- 다른 탭과 오래된 가져오기 토큰의 저장을 차단한다. 받는 도중 재시작한 항목은 실패로 표시해 재전송·취소할 수 있게 한다.
- Android NSD/J-PAKE/TLS·USB·SAF 공유와 Windows DNS-SD/J-PAKE/TLS·내장 ADB를 이식했다. 새 앱의 프로필·USB 소켓·Windows IPC는 구 앱과 분리한다. 전송기는 앱 DB를 수정하지 않는다.
- NAS 업로드는 임시 파일 검증 후 MOVE, GitHub는 비공개 저장소·고정 판본·파일 해시를 검증한다. 기존 JSON 8 MiB와 `chat-uploads` 호환을 유지한다.
- 비밀정보는 Android Keystore/Windows DPAPI를 사용한다. 업데이트 확인·다운로드는 `minchopie/RisuBard`로 맞췄다.

## 확인한 결과

| 구분 | 관측 결과 | 증거 |
|---|---|---|
| 공통 형식/자료 선택 | 116 통과 | `tmp/transfer-shared-final2.log` |
| 서버 전체 | 1,220 통과 / 4 생략. 생략된 Windows IPC는 아래 별도 실제 exe 검사로 실행 | `tmp/transfer-server-full6.log` |
| 클라이언트 전체 | 4,733 통과 / 6 생략. 이후 전달 상태 재시도 수정은 관련 2개 검사와 타입 검사를 다시 실행 | `tmp/transfer-client-full4.log`, `tmp/transfer-native-client2.log` |
| 실제 Windows IPC | 한글·ß 경로, v2 전달, ID 재시작 보존, 허용 명령, 부모 종료 후 helper 종료 통과 | `tmp/transfer-ipc-http-final2.log`, `tmp/transfer-portable29-ipc.log` |
| 실제 HTTP 저장 | 여러 조각의 요청 본문, 다른 탭/오래된 토큰423, 저장·서버 종료·재시작·적용 통과 | `tmp/transfer-ipc-http-final2.log` |
| 기억·슬롯 | 비어 있지 않은 기억/슬롯의 canonical 저장·재시작·실제 슬롯 불러오기, 두 번째 기억 적용 중 ENOSPC 뒤 복구, 왕복 중복/수정본 구분 통과 | `tmp/transfer-service-final8.log` |
| NAS/GitHub | 모의 HTTP, 실제 DPAPI, 8 MiB JSON 경계, 8 MiB 초과 묶음, 100,000,000 경계, 충돌·손상 시 이전 백업 보존 통과 | `tmp/transfer-integration-tests7.log` |
| Java/C# | JVM↔C# 루프백 J-PAKE·TLS, 65 MiB 양방향, 키 확인·틀린 코드·등록 해제·긴 검증 heartbeat 통과 | `tmp/transfer-pairing-interop*`, `tmp/transfer-tls-interop1.log` |
| Android 네이티브 | 컴파일, 직접 JUnit 10개 통과 | `tmp/transfer-native-junit.log` |
| 실제 Chromium UI | 파일 저장→열기→동일 자료 중복 방지, 같은 이름 캐릭터에 새 대화 추가, 기존 대화/선택 보존, 손상 파일 오류, 방법 전환 후 상태 유지 | `tmp/transfer-ui-*-snapshot.log`, `tmp/transfer-ui-durable.json` |
| 화면 폭 | 390px/1280px에서 전송 영역 scrollWidth=clientWidth. 800px 포함 스크린샷 확인 | `tmp/transfer-ui-layout390.log`, `tmp/transfer-ui-layout-evidence.log`, `output/playwright/transfer-*.png` |
| 타입/웹 | 타입 오류0·기존 스타일 경고8, 웹 빌드 통과 | `tmp/transfer-types9.log`, `tmp/transfer-web-final31.log` |
| Windows 내부 패키지31 | 동봉 의존성으로 별도 자료 경로의 서버 시작, self-contained helper 실제 IPC·8개 연결 유지 후 복귀·부모 종료 확인. 소스/웹580개 일치 | `tmp/transfer-portable31-smoke.log`, `tmp/transfer-portable31-ipc3.log`, `tmp/transfer-build31/windows-source.json` |
| APK31 | 일반/Offline clean 빌드, 각580개 소스/웹 파일 일치, ZIP CRC·모든 ELF16KiB·서명·zipalign 통과 | `tmp/transfer-build31/apk-verification.json`, `normal-source.json`, `offline-source.json`, 서명/정렬 로그 |
| Android 내부 실행 | API36 x64 16KiB 에뮬레이터에서 일반 APK31 실행·보존7회·인증 복구·이미지·Lua·스트리밍, 대기 공유 파일→아이콘 재실행→실제 Activity 재생성→영속 수신함 통과 | `tmp/transfer-emulator31-instrument.log` |
| Offline31 회귀 | 동일 에뮬레이터 통신OFF, 기존 Qwen3-0.6B Q8 모델로 앱 내부 API의 실제 생성 HTTP200·내용 `완료`. 모델 설정 해시 동일, 통신 원상 복구. 채팅 UI에서 새 턴을 저장한 시험은 아님 | `tmp/transfer-offline31-proof.json` |
| 실제 시작 복구 UI | 해시 불일치 안내→사용자 보류→앱 시작. 원래/변경된 수신 대화·원본 묶음·staging·복구 계획 모두 보존 | `tmp/transfer-recovery-ui-proof.json`, `output/playwright/transfer-recovery-held.png` |
| 기존 기능 UI | 전체 백업 다운로드 및 실제 디코딩, 페르소나 PNG 내보내기/다시 가져오기, 요청 로그 상세와 URL·헤더 비밀값 마스킹 | `tmp/transfer-ui-backup-inspected.json`, `tmp/transfer-ui30-persona-imported.log`, `tmp/transfer-ui30-log-detail.log` |
| 설정 복구 UI | 손상된 합성 자격정보를 명시적 확인 후 초기화. 원래 암호문 복구 사본과 대화 보존 | `tmp/transfer-ui30-reset-confirm.log`, `tmp/transfer-ui30-reset-done.log` |
| Android 전송 브리지 | 실제 WebView RPC 기기 ID·USB 시작·6자리 등록창·잘못된 핸들 거부 통과 | `tmp/transfer-android-bridge29.json` |

## 구분해서 남기는 한계

- 물리 TB710FU·SM-S938N 설치/ARM64 실행/실제 Wi-Fi 검색·USB 양방향·Quick Share 수신은 이번에 수행하지 않았다.
- 실제 NAS·GitHub 계정으로 업로드/다운로드하지 않았다. 모의 서비스 검사를 실계정 성공으로 표시하지 않는다.
- 슬롯 테스트의 인레이 설치 함수는 시험용 대역이다. 실제 이미지 렌더링/기기간 이동의 결합 검증은 별도다.
- 기억 해시 불일치 시 자동 복구를 강행하지 않는다. 보존된 작업 기록을 진단해야 한다.
- 긴 MGE 대화의 Offline 품질·ARM64 속도/발열/배터리는 이전과 같이 미검증이다.
- APK와 Windows 패키지는 내부 후보이며 정식 릴리즈가 아니다. 커밋·푸시·게시·물리 기기 설치는 하지 않았다.

## 검수 도구 결과 처리

실제 Fable 5.1·xhigh에 변경 소스의 읽기 전용 사본, 입력 SHA-256과 합성 시험 결과를 전달했다. 검토 문장 없이 도구 호출 문형만 반환한 응답과 출력 토큰 한도 오류는 검수 완료로 계산하지 않았다. 유효 원문은 `fable-transfer-*.md`에 보존한다.
앞선 유효 지적은 재현·소스 확인 후 수정했다. `atomicWriteJson`이 비동기라는 가정은 실제 동기 구현으로 반증됐다.

### 확인한 결함과 수정

- 복구 불일치로 앱 시작/저장이 계속 막히던 경우: 명시적 보류와 원본·복구 기록 보존을 추가했다. 다른 탭 잠금과 `TRANSFER_BUSY`를 구분해 세션을 잘못 비활성화하지 않는다. 자산 삭제도 같은 쓰기 잠금을 따른다.
- 준비 실패 시 남는 임시 디렉터리, 내보내기 지문 계산 전에 완료 기록을 쓰던 순서: 실제 디스크 실패를 주입해 재현하고 정리·기록 순서를 수정했다. 실패 시 기존 자료와 수신 원본을 지우지 않는다.
- Android 재생성/재연결/아이콘 재실행 중 공유 URI 누락, 종료 직후 작업 제출 예외: 대기 Intent 보존과 네이티브 예외 처리를 수정했다. 가져오기 상태 조회 실패 후에도 이미 확인된 전달 사실을 유지하고 재조회한다.
- Windows 8개 파이프 연결 시 전송기 종료: 생성 시점 IOException을 처리한다. 구 exe에서 종료를 재현했고 새 exe에서 8개 연결 유지·해제 후 정상 응답을 확인했다.
- 손상된 NAS/GitHub 자격정보로 설정 재입력 불가: 확인 후 암호문을 별도 보존하며 초기화한다. GitHub 기존 JSON 대화 수정본은 충돌을 표시하고 확인한 정확한 SHA에 대해서만 갱신한다.
- 요청 로그의 불투명 URL 키 값: 알려진 인증 쿼리 이름도 마스킹한다. 과거 로그를 임의로 삭제/재작성하지 않는다.
- 기존 시스템 로그의 4개 프로세스×25개 fsync 저장: 원본 HEAD에서도 5초 잠금 대기 실패를 재현했다. 저장·잠금 방식은 유지하고 한도를 30초로 늘렸다. 동시 실행 검사가 통과했다. 같은 저장 경로의 다중 프로세스 경합에서는 최악의 동기 대기가 늘어나는 한계가 있다.

### 실패한 검사와 후속 처리

서버 전체3/4, 중단한 직렬5에서 기존 로그 잠금 실패를 관측했고 원본 대조 후 전체6이 통과했다. 후보31의 첫 androidTest 빌드는 보호된 `Activity.onNewIntent` 직접 호출 때문에 실패했다. 공개 `Instrumentation.callActivityOnNewIntent`로 교정한 두 번째 빌드와 실제 에뮬레이터 검사가 통과했다. Windows 패키지 첫 stress 검사에서는 파이프 교체 순간의 직접 테스트 연결이 ENOENT였다. 제품 RPC의 재시도는 이미 구현되어 있으며, 테스트에도 제한된 ENOENT/EBUSY 재시도를 적용한 IPC3이 통과했다. 이 실패 로그도 보존한다.

최종 공동 검수: core6은 추가 확정 회귀 없음, remote5는 확정 차단 문제 없음, native4는 제품 가드 수용·테스트 호출 오류 지적(위와 같이 수정), native5는 두 테스트 수정에 추가 확정 결함 없음이다. 유효 검수10건·현재 입력 파일43개 해시 일치/미대조0. native5의 중복 helper 의견은 기존 Mutex 소스와 실제 두 프로세스 실행으로 추가 확인해 제품 결함으로 확정하지 않았다. 검수자의 비차단 메모(복구 이중 오류 시 원래 오류 원인 표시, 준비 단계 추가 fault coverage, 상태 재조회 문구 변화·리스너 시작 검사)는 최종 평가에 남긴다. 모든 상황의 오류 부재를 보증하지 않는다.

GitHub 파일 크기/고정 판본 계약은 [Contents 공식 문서](https://docs.github.com/en/rest/repos/contents)를 확인했다.
Android 브리지는 [WebViewCompat 공식 API](https://developer.android.com/reference/androidx/webkit/WebViewCompat)의 메시지 API를 따른다.
