# Android 파일 내보내기 누락 수정 — 2026-10-24

## GOAL / MUST / KEEP / VERIFY
- GOAL: 채팅 메뉴의 내보내기와 같은 파일 저장 경로에서 실제 Android 문서를 만든다. 받은 JSON을 다른 캐릭터에 가져올 수 있게 한다.
- MUST: 실제 Claude와 병렬 원인 검수 및 수정본 재검수. 같은 결함의 호출부 누락도 수정. 기존 모듈 재적용 구조 유지.
- KEEP: 기존 대화·설정·API·NAS 데이터 및 PC 브라우저 동작, 기존 전송·백업. 설치된 0.9.91이나 NAS 데이터는 수정하지 않았다.
- VERIFY: 바이너리 바이트/256KiB 청크/크기 제한 초과 입력/취소·재시도/재생성/실패 정리/다른 캐릭터 JSON 가져오기, 타입·빌드·모듈 재적용.

## 원인과 변경
공통 downloadFile은 blob 링크, LocalWriter는 StreamSaver만 사용해 Android WebView의 파일 저장으로 연결되지 않았다. 기존 RisuPlay RPC와 NativeDownload의 저장 위치 선택·생명주기를 재사용한다.
- download.begin/append/save/abort: 캐시의 UUID 임시 파일만 다루며 원본 앱 DB를 읽거나 쓰지 않는다.
- 256KiB씩 순서 확인 후 기록. 메시지 12MiB 한계 때문에 파일 전체를 한 번에 Base64로 보내지 않는다. 고정된 새 파일 크기 제한 없음; 실제 여유 공간 확인.
- 다운로드 버튼: 채팅 JSON/TXT/HTML·전체 대화, 페르소나·프리셋·모듈·Wiki·진단·이미지 등 공통 함수를 쓰는 경로 포함. 카드 PNG/CHARX와 패키지는 LocalWriter로 포함.
- 별도 링크 경로: painter 원본, 트리거 JSON, 코드 블록, 플러그인 템플릿을 연결. TransferPanel은 이미 Android 전용 저장 분기가 있어 변경하지 않았다. 서버 백업은 기존 native listener로 유지.
- 파일 이름의 실제 Android MIME을 사용하고 미등록 확장자는 vendor MIME으로 보존. CHARX를 ZIP MIME으로 강제하지 않는다.
- 저장창 취소/완료/복사 실패 시 해당 임시 파일만 정리. 프로세스 재시작 시 이전 중단 UUID 파일을 정리하되 복원된 저장창 파일은 보존. 같은 프로세스의 회전은 진행 중 파일을 정리하지 않는다.
- close/downloadFile 완료는 저장창 요청까지이며 최종 저장 성공은 Android 안내가 알린다. 기존 내보내기 성공 알림은 파일 저장 완료 보증이 아니다.

## 모듈 연결
file-export: 직접 내보내기 UI 4곳과 TS helper/tests. 기존 host-bridges: globalApi 다운로드/LocalWriter 연결. 기존 transfer-sync: Android 클래스. v0.9.81의 TextEncoder 변경을 보존한 호환 패치.

## 검증과 한계
최종 결과는 tmp/android-download-20261024/FINAL-PROOF.json 및 Claude JSON을 기준으로 한다.
- Kotlin 컴파일/런타임 JAR 재생성 후 직접 JUnit: 20개 통과. Gradle 테스트 실행기는 한글 classpath에서 모든 클래스를 못 찾았으므로 동일 컴파일 산출물·동일 dependency classpath를 java JUnitCore로 실행. 오래된 runtime JAR의 NoSuchMethodError도 재생성 후 해결.
- TS: 공통 경로·청크/오류·기존 전송·메모리 및 추출한 실제 exportChat/importChat JSON 왕복 12개 통과. 저장·Wiki API는 모의 객체이며 실기기 검증이 아니다.
- 타입/웹빌드 및 두 원작 기준 구조 재적용 결과는 최종 증거 참조.
- 실기기 저장창 선택·파일 목록·타 앱에서 열기·외부망 동기화는 미실행. 앱 설치/새 버전 릴리즈는 이 작업에서 하지 않음.

## Claude 교차 검수
실제 CLI Fable 5.1 high. 최초 감사 a2887183-18b7-4ebf-b481-f91d54d9d358. 수정본 검수에서 MIME/임시 파일 정리/PC 템플릿 보존 지적 반영. 오류를 삼키라는 제안은 가져오기 호출자가 성공으로 오인할 수 있어 채택하지 않고 거부 유지. 실제 최종 판정은 아래 후속 기록.

AOSP 참고: https://android.googlesource.com/platform/frameworks/base/+/android10-release/core/java/android/os/FileUtils.java (splitFileName). MIME과 확장자가 불일치하면 이름이 바뀔 수 있으나 application/octet-stream이 항상 .bin을 덧붙인다는 최초 검수 설명은 일반화하지 않는다.

최종 Claude 검수: 세션 `42620bf1-8778-42cd-b278-e0a231eff3f3`, 승인·남은 차단 없음. 소스/테스트 코드 검수이며 Claude가 테스트를 실행한 것은 아니다. Codex 실행: TS12·JUnit20·타입0오류8기존경고·웹빌드 통과. 실제 문서 제공자의 파일명/저장창 동작은 실기기 시험 대기.
