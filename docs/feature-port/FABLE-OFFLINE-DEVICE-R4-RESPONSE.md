# Fable R4 대응 — 기기 내 Offline

## 범위
GOAL: Android 태블릿/스마트폰 독립 Offline AI. MUST: 모델 준비 후 PC/Termux/인터넷 없이 생성, 기존 채팅/설정 보존, 자동 온라인 대체 금지. KEEP: 별도 앱 ID/데이터, 일반판, 기존 가져오기/저장. VERIFY: 내부 에뮬레이터만. 물리 설치/정식 배포 HOLD.

## 수정과 증거
- A: settings.tmp 파일 fsync → rename → POSIX 디렉터리 fsync가 성공한 뒤 이전 선택 GGUF를 즉시 정리. 시작 시 고아 파일 정리는 보조로 유지. 설정 rename 이후 디렉터리 sync 실패 시 현재 메모리/파일 설정을 새 모델로 두며 이전/새 GGUF 둘 다 유지하고 명시적 경고를 반환. 실패를 throw하여 새 파일을 삭제하는 경로로 보내지 않는다.
- B: 손상 설정에서도 사용자가 직접 모드/한도를 변경할 수 있다. preserveUnlinkedModels=true를 내부 설정에 저장해 다음 실행에도 출처를 모르는 모델 사본을 삭제하지 않는다. 유효한 enabled/context/output은 모델 레코드가 손상돼도 보존. 성공한 새 모델 가져오기가 표식을 해제한다. 자동 온라인 전환은 없다.
- 모드 PUT에도 디렉터리 sync. UI는 성공 문자열보다 결과의 저장 경고를 우선 표시한다. enabled=false인 모델 가져오기는 준비 후 기기 내 AI를 눌러야 함을 안내한다.
- Windows 서버 집중 검사10통과. 새 POSIX 전용 Node 테스트2개는 Linux Docker에서 실제 실행, 생략0. 디렉터리 sync 실패를 주입하고 디스크에 이전 또는 현재 설정이 남는 두 경우 모두 참조 모델이 존재함을 검증. 실제 전원 차단이나 Android f2fs 보장은 아니다.
- C: 클라이언트 집중136통과. SSE 400/500 오류, 스트림 펌프, journal의 부분 텍스트 이후 오류: 기존 저장 부분 텍스트를 보존하고 완료 job을 claim; 기존 메시지 없으면 오류 블록 저장. 재시작마다 무한 복구하지 않는다. requestChatData는 로컬 활성 시 fallback 목록을 비우고, requestChatDataMain/requestModelPreset가 로컬 모델/로컬 fetch를 강제. 오프라인 상태에서 실제 합성 SSE 오류창 이후 native 재요청 성공.
- D: 이전 bad port 실패는 포트번호가 기록되지 않아 원인을 확정하지 않는다. 3개 HTTP 테스트가 실제 fetch로 포트를 시험하고, cause.message=bad port인 경우만 최대3회 재바인딩하도록 변경했다. 다른 오류는 실패하며 주소/원인을 출력한다. 최종10검사통과. 제품 포트 로직은 변경하지 않았다.
- 4차 설명 정정: 토글은 저장 한도를 보호하지만, store 값이 변하지 않으면 UI 미적용 입력은 계속 보일 수 있다. 모든 미적용 폼을 폐기한다고 주장하지 않는다.
- WebView 종료는 앱/Node/llama가 전혀 없는 별도 빈 WebView에서 같은14/14 스택 프레임과 주소/BuildID로 재현했다. Android 표본 통계 설정만 테스트 동안 활성화했고 모두 원복/adb unroot했다. 제품 우회는 추가하지 않았다.

## 한계
수치 아닌 SSE code→기존 server 분류, 준비 중 요청 취소가 모델 시작 자체를 즉시 중단하지 않는 기존 제한, 실제 ARM64 성능/장시간 안정성은 별도. 온라인 공급자 실호출이나 개인 자료는 사용하지 않았다. 전체 포트/정식 배포 완료가 아니다.
