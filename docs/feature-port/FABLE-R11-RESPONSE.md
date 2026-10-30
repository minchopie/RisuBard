# Fable R11 실행 기반 후속 수정

GOAL: 재시작 첫 요청에 따른 확정 저장본 차이와 canonical 체크섬 오류의 조회 실패 수정. MUST: 기존 저장/복구/외부편집 가드와 원본 보존. KEEP: legacy migration, accepted chat race guard, physical installation HOLD. VERIFY: 실제 HTTP 서버 실패·재시작·서로 다른 최초 요청, 외부편집 원본과 복구 파일 검사.

R11 §2.1은 canonical full-write 실패 후 첫 patch의 hash mismatch409로 재현했다(tmp/runtime11-repro.log). §2.2는 첫 chat GET가 stale checksum으로500이 되는 것을 재현했다. publish-delayed/restart-patch의409 EXTERNAL_CHANGES_PENDING은 예상된 기존 가드이며 새 테스트의200 기대가 잘못됐으므로 정확한409+code를 단언하도록 교정했다(제품 동작을 우회하지 않음).

loadPersistedFullDatabase는 기존 migration→canonical 우선→읽기 불가 시 compatibility fallback을 한 곳에서 수행한다. ensureChatStore, patch cold load, persistChatStoreWithoutCache, shutdown fallback이 사용한다. 기존 metadata/ID/cold 정규화 함수와 초기화 후 동시 요청 재검사 가드를 유지한다. canonical export 실패만 fallback하며 실제 maintenance 저장 오류는 삼키지 않는다. 빈 데이터는 임의로 저장하지 않고 명시적으로 실패한다.

실행: 집중39 통과(tmp/runtime11-fixed.log); 전체 server1183 통과/3생략(tmp/server-suite-runtime13.log, maxWorkers4). 클라이언트/웹 소스는 변경하지 않았다. 전회 원문 서버를 전회 prompt에서 복원했고 해시00250fadf25ded2f40a5986b6fc556a4d07fa4a61ca4043e844a41cb6775a141가 당시 제출표와 일치했다. diff는 tmp/runtime11-server-fix.diff.

API36 APK14에서 시스템 SAF로 합성 카드 가져오기→제어된 강제 종료→재시작 후 카드/본문 보존과 세로 IME 위치를 확인했다. 9분34초 프로세스 유지 뒤 시험자가 종료했으며 그 PID의 네이티브 크래시는 없었다. 일반 카드 UI 검사이지 미구현risuplay v2 수신 성공이 아니다. APK15는 이 R11 후속 저장 수정 이전에 빌드됐으므로 최신 수정의 실제 실행 검증이라고 부르지 않는다. 최종 내부 APK 재빌드 예정.

알려진 전체 통합 gate: 비대기형 저장 차단/복구 안내 UI, v2 새 ID 기억/슬롯/receipt 재연결과 영속 저널, 전송 UI/transport, 실제 ARM64/기기 검증. 미구현을 완료로 주장하지 않는다. 이번 요청은 이 두 저장 수정과 회귀 검수이며 정식 릴리즈 승인이 아니다. R11§2.3의 source-extraction 하니스는 아직 해당 test 한정 한계로 남겼다; 이번 두 defect의 검사는 실제 server.cjs를 별도 프로세스로 실행한다.
