# Android 기기 내 AI — 내부 구현·검증

**최신 사용자 결정(2026-10-17): 로컬 AI 모델 작업 종료.** 아래는 과거 구현·검증 기록이다. GGUF/llama.cpp 추가 개발·모델 선택·속도/발열 시험은 계속하지 않고 일반판과 온라인 API 경로에 집중한다. 설치된 Offline 앱·모델·사용자 자료는 삭제하지 않는다. 앱 구동용 Node 서버와 오프라인 열람 기능은 이 결정의 제거 대상이 아니다. [구조·호환성 검토](LORE-COMPATIBILITY-20261017.md).

사용자 확정: 오프라인판은 태블릿·스마트폰에서 실행한다. PC·Termux·같은 Wi-Fi 서버에 의존하지 않는다. 물리 기기 설치 보류는 유지한다.

- GOAL: Android 앱 안의 로컬 모델로 기존 채팅 흐름을 실행한다.
- MUST: 별도 Offline APK, 모델 사전 준비 후 인터넷 없이 생성, 실제 Fable 5.1·xhigh 코드 공동 검수.
- KEEP: 기존 일반판·사용자 자료·온라인 모델/키 설정·카드/슬롯 흐름. 온라인 모델로 자동 대체하지 않는다.
- VERIFY: 모델 파일 가져오기·실제 생성·취소·재시작·저장 슬롯, 실패 시 이전 모델 보존, APK/ABI/16KiB/서명과 물리 검증의 구분.

## 최종 내부판 결과

최신은 APK28이다. 실제 Fable 5.1·xhigh 총7차 검수에서 재현된 지적을 수정했고 마지막 제출 범위의 차단 수준 결함·직접 회귀는 발견되지 않았다. 경고 문구/우선순위와 미검증 범위는 [최종 평가](FABLE-OFFLINE-DEVICE-FINAL-ASSESSMENT.md)에 분리했다. 전체 앱 완성·실기기·정식 배포 승인이 아니다.

서버12·클라이언트139·실제 Linux 저장 내구성3개 통과, 타입 오류0/기존 CSS 경고8, 웹·Offline/일반판 APK 빌드 통과. 최신 APK28에서 상태 GET 무응답 후 기존 채팅 접근, 복원 후 모델 표시, 통신OFF 상태의 실제 한국어 TURN14 생성을 확인했다. 설치 APK 해시·UID·최초 설치 시각·모델 설정 보존을 확인했고 시험 환경 복원도 완료했다. 아래 이전 후보 기록은 각 당시 검증이며 최신 전체 재시험으로 합산하지 않는다.

## 구현

`gradle -Poffline=true assembleDebug`는 **RisuBard Offline**, `app.risubard.personal.offline.debug`를 만든다. 일반판은 기존 ID와 이름을 유지하고 llama 엔진을 포함하지 않는다. 현재 둘 다 내부 debug 빌드이며 정식 버전·서명·릴리즈가 아니다.

AI 설정의 `GGUF 모델 파일 선택`에서 사용자가 준비한 단일 GGUF 텍스트 모델을 가져온다. Android 시스템 파일 선택기를 사용하고 파일을 버퍼 전체로 읽지 않고 앱 전용 저장소로 복사한다. 크기·여유 공간·GGUF 헤더·SHA-256·실제 엔진 시작을 확인한 뒤 선택 모델을 바꾼다. 검증 실패·취소·설정 rename 이전 실패 시 기존 모델 파일/설정을 보존한다. 설정 rename 이후 디렉터리 sync만 실패하면 새 설정을 반영한 상태로 이전/새 모델 파일을 함께 보존하고 경고한다. 설정 화면을 닫으면 가져오기를 취소한다고 화면에 명시한다. 모델 가중치는 APK에 포함하지 않는다.

모델 파일과 설정 파일의 fsync·rename·POSIX 디렉터리 fsync를 마친 뒤 이전 선택 모델을 즉시 정리한다. 설정 rename 뒤 동기화 실패가 나면 이전/새 모델을 모두 보존하고 경고한다. 설정 파일이 손상돼도 사용자가 직접 모드/길이를 바꿀 수 있으며, 내부 보존 표식으로 기존 GGUF가 다음 실행에서 삭제되지 않게 한다. 유효한 모드/한도와 손상된 모델 레코드는 구분한다. 실제 전원 차단 시험은 별도다.

llama.cpp 고정 커밋 `ea0c4c2c85fb183ec0fbd30a1af4e4275a18a064`를 NDK r29로 ARM64/x86_64 빌드했다. 자체 소스 추출·빌드 스크립트, 해시, 라이선스 고지를 포함한다. Android의 비공개 앱 디렉터리 안 Unix 소켓을 통해 Node 서버가 엔진과 통신한다. 공유 루프백 포트 선점 경로를 제거했고, 임의 키 인증도 유지한다. Node가 비정상 종료되면 자식 엔진이 종료되도록 `PR_SET_PDEATHSIG`와 부모 PID 확인을 적용했다.

기존 OpenAI 호환 어댑터·스트리밍·로그·채팅 저장 경로를 재사용한다. Offline 모드에서는 메인/보조/모듈 모델 바인딩과 토큰 계산을 기기 내 모델로 돌린다. DB에 저장된 온라인 설정은 수정하지 않는다. 입력창 위에 실제 로컬 모델 이름을 표시하며 해당 버튼으로 AI 설정을 연다. 모델이 없거나 준비에 실패하면 안내 오류를 표시하고 온라인 LLM으로 자동 전환하지 않는다. 상태 조회 실패도 저장된 채팅을 여는 부팅 과정을 중단하지 않는다.

문맥 기본4096/최대32768, 최대 응답 기본512로 별도 설정한다. 서버에서도 양의 응답 길이 제한을 강제한다. 실제 모델의 채팅 템플릿 전체를 토큰화해 남은 문맥 범위 안에서만 생성한다. 입력이 이미 문맥을 넘으면 안내하고, 사용자 텍스트를 임의로 잘라서 보내지 않는다. 120초 유휴 시 엔진이 모델을 내려놓고 다음 요청 때 다시 준비한다.

## 다음 설치 때의 사용 흐름

1. 별도 RisuBard Offline을 열고 AI 설정의 `GGUF 모델 파일 선택`에서 준비한 텍스트 모델을 고른다. 모델 파일을 앱 안으로 복사하므로 원본과 앱 사본을 위한 저장 공간이 필요하다.
2. `모델 준비 완료`를 확인한다. 기기 메모리에 맞는 모델/문맥을 써야 하며 준비 실패 시 원래 모델이 유지된다.
3. 기존 카드/채팅 가져오기 기능을 사용하고 평소 입력창에서 전송한다. 로컬 모델 이름은 입력창 위에 표시된다. 인터넷 없이도 모델 생성·로컬 저장을 사용할 수 있다.
4. 필요하면 같은 패널에서 `온라인 설정으로 전환`한다. 다시 `기기 내 AI 사용`을 누르면 저장된 로컬 모델을 사용한다. 모델은 채팅 백업이나 기기간 전송에 자동 포함하지 않는다.

현재 물리 기기 설치는 보류 중이다. 이 안내가 기기에 이미 설치됐다는 뜻은 아니다.

## 실제 확인

대상은 **API36 x86_64, PAGE_SIZE=16384 내부 에뮬레이터**다. 물리 TB710FU·SM-S938N에는 설치하거나 조작하지 않았다. 합성 카드 `Internal QA file picker`만 사용했다.

시험 모델은 공식 Qwen3-0.6B-Q8_0 GGUF(639,446,688바이트)이며 해시 `9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031`이다. 작은 실행 표본이며 권장 게임용 모델이나 품질 검증을 뜻하지 않는다. 모델은 배포 APK에 없다.

APK22에서 비행기 모드 ON, Wi-Fi/모바일 통신 OFF, WebView `navigator.onLine=false` 상태로 다음을 직접 확인했다.

1. 시스템 파일 선택기로 GGUF 모델을 가져오고 실제 네이티브 실행을 확인했다.
2. 기존 카드 가져오기·채팅 입력 UI로 영어/한국어 답변을 생성했다. 관찰한 요청은 로컬 토큰화/생성 경로였다.
3. Node 프로세스를 SIGKILL로 종료했을 때 llama 자식도 종료됐다. 앱 재시작 후 모델 선택·저장 채팅이 유지됐다.
4. 생성 취소 후 다시 전송해 답변을 받았다.
5. 기존 Quick Save 후 대화를 더 진행하고 Quick Load 확인창으로 저장한 TURN 1을 실제 복원했다.
6. 2분 이상 유휴 후 엔진 RSS가 약78MiB인 상태에서 다시 요청해 생성에 성공했다. 정확한 성능·메모리 벤치마크는 아니다.

APK22 해시: `946f1d4b49d03cb4aebc27241837b53762aa92a8bc3a677624b7274f407095cf`. 이 APK의 연결은 수정 전 루프백 방식이다. 이후 비공개 소켓·최종 문맥 검사·오류 복구·모델 표시를 추가한 **APK23**을 따로 검증한다. 두 결과를 혼동하지 않는다.

APK23 해시: `3ce5ee5a4f11338c6cf9be5183b7e922f043c55dbf7b624c0d58fd0d92fe81ed`. `tmp/offline-native/apk23/app-debug.apk`에 원본과 매핑을 보존한다. 소스/빌드568파일, APK·내부ZIP 전수 CRC/해시, 양 ABI의 Node·llama 4개 ELF16KiB, APK 서명·zipalign 통과. 에뮬레이터에만 `install --user 0 -r` 적용했다. 설치본 해시도 일치하며 UID u0_a216·최초 설치 시각·이전 모델·TURN 2 대화를 보존했다. 비공개 소켓을 쓰는 실제 프로세스 명령과 private 디렉터리0700 권한, 로컬 모델 표시를 확인했고 네트워크 없이 TURN 3 한국어 생성에 성공했다.

상태 API GET에 합성503을 주입한 뒤 실제 앱을 새로고침해, 모델 조회가 실패해도 기존 TURN 3 대화에 접근할 수 있음을 확인했다. 오류 주입을 제거하고 재시작하면 선택 모델 표시가 복원됐다. UI로 온라인→기기 내 모드를 왕복 전환해 원래 선택 모델과 문맥4096/시험용 응답96을 유지했다. 외부 온라인 API는 호출하지 않았다. 근거: `apk23-private-socket-chat.json`, `apk23-status-failure.json`, `apk23-toggle-online.json`, `apk23-installed-proof.json`.

일반판 회귀 빌드 해시: `4f484eeea6228d63486837017ef995a68d8695ac5873165c16a300602df238b0`. 매니페스트의 `app.risubard.personal.debug`/RisuBard와 엔진 미포함을 확인했다. `tmp/offline-native/online-regression/`에 보존하며 설치하지 않았다.

## APK24 후속 후보

2차 지적 D1/D2를 재현·수정한 내부 APK24는 `tmp/offline-native/apk24/app-debug.apk`에 보존했다. SHA-256은 `e3f908ad405bf7fd5eb2e5954b1eee2da7f5b0404d404eda35dbab7e3d2a1b8d`이다. 소스/빌드568파일·ZIP·4개 네이티브 ELF16KiB·APK 서명/정렬을 재검사했다. APK23과 DEX·네이티브·리소스는 바이트 동일하고 런타임 ZIP/해시만 바뀌었다. 일반판 회귀 APK는 앞서 만든 APK23 공통 런타임 기준이며 이후 일반판을 재빌드했다고 주장하지 않는다.

APK24도 에뮬레이터에만 업데이트했고, 모델·TURN 5 채팅이 보존됐으며 비행기 모드에서 TURN 6 `안녕` 답변 생성에 성공했다. 그 전에 첫 WebView 렌더러가 실행43초 후 `Metrics Background` 스레드에서 SIGSEGV로 종료됐다. 당시 llama 자식은 없었고 앱/Node는 유지됐으며 기존 onRenderProcessGone으로 화면이 다시 열렸다. 이후 재시작·TURN 6 보존·TURN 7 생성과 유휴 후 같은 엔진 PID의 TURN 8 `반가워요` 생성을 확인했다. 모델 RSS는1,124,320KB에서38,704KB로 내려간 뒤 다시 생성했다. 장시간 안정성/성능 벤치마크로 일반화하지 않는다.

종료 분리 시험에서 RisuBard/Node/llama가 없는 빈 WebView도 동일한14개 스택 프레임으로 종료했다. Android의 표본 통계 경로를 활성화해 재현했고 진단 설정/권한은 원래대로 복원했다. 해당 시험 환경의 Android·WebView 호환 문제로 분리했으며 제품에서 통계를 끄는 우회는 추가하지 않았다. 세부 증거와 한계는 [대조군 기록](WEBVIEW-METRICS-CONTROL-20261017.md)을 따른다.

## APK25 이전 내부 후보

3차 지적을 반영한 `tmp/offline-native/apk25/app-debug.apk`의 SHA-256은 `e23e32d311cedd9925ba4c73596bb1259688bbbe4c627f964336f67bee9d2339`이다. runtime ZIP `ea562f875db62c35bd2756cb7d77f8972a509783a0a453c731cfa7bf4ea4c509`. 소스/웹빌드568파일·전체ZIP CRC·양 ABI 4개 ELF16KiB·서명v2·zipalign 통과. 실제 설치본 해시가 일치하고 appId10216·최초 설치 시각을 보존했다.

Android 파일 선택기로639MB GGUF를 다시 가져와 POSIX 디렉터리 동기화와 실제 모델 시작에 성공했다. 교체 직후 이전/새 GGUF2개가 유지됐고, 앱을 종료·재시작한 뒤 선택한 새 모델만 남았으며 문맥4096/응답96을 보존했다. 모드 전환 때 입력란의 미적용2048/64가 저장값을 덮지 않음도 실제 settings.json으로 확인했다. 이는 합성 시험 앱에서의 검증이며 물리 기기 업데이트가 아니다.

마지막 APK25에서 HTTP200의 합성 SSE 오류를 주입하자 기존 오류창에 원인이 표시됐고 빈 성공으로 숨기지 않았다. 주입을 제거한 뒤 실제 로컬 모델로 TURN 10 `오프라인 성공` 답변을 받았다(`navigator.onLine=false`). 이는 시스템 파일 선택·실제 모델 준비 외에는 DevTools로 DOM 입력/버튼을 실행한 내부 기능 시험이며, 모든 버튼의 손가락 조작/키보드 시험을 대체하지 않는다. `apk25-sse-error-ui.json`, `apk25-final-chat.json`, `apk25-import-progress.json`, `apk25-restart-gc.json`, `apk25-toggle-stored.json` 및 `output/playwright/offline-ai-final25-chat.png`에 기록했다.

시험 종료 후 Offline/대조 앱을 종료하고 자체 ADB 포워딩만 제거했다. 원래 비행기 모드0·Wi-Fi1·모바일 데이터1, 통계 표본2와 빈 진단 속성, ADB UID2000을 복원했다. 앱/모델/합성 데이터와 이전 APK는 보존했다. 근거 `final-emulator-cleanup.json`.

## 자동 검사·공동 검수

- APK25 당시 서버 집중10개 통과: 실제 자식 프로세스/소켓/HTTP, 인증/활성 세션, 스트리밍 취소, 모델 크기/손상/저장 공간/커밋 실패, 초기화 오류, 고아 파일 정리, 문맥·응답 길이 경계, 중간 업로드 취소·손상 설정 이후 PUT 보존, 엔진 종료/상류 준비 오류, 실제 소켓 종료 후 재시도, 이전 설정 판본 복원 시 모델 보존.
- APK25 당시 클라이언트101개 통과: OpenAI 어댑터·오류/스트림·journal 재생·로컬 바인딩·설정 UI. SSE 오류가 빈 성공으로 끝나는 수정 전 실패2건을 재현한 뒤 공통 파서에서 오류로 전달했다. 타입 오류0·기존 BardPainterTools CSS 경고8, 웹/Offline APK25 빌드 통과.
- 전체 서버1,189개 통과·기존3개 생략, 전체 클라이언트4,715개 통과·기존6개 생략은 앞선 판본의 결과다. 이후 리뷰2/3 제품 변경과 회귀 추가는 위 집중10/101·타입·빌드로 검증했으며 전체 검사를 다시 실행했다고 표시하지 않는다.
- 기존 런타임 산출물5개 및 새 엔진 산출물1개 검사 통과. 공개 경계 검사와 `git diff --check` 통과.
- 실제 Fable 5.1·xhigh 1차 결과를 [원문](fable-offline-device-review-1.md)에 보존했다. 부팅 실패·서버 길이 제한·초기화 예외·모델 고아 파일·포트 선점 등 해당 지적을 수정했다. 모델이 없을 때 온라인으로 전환하라는 제안은 자동 온라인 전환 금지와 충돌하므로 채택하지 않았다. 모델 문맥 상한 확인은 실제 고정 소스의 `n_ctx_slot()`을 대조했다.
- [실제 2차 검수](fable-offline-device-review-2.md)의 D1/D2를 재현·수정했고 [실제 3차](fable-offline-device-review-3.md)가 수용했다. 3차의 모드 전환·손상 설정·모델 보존·SSE 오류 확인은 [3차 대응](FABLE-OFFLINE-DEVICE-R3-RESPONSE.md)에 기록했다. [실제4차](fable-offline-device-review-4.md)가 앞선 수정4개를 수용했고 모델 사본 누적과 손상 설정의 모드 전환 잠김을 추가 지적했다. [4차 대응](FABLE-OFFLINE-DEVICE-R4-RESPONSE.md)대로 수정했고 실제5차 결과와 이후 대응을 아래 APK26~28 기록에 남겼다.

상세 로그·실제 원문·입력 파일 해시·시험 JSON은 `tmp/offline-native/`, 캡처는 `output/playwright/offline-ai-*`에 있다. 이전 시험 파일은 덮어쓰지 않는다.

## APK26 이전 내부 후보

SHA-256: `3e5aaa0374b143c99d81c2798cf10b4100f9c2a14f8fb0ffd5d61691994d61fe`. 파일은 `tmp/offline-native/apk26/app-debug.apk`에 이전 APK와 분리해 보존했다. runtime ZIP `52a963c8d887e4db077d0fcf547e9afb6bbd00fb8a72cf43ddbb4e0bddc26ba8`, 161,403,731바이트. 소스/웹빌드568파일 일치, 내부/외부 ZIP CRC, ARM64/x64 Node·llama4개 ELF16KiB, 서명v2와zipalign 통과. 실제 에뮬레이터 설치본도 같은 해시다.

4차 수정 후 서버10, 클라이언트136, Linux POSIX 저장 내구성2, 산출물6검사 통과. 타입0오류/기존8경고, 웹·런타임·Offline/일반판 빌드 통과. POSIX 검사는 실제 Linux에서 실행됐으며 Windows 생략을 통과로 세지 않았다. 디렉터리 sync 실패 주입 후 이전/현재 설정이 남는 두 경우를 각각 확인했고 실제 Android 전원 차단 시험과 구분한다.

모델 파일을 Android 선택기로 다시 가져와 재시작 없이 이전 모델이 정리되고 새639MB GGUF만 남는 것을 확인했다. 모델 해시와 문맥4096/응답96은 보존됐다. 합성 시험 앱의 설정을 백업 후 손상시켜 앱이 열리고 사용자 모드 전환이 성공함을 확인했다. 다시 실행해 온라인 선택과 모델 파일 보존 표식이 유지됐으며, 시험 후 원래 설정을 바이트 동일하게 복원했다. 개인 앱/실제 채팅에는 접근하지 않았다. 근거 `apk26-immediate-model-reclaim.json`, `apk26-corrupt-settings-recovery.json`.

일반판도 같은 최종 런타임으로 재빌드했다. 해시 `942e2a8e2c9584313df703e1c1affc1c1bbd0d72098cbd8cbd9c7020616f7abd`, `tmp/offline-native/online-regression26/app-debug.apk`. 일반판ID/이름과 엔진 미포함,568파일/ZIP/Node16KiB를 검사했으며 일반판은 설치하지 않았다.


최종 APK26에서 부분 응답 `QA PARTIAL TEXT 26` 뒤 합성 SSE500을 주입하자 기존 부분 응답을 보존하면서 오류창을 표시했다. 주입을 해제한 뒤 실제 모델로 TURN12 `준비 완료`를 생성했다. Wi-Fi/모바일 통신 OFF 및 navigator.onLine=false였다. 근거 `apk26-partial-stream-error-ui.json`, `apk26-final-chat.json`, `output/playwright/offline-ai-final26-chat-settled.png`. 시험 후 원래 네트워크 설정/UID/진단 설정을 확인하고 자체 포워딩만 정리했다(`apk26-cleanup.json`).

## APK27 이전 내부 후보

5차의 시작 정리 실패를 수정 전 코드에서 실제 재현한 뒤 수정했다. 삭제 불가 항목은 경고로 남기며 정상 모델/설정을 막지 않는다. 시작 GC 전에 디렉터리 sync하고 실패하면 모델 정리를 보류한다. 초기화 자체 실패 시에도 사용자가 명시적으로 온라인을 선택하면 해당 실행에만 적용하고 미저장을 안내한다. 자동 온라인 전환은 없다. 코드/단계별 설명은 [5차 대응](FABLE-OFFLINE-DEVICE-R5-RESPONSE.md), 검수 원문은 [5차](fable-offline-device-review-5.md). 실제6차 완료 후 추가 수정과7차 결과는 아래 APK28 기록을 따른다.

최종 서버11개, Linux POSIX3개(skip0) 통과. 클라이언트는 APK26과 동일하여 이전136개/타입0오류·기존8경고/웹 빌드 결과를 재사용한다. 산출물6개 검사는 게이트 변경 전후 동일하다. Offline/일반판을 새 서버로 다시 빌드했다.

- Offline APK: `tmp/offline-native/apk27/app-debug.apk`, SHA-256 `f90608675db3abc82f021afb91113a3dab6da0c19d33dcde514ebd9ae738e1a6`, 161403963바이트.
- runtime ZIP: `acd627c5639a0fe7f84bfac2e663c5d7a5d10bbd357470dce33e808db769d979`.
- 일반판: `tmp/offline-native/online-regression27/app-debug.apk`, SHA-256 `8ab663654687ba48600e2f6af23ca47e09f679dc0b125cf3352e0618844a3c46`. 일반판은 설치하지 않았다.
- 양쪽568파일 소스/웹빌드 일치와 ZIP CRC, 네이티브16KiB 통과. Offline 서명v2·zipalign 및 에뮬레이터 설치본 해시 일치. UID/최초 설치 시각도 보존했다.

내부 Android에서 UUID.part를 빈 디렉터리로 만들어 정리 실패를 유도했다. 모델 표시/설정/채팅 접근이 유지되고 정리 경고만 표시됐다. 시험 디렉터리는 빈 디렉터리 제거로 정리했다. 이어 local-ai 디렉터리 권한을 백업 기록700→000으로 바꿔 초기화 EACCES를 유도했다. UI의 명시적 온라인 전환과 '이번 실행에서만/저장하지 못함' 안내를 확인했다. 이후700으로 복원하고 원래 설정 파일이 바이트 동일함을 검사했다. 재시작 후 로컬 모델/이전TURN12가 복구됐다. 근거 `apk27-startup-gc-warning.json`, `apk27-manual-online-recovery.json`, `apk27-installed-proof.json`.

최종 APK27에서 복구 후 TURN13 `확인 완료`를 실제 네이티브 모델로 생성했다(통신OFF/navigator.onLine=false). `apk27-final-chat.json`과 `output/playwright/offline-ai-final27-chat.png`에 기록했다. APK26→27의 실제 ZIP 대조에서 내부 변경은 `server/node/local-ai.cjs` 하나이고 DEX/리소스/네이티브/웹 번들은 동일하다(`apk26-to27-diff.json`). 시험 뒤 디렉터리700·모델설정·비행기모드0/Wi-Fi1/데이터1·UID2000·진단설정을 원복했고 자체 포워딩만 제거했다(`apk27-cleanup.json`).

### 확인된 제한

BardWiki 의미 분석은 시험 문맥4096에서 프롬프트 예상4785토큰으로 초과해422가 발생했다. 메인 채팅 생성 성공과 별개이며, 기억 분석 성공으로 세지 않는다. 큰 문맥을 감당하는 기기/모델이 필요하고 필수 프롬프트를 임의 삭제하지 않는다. 작은 시험 모델로 장문 MGE·BardWiki 품질까지 보장하지 않는다.

로컬 생성에는 원격 model-job journal이 없어 렌더러/앱 종료 시 진행 중 응답을 잃을 수 있다. 저장 완료된 대화와 모델 보존 시험은 통과했지만 진행 중 생성 복구를 보장하지 않는다. 취소/내용 전 오류 후 빈 assistant 자리표시는 기존 동작을 유지했다. 설정 손상으로 연결을 잃은 모델은 새 모델 가져오기가 성공하기 전까지 보존하고, 드문 sync 실패의 잔여 파일은 재적용·재시작에서 정리한다.

## APK28 최신 내부 후보

6차의 경미한 두 지적을 수정 전 재현 후 교정했다. 정리 경고가 손상 설정/저장 경고를 덮지 않으며, 실행 파일 검사 전에 저장 설정을 읽어 이전 명시적 온라인 모드와 한도를 유지한다. 비필수 상태 GET에5초 AbortSignal을 추가했고 Offline 앱에서 엔진 unavailable 응답이 와도 기존 모드를 유지한다. 전체 스토리지 인증/부팅의5초 제한은 아니며 모델 가져오기/응답 생성의 제한도 아니다. 실제7차 검수 완료: 차단 수준 결함·직접 회귀 없음. [7차 원문](fable-offline-device-review-7.md)과 [최종 평가](FABLE-OFFLINE-DEVICE-FINAL-ASSESSMENT.md)를 따른다. [6차 원문](fable-offline-device-review-6.md), [6차 대응](FABLE-OFFLINE-DEVICE-R6-RESPONSE.md).

- Offline: `tmp/offline-native/apk28/app-debug.apk`, SHA-256 `a7efb18c6f404bab0b99ee8ec3c3ec3de285f6d2031fad2b0343840f3b9425bb`, 161403919바이트.
- runtime ZIP: `367dba77fa5444038c8f176f2bcb5b38485d248a2aa17daae3092ba1ded22d84`.
- 일반판 회귀: `tmp/offline-native/online-regression28/app-debug.apk`, SHA-256 `d29ba8267c52437e4206689526ddba8f0bdd737306ff1ad9cbbda239d398d004`. 설치하지 않았다.
- 서버12, 실제 Linux POSIX3(skip0), 클라이언트139 통과. 타입0오류/기존8경고, 웹·런타임·양판 APK 빌드 통과. 산출물 검사6개와 공개 경계/변경 형식 검사도 통과했다.
- 양판568소스/빌드파일·ZIP CRC·네이티브16KiB 확인, Offline 서명v2/zipalign 통과.

실제 내부 Android에서 상태 GET 응답을 멈추고 새로고침했다. 조회를 취소한 뒤 홈과 기존TURN13 채팅을 열 수 있었고 기기 내 모드 표시가 유지됐다. 오류 주입 제거 후 새로고침하자 기존 모델 이름이 복원됐다. `apk28-status-timeout.json`/`apk28-status-restored.json`. 전체 부팅시간5초를 실측했다고 주장하지 않는다.


최신 APK28 실제 네이티브 모델이 TURN14 `완료`를 생성했다(navigator.onLine=false). `apk28-final-chat.json`, `output/playwright/offline-ai-final28-chat.png`. 설치본 SHA-256이 배포 후보와 일치하고 appId10216·최초 설치 시각·settings.json이 보존됐다(`apk28-installed-proof.json`). 종료 후 비행기모드0/Wi-Fi1/데이터1·통계 표본2/빈 진단 속성·ADB UID2000·모델 디렉터리700을 확인하고 자체5572포워딩만 제거했다. 앱/Node/llama 프로세스는 종료됐고 데이터는 보존했다(`apk28-cleanup.json`).

## 남은 검증과 범위

물리 ARM64 두 기기의 실행·속도·발열·배터리·키보드·장시간 백그라운드는 미검증이다. 실행 중 Android가 앱을 종료하면 생성이 끊길 수 있다. 모델의 한국어·장문 MGE 플레이·기억 갱신 품질은 작은 합성 대화 시험으로 입증하지 않는다.

텍스트 모델을 대상으로 한다. 이미지 첨부는 자동으로 누락시키지 않고 안내한다. 웹 검색·온라인 임베딩·Google/DeepL·음성·NAS/GitHub, 원격 자료는 별도 인터넷/모델 지원이 필요하다. 전체 RisuBard 기능 이식, v2 기억/슬롯 ID 연결과 수신 복구, 전송 UI/각 경로 통합, 정식 배포는 기존 미완료 상태다. 이번 내부 Offline APK를 전체 프로젝트 완성판으로 게시하지 않는다.
