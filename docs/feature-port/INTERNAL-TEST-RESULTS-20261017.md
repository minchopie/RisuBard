# RisuBard 내부 검사 중간 결과 — 2026-10-17

사용자 요청에 따라 **물리 태블릿·스마트폰 조작과 추가 설치는 보류**했다. 아래는 구현 중인 코드와 내부 APK의 검사 기록이다. 기능 통합 완료나 정식 릴리즈 승인 기록이 아니다.

## 검사한 코드와 파일

- 기준: RisuBard `64ebfb2397188ae30f88dd2e8b25747192ccbb4b`, 작업 브랜치 `codex/risubard-feature-port`.
- 내부 APK16: `android-app/app/build/outputs/apk/debug/app-debug.apk`.
- SHA-256: `b3ef9accbfd54de39316ba03a72047c1891c2cb74b86477d220bc5eabbda2d09`.
- 패키지: `app.risubard.personal.debug`, 내부 debug 서명. 정식 설치 파일이 아니다.
- 포함된 runtime ZIP SHA-256: `0c8df30e1464372b8885c5c9c7fe9ed1675cf57f8e9ad8031df3789c33f8d497`.
- APK ZIP/CRC·양 ABI ELF 16KiB 정렬·서명·zipalign 검사 통과. 소스/웹 빌드497파일이 내부 ZIP과 바이트 단위로 일치한다.
- 이 APK는 API36 x64 16KiB 에뮬레이터에만 설치했다. 기존 합성 카드와 UID·최초 설치 시각이 유지됐다. 최종 ARM64 실행은 보류 중이다.
- 검사한 두 APK는 `tmp/apk16-emulator/`에 별도로 보존했고 `mapping.json`에 원본·사본·해시를 기록했다.

## 자동 검사

| 검사 | 관찰 결과 | 로그 |
|---|---|---|
| 전체 클라이언트 | 4,713통과 / 6생략 | `tmp/client-suite-ports4.log` |
| 전체 서버 | 1,183통과 / 3생략 | `tmp/server-suite-runtime13.log` |
| 기존 호환성 | 94통과 / 5생략 | `tmp/compat-suite-internal12.log` |
| 타입 / 웹 빌드 | 오류0·기존 CSS경고8 / 통과 | `tmp/typecheck-ports4.log`, `tmp/web-build-ports4.log` |
| 공통 전송 | 116통과, 공통 구현5파일의 strict TypeScript 오류0 | `tmp/transfer8-boundary-fixed.log` |
| ZIP / 기억 자료 | 최종 URI 수정 이후26통과(8+18) | `tmp/transfer8-bound-memory-final.log` |
| 저장 실패·재시작 집중 검사 | 39통과 | `tmp/runtime11-fixed.log` |

각 검사는 중복되는 영역이 있어 합산하지 않는다. 먼저 실패한 재현 로그와 Windows 환경의 일시 오류 기록도 유지했다. 통과 결과는 실제 Google/Gemini/NAS 요청이나 아직 연결하지 않은 전송 UI의 성공을 뜻하지 않는다.

## 에뮬레이터 실행과 화면

- APK16에서 루프백 서버·기존 쿠키/JWT 연결·설치 자격정보 복구·실패 후 재시도·이미지·Lua·모의 응답 스트리밍·Wiki·저장·기본 백업 파일 쓰기 검사 통과. 복구 파일 원본 보존과 ContentResolver 복사, 구 백업 보존도 확인했다.
- 실제 Android 파일 선택창으로 합성 카드 JSON을 가져오고, 제어된 강제 종료·재시작 뒤 카드와 첫 메시지가 유지됨을 APK14에서 확인했다. APK16 업데이트 뒤에도 같은 카드가 남았다.
- 세로 입력창은 키보드 위에 표시됐다(APK14: viewport528px, 입력칸 bottom513.24px). APK16 가로 입력은 실제 Android 터치로 키보드를 열었으며 viewport122px, 입력칸 bottom107.24px로 화면 안이었다. 본문 좌우 여백은16px/약15.81px로 반올림 범위에서 같다.
- 좁은 화면의 저장 도구 모음은 기존 가로 스크롤 구조였다. 실제 스와이프 후 마지막 이동 버튼이 완전히 표시되고 터치 가능했다. 관련 UI를 임의 변경하지 않았다.
- APK16에서 합성 초안 입력 → Android Home → 복귀 시 같은 PID와 초안·첫 메시지가 유지됐다. 시험용 초안은 이후 제거했다. 강제 종료 후 초안 보존이나 디스크 flush 검증으로 확대 해석하지 않는다.
- API35/WebView124의 MemoryInfra 종료는 RisuBard/Node가 없는 빈 WebView에서도 같은 스택으로 재현됐다. 별도 API36/WebView133에서 동일 진단은 대조 앱과 RisuBard 모두 통과했다. 모든 Android 버전의 장시간 안정성을 입증한 것은 아니다.

근거: `RUNTIME-UI-QA.md`, `tmp/emulator36-apk16-instrumentation.log`, `tmp/apk16-webview-probe.json`, `tmp/emulator36-saf-qa.json`, `tmp/apk16-landscape-ime.json/png`, `tmp/apk16-toolbar-scroll.json`. 데이터 URL fetch 검사는 현재 TypeScript를 WebView에 주입한 검사이며 배포 번들의 실제 번역 요청 검사와 구분한다.

## 자체 검수와 실제 Fable 공동 검수

모델 식별 `claude-fable-5-1`, 요청 추론 강도 xhigh. 코드·차이·실패/수정 로그를 전달했고 물리 기기나 사용자 DB·인증정보는 전달하지 않았다.

- 전송9차: URI 경계 수정에 대한 차단 결함 없음. `fable-transfer-review-9.md`.
- 호환4차: native fetch 수신 객체와 console의 logcat 노출 수정 수용. `fable-ports-review-4.md`.
- 실행 기반12차: 11차의 두 저장 문제 수정, 기존 실패 전파·동시 요청 보호·외부 편집 원본 보존을 확인했다. 이번 차이에서 새로운 데이터 손실 경로나 회귀를 찾지 않았다. `fable-runtime-review-12.md`.

세 검수 묶음의 제출 파일을 현재 파일과 다시 대조해 모두 일치했다(`tmp/final-internal-review-input-checks.json`). 위 판정은 각각 제출 범위의 코드 읽기와 제시한 시험 기록에 대한 검수이며 전체 제품 승인이나 Fable의 실기기 실행 결과가 아니다.

12차에서 남긴 항목도 보존한다. 읽기 fallback의 넓은 catch와 경로 진단 부족, 실행 중 저장소를 다시 여는 시험 하니스, blob이 없는 저장소/임시 I/O 오류/대기 중 외부 편집에서의 추가 가설은 차단 결함으로 확정하지 않았다. 준비된 저널을 시작 때 복구한 뒤 앱 자체 변경이 외부 편집으로 분류되어409가 되는 경로는 현재 동작을 검증한 것이며, 자동 복구 UX가 완성됐다는 뜻이 아니다. 자세한 조건과 근거는 실제 검수 원문에 남겼다.

## 다음 구현 및 설치 전 남은 조건

- `.risuplay v2`의 새 캐릭터·채팅·슬롯 ID 및 Wiki 근거/해시 연결, 영속 수신 작업 기록, 클라이언트 저장 확인과 시작 시 복구. 현재 v2 가져오기는 불완전 적용을 막기 위해 명시적으로 거부한다.
- 실제 앱의 일관된 내보내기, 수신 시 로컬 모델 연결 유지, 통합 전송 UI와 NAS/GitHub/Wi-Fi/USB/시스템 공유·Windows 전송기 연결.
- 새 ARM64 바이너리와 최종 앱의 실기기 실행·기기간 양방향 전송·BardWiki 조회·저장 슬롯 실제 불러오기. 사용자 다음 설치 요청 전까지 기기를 사용하지 않는다.
- 전체 구현에 대한 최종 공동 검수, 정식 서명·버전·배포 파일·업데이트 경로 검사.

이 단계에서 커밋·푸시·릴리즈하지 않았다. 후속 구현 현황은 `STATUS.md`와 `FEATURE-MAP.md`에 이어 기록한다.

## 2026-10-17 전송 통합 내부 검사 후속

공통 v2를 앱 UI·Node 저장·BardWiki·슬롯·NAS/GitHub·Android/Windows 네이티브 전송에 연결했다. 최신 검증과 한계는 TRANSFER-INTEGRATION-20261017.md, 사용 흐름은 TRANSFER-USER-GUIDE.md를 따른다. 클라이언트4,730/6생략, 서버1,214/4생략, 공통116, 실제Windows IPC/HTTP 재시작·충돌·회복·65MiB Java/C# 상호운용 통과. APK29 일반/Offline와 Windows 내부 패키지 준비, API36 x64 에뮬레이터 및 실제 Chromium UI 확인. Fable 최종 읽기 전용 검수 진행 중. 물리 기기 설치/실계정/정식 게시 보류, 미완료 범위를 숨기지 않는다.

공통 v2를 앱 UI·Node 저장·BardWiki·슬롯·NAS/GitHub·Android/Windows 네이티브 전송에 연결했다. 최신 검증과 한계는 TRANSFER-INTEGRATION-20261017.md, 사용 흐름은 TRANSFER-USER-GUIDE.md를 따른다. 클라이언트4,730/6생략, 서버1,214/4생략, 공통116, 실제Windows IPC/HTTP 재시작·충돌·회복·65MiB Java/C# 상호운용 통과. APK29 일반/Offline와 Windows 내부 패키지 준비, API36 x64 에뮬레이터 및 실제 Chromium UI 확인. Fable 최종 읽기 전용 검수 진행 중. 물리 기기 설치/실계정/정식 게시 보류, 미완료 범위를 숨기지 않는다.

## 2026-10-17 전송 이식 내부 검수 완료 — 후보31

공통 .risuplay v2, BardWiki/저장 슬롯/참조 자료, 기존 캐릭터에 채팅만 추가, 파일/NAS/GitHub/Android·Windows Wi-Fi·USB·공유 연결, 영속 대기열·중단 복구를 이식했다. 요청 로그·백업·페르소나는 기존 흐름을 재사용하고 실제 UI로 검사했다. 기존 카드/대화/API/현재 화면은 보존한다.

자체 검사 후 실제 Fable5.1·xhigh 읽기 전용 검수10건에서 확인된 문제를 수정·재검사했다. 최종 core6/remote5/native5는 각 범위의 추가 확정 회귀·차단 문제를 발견하지 않았고, 검토한 현재43개 파일은 입력 해시가 일치한다. 비차단 의견의 판단과 근거는 FABLE-TRANSFER-FINAL-ASSESSMENT.md에 남겼다. 앞선 이 문서의 미완료/대기 표시는 해당 시점의 이력이다.

서버1220/4skip·클라이언트4733/6skip(마지막 전달 상태 수정2개 별도 재검사)·공통116 통과, 타입0오류/기존8경고. 일반/Offline APK31와 Windows 포터블 ZIP·전송기, 사용 안내·검수 기록·SHA-256 준비. 각APK580개 소스 대조/CRC/allELF16KiB/sign/align, Windows33755개파일해시/CRC·실제IPC·중복프로세스차단·독립시작, API36 x64 내부 실행/공유URI재생성/Offline 통신OFF 실제생성 통과.

최신 기준: TRANSFER-INTEGRATION-20261017.md, FABLE-TRANSFER-FINAL-ASSESSMENT.md, TRANSFER-USER-GUIDE.md. 산출물 tmp/transfer-build31/README.md와 SHA256SUMS.txt. 물리 TB710FU/SM-S938N 설치/최종ARM64·실Wi-Fi/USB/QuickShare·실NAS/GitHub·긴MGE품질은 보류/미검증. 커밋·푸시·정식게시 없음. 사용자기기/개인대화/계정은 변경하지 않았다.
