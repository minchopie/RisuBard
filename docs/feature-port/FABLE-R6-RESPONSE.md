# Fable 실행 기반 6차 지적 대응

2026-10-17 내부 검증. 실기기 설치는 사용자 지시로 보류한다.

- R6 #1 stale adoption: 제공하지 않았던 /api/patch, /api/write, saveChatContentHandler는 모두 같은 storage queue 안에서 adoptSettledExternalProjection을 먼저 실행한다. adoption 실패면 쓰기 전에 throw, 성공이면 conflict 응답 후 return한다. 따라서 실패한 adoption 사이 새 쓰기가 수락되는 제시 시나리오는 확인되지 않았다. 이 코드를 7차에 제공하며 pending을 임의로 덮어쓰지 않았다.
- #3 무음 no-op: 재현 확인. compatibility DB가 없는 경우 canonical repository로 복원하고 ensureChatStore도 모든 canonical 채팅을 복원한다. 함수 재현은 수정 전 실패, 수정 후 통과. uncached-chat-flush-http.test.ts는 DB 최초 읽기 없이 실제 HTTP 채팅 저장과 flush를 수행하고 변경 채팅·무관한 채팅 모두 디스크에서 확인했다.
- #4 character-assets 실패 후 자기 저장을 외부 변경으로 오인: 실제 repository/observer로 재현 조건을 검사해 own writes를 settle하도록 수정했다. 실제 외부 변경은 검토 대기로 유지한다. canonical-projection-sync.test.ts 두 경우 통과.
- #2 Android 복구본 접근: MainActivity에서 앱 전용 shutdown-recovery의 일반 파일만 목록화하고 Android 파일 저장 선택기로 복사한다. 원본 유지, 링크 배제, 회전 시 선택 파일 이름 복원. Kotlin 구현과 에뮬레이터용 instrumentation 추가; 새 APK 결과는 후속 기록한다. 로그는 제한된 이전 로그 1개와 append 방식으로 보존한다.
- #8 종료 유예: 5+2초에서 30+5초로 늘렸다. Android 프로세스 강제 종료 상황 전체를 보장하지 않으며 실제 대용량 기기 시간은 후속 게이트다.
- #9 복구 전에 ensureChatStore로 본문 준비. uncached 경로의 canonical 복원도 함께 보완했다.
- #5 externalEditSession은 1290 부근에서 초기화된 뒤 7500 이후 리스너가 열리므로 제시한 시작 레이스를 확인하지 못했다.
- #6 JSON Patch 전체 문서 포인터는 빈 문자열이고 tracker가 unsafe로 처리한다. '/'는 빈 이름의 루트 필드이며 현재 정상 패처는 생성하지 않는다. 검증 없이 새로운 패치 의미를 만들지 않았다.
- #13 /api/write는 tracker에 맡기지 않고 directCollection 없이 persistCanonicalProjection을 호출해 전체 canonical 쓰기를 완료한다. 전체 핸들러를 제공한다.
- #7 flush 실패 시 전체 쓰기 재시도 비용은 남는다. 데이터 보존 경로를 성능 제안만으로 교체하지 않았다. #10 별도 종료 watchdog은 아직 넣지 않았다. 기존 native bounded wait와 owner EOF 정리가 있으며 큰 실제 기기 종료 시험은 미완료다.

검증: 관련 서버 54개 통과 (runtime-transfer-review-current.log), 별도 v2 마지막 22개 통과. 전체 클라이언트 4694개 통과/6생략은 이번 runtime 후속 수정 전 소스 기준이다. APK9 x64 16KiB 에뮬레이터는 인증/복구/이미지/Lua/스트리밍/서버 경로 및 강제 종료 후 persistedRuns 1→2 확인; 새 Kotlin UI는 APK10에서 확인 예정. ARM64 자체 빌드는 진행 중.
