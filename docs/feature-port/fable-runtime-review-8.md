# Fable 5.1 xhigh 실행 기반 8차 검수 (읽기 전용, 제공 자료 기준)

## 0. 판정 요약

- **릴리스 승인 아님(요청도 아님).** 런타임 단계 검수로서, R7에서 코드상 확인했던 결함 2건(§2-1, §2-2)은 **제공된 전체 핸들러·sync 모듈·실제 프로세스 테스트로 수정 확인**한다. R7 §3-1은 `db.cjs`/`compatibility-cache.cjs` 전체 제공으로 **철회**, §3-4는 모니터 은퇴로 **소멸**, §3-5·§3-8은 **수정 확인**.
- 이번 라운드에 **실행으로 재현된 결함은 없다.** 코드 읽기로 확인되는 새 사항 1건(§2-A, 좁은 창, 소실 아님·UI 정지)과 미검증 리스크 몇 건(§3)이 있다. 어느 것도 R7 수정의 회귀가 아니며 대부분 기존 구조에서 비롯된다.
- 증거 공백: `live-files-http.test.ts`는 소스만 제공되고 포커스 로그(33건)에 없음, 서버 전체 스위트는 "다음 실행 대기", 클라이언트 스위트 실행 로그 없음, APK11은 R7 이전 소스. 모두 게이트로 유지.

---

## 1. R7 항목 재평가

| R7 | 판정 | 근거 (제공 코드·로그 기준) |
|---|---|---|
| §2-1 `/api/write` 실패 경로 | **수정 확인(실행 증거 있음)** | 핸들러가 `initChatStore(fullDb)` 직후, `kvSet` 이전에 `dbCache=normalizeJSON(stripChatsFromDb(fullDb))`, `dbEtag=etag(fileContent)`, `liveFilesPendingWrites=true`, `directWriteTracker.observe(key, [])`(→`unsafe`), `compatibilityCache.setVerified(false)`를 설정한다. 이후 `kv-write`/`canonical-sync` 실패 시 catch는 500만 반환하고 이 상태를 남긴다. 머릿속 재현: 다음 chat-content → `dbCache` 존재 → `persistDbCacheWithChats('chat-debounce', {directCollection: take()=null})` → `deferCompatibility` 평가에서 `canDefer()`는 `verified=false`라 false → 전체 인코딩+`kvSet`+full-sync. `flush?mode=canonical`도 같은 이유로 full 경로. 종료 시 flush 실패 → exit 1 → `dbCache`(신 stripped)로 `reassembleFullDb` → 복구 파일 = `incoming`. 성공 시엔 `persistCanonicalProjection`이 pending을 false로 내리고 후속 블록이 `delete dbCache`·`directWriteTracker.clear`·`clearPersistFailure`. 로그에 kv/canonical × chat/flush/shutdown 6건 통과(`full-write-failure-http`). 전제 단계(decode~encode) 실패는 무변이 유지 — R7 권고와 일치. |
| §2-2 adoption vs `settle()` | **수정 확인(단위+실제 fingerprint)** | `persistCanonicalProjection`이 `{...result, acceptedRevision: save.settle()}` 반환. 병합 경로는 `acceptedRevision` null이면 `CANONICAL_FILES_CHANGED` throw, `readyDb/readyRevision` 미설정이라 `liveFilesAdoption`(pending·baseline·recoverySaved) 유지 → 재시도 시 `loadExternalChanges()`가 partial 마커 불일치로 새 revision 반환 → 재병합. 비병합 경로는 `accept(changed.revision)`로 reconcile 시점만 수락; `accept(revision)`은 `acceptedFiles=null`로 두고 `hasExternalChanges()`가 지연 재계산하므로 그 뒤 편집은 revision 불일치로 pending. `canonical-projection-sync.test`의 'adoption never accepts…(merge false/true)'가 `{...f.sync}`로 실제 `beginSave/settle/hasExternalChanges` 클로저를 쓰므로 fingerprint 로직 검증으로 유효. 잔여 nit: §3-5. |
| §3-1 `/api/patch` `{}` 시드 | **철회** | `db.cjs`가 `attachCompatibilityCache` 적용 후 `{...store}`를 export하므로 `server.cjs`의 `kvGet`은 래퍼. `kvGet('database/database.bin')`이 비면 `rebuild('read')`가 `hasCanonical()`(index/sidebar.json) 조건으로 `exportLegacyDatabase()`→encode→`original.kvSet`→bytes 반환, 실패 시 throw. 따라서 `{}`는 canonical도 KV도 없는 신규 설치에서만 도달. `uncached-chat-flush-http` 2건은 preload가 `original.kvGet`만 가로채므로 래퍼 재구축 경로를 실제로 탄다 — 적합한 검증. |
| §3-4 live monitor | **소멸(은퇴 확인)** | `createLiveFileMonitoring`이 `enabled:false`로 생성 → `active` undefined → `isEnabled()` 항상 false, `reconcile/accept/invalidate/reset` 모두 `active?.` no-op. `setEnabled(true)` throw → `/api/live-files/monitoring` POST는 queue 내 throw → `next(error)` 500 (HTTP 테스트는 `enable.ok===false`만 단언). `config/live-file-monitoring.json`은 읽지 않음. R6 #4의 "자기 쓰기를 fresh로 보고" 우려는 코드가 사라졌으므로 소멸. |
| §3-5 `invalidateDbCache` | **수정 확인** | `liveFilesPendingWrites=false`, 타이머·`dbCache`·`fullChatStore`·`canonicalProjectionReady` 정리. pending=true & 캐시 없음 & 스토어 빈 상태로 가는 다른 경로는 제공 코드에 없다(stub-flag-loss는 채팅이 있어야 발생). `clearPersistFailure()` 위치는 그대로지만 도달 조건이 "아무것도 pending 아님"뿐이라 무해. |
| §3-8 성공 시 tracker clear | **수정 확인** | 성공 블록에 `directWriteTracker.clear(DB_HEX_KEY)` 추가됨. |
| ENOSPC E2E | **확인** | `shutdown-flush-failure-http`: chat 쓰기 → flush 500(`kvSet` ENOSPC) → 종료 exit 1 → canonical은 원본 유지, 복구 파일에 `updated` 채팅 + `desc: 'Before'`, 토큰 파일 삭제. 로그 통과. |
| 백업 기본 경로 | **확인** | `DEFAULT_BACKUPS_DIR = path.join(embedded.enabled ? savePath : process.cwd(), 'backups')`. `isManagedBackupPath`는 `process.cwd()` 기준이라 embedded 기본값은 관리 경로가 아님. |

---

## 2. 코드상 확인 사항 (실행 미재현, 제공 server.cjs만으로 결정됨)

### 2-A. [하·창 좁음] stripped 캐시 없음 + pending chat + 외부 편집 → `/api/read`와 `/api/external-changes/resolve` 모두 500
- **상태 도달**: `/api/write` 성공은 `delete dbCache[DB_HEX_KEY]`로 끝난다. 그 뒤 첫 `/api/patch` 이전에 chat-content POST가 오면 `fullChatStore`만 갱신되고 `liveFilesPendingWrites=true`(캐시 없음). 이때 canonical 파일이 외부에서 바뀌면:
  - debounce persist: `persistChatStoreWithoutCache` → `persistCanonicalProjection` → `save.externalChanges` → throw(실패 기록).
  - `/api/db/flush`: `externalChangesAwaitingReview()` → paused.
  - `/api/read`: `flushPendingDbWithinQueue({adoptExternal:true})` → `adoptSettledExternalProjection()` → `fresh && !liveFilesAdoption && liveFilesPendingWrites && !fresh.previous`(모니터 은퇴로 `previous`는 항상 없음) → throw → 500.
  - `resolve`: `!dbCache` 분기 → `accept`는 같은 adoption throw → 500, `keep`은 409 "reload" → reload는 다시 500.
- **결과**: 데이터는 메모리에 있고 정상 종료 시 복구 파일(`stripChatsFromDb(exportLegacyDatabase())` + `fullChatStore`)로 보존되므로 **소실은 아님**. 그러나 사용자 조작으로 탈출할 경로가 없다.
- **최소 수정(미검증 제안)**: resolve의 `!dbCache` 분기에서 `await ensureChatStore(); dbCache[DB_HEX_KEY] = normalizeJSON(stripChatsFromDb(userDataRepository.exportLegacyDatabase()))`로 시드한 뒤 기존 review 경로로 떨어뜨리기. 앱 측 보호할 메타데이터 상태가 없으니 diff는 비고, `persistDbCacheWithChats(..., {externalRevision})`가 외부 메타데이터 + pending 채팅을 함께 기록한다. 또는 `/api/write` 성공 시 이미 설정한 `dbCache`를 삭제하지 않고 유지(캐시 없음 창 자체를 닫음) — 단 msgpack 재디코드 결과와 `normalizeJSON` 직접 결과가 해시 수준에서 동일한지는 utils 미제공이라 단정 못 함.

### 2-B. [관찰·비차단] 외부 편집 모드 진입 불가
- `/api/external-edit/start`가 `liveCharacterFiles.isEnabled()`를 요구하는데 항상 false → 409. 모니터 은퇴에 따른 의도된 기능 보류라면 문제 없음; 아니라면 게이트 제거 필요. 데이터 이슈 아님.

---

## 3. 미검증 리스크 (확인 필요, 결함 단정 아님)

1. **[중·확인 요망] 트랜잭션 도중 canonical 실패가 "외부 변경"으로 자기분류될 가능성.** `persistCanonicalProjection` catch는 `errorStage==='transaction'`일 때 `CANONICAL_FILES_CHANGED`만 `settle()`한다. 디스크 오류 등으로 저널이 일부 publish된 상태라면(file-store.cjs 미제공이라 publish 원자성 불명) fingerprint가 `acceptedFiles`와 어긋나 `hasExternalChanges()`가 true → §2-1이 열어준 재시도(flush·chat-debounce)가 `externalChangesAwaitingReview()`/`save.externalChanges`에 막히고 review가 뜬다. `dbCache`(신 상태)와 파일(부분 신)을 비교하는 review에서 **keep**은 안전(앱 상태로 덮어씀), **accept**는 아직 안 써진 부분을 파일 버전으로 되돌릴 수 있다. 제공 테스트의 canonical 장애 주입은 `writeCanonicalProjection` 진입 전이라 이 경로를 커버하지 않는다. 확인 후 필요하면 transaction 실패 catch에서 `repository.recoverPendingTransactions?.()` 후 `save.settle()`을 호출해 자기 쓰기를 수락하는 방안 검토(`observeWrites`가 저널 publish 파일을 `wrote`로 보고하는지에 의존).
2. **클라이언트 ETag 계약(R6 #12 잔존).** 실패한 전체 쓰기 뒤 `dbEtag`가 클라이언트가 보낸 바이트의 etag로 전진한다. `setItem`은 500에서 `_lastDbEtag`를 갱신하지 않으므로, 클라이언트가 이전 etag로 `x-if-match` 재시도하면 500 대신 409 ETag mismatch를 받는다. globalApi 미제공이라 409 처리(리로드→`/api/read` flush 재시도로 자기 쓰기 회복 vs. 동일 etag로 반복 재시도) 불명. 소실 경로는 아니다.
3. **canonical 단계 실패 후 크래시 창(기존 구조).** `kvSet` 성공·canonical 실패 상태에서 비정상 종료되면 복구 파일이 없고, KV 블롭(신)은 다음 시작의 canonical 우선 읽기 뒤 첫 persist에서 구 구조로 덮인다(채팅 payload는 id가 맞으면 살아남음). 테스트는 정상 종료만 다룬다. R7 수정의 회귀는 아니며 Android는 kill이 보존 범위 밖임이 이미 명시.
4. **백업 inventory 재귀 여부.** embedded 기본 `backups`가 `savePath` 아래다. `listCanonicalBackupEntries(savePath)`/`CANONICAL_BACKUP_DIRECTORIES`가 고정 디렉터리 목록이면 무관하나, 데이터 루트 전체를 걷는다면 백업이 이전 백업을 포함해 커진다. 모듈 미제공.
5. **[nit] 병합 경로의 `accept(acceptedRevision)` 중복.** `settle()`이 이미 `acceptedFiles=after.files`를 기록했는데 `accept(revision)`이 `acceptedFiles=null`로 되돌린다. `hasExternalChanges()`가 재계산하므로 정확성 영향 없음; 그 사이 편집은 revision 불일치로 잡히지만 `changedFiles()`가 null이 돼 review가 내용 비교로 떨어질 뿐.
6. **`live-files-stability`의 'failed adoption retries' 2건은 `isEnabled:()=>true`로 은퇴된 reconcile 분기를 실행.** 틀린 건 아니나 프로덕션 adoption 경로(`loadExternalChanges`)의 재시도 검증은 `canonical-projection-sync.test`의 merge 케이스와 after-publication 스텁에 의존한다. 참고용.

---

## 4. 증거 평가와 공백

- `tmp/runtime8-focused.log`: 6파일 33건 통과, 파일명 포함. 구성 합산(11+2+6+11+1+2=33)이 로그와 일치하고 R7 주장과 숫자 일치.
- **로그에 없는 것**: `live-files-http.test.ts`(2건) — 소스만 제공, 통과 여부 미증명. 이전 라운드의 graceful-shutdown/shutdown-recovery/uncached 단위 등은 이번 포커스 실행에 없음. "전체 실행에서 stale 스텁 2건 실패 → 수정 후 다음 전체 실행 대기"는 게이트.
- 클라이언트: `serverDbFlush.test.ts`·`immediateSave.test.ts` 소스는 제공됐으나 실행 로그 없음. 둘 다 `globalApi.svelte.ts`를 슬라이스하는데 그 소스는 미제공이라 내용 검증 불가.
- 테스트 하네스 메모: `canonical-projection-sync.test`의 `persistCanonicalProjection` 추출은 성공 경로에서 참조하는 `liveCharacterFiles`·`projectionShadow`·`kvList`·`logger`가 deps에 없다. 지금은 `characterAssets.sync`가 throw해 도달하지 않지만, 성공 경로를 검증하도록 확장하면 ReferenceError가 난다.
- APK11 로그: `INSTRUMENTATION_CODE: -1`(OK), `persistedRuns:4`, `stableBackupDirectory:true`, recoveryExport 줄이 symlink 거부·ContentResolver 복사·원본 보존·"system picker not automated"를 명시. JSON과 정합. `finalSourceVerified:false`, ARM64 4KiB, 실기기 미검증 유지. R7 명시대로 APK11은 post-R7 서버 소스가 아니다.
- 여전히 없는 E2E: (a) §2-A, (b) §3-1 트랜잭션 도중 실패, (c) 실패한 전체 쓰기 후 클라이언트 재시도(`x-if-match` 포함) 계약, (d) 클라이언트 스위트 현재 소스 재실행.

---

## 5. 게이트 (결함으로 집계하지 않음)

서버 전체 스위트 재실행, `live-files-http` 통과 로그, 클라이언트 전체 재실행, post-R7 소스로 APK 재빌드·instrumentation, ARM64 16KiB 빌드, 실기기(HOLD 유지)·SAF 선택기 수동, 대용량 종료 시간, v2 통합, 데스크톱 복구 파일 안내 UI 부재(기존).

---

## 6. 다음 라운드 권고 순서

1. §3-1 트랜잭션 도중 실패 재현(저널 publish 중 주입) — 결과에 따라 catch에서 recover+settle.
2. §2-A 최소 수정 + HTTP 케이스 1건(write 성공 → chat-content → 외부 편집 → resolve accept).
3. 증거: 전체 서버 스위트 로그(파일명 포함), `live-files-http` 포함, 클라이언트 스위트 현재 소스 로그.
4. §3-2 클라이언트의 전체 쓰기 409/500 처리 경로를 globalApi 슬라이스로 제공해 계약 확정.
5. 그 후 post-R7 소스로 APK 재빌드 후 x64 16K 재실행; 실기기는 HOLD 유지.
