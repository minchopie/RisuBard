# 실행 기반 Fable 5차 지적 대응

2026-10-17. 내부 소스·합성 자료 검사이며 실기기 또는 릴리즈 승인서가 아니다. 사용자 요청에 따라 태블릿·스마트폰 설치와 조작을 보류한다.

| 지적 | 실제 소스 확인 및 대응 | 증거 |
|---|---|---|
| 타이머를 지운 뒤 persist 실패 시 재시도 소실 | 확인. 기존 `liveFilesPendingWrites`를 flush 조건에 포함해 타이머가 없어도 인정된 변경을 다시 저장한다. 성공 후 기존 실패 경고도 해제한다. | `pending-flush-retry.test.ts`: 첫 저장 실패, 타이머 제거, 두 번째 저장 성공, 세 번째 무변경 확인 |
| HTTP 200 `paused:true`를 저장 완료로 취급 | 확인. NodeStorage가 기존 ConflictError로 전달하며 외부 수정 검토/외부 편집 상태를 구분한다. | `serverDbFlush.test.ts`, 즉시 저장 관련 총 16개 통과 |
| 외부 수정 검토 대기 중 종료하면 인정된 채팅 소실 | 실제 서버로 재현. 수정 전 exit 0으로 종료했다. 수정 후 저장 큐 안에서 남은 메모리 내용을 `trash/shutdown-recovery/<uuid>.bin`에 기존 원자적 파일 쓰기로 보존하고 exit 1로 종료한다. 외부 수정본은 그대로 둔다. | `shutdown-recovery-http.test.ts`: HTTP 채팅 쓰기 → 외부 metadata 변경 → 보류 응답 → 로컬 종료 → 외부 파일 바이트 일치와 복구 파일의 신규 메시지 확인 |
| 종료 경로의 대형 호환 DB 생성 비용 | Android 내장 서버 종료에는 기존 canonical flush 옵션을 사용한다. 데스크톱 기본 종료의 호환 출력 동작은 유지한다. | `graceful-shutdown.test.ts`; Android 실제 종료 시간·강제 종료 시험은 남음 |
| adoption 성공 반환이 실제 저장 없이 성공 처리 | 제공 범위 부족에 따른 지적으로 확인. 실제 adoption은 canonical merge/저장, KV 기록과 캐시 갱신 후 성공을 반환한다. 보류와 다른 경로다. 임의 변경하지 않고 6차 검수에 전체 함수를 제공했다. | `server.cjs: adoptExternallyChangedCanonicalProjection` |
| root/preset/module과 chat의 혼합 저장 미검증 | tracker는 root를 chat 직접 저장에 합치며 다른 혼합은 전체 저장으로 전환한다. 실제 HTTP 테스트에 root/preset/module patch → canonical flush → 프로세스 종료 → 디스크 재열기 단언을 추가했다. | `direct-write-tracker.test.ts`, `canonical-projection-writer.test.ts`, `painter-save-flush.test.ts` |
| triggerSave Promise/Android 호출 스레드 미검증 | 실제 triggerSave와 MainActivity 전체 소스 및 테스트를 6차에 제공했다. 실제 기기 백그라운드 작업 완료는 아직 재검증하지 않았다. | `fable-runtime-review-6.prompt.txt`는 로컬 임시 증거; 공개 검수 결과는 별도 Markdown으로 기록 |

복구 파일은 로컬 사용자 데이터 영역의 일반 RisuSave 백업이다. 자동으로 현재 DB에 덮어쓰지 않는다. 이 경로의 복구는 수동 확인이 필요하다. 저장 공간 부족이 복구 파일 쓰기까지 막는 경우에는 오류 기록과 비정상 종료 상태만 남길 수 있으며, 이를 데이터 보존 성공으로 보고하지 않는다. 이 종료 복구는 전송 가져오기 저널의 자동 복구를 대체하지 않는다.

수정 후 관련 HTTP·제어 흐름 검사 5개, 전체 서버 검사 1,126개 통과/3개 생략. 타입 오류 0/기존 CSS 경고 8. 실제 Fable 5.1·xhigh 6차 검수가 진행 중이며, 16KiB 네이티브 빌드·실행과 최종 앱 검증은 아직 미완료다.
