# 기기 내 AI 2차 공동 검수 대응

실제 원문은 `fable-offline-device-review-2.md`다. 차단 결함 없음이라는 표현과 별개로 D1/D2를 수정하고 재현 검사를 남겼다.

- D1 엔진 종료 후 socketPath가 undefined가 되어 TCP localhost:80으로 갈 수 있음: 재현 검사에서 수정 전 잘못된 호출/200이 발생했다. relay가 소켓/키를 스냅샷으로 고정하고 매 호출 때 일치 여부를 확인한다. 최하위 socketFetch도 경로가 없으면 거부하므로 TCP로 전환하지 않는다. 접속 종료 오류는 한국어503으로 안내한다. 수정 후 재현 통과.
- D2 준비 중503/깨진 JSON을 영구 모델 형식 오류로 표시: 상태별 안내·상류 오류 보존·JSON 파싱 실패 처리로 수정했다. 수정 전503이500이 되는 경우를 재현했고, 최종503/502 및 취소 신호 검사를 통과했다. Response 생성의 예외도 Promise 거부로 전달해 프로세스 전체로 새지 않는다.
- D3 업로드 중 pipeline이 소켓을 끊으면 JSON 오류를 읽지 못할 수 있음: 안전한 스트림 종료·기존 모델 보존을 유지한다. UI의 Failed to fetch를 한국어 연결 종료 및 현재 모델/저장 공간 재확인 안내로 바꿨다. 오류 본문 전달을 항상 보장하지 않는다.
- D4 정확한 토큰 계산도 모델을 불러옴: 로컬 모델 토크나이저 사용을 유지하고 UI에 최초/유휴 뒤 준비 시간이 있음을 명시했다. 모델을 준비하기 전에는 모델에 맞는 토큰 계산을 할 수 없다. UI 탐색 중 토큰 카운트가 요청되면 모델을 불러올 수 있다.
- R1 sleep guard: 고정 llama.cpp의 create_response()는 server_res_generator 생성자에서 wait_until_no_sleep()을 호출한 다음 핸들러가 vocab을 읽는다. 해당 실제 소스와 사용자 흐름의 유휴 복귀 결과를 후속 검수에 제공한다.
- R2 Unix 소켓 길이: APK23 debug ID의 실제 비공개 경로로 바인드·생성 성공을 확인했다. 일반판/다른 임의 data root에 같은 보장을 확장하지 않는다.
- R3 GC 동시 실행: server.cjs 19~21행이 createLocalAI(약4498행)보다 먼저 기존 acquireDataRootLock을 획득한다. 다른 실행 인스턴스는 이 앞에서 거부된다. 중복 잠금/GC 구조 변경을 추가하지 않았다. 실제 잠금 검사도 전체 서버 검사에 포함됐다.

회귀 근거: `tmp/offline-native/server-tests-r2-before.txt`(준비503 오분류), `server-tests-r2-death-before.txt`(엔진 종료), `server-tests-r2-final.txt`(8개 통과). 원본 실패 로그는 유지한다. 최종 제품 코드와 테스트는 3차 공동 검수 대상이다.
