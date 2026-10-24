# Fable 전송8차 후속

R7-1을 profile:assets/one.png, metadata:assets/two.png, my_data:assets/three.png 세 입력으로 재현했다. 수정 전 profile 일부가 file: URI로 보고되어 테스트가 실패했다(tmp/transfer8-boundary-repro.log). 현재 URI 정규식 앞에 ASCII 식별자/스킴 문자 경계 (?<![A-Za-z0-9_+.-]) 한 곳만 추가했다. URI/data payload 처리와 바로 옆 로컬 asset 수집은 기존 테스트 그대로 통과한다.

공통116개 모두 통과(tmp/transfer8-boundary-fixed.log), 공통 구현 모듈 strict TS 종료0. 이번 변경은 snapshot.ts 한 줄과 snapshot.node-test.ts 새 regression 한 개뿐이며 메모리 페이지 코드는 변경하지 않았다. //assets/x.png는 protocol-relative URL로 해석한다; 문맥 없는 텍스트에서 JS주석과 URL을 동시에 판별하지 않는다. 정식 UI 연결 전에 external 안내에 원문을 보여주며 임의로 내려받지 않는다.

전체 integration gate와 물리 설치 HOLD 유지. 이번 한 줄의 결함/회귀와 테스트 검수만 요청한다.
