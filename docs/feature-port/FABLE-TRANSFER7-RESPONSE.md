# Fable transfer R7 대응 — 내부 검수

물리 설치 HOLD를 유지한다. v2 새 ID 기억 적용/영속 저널/전송 UI는 미완료이며 전체 제품 승인을 요청하지 않는다.

- D-R6-1: 중복 페이지 해시의 크기가 서로 다를 때 기존 단언에 파일 경로와 해시를 추가했다. 기존 저장 슬롯은 그대로 보존한다. 새 테스트는 수정 전 경로가 없어서 실패(transfer7-page-repro-valid.log)했고 수정 후 통과했다. 첫 repro의 잘못된 vitest config 이름 오류는 실행 도구 오류였고 제품 결함 근거에 포함하지 않는다.
- D-R6-2: 자유 텍스트의 scheme://, //, data:, blob:, file: URI를 로컬 자산 탐색 대상에서 제외한다. 실제 원문은 그대로, 외부 주소는 내려받지 않고 표시하며 data URI는 인라인으로 보존한다. 5종 URI와 바로 옆 실제 로컬 자산을 검사했다. 수정 전 data URI가 Missing local asset 오류를 일으켰고 수정 뒤 통과했다.
- 115 shared + 26 archive/memory 통과, strict TS 종료0. Strict TS는 tsconfig의 다섯 구현 모듈만 검사하며 node-test.ts/CJS는 실행 검증이다. 전후 입력 해시 배열, 명령/시각/종료값/로그 해시 모두 transfer7-verification.json에 있다.
- 손상된 registry의 유효 ID + manifest 없는 행에 대한 방어는 기존 경계 위험으로 남긴다. 현재 host가 아직 없으며 새 버전 적용 시 registry 검증/복구 대상이다. 원본 DB/슬롯/외부 URL은 변경하지 않았다.

실제 SAF 시스템 선택창→합성 v2 카드 JSON 가져오기→강제 종료→재시작 후 카드/첫 메시지 보존을 API36 에뮬레이터 APK14에서 확인했다. 키보드 표시 후 viewport840→528 CSSpx, textarea.bottom513.24로 화면 안에 유지됐다. 이 결과는 일반 카드 가져오기 경로이며 미구현 risuplay v2 수신 성공이 아니다. APK14는 이 전송 후속 수정 이전 파일이므로 재빌드해야 한다.
