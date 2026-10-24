# Fable 5.1 xhigh 실행 기반 6차 검수

# Fable 5.1 런타임 리뷰 6 — 독립 검토 결과

## 0. 요약

- R5에서 확인된 4개 결함(더티 플래그 유지, paused 200 → ConflictError, 종료 시 미반영 데이터 보존 + exit 1, 임베디드 종료의 canonical flush)은 **제공된 코드와 테스트 증거 기준으로 모두 수정 확인**됨.
- 어댑션(adoption) 우려는 **대체로 해소**되나, 재개(resume) 경로에서 `pending` 스냅샷이 갱신되지 않는 **새 결함(#1)** 이 보임.
- 신규로 코드상 확인되는 결함 2건(#1, #2), 조건부 확인 1건(#3), 미검증 리스크 다수. 데이터 손실로 직결되는 "확정" 결함은 #1(조건부)뿐이며, 나머지는 복구 불가 UX·무음 no-op·자기충돌 류.
- 브라우저 저장 동작(`supportsPatchSync && !Android` → flush 미대기)은 테스트로 유지 확인. 외부 canonical 편집 보존도 HTTP 테스트로 확인.

---

## 1. R5 결함 재검증

| R5 항목 | 판정 | 근거 |
|---|---|---|
| 실패한 flush 후 더티 플래그 유지 | **수정 확인** | `flushPendingDbWithinQueue`는 타이머만 지우고 `liveFilesPendingWrites`는 `persistCanonicalProjection`의 `save.settle()` 이후에만 false. `pending-flush-retry.test`가 제어 흐름을 검증. 단 이 테스트는 `persistDbCacheWithChats`를 스텁하고 플래그 해제를 스텁 안에서 흉내내므로 "실제 플래그가 settle 이후에만 꺼진다"는 부분은 코드 읽기로만 확인. |
| paused HTTP 200 → ConflictError | **수정 확인** | `NodeStorage.flushDatabase`가 `result.paused`면 throw. `serverDbFlush.test` 2케이스 통과. keepalive 경로는 catch로 삼킴(의도대로). |
| 종료 시 미반영 메모리 보존 + exit 1 | **수정 확인(일부 분기만)** | `shutdown-recovery-http.test`가 실제 서버로 "외부 변경 대기 → flush 조기 return → 복구 파일 생성 → exit 1 → 외부 파일 불변"을 검증. **단, "flush가 throw한 경우 + 복구 파일" 조합은 E2E 테스트 없음**(단위 테스트는 exit 코드만 확인, `liveFilesPendingWrites=false` 고정). |
| 임베디드 종료 시 canonical flush 요청 | **수정 확인** | 코드 + `graceful-shutdown.test`의 `toHaveBeenCalledWith({materialize:false, deferCompatibility:true})`. |

### R5 어댑션 우려 재평가
"adoption이 true를 반환하기 전에 canonical/kv를 영속한다"는 주장은 **코드상 맞음**:
- 머지 경로: `persistCanonicalProjection(fullDb, {trigger:'live-files-merge', adoptingLiveFiles:true})`가 full-sync import를 수행한 뒤 `kvSet('database/database.bin')`.
- 비머지 경로: canonical은 이미 외부 상태이므로 `kvSet`만으로 충분.
- 따라서 `flushPendingDbWithinQueue`가 adoption 직후 조기 return하면서 `liveFilesPendingWrites=false`로 두는 것은 정당.

남는 캐비엇:
- (a) 조기 return 시 `clearPersistFailure()`를 건너뜀 → 이전 persist 경고가 다음 성공 flush까지 잔존(경미).
- (b) adoption은 `liveCharacterFiles.accept(fullDb)`를 **revision 인자 없이** 호출(일반 경로는 `accept(db, acceptedRevision)`). 구현 미제공이라 영향 미검증.
- (c) `kvSet`으로 compat blob을 직접 쓰므로 `compatibilityCache` 내부 상태(verified/invalidated)와 KV가 어긋날 가능성 — 구현 미제공, 미검증.
- (d) **재개 시 stale pending** — 아래 #1.

---

## 2. 신규 발견 (심각도순)

### 1. [중] 어댑션 재개 시 `pending` 스냅샷 미갱신 → 사이 쓰기 유실 가능
- **확인 수준**: 코드상 확인(로직). 결과(데이터 유실)는 "`liveFilesAdoption` 설정 중에 `/api/patch`가 쓰기를 받아들이는가"에 의존 — 해당 핸들러 미제공. 다만 `externalChangesAwaitingReview()`가 `!liveFilesAdoption` 조건으로 진행 중 어댑션을 **명시적으로 게이트에서 제외**하므로 받아들일 가능성이 높음.
- **트리거**: ① 외부 변경 감지 → flush에서 adoption 시작, `liveFilesAdoption={pending: dbCache 스냅샷,…}` 설정 ② 이후 단계에서 throw(예: 외부 파일이 또 바뀌어 `live-files-merge`의 `externalRevision` 불일치로 `CANONICAL_FILES_CHANGED`, 또는 `kvSet`/encode 실패) → catch에서 `liveFilesAdoption` 유지 ③ 클라이언트가 500을 받고 재시도 → patch가 dbCache에 반영 ④ 다음 flush가 adoption 재개: `else if (fresh) { changed=fresh; readyDb=null }`만 수행, `pending`은 ①의 스냅샷 그대로 → merge 결과로 `dbCache[DB_HEX_KEY]=stripped(fullDb)` 덮어쓰기, `liveFilesPendingWrites=false`, etag 교체. ③의 쓰기는 메모리·canonical·복구 레코드(`recoverySaved:true`라 ①의 pending으로 저장됨) 어디에도 없음.
- **최소 수정**(둘 중 하나):
  - 재개 분기에서 `liveFilesPendingWrites && dbCache[DB_HEX_KEY]`이면 `pending`을 현재 dbCache로 재계산하고 `recoverySaved=false`로 되돌려 복구 레코드를 다시 저장. (실패한 adoption은 dbCache를 건드리지 않으므로 baseline은 그대로 유효.)
  - 또는 `liveFilesAdoption && !readyDb` 동안 `/api/patch`·`/api/write`·chat-content에 `EXTERNAL_CHANGES_PENDING` 409를 반환해 창을 닫음.
- **테스트 제안**: HTTP 테스트에서 metadata.json을 두 번(두 번째는 첫 flush 직후) 수정하고, 사이에 patch를 넣은 뒤 두 번째 flush 후 canonical export에 그 patch가 있는지 확인.

### 2. [중] Android에서는 R5의 "수동 복구 파일"이 사실상 도달 불가
- **확인 수준**: Kotlin 코드상 확인.
- **근거**: ① 복구 파일 경로가 `files/user-data/trash/shutdown-recovery/*.bin` — 앱 전용 저장소, 사용자 접근 불가. ② 유일한 포인터인 로그 라인이 `embedded-server.log`에 가는데 `builder.redirectOutput(File)`은 `Redirect.to` = **매 시작마다 truncate** → 다음 실행에서 소실. ③ `EmbeddedServer`는 exit code를 전혀 읽지 않음(`stop()`도 `waitFor` 결과만 봄). 즉 "exit 1"은 데스크톱 전용 신호.
- **트리거**: Android에서 외부 변경 대기 상태(또는 persist 실패) 중 `stop()` 경유 종료.
- **최소 수정**: 서버 시작 시 `trash/shutdown-recovery/*.bin`을 열거해 `/api/…` 상태로 노출하거나 `liveFilesRecovery`처럼 UI 알림으로 띄움(소스 수정, 데스크톱에서도 유용). Kotlin은 `ProcessBuilder.Redirect.appendTo` + 크기 상한. 실제 UX 확인은 디바이스 게이트.

### 3. [중·조건부] `persistChatStoreWithoutCache`의 무음 no-op → flush가 "성공" 응답
- **확인 수준**: 로직 확인. 도달 조건(`dbCache` 부재 + 보류 쓰기)은 부분 미검증.
- **근거**: `mode=canonical` flush 이후 KV의 `database/database.bin`은 삭제됨(painter 테스트가 `kvGet === null` 단언; `compatibilityCache.invalidate()`). 이 상태에서 `flushPendingDbWithinQueue`가 `dbCache[DB_HEX_KEY]` 없음 → `fullChatStore.size>0` 분기 → `persistChatStoreWithoutCache` → `kvGet` null → **조용히 return**. 이어서 `clearPersistFailure()`가 **무조건** 실행되고 `liveFilesPendingWrites`는 true로 남음. 클라이언트는 `success:true`를 받고, 이후 모든 flush가 같은 no-op. 종료 시에야 exit 1 + 복구 파일.
- **dbCache 부재 경로**: stub-flag-loss 가드가 `delete dbCache[filePath]` 후 throw(코드 확인); `invalidateDbCache()` 존재(호출자 미제공); `/api/read` 전 chat-content POST(미제공). 셋 중 첫 번째는 코드로 존재.
- **최소 수정**: raw가 null이면 `userDataRepository.exportLegacyDatabase()`로 폴백(shutdown이 이미 쓰는 방식)하거나 throw. 그리고 `clearPersistFailure()`는 실제 persist가 일어난 경우에만 호출.

### 4. [중·미검증] `persistCanonicalProjection`에서 `character-assets` 단계 실패 시 자기 쓰기가 "외부 변경"으로 보일 수 있음
- **근거**: canonical 트랜잭션은 이미 publish됐는데 `characterAssets.sync` throw → `save.settle()`·`liveCharacterFiles.accept` 건너뜀(catch는 `errorStage==='transaction'`일 때만 settle). 다음 `beginSave()`가 미수락 revision을 외부 변경으로 판정하면 `CANONICAL_FILES_CHANGED` → flush paused → 사용자 자신의 저장이 리뷰 대상이 되는 자기충돌. `canonicalProjectionSync` 미제공이라 판정 로직은 미검증.
- **최소 수정**: `character-assets`/`revision-accept` 단계 실패 시에도 `save.settle()` 호출(모듈 동기화처럼 비치명 처리 가능).

### 5. [하] `/api/db/flush`의 `externalEditSession.isActive()`에 `?.` 누락
- `let externalEditSession` 미초기화 선언, 다른 모든 곳은 `?.`. 리스너가 할당보다 먼저 열리면 TypeError→500. 테스트는 `test_auth` OK 이후에만 호출하므로 통과. 수정: `?.`로 통일.

### 6. [하·미검증] direct-write-tracker가 `path === '/'`(전체 교체)를 루트 설정으로 분류
- `'/'`는 characters 정규식·NON_ROOT 둘 다 안 걸려 `hasRootSettings=true` → `botPresetState` 직접 레인 → characters/modules 변경이 canonical에 안 쓰이고, `deferCompatibility`면 compat blob까지 삭제됨. 패처가 루트 교체를 생성하는지는 미확인. 수정: `path === '/'` 또는 두 번째 세그먼트 없는 경로를 unsafe 처리(1줄).

### 7. [하] Android `triggerSave`: patch 성공 후 flush만 실패해도 `forceFullWriteOnRetry=true`
- 서버는 이미 patch를 보유(더티 유지)하므로 전체 DB 재업로드 + full canonical sync가 최대 5회 반복. 손실은 아니고 비용 문제. `immediateSave.test`의 Android 케이스가 "배치 미유실"만 확인. 수정: `result==='saved'` 이후 flush 실패는 배치 requeue 없이 flush만 재시도(또는 force 없이 requeue).

### 8. [하] `EmbeddedServer.stop()` 종료 예산 5s+2s 후 SIGKILL
- 트래커 unsafe 상태의 종료 flush는 full canonical sync(테스트 픽스처 1.5MB에서 346ms, 실 DB는 수 초 가능) → SIGKILL이면 exit 코드·복구 파일 모두 없음. 호출 경로는 자격증명 불일치·ConnectException 재시작뿐이라 빈도 낮음. 수정: `waitFor(30, SECONDS)` 정도로 상향. 소요 시간 측정은 디바이스 게이트.

### 9. [하] 종료 복구 작성기가 `ensureChatStore()`·stub-loss 가드를 생략
- `reassembleFullDb(base)` 전 chat store 보장 없음. HTTP 테스트는 `/api/read` 후라 `fullChatStore`가 채워진 경우만 검증. `exportLegacyDatabase()` 폴백 경로도 미테스트. 수정: `await ensureChatStore()` 추가, `findStubFlagLossChats` 결과를 로그.

### 10. [하] 종료 워치독 부재
- 저장 큐를 긴 작업이 쥐고 있으면 `shutdownGracefully`가 영원히 대기(데스크톱 `/api/local-shutdown` 행, Android는 7초 후 SIGKILL). 수정: 저장소를 건드리지 않는 타이머로 N초 후 로그 + `exit(1)`.

### 11. [하·미검증] `trash/` 네임스페이스
- 복구 파일이 `trash/shutdown-recovery/`에 있음. `trash/`를 비우는 정리 작업이 있다면 제외해야 함. 제공 코드에는 없음.

### 12. [정보] 호출자 계약 변경
- `requestImmediateSaveImpl({flushServer:'canonical'})`가 이제 paused에서 ConflictError로 reject. 호출자(임포트 설치 등)가 이를 잡아 리뷰 UI로 연결하는지 미제공. `'canonical-background'`는 `console.warn`으로 삼킴(의도).

### 13. [정보·검증 필요] `/api/write`(전체 DB)의 트래커 오염
- 전체 쓰기가 `directWriteTracker.observe(key, [])`(unsafe)를 호출하지 않으면, 앞선 chatState 레인이 전체 쓰기의 모듈/페르소나 변경을 빠뜨린 채 canonical에 부분 쓰기 + compat 삭제 가능. 핸들러 미제공. 테스트 제안: chat patch → `/api/write`(모듈 변경 포함) → `flush?mode=canonical` → export에 모듈 존재 확인.

---

## 3. 테스트 증거 평가와 커버리지 공백

- 로그는 파일명 없는 집계(서버 27건/4파일). 제공된 세 파일 합계는 20건 → 1개 파일(7건) 미식별. 클라이언트 16건은 제공된 두 파일과 일치.
- 소스 추출(`new Function`) 테스트는 제어 흐름만 검증하며 실제 의존 함수(persist, 플래그 해제, queue)는 스텁 — 통합 보증은 HTTP 테스트 2건에 의존.
- **공백**: (a) flush throw + 복구 파일 E2E, (b) `exportLegacyDatabase()` 폴백 복구, (c) chatState + `includeRootSettings:true` 혼합 레인의 E2E(painter 테스트의 루트 패치와 chat 저장은 별도 flush), (d) `/language`·`/plugins`·`pluginCustomStorage` 단독 변경이 `botPresetState` 직접 레인으로 canonical에 써지는지(루트 단독 E2E는 `bardPainterFragments` 1건), (e) #1 시나리오, (f) 디바운스 성공 시 `lastPersistFailure` 해제 여부(해당 persist 콜백 미제공).

---

## 4. 소스 수정 vs 게이트 구분

**지금 소스로 고치고 내부 테스트로 닫을 수 있는 것**: #1, #3, #4, #5, #6, #7, #9, #10, #2의 서버측(시작 시 복구 파일 노출), #8의 상수 조정.

**런타임/16KiB/디바이스 게이트(현재 검증 불가, 승인 주장 없음)**:
- 16KiB 페이지 자체 심 Node 빌드에서 `libnode.so` 로딩·fs 동작 — 제공 자료에 근거 없음.
- Android 백그라운드 전환(`onPause` → `risubard-native-background` → patch/flush) vs 프로세스 kill 레이스; WebView가 일시정지 중 네트워크를 유지하는 시간.
- `stop()` 7초 예산의 실제 충분성, 복구 파일 UX(#2), 쿠키/세션 동작.
- 구형 USB 데이터 호환은 제공 범위 밖이라 판단 유보.
