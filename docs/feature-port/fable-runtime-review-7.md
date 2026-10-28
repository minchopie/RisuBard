# Actual Fable 5.1 xhigh runtime review 7

# Fable 5.1 xhigh 실행 기반 7차 검수 (읽기 전용, 제공 자료 기준)

## 0. 판정 요약

- **릴리스 승인 아님.** 이유: 신규로 코드상 확인되는 데이터 보존 결함 1건(§2-1), 외부 편집 소실 가능 로직 1건(§2-2), 검증이 필요한 중대 리스크 1건(§3-1)이 남아 있고, Kotlin 복구 UI는 아직 실행 증거가 없다(게이트).
- R6 지적 중 **#1(재개 시 stale pending), #5(`?.` 레이스), #6(`/` 포인터)은 제공된 전체 핸들러·초기화 순서·JSON Pointer 의미를 근거로 철회**한다. #3, #4(sync 레벨), #8, #9는 수정 확인. #2는 코드상 구현 확인, 실행은 APK10 게이트.
- R6 #13의 "성공 경로" 우려는 `/api/write` 전체 핸들러로 해소됐지만, **같은 핸들러의 실패 경로**가 이번 라운드의 핵심 신규 결함이다.

---

## 1. R6 항목 재평가

| R6 | 판정 | 근거 (제공 코드 기준 머릿속 재현) |
|---|---|---|
| #1 stale pending | **철회** | `/api/patch`·`/api/write`·`saveChatContentHandler` 모두 같은 queue 안에서 `externalChangesAwaitingReview()`(liveFilesAdoption 중엔 false) → `adoptSettledExternalProjection()` 순. adoption 실패 시 throw → 500, 쓰기 미적용. 성공 시 `sendCanonicalProjectionConflict` → 쓰기 미적용. 즉 `liveFilesAdoption` 설정~완료 사이에 `dbCache`/`fullChatStore`를 바꾸는 창이 세 핸들러에선 없다. 재시도 시 `pending`이 첫 스냅샷인 것은 **정확**(사이 쓰기 없음). 잔여: 미제공 쓰기 경로(chat-content-upload finalize, 채팅 삭제, backup import 등)가 같은 게이트를 지키는지는 확인 불가(주장 아님). |
| #2 Android 복구본 | **코드상 구현 확인, 실행 미증명(게이트)** | §5 참고. 로그는 `appendTo`+2MB 회전으로 보존되고, 복구 파일 자체를 UI가 직접 열거하므로 로그가 유일한 포인터라는 문제는 해소. |
| #3 무음 no-op | **수정 확인** | `persistChatStoreWithoutCache`가 `raw ? decode : exportLegacyDatabase()`로 폴백. `ensureChatStore`도 raw 없고 canonical ready면 전체 채팅 복원. 단위(2nd test: decode 미호출·canonical→changed 확인) + HTTP(`uncached-chat-flush-http`: 변경 채팅/무관 채팅 모두 디스크 확인) 통과. 잔여: `clearPersistFailure()`는 여전히 무조건 호출 — 도달 조건이 `dbCache` 없음 + `fullChatStore` 비어 있음 + pending true로 좁아졌을 뿐(§3-5). |
| #4 character-assets 실패 | **sync 레벨 수정 확인 / live monitor 레벨 미검증** | catch에서 `errorStage ∈ {character-assets, revision-accept}`면 `save.settle()`. `settle()`은 `written`·`insideTree`·불변 파일을 own으로, 나머지를 external로 분류해 partial revision 기록 — 테스트 두 경우 논리와 일치. 그러나 catch 경로에선 `liveCharacterFiles.accept(db, rev)`가 호출되지 않는다. `liveCharacterFiles.reconcile()`이 자기 쓰기를 `fresh`로 보고하면 adoption(자기충돌·불필요한 recovery 레코드)이 일어날 수 있으나, monitor 구현 미제공이라 미검증(§3-4). |
| #5 `?.` | **철회** | `externalEditSession = createExternalEditSession(...)`이 라우트 등록 이전 동기 초기화 슬라이스 끝에 있고, 핸들러는 listen 이후에만 실행. `persistCanonicalProjection`의 `?.`는 초기화 중 호출 대비로 타당. 스타일 불일치일 뿐 결함 아님. |
| #6 `/` 경로 | **철회** | RFC 6902 전체 문서 포인터는 `""`이며 `startsWith('/')` 실패로 unsafe. `/`는 빈 이름 키. 생성 주체가 없다는 설명 수용. |
| #7 Android 재시도 비용 | 유지(성능, 비차단) | 클라이언트 미제공. |
| #8 종료 예산 | **수정 확인** | `waitFor(30s)` → `destroy` → `waitFor(5s)` → `destroyForcibly`. 실기기 소요 시간은 게이트. |
| #9 복구 전 ensureChatStore | **수정 확인** | `await ensureChatStore()` 후 `reassembleFullDb(base)`. uncached 종료 E2E는 없음(§4). |
| #10 watchdog | 미착수(비차단) | Android는 30+5s 후 SIGKILL로 상한이 있고, 데스크톱 `/api/local-shutdown`은 여전히 무한 대기 가능. 데이터 손실 결함은 아님. |
| #12 클라이언트 계약 | 미검증 유지 | 클라이언트 미제공, 전체 클라이언트 테스트도 수정 전 소스 기준. |
| #13 `/api/write` 트래커 | **성공 경로 해소 / 실패 경로 신규 결함** | 성공 시 `persistCanonicalProjection(fullDb, {trigger:'full-write'})` = full-sync이므로 트래커 잔존 상태는 과포함만 유발(누락 아님). 실패 경로는 §2-1. |

---

## 2. 신규 확인 결함 (코드상 확인)

### 2-1. [중] `/api/write` canonical 실패 후 캐시 불일치 → 이후 persist가 전체 쓰기를 되돌림
- **확인 수준**: 코드 읽기로 상태 전이 확인. 결과(손실)는 canonical 실패가 선행돼야 하는 조건부.
- **상태 전이**: `/api/write`(database.bin)는 `initChatStore(fullDb)` → `kvSet` → `persistCanonicalProjection` 순. `kv-write`나 `canonical-sync` 단계에서 throw하면 catch가 `res.status(500)` 후 `return`하므로 그 뒤의 `delete dbCache[DB_HEX_KEY]`·타이머 정리·`dbEtag` 갱신이 모두 건너뛰어진다. 결과: `fullChatStore`=신, KV=신(kv-write 통과 시), **`dbCache`=구(stale)**, `liveFilesPendingWrites`=변경 없음(보통 false), `directWriteTracker`=unsafe 아님, `compatibilityCache.setVerified(false)` 미호출. `persistDbCacheWithChats`/`persistChatStoreWithoutCache`의 catch는 `setVerified(false)`+`observe(key, [])`를 하는데 이 핸들러만 하지 않는다.
- **손실 재현**: ① 클라이언트가 (패치 hash 불일치 폴백 등으로) 전체 쓰기 → canonical 단계 실패(asset 쓰기 오류, 디스크, 또는 beginSave 이후 외부 편집 레이스로 `CANONICAL_FILES_CHANGED`) → 500. ② 사용자가 계속 대화 → `/api/chat-content` POST(해시 검사 없음) → `dbCache[DB_HEX_KEY]` 존재(구) → chat-debounce → `persistDbCacheWithChats(구 stripped)` → `reassembleFullDb(구)`는 구 구조의 캐릭터만 순회하므로 전체 쓰기로 추가/변경된 캐릭터·모듈·설정은 빠짐 → (a) deferCompatibility면 `compatibilityCache.invalidate()`로 신 KV 블롭 삭제 + chat-direct 레인만 canonical에 기록, (b) 아니면 구 구조로 KV 덮어쓰기 → 어느 쪽이든 마지막에 `initChatStore(fullDb)`가 `fullChatStore`를 구 구조로 재구성. 전체 쓰기 내용이 메모리·KV·canonical 어디에도 남지 않는다. ③ 외부 편집 레이스 변형: 이후 쓰기는 409 `EXTERNAL_CHANGES_PENDING`으로 막히지만, 사용자가 adoption을 선택하면 `liveFilesPendingWrites`가 false라 `pending=null` → 병합 없이 외부 canonical이 KV/`dbCache`/`fullChatStore`를 대체 → 복구 레코드 없이 소실.
- **재시도 안전망 부재**: `/api/db/flush`·종료 flush는 `saveTimers||liveFilesPendingWrites` 조건을 못 넘어 아무것도 하지 않고, 종료 복구 파일도 생성되지 않는다(`dbCache`가 있어도 구 상태). 재시도는 전적으로 클라이언트의 전체 쓰기 반복에 의존한다.
- **최소 수정**: 실패 단계가 `kv-write`/`canonical-sync`(= `initChatStore` 이후)이면 catch에서 `dbCache[DB_HEX_KEY] = normalizeJSON(stripChatsFromDb(fullDb))`, `dbEtag = computeBufferEtag(fileContent)`, `liveFilesPendingWrites = true`, `directWriteTracker.observe(DB_HEX_KEY, [])`, `compatibilityCache.setVerified(false)`. 이렇게 하면 다음 flush가 full-sync로 재시도하고 종료 시 복구 파일에도 포함되며, 해시 검사도 클라이언트 상태와 일치한다. 그 이전 단계 실패(decode~encode)는 아무것도 변이되지 않았으므로 현 동작 유지. 차선(최소): 다른 persist catch처럼 `setVerified(false)`+`observe(key, [])`+`delete dbCache[DB_HEX_KEY]`만이라도 넣어 stale 캐시가 재조립에 쓰이지 않게 할 것 — 단 이 경우 canonical 재시도는 여전히 클라이언트 의존.
- **테스트 제안**: `/api/write` 본문을 기존 방식(`new Function` 슬라이스)으로 추출해 `persistCanonicalProjection`을 throw로 스텁한 뒤 `dbCache`·`liveFilesPendingWrites`·tracker 상태를 단언. HTTP 레벨은 전체 쓰기 → (asset 디렉터리를 읽기 전용으로 만들어) 실패 유도 → chat-content → `flush?mode=canonical` → export에 전체 쓰기의 신규 캐릭터가 남는지 확인.

### 2-2. [하~중·창 좁음] adoption이 `settle()` 결과를 무시하고 무조건 `accept()`
- **확인 수준**: 로직 확인. 손실 대상은 앱 데이터가 아니라 외부 편집.
- **재현**: adoption 병합 경로에서 `persistCanonicalProjection(fullDb, {adoptingLiveFiles:true})` 실행 중(full-sync, 큰 DB면 수 초) 다른 프로그램이 파일 X를 편집 → `settle()`이 partial revision을 기록하고 X를 pending으로 남김(이 동작은 'leaves a file edited during an unrelated save pending' 테스트가 보장) → 그러나 adoption은 반환값을 보지 않고 곧바로 `canonicalProjectionSync.accept()`(인자 없음 → 현재 fingerprints 전체 수락) + `liveCharacterFiles.accept(fullDb)` → X의 편집이 리뷰 없이 수락되는데, 메모리(`dbCache`/`fullChatStore`/KV)는 X 편집을 모르는 `fullDb` → 다음 full-sync에서 X가 덮어써진다. 비병합 경로도 reconcile 시점과 `accept()` 사이(encode+kvSet)의 작은 창이 있다.
- **최소 수정**: 병합 경로는 persist 직후 `canonicalProjectionSync.hasExternalChanges()`가 true면 `readyDb`를 비우고 `CANONICAL_FILES_CHANGED`로 throw(재개 가능). 비병합 경로는 `accept()` 대신 `accept(changed.revision)`으로 reconcile 시점 revision만 수락해 그 뒤 변경은 pending으로 남기기. `liveCharacterFiles.accept(fullDb)`도 revision 인자를 넘기는 쪽으로 통일(구현 미제공이라 효과 미검증).

---

## 3. 미검증 리스크 (확인 필요, 결함 단정 아님)

1. **[중·확인 요망] `/api/patch` 캐시 재적재 폴백 `dbCache[filePath] = {}`가 `database/database.bin`에도 적용됨.** KV 블롭이 없고(canonical-only flush로 삭제된 뒤 크래시/재시작) `dbCache`도 없는 상태에서 첫 요청이 patch면 `{}`가 캐시에 남는다. 해시 불일치 409로 patch 자체는 막히지만 `{}`는 그대로이고 `dbEtag`도 `{}`의 etag로 바뀐다. 이어 클라이언트의 전체 쓰기(큰 DB 인코딩으로 느릴 수 있음)보다 chat-content debounce가 먼저 발화하면 `persistDbCacheWithChats({})`가 실행된다. `reassembleFullDb({})`·`syncLegacyChatState({}, …)`·폴백 `importLegacyDatabase({}, {mode:'sync'})`의 동작이 미제공이라 결과(빈 DB 기록, canonical 삭제 여부)는 단정 불가하나, 성공 시 마지막 `initChatStore(fullDb)`가 메모리 채팅 저장소를 비우는 것은 확실. **최소 수정**: database.bin은 KV 부재 시 `{}` 대신 `await ensureChatStore(); dbCache = normalizeJSON(stripChatsFromDb(userDataRepository.exportLegacyDatabase()))`로 시드(R6 #3 수정과 같은 원칙). 1~3줄.
2. **R6 (c) 잔존**: adoption·`persistChatStoreWithoutCache`가 `kvSet('database/database.bin')`을 직접 쓰므로 `compatibilityCache`의 verified/invalidated 내부 상태와 KV가 어긋날 수 있음. 구현 미제공.
3. **`persistChatStoreWithoutCache`**: `findStubFlagLossChats` 가드 없음, 기존 KV 블롭엔 `decodeRisuSave`(persistent-id 변형 아님) 사용. `ensureChatStore`가 `runMaintenance`로 id를 KV에 되써 준다면 무해. 기존 코드이며 이번 변경 범위 밖.
4. **R6 #4 live monitor 측**(§1 표 참조): asset 실패 후 `liveCharacterFiles.accept` 미호출 → 자기 쓰기가 `fresh`로 보고되면 불필요한 adoption·복구 레코드·클라이언트 409. 손실은 아님(pending 병합됨).
5. **flush 무음 no-op 잔여 경로**: `invalidateDbCache()` 호출자(미제공)가 pending true·`fullChatStore` 비어 있는 상태를 만들면 `clearPersistFailure()`만 실행되고 `success:true`. 종료 시엔 복구됨. `clearPersistFailure()`를 실제 persist 분기 안으로 옮기는 1줄 수정 권장.
6. **재개된 adoption의 recovery 레코드 정체**: `recoverySaved=true`라 두 번째 `fresh`로 재병합해도 레코드의 `conflicts`/`externalRevision`은 첫 시도 값. pending/baseline은 유효하므로 복구 자체는 가능, 표시 정보만 부정확.
7. **종료 복구 엣지**: `canonicalProjectionReady=false`이고 `dbCache`가 없으면 `exportLegacyDatabase()`가 실패해 복구 파일 없이 exit 1 가능. 신규 설치 초기 구간 한정.
8. **`/api/write` 성공 시 `directWriteTracker.clear` 미호출**: 잔존 `characterIds`에 전체 쓰기로 삭제된 캐릭터가 섞이면 다음 chat-direct 레인이 `syncLegacyChatState`에 존재하지 않는 캐릭터를 넘긴다. 실패→full-sync 폴백이면 안전, 무시면 무해, 그 외는 미지. adoption처럼 `clear` 권장.

---

## 4. 증거 평가와 공백

- `runtime-transfer-review-current.log`: 9파일/54건 통과이나 파일명이 없다. 제공 5개 파일의 테스트는 14건(pending-flush-retry 2, uncached 1, shutdown-recovery 1, graceful-shutdown 2, canonical-projection-sync 8)으로 **40건/4파일 미식별**. 응답 문서의 "관련 서버 54개"는 이 로그와 숫자만 일치.
- 클라이언트 4694건은 **runtime 수정 전 소스 기준**이라 R5 ConflictError 계약(#12)·Android triggerSave(#7)에 대한 현재 상태 증거가 없다.
- `canonical-projection-sync.test`의 asset 실패 케이스는 `writeCanonicalProjection`을 `repository.importLegacyDatabase` 직접 호출로 스텁했지만 `observeWrites`·repository·fingerprint는 실제라 settle 로직 검증으로 충분. 단 `liveCharacterFiles`는 전혀 개입하지 않는다.
- 여전히 없는 E2E: (a) flush throw + 복구 파일, (b) uncached 상태에서의 종료 복구(`ensureChatStore` 폴백), (c) §2-1 `/api/write` 실패 경로, (d) §3-1 `{}` 캐시 경로, (e) adoption 중 외부 편집(§2-2).
- APK9 로그: `INSTRUMENTATION_CODE: -1`은 `RESULT_OK`이며 `persistedRuns: 2`, 14개 체크 통과. `recoveryExport=` 결과 줄이 없는 것은 APK10 미실행과 일치. `runtime-x64-16k-elf.json`의 `finalSourceVerified:false`, ARM64 4KiB는 명시 게이트.

---

## 5. Kotlin 복구 UI 코드 읽기 결과 (실행 증거 없음 → 게이트)

결함으로 볼 것은 없다. 확인 사항: 경로가 서버 `savePath`(`files/user-data`)의 `trash/shutdown-recovery`와 일치, UUID 정규식이 `randomUUID()` 출력과 일치(임시 파일은 자연 배제), 링크·부모 디렉터리 검사, 회전 시 이름 복원, 102 결과에서 원본 재검증 후 `ContentResolver`로 복사, 원본 보존. 버튼은 `panel`이 GONE이 돼도 WebView 위에 남는다. `refreshRecovery()`가 서버 시작 성공 시마다 호출되므로 `stop()`→재시작 경로의 파일도 즉시 노출된다.

비차단 메모: `recoveryFiles()`가 메인 스레드에서 디스크 I/O(작은 디렉터리라 실질 문제 없음), `openOutputStream(…, "wt")`는 일부 provider가 거부할 수 있어 실패 시 `"w"` 재시도 고려, 로그 회전이 시작 시에만 검사되고 `check(log.renameTo(...))` 실패가 시작 실패로 번짐, 같은 초에 생성된 두 파일은 다이얼로그에서 구분 불가. 복구 파일은 `stop()` 경유 종료(자격증명 불일치·ConnectException·시작 실패)에서만 생성되며 Android의 일반 프로세스 kill은 여전히 보존 범위 밖 — 이미 명시된 게이트이므로 결함으로 세지 않는다.

Instrumentation: `recoveryFiles`/`onActivityResult` 리플렉션 호출과 `Uri.fromFile` 대상은 실제 SAF 선택기를 우회하므로, 통과하더라도 "복사 로직 + 링크 배제"까지만 증명한다는 점을 결과 기록에 유지할 것.

---

## 6. 게이트 (코드 결함으로 집계하지 않음)

- APK10 instrumentation 미실행(§5), ARM64 16KiB 빌드 진행 중, 실기기 대용량 종료 시간(30+5s 충분성), SAF 선택기 수동 확인, Android 백그라운드 전환 vs kill 레이스, v2 통합, 수정 후 소스 기준 클라이언트 전체 재실행, 구형 USB 데이터 호환.

---

## 7. 다음 라운드 권고 순서 (데이터 보존 우선)

1. §2-1 `/api/write` 실패 경로 상태 정리(+ 단위 테스트).
2. §3-1 `/api/patch`의 `{}` 시드 제거(+ `reassembleFullDb({})`/`importLegacyDatabase({}, sync)` 동작 확인 결과를 명시).
3. §2-2 adoption의 `accept()`를 settle 결과/`changed.revision`에 종속시키기.
4. §3-5 `clearPersistFailure()` 위치 조정, §3-8 `/api/write` 성공 시 tracker clear(각 1줄).
5. 증거: 54건 로그에 파일명 포함, 클라이언트 스위트를 현재 소스로 재실행, (a)(b) E2E 추가.
6. 그 후 APK10 실행 결과를 기록하고, 실기기 항목은 게이트로 유지.
