# Bard 자료 전송 필드 조사

기준 소스 64ebfb23. 현재는 실제 저장 경로와 참조 조사이며 전송 구현 완료 기록이 아니다.

| 자료 | 실제 저장 위치 / 작성 코드 | 보존·연결 조건 |
|---|---|---|
| 채팅 본문·분기·스크립트 상태·변수 | 기존 Chat 전체 직렬화, `storage/nodeStorage.ts`, `globalApi.svelte.ts`, `server.cjs` chat-content/canonical 저장 | 선택 채팅만 완전 hydration 후 직렬화. 전송 중 상태와 인증정보 제외. 서버 업로드 200은 저장 완료가 아니므로 canonical flush 뒤 해시 확인 |
| 현재 기억 상태 | `risubard/characters/id-<base64url>/chats/id-<base64url>/narrative-state.json` | schemaVersion 1, facts/events/appliedOperationIds. evidence/invalidatedBy의 chatId 연결, messageId 보존 |
| 기억 사건 로그 | 같은 폴더 `events.jsonl` | 각 레코드 schemaVersion/operationId/event, event.evidence의 chatId. 미완성 마지막 줄의 기존 복구 규칙 보존 |
| 그래프 기억 | `narrative-graph-state.json`, `narrative-graph-operations.jsonl`, `narrative-graph-index.json`, `narrative-graph-dirty.json` | graph-workspace의 schema와 근거 참조를 함께 보존. index만 복사하거나 state만 복사하지 않음 |
| 설명·로어 근거 | `source-snapshot.json`, `baseline-summary.txt` | sourceSnapshot schemaVersion 1, sources[].sourceId/kind/content/fingerprint. `character-description:<encoded characterId>`와 `lorebook:<encoded scopeId>:...` 구조를 구분. 본문 일괄 문자열 치환 금지 |
| BardWiki | workspace 아래 `wiki/`의 events/characters/locations/factions/creatures/items/concepts/notes, current-scene.md/index.md | Markdown 본문·프런트매터·상대 파일 위치를 함께 보존. 기존 wiki import는 수동 문서로 바꾸며 근거를 분리하므로 이 전송에 그대로 쓰지 않음 |
| 위키 변경 이력 | `.risubard-history`, `.risubard-trash`, `.risubard-review` | 선택 workspace 범위의 파일. 복구 중인 자료는 복구 완료 후 일관된 스냅샷을 만들며 조용히 누락하지 않음 |
| 작업 중 복구 자료 | `.risubard-recovery`, `.risubard-snapshots`, fork/replace marker·완료 영수증 | 기존 작업·가져오기를 먼저 마무리. 남은 미확정 복구 상태를 받는 앱의 활성 복구 명령으로 가져오지 않음 |
| 첫 인사 근거 | `first-message:<chatId>:<greetingIndex>` (`process/index.svelte.ts`) | 일반 messageId와 달리 chatId를 담음. 위키 source_messages, turn receipt 등 구조적인 근거 ID를 함께 연결 |
| 위키 turn receipt | `canonicalTurnReceipt.ts`의 sourceMessageIds/eventIds/changes/recovery | changes[].afterHash와 recovery의 contentHash/inputHash는 무엇을 해시하는지 확인 후 갱신. 임의 재해시·삭제 금지 |
| 저장 슬롯 | `save-slot:<saveId>`를 workspace ID로 사용. `risubard-save.json`, `chat.bin` | `chat.bin`은 RisuSave 헤더가 없는 MessagePack(`memorySaveCodec.ts`)이다. manifest schemaVersion 1(전체 복사)과 2(공용 페이지 목록) 모두 처리. sourceChatId가 선택된 채팅인 슬롯만 포함 |
| 슬롯 메타 | saveId/sourceChatId/sourceChatName/createdAt/turnCount/latestMessageId/latestEvent | 캐릭터·채팅·슬롯 매핑 일치. 이름·시각·미리보기 보존. 수정 수신은 기존 슬롯을 덮어쓰지 않음 |
| 공용 저장 페이지 | `risubard-save-files.json` schemaVersion 1, files[].path/hash/size, 캐릭터 `save-store/<hash[0:2]>/<sha256>` | 선택 슬롯이 참조한 페이지만 포함. 내용 변환 시 SHA-256·bytes·목록 참조도 함께 변경. 다른 슬롯이 쓰는 페이지 삭제 금지 |
| 이미지·삽입 자료 | 기존 assets/inlay 참조, 현재 Chat와 저장 슬롯 chat.bin/기억 문서의 참조 | 현재 채팅뿐 아니라 슬롯이 참조하는 자료도 수집. 외부 URL은 임의 다운로드하지 않음 |

공통 경로 계산은 기존 `resolveMemoryWorkspace`, `memorySaveWorkspaceId`, `saveStoreDirectory`를 사용한다. 심볼릭 링크·부모 경로 탈출·중복 archive member·실제 해제량은 수신 전에 검사한다.

아직 남은 조사: Chat의 Bard 추가 필드 전수 목록, 위키 receipt/recovery 해시의 재계산 경계, source scope ID 변경 후 legacy identity fingerprint의 관계, 저장 슬롯 내부의 모든 에셋 참조. 이 항목들을 해결하기 전 v2 보존 검증을 통과했다고 표시하지 않는다.

2026-10-17 내부 구현: `play-set-memory.cjs`가 기존 서비스의 선택 채팅·공용 슬롯 저장소 읽기 잠금 안에서 임시 사본을 만든다. 슬롯 이름 변경도 저장소 쓰기 잠금에 참여한다. 요청 프롬프트는 슬롯의 전송 사본에서 제거하고 원본 슬롯은 유지한다. 현재 Wiki·슬롯 채팅·참조 공용 페이지의 텍스트는 기존 공통 에셋·inlay 스캐너로 넘긴다. 실제 Wiki 생성 → 저장 슬롯 생성 → ZIP 쓰기/검증 → 공용 페이지 복원 내부 시험이 통과했다. 다른 앱의 ID로 연결하고 슬롯을 UI에서 불러오는 검증은 아직 아니다.

추가 확인한 Chat 필드: `bardPainter`(anchor.characterId/chatId/messageId), `risuBardGallery`(이전 채팅 갤러리), `risuBardWikiGuide`, `risuBardSettings`, `risuBardWikiReboot`, `risuBardLastAutosaveTurn`, 메시지 안의 스크립트 체크포인트와 `risubardCanonicalReceipt`. 처리 중인 위키 재구축·Painter 압축은 완료 후 내보내도록 검사한다. `bindedBotPreset`·`useModelPreset`·`modelBinding`의 수신 기기 연결 유지 처리는 앱 가져오기 연결 시 검증해야 한다.

추가 내부 시험: 전송 ZIP에서 현재 Wiki와 저장 슬롯을 별도 사용자 데이터 폴더에 풀고, 원본 폴더를 전달하지 않은 새 Node 프로세스에서 기존 `prepareMemorySaveLoad` → `completeMemoryFork`를 실행했다. 새 서비스로 다시 읽은 Wiki는 슬롯의 과거 사건을 보존하고 저장 이후 사건은 포함하지 않았다. 채팅 본문·스크립트 상태·슬롯 이름도 보존했다. 이 시험은 동일한 캐릭터·채팅 식별자를 사용한 파일/서비스 왕복이며, 서로 다른 기기 ID 재연결·가져오기 UI·실기기 시험은 아니다.

추가 처리: BardPainter result.assetId/referenceAssetId는 bare inlay UUID이므로 기존 inlay 수집·재연결 규칙에 연결했다. character/chat 갤러리의 sourceChatId로 선택 채팅 발췌만 포함하며, 소유가 불분명한 character 갤러리는 제외 항목으로 명시한다. 갤러리 메시지의 promptInfo.promptText도 제외한다. 저장 슬롯의 과거 streaming/reboot/compressionPending 표시는 원본을 건드리지 않고 전송 사본에서만 제거한다. 갤러리의 수신 캐릭터 적용과 ID 연결은 아직 남아 있다.

## ID 변경과 해시의 실제 의미 (2026-10-17 추가 조사)

- `risubard-markdown-wiki.ts`의 `contentHash`는 프런트매터를 포함한 원본 UTF-8 파일 전체의 SHA-256 **base64url**이다. 공용 저장 페이지의 SHA-256 **hex**와 표현이 다르다. `source_messages`를 바꾸면 둘 다 바뀐다. 본문에 등장하는 ID 모양의 문자열은 편집 대상이 아니다.
- `canonicalTurnReceipt.changes[].afterHash`는 그 턴에서 저장한 문서 판본의 contentHash다. 현재 문서가 그 후 수정되었으면 현재 판본 해시로 덮으면 안 된다. `.risubard-history` 등 실제 보존 판본과 이전→새 해시 대응을 찾아야 한다. `recovery.deferred[].contentHash`도 같은 판본 검증에 쓰인다.
- `recovery.inputHash`는 문서 해시가 아니다. `risubard-memory-analysis.ts`가 `previousCanonicalReceipt`를 제외한 **요청 snapshot 전체의 JSON.stringify**를 SHA-256 hex로 계산한다. 채팅 ID만으로 재계산할 수 없고, 이전 요청 snapshot은 receipt에 포함되지 않는다. 변경 ID에서 이 해시의 의미를 유지하는 정책과 재시도 동작은 아직 미검증이다. 임의 재해시·삭제하지 않는다.
- `source-snapshot.json`의 fingerprint는 `sourceSnapshot.ts`가 `[kind, content]`를 FNV-1a 64비트로 계산한다. sourceId만 바꾸면 이 fingerprint는 그대로다. 반면 `sourceProjection.ts`의 **legacy sourceId 안의 identity**는 scopeId·key·secondkey·comment·mode·content를 함께 사용한다. 단순 scopeId 문자열 치환만으로 정상적인 다음 투영과 일치하지 않는다. 현재 로어에서 과거 identity를 재구성할 수 없는 경우의 처리도 남아 있다.
- 그래프 state/index와 node/edge의 `storyId`는 캐릭터 ID, `branchId`는 채팅 ID다. edge의 `sourceId/targetId`는 그래프 node ID이므로 캐릭터 ID 치환 대상이 아니다. operation log는 schemaVersion2 레코드의 operations를 보존해야 하며, 미완성 마지막 줄은 기존 reader가 별도로 다룬다.
- 수신 채팅의 API 연결은 `newChatModelDefaults`와 `resolveChatModelBinding` 계약을 따라야 한다. `useModelPreset=true`만 두고 송신측 modelBinding을 지우면 `nodeOnlyModelModeLock=none`에서 자동 기본값으로 돌아가지 않고 `main-unset/sub-unset`으로 차단된다. 현재 수신 대상 또는 새 채팅의 로컬 기본값을 명시적으로 적용하는 앱 연결이 필요하며, API 키나 송신측 연결을 가져오는 해결법은 사용하지 않는다.

위 항목은 실제 소스 조사 결과다. 다른 ID 수신 구현이나 검증 완료를 뜻하지 않는다.

후속 소스 확인: `risubard-memory-analysis.ts:1106`은 현재 요청에서 previousCanonicalReceipt를 뺀 전체 입력 해시와 저장된 recovery.inputHash가 같을 때만 이전 receipt의 deferred/changes를 재사용한다. 다른 ID로 옮긴 뒤 해시를 그대로 두면 과거 기록 자체는 보존되지만 동일 요청 재시도 최적화는 적용되지 않는다. 이를 곧바로 무해하다고 판단하지 않으며, 새 ID에서 재분석해 중복 사건/문서가 생기는지 실제 검사가 필요하다.

슬롯 불러오기의 기존 `applyMemorySavePromptSettings`는 현재 채팅의 페르소나·프리셋·모델 연결과 토글을 유지하고, 슬롯의 일반 GLGlobalVariables는 복원한다. 새 전송 수신에서도 이 계약을 재사용해야 한다. `InlayAsset` 본문 메타데이터는 ext/name/type/width/height이며 ID는 별도 저장 키이고, `inlay_meta/`의 charId/chatId·시각은 별도 자료다. 에셋 본문과 기기별 탐색용 메타데이터를 혼동하지 않는다.

전송 사본의 정규화 계약: 현재 채팅과 갤러리 메시지의 `promptInfo.promptText`는 요청 프롬프트이므로 제외하며 제외 기록을 남긴다. 송수신 기기의 로컬 ID는 내용 판본 해시에서 제외하고 안정적 출처 ID와 참조 자료 해시로 비교한다. Painter inlay ID, 갤러리 sourceChatId도 선언된 참조의 출처로 비교하며 본문 문자열을 ID처럼 일괄 치환하지 않는다. 채팅에 속한 구형 갤러리 슬롯에 sourceChatId가 없으면 전송 사본에 소유 채팅 ID를 채운다. 캐릭터 갤러리처럼 소유를 확정할 수 없는 자료는 제외 기록에 남긴다. 선택 채팅이 늘어 갤러리가 더 포함된 사본은 더 풍부한 수신본으로 따로 추가하며 기존 채팅을 덮어쓰지 않는다. 현재 v2 가져오기 계획 함수는 기억 수신 저널이 완성되기 전까지 명시적으로 거부한다.

기존 메모리 적용 코드 재사용 위치: `forkMemoryWorkspace`는 `destinationCharacterId`로 대상 디렉터리를 바꾸고 `populate(staging, sourceDirectory)`로 준비된 자료를 채울 수 있다. 자체 `.risubard-fork.json`과 `completeMemoryFork`의 finalize/discard를 제공한다. 그러나 기본 복사는 내부 JSON·Markdown의 chatId/storyId/근거를 바꾸지 않는다. 이 함수만 호출했다고 다른 ID의 기억 전송이 검증되는 것은 아니다. 전송 작업 기록에 예정 ID를 먼저 남기고, 기존 fork marker/token과 클라이언트 저장 확인을 함께 복구하는 연결이 필요하다.

수신 호스트의 전제: 대상 캐릭터와 출처 ID로 대응하는 채팅의 coldstorage/stub/placeholder를 복원한 뒤 계획 함수를 호출한다. 계획 함수는 필요한 복원을 오류로 알리며 사용자 DB를 변경하지 않는다. ID가 없는 관계없는 기존 채팅은 출처 매핑 비교에서 제외하고 그대로 보존한다. 출처 기기로 돌아온 좁은 선택은 수신 파일의 채팅 선택 집합을 과거 출처→로컬 ID 매핑으로 투영해 갤러리를 비교한다. 과거 넓은 내보내기 하나만 있어도 변하지 않은 좁은 반환을 중복으로 처리하며 기존 갤러리를 삭제하지 않는다.

2026-10-17 후속: 위의 v2 가져오기 거부/ID 연결 대기 표시는 초기 조사 이력이다. 현재 play-set-service.cjs가 영속 계획과 canonical 클라이언트 저장을 연결하며, play-set-relink.cjs/bardIdentity.ts가 typed ID·메시지 근거·인레이 별칭·저장 슬롯/페이지를 연결한다. play-set-fingerprint.cjs는 검증된 파일 내용으로 로컬 중복 지문을 계산한다. 비어 있지 않은 Wiki/슬롯의 A→B→A, 수정 Wiki, 부분 기억 공개 실패 후 복구, 실제 저장 슬롯 불러오기는 내부 검사 통과. 물리 기기 결합 검증은 미완료다.
