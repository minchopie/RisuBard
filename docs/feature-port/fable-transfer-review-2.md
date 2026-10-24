# Actual Fable 5.1 xhigh transfer review 2

로 선언한다. 슬롯 `chat.bin` 안의 Painter ID는 `aliasesOnly` 스캔으로 context `inlays` 별칭에만 들어가고(테스트: inlay 2건, 슬롯 바이트 불변), 라이브 채팅의 ID는 선언 참조로 재연결된다(shared 로그 "Painter result and reference images are included and rebound…"). 잔여는 스캔 술어와 프로토콜 정규식의 범위 차이다(2-E).

## 2. 증명된 잔여 결함

### 2-A. v1 중간 finalize의 known 재사용이 v2 최종 manifest에 유출된다 (낮~중, 영향은 경계)
- 파일: `snapshot.ts` `snapshotPlaySet` 말미의 `finalizeSnapshotLineage(result)`, `play-set-memory.cjs` `attachPlaySetMemory`의 `{ ...snapshot.manifest, version: 2, bard }`.
- 근거: v1 pass에서 되돌림 분기가 성립하면 `Object.assign(manifest, clone(known))`이 `manifest.items`를 history의 v1 known 항목으로 바꾼다. attach는 얕은 스프레드로 그 `items`를 그대로 승계한 뒤 v2 revision을 다시 계산한다. 새 v2 revision은 ancestors에 없으므로 `parent = previous.revision`으로 확정되지만, `items[].parent`는 known(v1) 기준 값이다. `revisionOf`는 `parent`를 제외하고, `validateManifest`는 `parent`가 null/해시이기만 하면 통과하므로 어떤 검사도 이 불일치를 잡지 못한다.
- 트리거: 과거 v1 내보내기 G1(채팅 상태 S, R1) → Bard 포함 v2 내보내기 G2(상태 S′, parent=R1) → 채팅을 S로 되돌려 v2 재내보내기. v1 pass의 revision이 R1이고 R1 ∈ G2.ancestors이므로 known=G1, `validateRecords(G1, records)`와 자산 가용성이 성립해 reusable. 결과: manifest 계보는 G2의 후계, 항목 계보는 G1 기준(예: parent=null). 신규 계산이라면 변경 항목의 parent는 G2 항목 해시여야 한다. 기존 사용자(v1 세대 보유) 환경에서 현실적이다.
- 영향: 수신 측 `apply.ts`(미제공)가 `item.parent`로 항목 단위 선형/분기 판정을 한다면 오판. 내보내기 실패는 없다.
- 최소 수정: `snapshotPlaySet`이 finalize 직전 manifest(items 포함)를 `lineage.draft`로 보관하고, `finalizeSnapshotLineage`가 항상 draft에서 시작하도록 멱등화한다(또는 attach가 예정된 호출자에게 finalize를 미루는 옵션). 테스트로 "v1 세대→v2 세대→v1 상태로 되돌린 v2 내보내기"에서 `items[].parent`가 신규 계산과 같음을 고정.

### 2-B. 송신 기기 로컬 ID가 revision과 채팅 지문에 포함된다 (중, 프로토콜 호환 결정 사항)
- 파일: `protocol.ts` `orderedBardWorkspace`(`{ ...workspace }`로 `sourceCharacterId`/`sourceChatId` 포함) → `revisionOf`; `characterChats.ts` `chatFingerprint`의 `bard: orderedBardWorkspace(workspace)`; `play-set-memory.cjs`가 `sourceChatId: chatId`(호출 기기 로컬 ID)를 기록.
- 근거: v1은 항목을 portable ID로만 묶고 `parent` 같은 로컬 유래 값을 identity 밖에 두어 "변경 없는 재내보내기/왕복은 동일 revision"을 보장한다(shared 로그 "returning an unchanged export to its origin…", "legacy receipt of the same text chat…", "roundtrip and two-hop retain original identity"). v2의 `bard`에는 송신 로컬 chat/character ID가 그대로 해시된다.
- 트리거(코드 속성은 확정, 체감은 수신 경로 완성 뒤): A가 v2 내보내기 → B 수신 → B가 변경 없이 재내보내기. B의 capture는 B 로컬 chat ID를 `sourceChatId`로 기록하므로 모든 파일 해시가 같아도 revision ≠ A의 revision → 계보상 후계로 기록. A가 되돌려 받으면 수신 지문의 `bard.sourceChatId`(B 로컬)가 A의 `exported` 세대 지문(A 로컬)과 달라 `old` 미발견 → 동일 콘텐츠 채팅이 중복 추가된다. 부수적으로 송신 로컬 UUID가 아카이브에 남는다.
- 왜 지금인가: `revisionOf`는 해시 포맷이라 실사용 v2 아카이브가 생긴 뒤 바꾸면 기존 revision이 모두 무효화된다. 수신 ID 재연결(pending) 설계 전에 정해야 한다.
- 최소 수정: `revisionOf`와 `chatFingerprint`에서 `sourceCharacterId`/`sourceChatId`를 제외(`parent`처럼 identity 밖), 또는 manifest에서 제거하고 attach는 `snapshot.localIds`만 쓴다(이미 그렇게 `character`/`chat`을 구한다). 테스트로 "다른 로컬 ID, 같은 Bard 바이트 → 같은 revision·지문"을 고정.

### 2-C. 2-4 잔여: 대상이 표시되지 않는 오류 (낮)
- 1절 2-4에 열거한 6종. `walk`/`capture`는 `name`(상대 경로)을 이미 가지고 있으므로 메시지에 덧붙이는 것으로 충분하다. 손상 테스트는 메시지를 `toThrow(/slot/)` 등으로 확인해야 증거가 된다.

### 2-D. 전체 문자열 `startsWith('assets/')` 휴리스틱이 자유 텍스트 자료에 적용된다 (낮)
- 파일: `snapshot.ts` `scan`: `if (field.startsWith('assets/') …) asset(field, …)`; 이 분기가 성립하면 정규식 추출 분기(`!field.startsWith('assets/')`)는 건너뛴다. `asset()`은 `^assets\/[^/\\]+$`에 맞지 않으면 `Unrecognized local asset: <전체 문자열>`을, 맞으면 `source.asset(<전체 문자열>)`→null로 `Missing local asset`을 `missing`에 넣어 `writePlaySetArchive`가 차단한다(`[^/\\]`는 개행도 매치).
- 트리거: `playSetMemoryMaterials`가 `{ value: <파일 전체 텍스트> }`로 넘기는 wiki `.md/.txt/.json/.jsonl`, 슬롯 페이지, `baseline-summary.txt`, 또는 슬롯/라이브 채팅의 임의 문자열 필드(`message[].data` 등)가 `assets/`로 시작하는 경우. 예: `assets/x.png 설명…`으로 시작하는 요약 파일 → 해당 채팅 내보내기 전체가 차단되고 뒤따르는 다른 참조도 수집되지 않는다. 구조 필드(`image: 'assets/..'`)용 휴리스틱이 v1부터 있던 것이지만, 파일 전체를 하나의 필드로 넘기는 자료 스캔에서 오탐 범위가 넓어졌다.
- 최소 수정: 전체 일치 분기는 `^assets\/[^/\\\s]+$`일 때만 적용하고 그 외는 정규식 추출로 처리하거나, 자료 스캔(label 경로)에서는 전체 일치 분기를 끈다.

### 2-E. Painter 스캔 술어와 프로토콜 기대 종류 정규식이 어긋난다 (낮, 트리거 현실성은 경계)
- 파일: `snapshot.ts` `scan`의 `/\/bardPainter\//.test(p)`(비앵커, 모든 레코드 종류에서 ref 추가) vs `protocol.ts` `validateManifest`의 `item.kind === 'chat' && /^\/bardPainter\/(results\/\d+\/(assetId|settings\/context\/referenceAssetId)|settings\/context\/referenceAssetId)$/`.
- 근거: 예시 위치 밖의 `assetId`/`referenceAssetId`(예: `chat.scriptstate.bardPainter.assetId`—scriptstate는 스크립트 자유 형식, 또는 character/persona/module 레코드의 `bardPainter`, `results[i].variants[j].assetId` 같은 추가 배열)에 실제 inlay ID가 있으면 ref가 추가되고 기대 종류는 `asset`이 되어 `Wrong dependency kind: …`로 `attachPlaySetMemory`의 `validateRecords`(v1 단독 내보내기는 `writePlaySetArchive`)가 실패한다. inlay가 없으면 `Missing inlay`로 차단되므로 어느 쪽이든 내보내기가 막힌다.
- 트리거 현실성: Painter 실제 타입(미제공)에 추가 위치가 있으면 Painter를 쓴 모든 채팅이 실패하는 상위 위험이 되고, 없으면 조작된 scriptstate에서만 재현된다.
- 최소 수정: ref 추가 조건을 프로토콜 정규식과 같은 함수로 공유(별칭 수집용 `aliasesOnly` 경로는 `/value/bardPainter/…` 접두가 붙으므로 느슨해도 됨), 또는 프로토콜을 chat 레코드의 `^/bardPainter/` 하위 전체로 확장.

## 3. 미검증 위험 (경계)

1. **compressionPending 정책 상반/영구 차단 재발 가능성**: `rebindPainterChatScope`는 복사·불러오기 시 pending 결과를 제거하고 `referenceId`를 비우는데(원 소유 채팅의 미완료 압축), 내보내기는 플래그만 지우고 결과·`assetId`를 보존한다. 압축 완료가 inlay를 교체·삭제하는 구현이라면 동결 슬롯의 `assetId`는 사라진 inlay를 가리켜 `Missing inlay` 차단이 되고, 슬롯 삭제 외 해결책이 없다. Painter 코드 미제공. 권장: "슬롯 pending 결과의 inlay 부재" 테스트, 필요 시 해당 결과를 excluded 처리.
2. **동결 콘텐츠의 삭제 자산 참조**: 슬롯 chat.bin, `.risubard-history/.risubard-trash/.risubard-review`가 삭제된 asset/inlay를 참조하면 차단형 `missing`. 문서가 정책으로 채택했으나 2-2가 제거한 "실행 불가능한 조치 안내" 유형이 다른 경로로 남는다. 또 자유 텍스트에서 `assets/foo` 같은 문자열 언급도 참조로 간주된다.
3. **구형 `_placeholder` 슬롯**: `Chat body is not loaded`로 영구 차단되며 본문이 있는 사본에는 메시지가 맞지 않는다. 최소한 "슬롯 N을 삭제/재저장" 안내 필요.
4. **서비스 래퍼 경유 junction**: 1절 2-3 참조.
5. **scannedChats의 capture 단위 상태**: 1절 참조.
6. **슬롯 chat.bin에 남는 전송 범위 필드**: `risuPlayContext`, `risuTransferSource`, `risuTransferMedia`, `modules`, `bindedPersona`가 동결 사본에 그대로 실린다. 수신 기기의 `prepareMemorySaveLoad`는 `bindedPersona` 등은 `applyMemorySavePromptSettings`로 덮지만 `risuPlayContext`/`modules`는 두므로 다른 기기의 instanceId를 가진 채팅이 복원될 수 있다. `risuTransferMedia`는 별칭 해석에 필요해 단순 삭제는 불가 — 수신 설계 시 결정.
7. **현재 chat 전용 수신기가 v2를 받아들이는 문제**: `applyCharacterChats`는 v2 manifest를 거부하지 않고 `bard`를 포함한 지문으로 `risuTransferSource.hash`와 세대를 기록한다. 나중에 Bard 수신기가 생겨도 같은 아카이브는 `duplicate`로 판정되어 Bard가 영영 적용되지 않을 수 있다. pending "v1 호환에서 Bard 제외 안내"와 묶어 "Bard 미적용" 표식 또는 v2 거부를 먼저 정해야 한다.
8. **지문/revision에 이력·휴지통 포함**: Bard 로그만 바뀌어도 채팅이 새 버전이 되어 수신 측 중복 채팅이 생긴다.
9. **슬롯 열거 순서 비결정**: `chatsDirectory` readdir 순서가 그대로라 `manifest.json` 바이트가 플랫폼별로 다르다(revision은 정렬 해시라 안정).
10. **save-store 위치 가정**: `saveStoreDirectory(slotDirectory)`(미제공)가 슬롯 디렉터리 내부라면 `walk`가 페이지를 `files`로도 중복 수집한다(무해하나 2-5 규칙이 형식화됨).
11. **테스트 증거 공백**: 2-A 시나리오, 2-4 메시지, 2-3 서비스 경로, 2-D/2-E 트리거가 모두 미검증. `play-set-archive.test.ts`의 `sample()`은 attach를 거치지 않아 스캐너 계약을 우회한다(픽스처 한계, 결함 아님).

## 4. 미완료 과제 추적 (결함으로 세지 않음, 승인 대상 아님)

- 채팅/슬롯/근거/Painter/source ID 재연결 — 2-B 결정이 선행 조건.
- 페이지 해시/receipt, 영속 적용 저널, 수신 기기의 API 바인딩 유지.
- 선택되지 않은 gallery 범위와 내포 promptInfo 정리(`risuBardGallery`, `bardPainter.anchor.chatId` 간접 포함 포함).
- compatibility v1에서 Bard 제외 안내 — 3-7과 함께 결정.
- 앱 UI·모든 전송 경로, 임시 디렉터리 청소, "내보내기 중 생성 금지".
- 문서가 명시한 pending 항목과 코드 상태는 일치하며, 문서가 완료라고 주장하는 범위(export/archive + 공용 코어)를 벗어난 주장은 없었다.

## 5. 결론

1차 지적 2-1·2-2·2-3·2-5·스캐너 계약·Painter inlay는 코드와 현행 테스트로 수정이 확인되었고, 2-4는 절반만 반영되었다. 릴리스 전 결정이 필요한 것은 **2-B(송신 로컬 ID의 해시 포함 — 프로토콜 포맷이라 지금 정해야 함)**이며, **2-A(finalize 멱등화)**와 **2-E(스캔 술어 정합)**는 작은 수정으로 닫을 수 있다. 2-C·2-D는 소규모 개선이다. 3절 1·7은 pending 수신 작업의 설계 입력으로 넘겨야 한다. 현재 export/archive 코어는 내부 검토 통과 수준이지만, 문서 스스로 밝힌 대로 미완료 과제가 남아 있어 릴리스 승인 판정은 하지 않는다.
