# Fable 5.1 xhigh 전송 기반 1차 검수

# RisuBard `.risuplay` v2 내보내기·Wiki/슬롯 캡처 중간 리뷰 (소스 한정, Fable 5.1)

범위: 제공된 `protocol.ts` / `snapshot.ts` / `characterChats.ts` / `play-set-archive.cjs` / `play-set-memory.cjs` / `risubard-memory-save*.ts` / `memorySaveCodec.ts` / 런타임 서비스 잠금 코드와 두 테스트 파일, 두 로그. 가져오기(ID 재연결·영수증·수신 저널·UI/전송)는 PENDING으로 보고 결함으로 세지 않았다. 아래에서 "증명됨"은 제공된 소스만으로 트리거가 확정되는 것, "경계"는 제공되지 않은 소스나 런타임에 의존해 판정 불가인 것이다.

---

## 1. 확인된 정상 동작 (요구사항 대비)

- **선택 범위 격리**: 캡처는 `chatIds`의 workspace와 `sourceChatId`가 선택 채팅인 슬롯만 복사하고, 슬롯이 참조한 공용 페이지만 `save-store/hh/<hash>`에서 가져온다. `private.md` 제외 테스트와 코드가 일치한다.
- **요청 프롬프트 제거**: 라이브 채팅과 슬롯 `chat.bin` 모두 `sanitizeTransferChat`를 거쳐 `promptInfo.promptText`가 제거되고 `excluded`에 기록된다. 슬롯은 디코드→정리→재인코딩된 사본만 manifest가 가리키므로, 원본 바이트 블록은 `blocks`에 남아 있어도 `expectedEntries(manifest)`에 포함되지 않아 ZIP에 쓰이지 않는다.
- **원본 불변**: 캡처는 임시 디렉터리에만 쓰고(`copyFile` EXCL, `wx`), 원본 슬롯 `chat.bin`이 그대로임을 테스트가 확인한다. 이 모듈에 DB 쓰기는 없다.
- **잠금**: `capturePlaySetMemory`가 선택 채팅 lane과 `SAVE_STORE_LANE`을 읽기 lane으로 잡으므로 rename/create/delete/prepareLoad/wiki 쓰기가 복사 완료까지 대기한다. 반환 뒤 lane이 풀려도 아카이브는 임시 사본만 읽는다.
- **스트리밍·용량**: yazl에 `size`를 넘겨 ZIP64 판정이 가능하고, 블록은 256KiB 슬라이스로만 읽는다. 65MiB+17 테스트에서 `arrayBuffer` 금지가 지켜진다. 읽기 측은 중앙 디렉터리 메타 예산, 레코드 JSON 예산, 실제 해제 바이트와 해시를 다시 검사한다.
- **안전 경로**: `workspacePath`가 Windows/Android 금지 문자·예약 장치명·끝 공백/점·`.`/`..`를 거부하고, NFC+소문자 중복과 파일/디렉터리 충돌을 잡는다. 캡처 측 `safeStatus`는 root부터 모든 부모를 `lstat`하며 junction 테스트가 통과한다.
- **아카이브 읽기 방어**: 중복 entry, 심볼릭 링크/디렉터리 속성, 암호화 비트, 잘린 파일, 검증 후 변조(`copyEntry` 재해시)가 모두 거부된다.

---

## 2. 증명된 버그

### 2-1. `attachPlaySetMemory`가 revision을 다시 계산하면서 계보 규칙을 건너뛴다 (중)

**파일**: `server/node/play-set-memory.cjs` `attachPlaySetMemory`, `shared/play-set/snapshot.ts` 끝부분.

**근거**: `snapshotPlaySet`은 v1 revision을 구한 뒤 (a) `revision === previous.revision`이면 `parent/ancestors`를 previous의 것으로 바꾸고, (b) `ancestors.includes(revision)`이면 되돌림 처리를 한다. 그런데 `attachPlaySetMemory`는 `version: 2, bard`를 붙여 `revisionOf`를 다시 돌리고 `validateRecords`만 호출한다. `revisionOf`는 `version`과 `bard`를 해시에 넣으므로 v1 revision은 v2 provenance의 revision과 절대 같을 수 없어, 규칙 (a)는 항상 불발하고 `parent = previous.revision`, `ancestors = [previous.revision, …]`로 고정된다.

**트리거**: provenance(`risuPlaySets.generations`의 `exported`/`characterChats` 세대)에 이미 v2 manifest가 있고, 채팅과 Bard 자료가 그 뒤로 바뀌지 않은 채 다시 내보낼 때. 새 v2 revision이 `ancestors[0]`과 같아져 `validateManifest`의 `m.ancestors.includes(m.revision)`에 걸려 **'Invalid revision ancestry'로 내보내기가 실패**한다. 이전 v2 상태로 되돌린 경우도 같다. 반대로 v1 revision이 이전 v1 revision과 같은 경우에는 (a)가 적용된 뒤 attach가 revision을 바꾸므로, Bard를 처음 붙인 재내보내기가 이전 세대의 **형제**(`parent = previous.parent`)로 기록되어 수신 측이 선형 갱신 대신 분기로 보게 된다. 되돌림 분기에서 `Object.assign(manifest, clone(known))`이 실행된 뒤 attach가 revision만 바꾸는 경우도 동일하게 실제 직전 세대가 계보에서 빠진다.

**현재 노출 여부**: v2 세대를 provenance에 기록하는 앱 코드는 PENDING이지만, `snapshotPlaySet(…, previous)`가 공개 계약이고 v1에서 export 세대를 기록하는 패턴이 그대로 쓰일 것이므로 appUI를 연결하기 전에 고쳐야 한다.

**최소 수정**: 계보 확정 블록(규칙 a·b와 `known` 재사용)을 `finalizeLineage(manifest, previous, history, records, blobs/loaders)` 같은 공용 함수로 뽑고, `attachPlaySetMemory`가 `previous`(또는 `snapshot`에 보존한 provenance)를 받아 revision 재계산 뒤 같은 함수를 호출한다. 더 단순한 대안은 `snapshotPlaySet`에 Bard workspace 공급 훅(예: `source.bardWorkspaces(portableIdOf)`)을 두어 revision을 한 번만, 최종 형태로 계산하는 것이다. 어느 쪽이든 "v2 세대 이후 변경 없는 재내보내기가 성공하고 revision이 동일하다", "되돌림이 known 세대로 복귀한다"를 테스트로 고정해야 한다.

### 2-2. 슬롯 `chat.bin`에 라이브 채팅용 차단 조건을 그대로 적용해 영구 차단이 생긴다 (중)

**파일**: `play-set-memory.cjs` 슬롯 루프의 `sanitizeTransferChat(chat, manifest.saveId + '/chat.bin', omitted)`; `snapshot.ts` `sanitizeTransferChat`.

**근거**: `sanitizeTransferChat`는 `isStreaming/_placeholder/_stub`, `risuBardWikiReboot`, `bardPainter.results[].compressionPending`이면 "완료를 기다려라/취소하라"고 throw한다. 라이브 채팅에서는 사용자가 조치할 수 있지만, 슬롯은 저장 시점에 고정된 불변 사본이므로 플래그가 영원히 남는다. 해당 슬롯이 선택 채팅의 것이면 **그 채팅의 내보내기가 슬롯을 삭제하기 전까지 항상 실패**하고, 메시지("Wait for chat generation…")는 실행 불가능한 조치를 안내한다.

**트리거**: 위키 재구축 진행 중이나 Painter 압축 대기 중에 저장(특히 `risuBardLastAutosaveTurn`이 시사하는 자동 저장)된 슬롯. 자동 저장이 실제로 그 시점에 일어날 수 있는지는 미검증이지만, 코드 경로 자체는 확정이다.

**최소 수정**: 슬롯 사본에는 `isStreaming/_placeholder/_stub/activeStreamingDisplayOptimizationMode`를 삭제하고, `risuBardWikiReboot`·`compressionPending`은 throw 대신 `excluded`에 "슬롯 저장 시점의 미완료 상태" 사유로 기록하거나 해당 슬롯만 명시적으로 제외하도록 `sanitizeTransferChat(chat, path, excluded, { frozen: true })` 분기를 추가한다. 테스트에 `isStreaming: true`가 담긴 슬롯 fixture를 넣어 내보내기가 성공하고 excluded가 남는지 확인한다.

### 2-3. 사용자 데이터 루트가 심볼릭 링크/junction이면 모든 내보내기가 실패한다 (낮~중)

**파일**: `play-set-memory.cjs` `safeStatus`: `let current = root, status = await fs.lstat(current); if (!status.isDirectory() || status.isSymbolicLink()) throw new Error('Unsafe Bard storage root')`.

**근거**: `root = resolve(userDataDirectory)`는 realpath를 하지 않는다. 프로필을 junction/symlink로 옮긴 Windows·Linux 사용자는 `lstat(root)`가 링크를 돌려주어 즉시 throw된다. 링크 금지의 목적("연결된 workspace가 무관한 데이터를 내보내지 않게")은 루트 아래 세그먼트 검사로 충족되므로 루트 자체의 링크는 데이터 유출과 무관하다.

**최소 수정**: `const root = await fs.realpath(resolve(userDataDirectory))`로 한 번 정규화한 뒤 아래 세그먼트 검사는 유지. `resolveMemoryWorkspace`에도 같은 root를 넘긴다(현재도 동일 변수를 쓰므로 일관성은 유지된다).

### 2-4. 무관한 슬롯의 손상 manifest가 선택 채팅의 내보내기를 막고, 오류가 대상을 지목하지 않는다 (낮)

**파일**: `play-set-memory.cjs` 슬롯 루프 — `parseMemorySaveManifest(JSON.parse(await metadata(...)))`와 `slotId !== memorySaveWorkspaceId(manifest.saveId)` 검사가 `byChat.get(manifest.sourceChatId)` 필터 **이전**에 실행된다.

**근거**: 같은 캐릭터의 다른 채팅 슬롯이 `risubard-save.json` 손상(`{}` 등)이면 `Invalid memory save manifest`로 전체 캡처가 실패한다. `listMemorySaveSlots`는 같은 상황을 건너뛰는데 캡처는 중단한다. "조용히 누락하지 않음" 원칙과 "선택되지 않은 자료" 사이의 정책 판단이 필요하지만, 최소한 어느 디렉터리인지 메시지에 포함해야 한다. 같은 결함 유형으로 `workspacePath`/`capture`의 'Unsafe Bard workspace path'도 파일명을 알려주지 않는다.

**최소 수정**: 두 오류에 `item.name`/`relativePath`를 덧붙인다. 정책상 무관 슬롯을 건너뛰기로 하면, 소유자를 알 수 없는(파싱 실패) 슬롯은 `excluded`에 경고로 남기고 계속 진행하는 분기를 둔다.

### 2-5. 프로토콜 v2 슬롯 검증이 schemaVersion 2에 필요한 페이지 목록을 요구하지 않는다 (낮, 계약 공백)

**파일**: `protocol.ts` `validateBard` — 필수 파일은 `chat.bin`, `risubard-save.json`만.

**근거**: `pages`가 비어 있지 않거나 manifest가 schemaVersion 2인 슬롯은 `risubard-save-files.json` 없이는 복원 불가능하지만 검증을 통과한다. 현재 exporter는 `walk`로 항상 포함하므로 내보내기 결함은 아니고, 가져오기(PENDING)가 의존하게 될 공유 계약의 구멍이다. `pages.length > 0`이면 해당 파일을 필수로 두는 한 줄 추가로 막을 수 있다.

---

## 3. 설계상 함정 / 판단 필요 (버그로 분류하지 않음)

- **이력·휴지통·검토 폴더까지 차단형 에셋 스캔**: `playSetMemoryMaterials`는 `.risubard-history`/`.risubard-trash`/`.risubard-review`의 `.md/.json/.jsonl/.txt`도 스캔하고, 없는 에셋은 `missing`으로 올라가 `writePlaySetArchive`가 거부한다. 휴지통에 들어간 문서가 삭제된 이미지를 참조하면 사용자 UI로는 해결할 수 없는 영구 차단이 된다. 이력/휴지통은 `optional` 이슈로 분류하거나 `omitMissingModuleIcons`처럼 명시적 생략 옵션을 두는 결정이 필요하다.
- **attach가 material 스캔 수행 여부를 검증하지 않음**: `play-set-archive.test.ts`의 `sample()`처럼 `chatMaterials` 없이 `snapshotPlaySet`을 돌린 뒤 `attachPlaySetMemory`를 붙여도 성공한다. 이 경로에서는 Wiki/슬롯이 참조한 이미지가 조용히 빠진다. 캡처가 yield한 (char, chat) 쌍을 기록하고 attach에서 `workspaces`와 대조해 불일치 시 throw하면 호출자 실수를 막을 수 있다.
- **DB 채팅과 디스크 Wiki의 단일 일관 시점 부재**: 캡처는 서비스 잠금 안에서, 채팅 레코드는 렌더러 DB에서 별도로 읽힌다. 그 사이에 턴이 완료되면 채팅 메시지 수와 위키 이벤트가 어긋난 아카이브가 나온다. 모듈 수준에서는 불가피하므로 appUI 연결 시 "내보내기 중 생성 금지"로 닫아야 한다.
- **다른 채팅 자료의 간접 포함**: `risuBardGallery`(이전 채팅 갤러리), `bardPainter.anchor.chatId`가 가리키는 다른 채팅의 이미지가 선택 채팅 레코드에 실려 그대로 수집된다. 또 Painter 결과의 이미지 생성 프롬프트는 "요청 로그"로 볼 여지가 있다. 보존/제외 정책을 문서로 확정해야 한다.
- **manifest.json 바이트 비결정성**: 슬롯 순서가 `readdir` 순서라 플랫폼마다 `manifest.json`이 달라진다. revision은 정렬 해시라 안정적이지만 바이트 재현성이 필요하면 캡처에서 `sourceId`로 정렬하면 된다.
- **8MiB manifest 상한과 이력 성장**: FileBlock 하나가 약 200B이므로 `.risubard-history`가 수만 파일이면 'Manifest exceeds metadata memory budget'으로 막히고 해결 수단이 이력 삭제뿐이다.
- **크래시 잔존물**: `play-memory-*`에는 정리 전 원본 `chat.bin`(promptText 포함) 사본이 남는다. 시작 시 임시 디렉터리 청소 코드는 제공 범위에 없다.
- **excluded 라벨 네임스페이스**: 슬롯 excluded는 `saveId/chat.bin/...`, 같은 슬롯의 missing은 `chatId/saveId/chat.bin/...`로 접두가 다르다. UI에서 묶어 보여줄 때 혼란 요인.

---

## 4. 미검증 경계 (제공 소스로 판정 불가)

- **ZIP64 실측**: 테스트는 65MiB로 "64MiB 상한 없음"만 증명한다. 4GiB 초과 entry/오프셋에서 yazl 자동 ZIP64와 yauzl 읽기가 맞물리는지는 미실행. `addReadStreamLazy`, `yauzl.openPromise`/`eachEntry`/`openReadStreamPromise`는 설치된 3.x 계열 API를 전제로 하며 테스트 통과로만 확인된다.
- **Wiki 파일명 규칙 vs `workspacePath`**: 위키 slug 생성기가 `:`·예약 장치명(`con.md` 등)·대소문자만 다른 두 파일(Linux/Android)을 만들 수 있다면, 내보내기가 'Unsafe Bard workspace path'/'Duplicate Bard workspace path'로 실패한다. `risubard-markdown-wiki.ts`가 없어 판정 불가. Windows MAX_PATH도 검사하지 않는다.
- **복구 폴더 수명**: `.risubard-snapshots`가 턴 완료 후 비워지는 임시 자료인지, 되돌리기용으로 유지되는 버퍼인지에 따라 "비어 있어야 함" 조건이 정상 플레이 중 상시 실패를 만들 수 있다. `.fork-complete-` 영수증을 건너뛰는 처리도 `risubard-memory-fork.ts`의 finalize 순서(영수증 기록→rename→삭제인지)에 따라 덮어쓰기 직전의 옛 슬롯을 내보낼 가능성이 있다. 복구용 `completeMemoryFork`는 슬롯 lane만 잡고 `SAVE_STORE_LANE`을 잡지 않아 캡처와 동시 실행될 수 있는데, 이 경우 stamp 불일치나 ENOENT로 실패(안전)할 뿐 조용히 지나가진 않는다.
- **비밀값 잔존 가능성**: `risuBardSettings`(제공 코드에서 내용 미확인), `.risubard-review` 문서, `message.generationInfo` 등 `promptInfo.promptText` 외 필드에 자격 증명이나 원문 요청이 들어가는지 확인 필요.
- **파일 시스템 경계**: 하드링크는 `lstat`로 탐지 불가(동일 볼륨, 같은 사용자라 위험은 낮음). 런타임 서비스를 거치지 않는 직접 파일 쓰기나 두 번째 프로세스는 잠금 밖이다. `openAsBlob`은 Node 20+ 전제이며 Android 런타임은 범위 밖으로 명시돼 있다.
- **디코드 측 `__proto__`**: msgpackr 디코드가 `__proto__` 키를 어떻게 처리하는지는 가져오기 신뢰 경계에서 확인해야 한다(내보내기는 사용자 자신의 파일이라 영향 없음).
- **테스트 증거 불일치**: `tmp/play-set-legacy-memory-tests.log`는 "2 files, 14 tests"인데 제공된 두 vitest 파일은 7+9=16개 테스트를 정의한다. 로그가 현재 파일보다 오래되었거나 다른 파일 묶음일 수 있으므로, 현재 테스트가 실제로 통과했다는 증거로는 쓸 수 없다. 94개 node:test 로그는 protocol/snapshot 계층 테스트(미제공)로 보이며 내용은 일관된다.

---

## 5. 결론

내보내기 본체(선택 범위 격리, 프롬프트 제거, 원본 불변, 스트리밍, 안전 경로, 아카이브 자기검증, 잠금 참여)는 제공 소스 기준으로 요구사항을 충족한다. 릴리스 전 반드시 고칠 것은 **2-1(계보 확정 누락 — 변경 없는 재내보내기 실패)**과 **2-2(슬롯 영구 차단)**이며, 2-3·2-4는 작은 수정으로 사용자 경험 함정을 제거한다. 3절의 정책 항목(이력/휴지통 스캔 차단, attach의 스캔 검증, 다른 채팅 자료)은 appUI를 연결하기 전에 결정해 문서에 반영하면 된다. 이 리뷰는 중간 내부 검토이며, PENDING인 가져오기 경로와 미검증 경계는 성공/실패 판정에 포함하지 않았다.
