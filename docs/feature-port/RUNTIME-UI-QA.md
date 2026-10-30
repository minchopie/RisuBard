# 독립 APK UI 검증 목록

작성·저장·가져오기 검사는 신규 debug 앱의 합성 자료에서 수행했다. 태블릿 키보드 검사는 사용자가 열어 둔 화면의 위치·크기만 측정했고 채팅은 변경하지 않았다. 기존 USB 앱의 사용자 채팅은 읽거나 변경하지 않는다. 2026-10-17 사용자 요청으로 추가 실기기 조작·설치는 보류하고 내부 검사를 진행한다.

| 주장 / 조작 | 검증 | 시각 확인 | 상태 |
|---|---|---|---|
| PC·Termux 없이 시작 | APK 프로세스가 자체 Node와 루프백 서버 실행 | 첫 화면에 서버 주소·암호 입력 없음 | 네이티브와 WebView 두 기기 통과 |
| 기존 앱 별도 보존 | 패키지 ID와 기존 version/설치 시각 대조 | 두 앱 별도 아이콘 | 설치 통과, 최종 재대조 대기 |
| 기존 쿠키/JWT 자동 연결 | native bootstrap 뒤 writer=free, WebView가 기존 흐름 사용 | 비밀번호 입력 모달 없음 | 두 기기 통과 |
| 캐릭터·채팅 저장 | 새 합성 캐릭터 작성, 메시지 저장, force-stop → 재실행 | 저장 전후 동일 표시 | 두 기기 표본 보존. 폰 첫 생성은 요청 본문·200·canonical flush 200·재시작 hydration 확인. 단순 업로드 200 직후 강제 종료는 지연 저장 손실 재현; Android 보완 후 재검증 대기 |
| 파일 선택 | 선택 취소 → 다시 열기 → 합성 카드 파일 가져오기 | 선택기/오류/성공 표시 | SM-S938N의 Android SAF → v2 JSON 카드 가져오기 통과 |
| 키보드·회전 | 입력 후 키보드 표시/숨기기, 방향 전환 | 입력창과 버튼이 키보드에 가려지지 않음 | APK UA의 focus 중 viewport 갱신 수정, 단위 검사 3개 통과. 폰 세로/가로 555/198px, 태블릿 가로/세로 405/885px에서 입력창이 viewport 안에 표시됨. 태블릿은 사용자가 화면 키보드를 연 뒤 측정 |
| 재시도 | 서버 시작/연결 실패 후 재시도, 빠른 중복 클릭 | 재시도 버튼 비활성화·복귀 | 중복 시작 억제 구현, UI 실패 주입 대기 |
| 백그라운드 전환 | Home → 앱 복귀, 데이터와 서버 상태 관찰 | 편집/메시지 유지 | 폰의 같은 PID·초안 보존 통과. WebView Home의 visibility 이벤트가 없어서 native onPause 저장 신호 추가, 새 빌드 검증 대기 |

프로토타입의 다운로드·전송 UI는 아직 이식 전이다. 기존 일반 화면의 전체 기능 검수와 이번 변경에 대한 검수는 구분한다. 4KiB 기기 성공은 16KiB 성공을 뜻하지 않는다.

2026-10-17 후속 내부 실행: APK13 x64 16KiB instrumentation은 통과했으나, 실제 WebView 화면을 유지한 UI 프로세스는112초 후 네이티브 SIGTRAP으로 종료됐다(MemoryInfra, WebView124 libmonochrome). 따라서 장시간 UI 안정성은 미통과이며 환경/앱 원인 분리 시험을 진행한다. 물리 기기 설치 보류는 유지한다.

2026-10-17 후속 분리 시험: API35/WebView124의 빈 WebView 대조 앱에서도 CDP memory dump 때 같은 MemoryInfra SIGTRAP/BuildId가 재현됐다. API36/16KiB/WebView133에서는 동일 대조 앱과 RisuBard APK14의 같은 진단이 성공했다. APK14 설치 해시 확인, 실제 첫 화면 렌더링, fetch 데이터 URL/console 경계, 인증·복구·앱 UID 서버/이미지/Lua/스트리밍 내부 검사가 통과했다. API35 문제를 제품 수정으로 숨기지 않았으며 장시간/물리 ARM64 검증은 별도다. 근거: tmp/webview35-blank-crash-stack.txt, tmp/webview36-blank-memorydump.json, tmp/webview36-apk14-memorydump.json, tmp/emulator36-apk14-instrumentation.log, tmp/apk14-webview-probe.json.

## API36 / APK14의 실제 시스템 선택기 검사 (2026-10-17 05:58)

물리 기기는 조작하지 않았다. emulator-5572에서 합성 카드 파일만 사용했다.

- Android DocumentsUI의 Downloads에서 internal-qa-card.json을 실제 선택하여 일반 v2 카드 가져오기 성공. 이름/한국어 첫 메시지 확인.
- 제어된 force-stop과 재시작 후 기본 홈 화면으로 시작하며, Character Vault에서 합성 카드와 첫 메시지가 보존됨을 확인했다. 현재 선택을 유지하는 동작과 자료 보존을 혼동하지 않는다.
- 세로 화면 키보드 표시: viewport840→528 CSSpx, 입력칸 bottom513.24, 화면 안이며 키보드 바로 위. 본문 왼쪽16px/오른쪽약15.81px(서브픽셀 반올림 차이).
- 가로 추가 시험은 Character Vault 모달/검색 키보드가 열린 상태여서 채팅 입력창 성공으로 기록하지 않았다. Back이 Activity를 정상 종료했고 이전 빈 WebView 대조 앱이 나타났다. 크래시로 해석하지 않는다. 에뮬레이터 방향 설정은 원래 user_rotation0/accelerometer_rotation1로 복원했다.
- APK14 PID8048이9분34초 유지된 뒤 시험자가 force-stop했다. 그 시점 종료 기록에 이 PID의 네이티브 크래시는 없었다. 짧은 제한 시간 관찰이며 장시간 안정성/다른 WebView 버전/ARM64 검증으로 일반화하지 않는다.
- 근거: tmp/emulator36-saf-qa.json 및 연결된 XML·JSON·스크린샷. 이 시험은 일반 카드 JSON 경로이며 아직 구현 중인 risuplay v2 수신 시험이 아니다.

## API36 / APK16 가로 입력과 도구 모음 후속 검사 (2026-10-17 06:11)

emulator-5572의 같은 합성 카드에서 실행했다. 기기 설치 보류를 유지했고 실제 제공자 요청은 하지 않았다.

- 좁은 세로 화면의 저장 도구 모음은 기존 `overflow-x: auto` 영역이다. Android의 실제 가로 스와이프 후 scrollLeft41.52px가 되었고 마지막 이동 버튼이 도구 모음 안에 완전히 표시되며 터치 대상도 그 버튼임을 확인했다. 단순히 최초 화면 밖에 있다는 이유로 UI를 변경하지 않았다. 근거: tmp/apk16-toolbar-scroll.json.
- 보관함과 사이드바를 닫은 실제 채팅에서 가로 회전 후 입력칸을 Android 터치로 눌렀다. 입력기는 `mInputShown=true`, 앱 viewport는864×360→864×122 CSSpx, 입력칸 bottom107.24px이며 포커스와 화면 내부 표시를 확인했다. 스크린샷에서도 입력칸·전송 버튼이 키보드 위에 있다. 근거: tmp/apk16-landscape-before-ime.json/png, tmp/apk16-landscape-ime.json/png.
- 검사 후 키보드를 닫고 방향 설정 user_rotation0/accelerometer_rotation1을 원래대로 복원했다. 앞선 APK14 가로 시도가 유효하지 않았다는 기록은 유지한다. 이번 결과도 에뮬레이터 표본이며 실기기 결과가 아니다.
- APK16에서 Android 입력으로 합성 초안을 입력한 뒤 Home → 앱 복귀를 실행했다. PID9570이 같고 초안·첫 메시지가 유지됐다. 시험용 초안만 제거했다. 강제 종료 후 초안 보존이나 onPause의 디스크 flush 성공까지 입증하는 검사는 아니다. 근거: tmp/apk16-background-before.json, tmp/apk16-background-after.json.
