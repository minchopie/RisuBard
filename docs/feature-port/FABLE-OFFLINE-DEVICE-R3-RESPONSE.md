# 기기 내 AI 3차 공동 검수 대응

실제 원문은 fable-offline-device-review-3.md. D1/D2 수정 수용 뒤 추가 지적을 코드/재현으로 판정했다.

- 오래된 limits로 모드 전환: 실제 컴포넌트 시험에서 2048/128이4096/512로 덮였다. 전환은 현재 저장값을 새로 조회하고 적용 버튼만 편집값을 쓴다. store 변경은 필드에도 반영한다. 수정 후 UI 검사 통과.
- 손상 설정 이후 PUT가 model:null을 저장해 다음 시작에서 복사본을 지움: 해당 PUT를409로 거부하고, 원본 손상 설정/모델 파일을 보존한다. 성공한 모델 재선택만 상태를 복구한다. before실패→after통과.
- 전원 단절 순서: GGUF rename 뒤 POSIX 디렉터리를 fsync하고 설정을 저장한다. 이전 모델 삭제는 다음 시작 때 유효 설정을 읽은 뒤 기존 GC가 한다. 따라서 이전 설정이 남은 창에서도 이전 모델이 유지된다. 해당 상태의 합성 복구 시험 통과. 실제 전원 차단/f2fs는 미검증, Windows에는 디렉터리 fsync를 적용하지 않는다.
- 실제 socketFetch: 모의 엔진을 실제 자식 프로세스로 실행하고 요청 중 exit7 시503, 다음 요청 재시작200을 확인했다. 기존 주입형 단위 시험과 별도다. 수정 전 기록의 추가 bad-port 실패2건은 OS가 선택한 테스트용 포트를 fetch가 거부한 하니스 오류이며 제품 성공/실패로 세지 않는다. 같은 시험 재실행에서는 통과했다.
- 최종 오류 본문: NodeStorage.shouldRetryAuth는 특정 앱 문자열만 재인증하므로 native401 객체가 앱 세션을 초기화하지 않는다. 고정 엔진 서버 소스에423 상태는 없었다. HTTP 오류 객체는 기존 deriveHttpError가 읽는다. 반면 SSE error 프레임은 기존 parseChatStreamDelta가 null로 버려 실제 실패 응답이 빈 성공으로 끝나는 경우를400/500 표본으로 재현했다. 공통 파서에서 기존 오류 추출/분류를 사용해 예외로 전달하도록 수정했다. 라이브 스트림과 journal replay 양쪽이 같은 파서를 사용한다. 관련101검사 통과.
- savePath=processDataRoot는 server.cjs1036행, data lock21행, localAI 생성4498행이며 GC는 같은 잠금 안이다. 100mb JSON/SSE압축 제외/requestTimeout0/localAI.close 종료연결도 실제 소스 확인했다. 기존 PID 재사용 잠금의 희박한 가능성은 이번에 구조를 바꾸지 않는다.
- 유휴 복귀: APK24 실제 엔진의RSS1,124,320KB→38,704KB를 관찰한 뒤 같은PID13240으로TURN8 한국어 반가워요 생성 성공. 재시작 후TURN6/모델도 보존됐다. 토큰 계산도 모델을 다시 올릴 수 있다는 기존 안내는 유지한다.
- native timeout은 사용자가 취소할 수 있는 기존 방식. running은 프로세스/endpoint 생존 뜻이고 모델 상주 여부가 아니다. 모델의 모든 사이즈/성능을 보장하지 않는다.

APK24 WebView 종료: 빈 대조 앱198초 동안 같은 종료는 관찰되지 않았다. APK24 재시작 후 동일 부모/렌더러/Node로6분 이상 관찰 및TURN7/8 생성에 성공했으나 장시간 안정성의 증거로 일반화하지 않는다. 원인 미확정; 설치/릴리즈 HOLD 유지.

근거는 tmp/offline-native/ui-r3-before.txt, ui-r3-after.txt, server-r3-before.txt, server-r3-after.txt, sse-r3-before.txt, client-r3-after.txt, apk24-restart.json, apk24-idle-before-wake.json, apk24-idle-wake.json.
