# Fable 전송 기반 1차 지적 대응

- 2-1 반복 v2 내보내기의 Invalid revision ancestry를 실제 테스트로 재현했다. 최종 Bard 첨부 뒤 기존 계보 규칙을 재사용해 final revision을 확정한다. 변경 없는 재전송, 변경본의 직전 parent, 알려진 판본으로 되돌리기를 검사했다.
- 2-2 일반 저장 슬롯 생성기는 streaming/reboot를 이미 정리하지만 Painter compressionPending과 구형 슬롯은 남을 수 있다. 완전한 본문을 가진 동결 사본의 과거 작업 플래그만 excluded에 기록하고 제거하며 이미지/본문을 보존한다. stub/placeholder는 본문이 빠졌으므로 계속 명시 오류로 차단한다. 원본 슬롯 바이트 보존 확인.
- 추가 자체 검수: Painter result.assetId 및 settings.context.referenceAssetId는 일반 assets/문자열이 아니라 inlay ID였다. 기존 inlay 수집/참조 재연결을 사용하며 누락 이미지는 missing으로 보고한다. 실제 applyCharacterChats 후 새 inlay ID와 사본 불변을 확인했다.
- 2-3 설정된 사용자 데이터 루트 junction은 realpath로 해석한다. 그 아래 workspace 링크는 계속 금지한다. 두 경우 실제 filesystem 테스트.
- 2-4 손상 슬롯 오류에 슬롯 ID를 포함한다. 소유자를 판별할 수 없는 손상 슬롯을 조용히 제외하지 않으며 전체 실패를 표시한다. 정책을 임의로 바꾸지 않았다.
- 2-5 pages가 있는 슬롯은 risubard-save-files.json을 필수로 검증한다. 실제 v2 slot metadata/files cross-check는 importer 구현에 계속 필요하다.
- 자료 스캔 누락: capture별 material iterator가 선택 채팅 끝까지 소비됐는지 확인하고 attach에서 빠진 경우 거부한다. 테스트에도 실제 material reader를 연결했다.

현재 검사: shared 95통과, ZIP8+memory14=22통과. 처음 검토 자료에 오래된 로그를 넣었던 문제를 바로잡고 현재 소스와 함께 최신 로그를 제공한다. 별도 프로세스에서 실제 prepareMemorySaveLoad/completeMemoryFork 후 슬롯의 과거 Wiki/본문/변수를 읽었다. 이 시험은 같은 ID의 filesystem 왕복이며 새 ID 재연결, 앱 UI, 물리 기기 전송 성공을 뜻하지 않는다.

미완료: 채팅/슬롯/근거/Painter/source ID 재연결, 페이지해시/receipt, 영속 적용 저널, API 바인딩의 수신 기기 유지, 선택되지 않은 gallery 범위와 내포 promptInfo 정리, compatibility v1에서 Bard 제외 안내, 앱 UI/모든 전송 경로. 이들을 완료나 승인 대상으로 제시하지 않는다. 이미 존재하는 이력/휴지통도 자료로 수집하되 누락 자료를 사용자에게 표시한다. 임의 외부 다운로드/자료 대체/원본 삭제는 없다.
