# RisuBard 전송/동기화 모듈 (transfer-sync)

플레이 세트 전송(USB·Wi-Fi·NAS·GitHub)과 NAS 자동 동기화를 upstream RisuBard(`rpaddict/RisuBard`) 위에 다시 얹을 수 있는 단위로 정리한 것이다. 저장 파일·NAS 통신·Android/USB 와이어 형식은 바뀌지 않았다(0.9.81 모듈화는 이동만; 그 뒤 비차단 동기화 동작이 추가됨, 아래 §0).

## 0. 현재 동작: 비차단 백그라운드 동기화 (0.9.81 이후)
- 로컬 플레이·전송은 NAS를 기다리지 않는다. 전송 전 검사(`preSendSync`)는 미해결 apply의 hold만 거부하고 네트워크를 호출하지 않는다.
- 주기(5 s 저장 안정·30 s 폴·전면 복귀·reconnect)는 status → [snapshot(생성·가져오기 중 생략) → publish] → pull → pending 미리보기까지만 백그라운드로 돈다. 받은 커밋은 store에 영구 보관된다("받았음, 나중 적용").
- apply(plan→arm→save→finish)는 **안전 창**에서만: 앱 시작, 전면 복귀(visibilitychange/focus), 대화 열기(`risubard-chat-opened` 이벤트·캐릭터 전환), 수동 「지금 동기화」. 타이머·저장·전송·reconnect·"유휴"는 적용하지 않는다. 창은 이벤트 시점의 상호작용 카운터(pointerdown/keydown/input/touchstart/wheel, document 캡처)를 epoch로 가지며 갱신되지 않는다; 그 뒤 입력이 있으면 plan은 해제된다(await마다 재확인). plan의 실제 대상이 열어 둔 대화면 전면 창에서는 보류(`deferred-active-chat`)하고 다시 열 때 적용한다. UI·저장 잠금이 없는 서버 plan 계산은 기존 요청 제한을 사용하고, 응답 후 클라이언트 pre-arm 준비를 10 s로 한정; 서버에 남은 prepared plan은 다음 주기에 해제한다(armed 저널은 finish/recovery만).
- hold(`syncSaveHold`)와 `inert`는 arm→finish(및 시작 복구)에만 걸리고, 자동 동기화의 상태는 화면을 덮지 않는 인플로우 상태 줄로만 표시된다(수동 전송은 기존 모달).
- 한계: OS 백그라운드 서비스 없음(앱이 보일 때만), 입력 추적은 document 이벤트, 스냅샷 exclusive 구간의 423 재시도 지연 유지, armed 구간의 지속 시간은 보장하지 않음. 호스트(upstream 파일)에는 작은 훅만 남아 있으며 그 훅은 검토된 패치 한 장(`integration.patch`)으로 관리한다.

## 1. 구성
| 영역 | 위치 | 비고 |
|---|---|---|
| 서버 구현 17파일 | `server/node/transfer-sync/*.cjs` | `nas-route`, `nas-sync-{core,manifest,projection,remote,service,share,store,vault}`, `play-set-{archive,fingerprint,memory,relink,service}`, `transfer-{remote,secrets,windows}` |
| 서버 옛 경로 shim 17 | `server/node/<같은 이름>.cjs` | 한 줄 `module.exports = require('./transfer-sync/…')`. `server.cjs`·메모리 런타임·테스트는 옛 경로 그대로 |
| Android 임베디드 서버 글루 | `server/node/embedded-runtime.cjs` | Android 앱이 쓰는 호스트 측 런타임(`embedded.*`) |
| 클라이언트 구현 8파일 | `src/ts/transfer-sync/*.ts` | `nasSync`, `nasSyncCoordinator`, `nasSyncUi`, `playTransfer`, `transferNas`, `transferNative`, `transferState`, `transferAssets` |
| 클라이언트 옛 경로 shim 8 | `src/ts/<같은 이름>.ts` | `export * from './transfer-sync/…'` — 같은 ESM 인스턴스라 스토어·코디네이터 싱글턴 동일 |
| UI | `src/lib/Setting/Pages/TransferPanel.svelte` | `SystemBackup.svelte`에 마운트(훅) |
| 공유 코덱 | `shared/play-set/*`, `src/ts/risubard/memorySaveCodec.ts` | 서버·클라이언트·네이티브가 함께 쓰는 프로토콜/스냅샷/코덱 |
| 네이티브 | `android-app/`, `desktop-transfer/`, `scripts/android/` | 통째로 모듈 소유(upstream에 없음) |
| 도구·문서 | `scripts/transfer-sync/check-upstream.mjs`, `docs/transfer-sync/{manifest.json,integration.patch,MODULE.md}` | |

패키징은 추가 등록 없이 포함된다: `release.yml`은 `server/`·`shared/play-set/`를, `scripts/android/package-runtime.mjs`는 `server/node`·`shared/play-set`·`src/ts/risubard`·어댑터 4파일을 **재귀** 복사한다. `nas-sync-packaging.test.ts`가 두 목록으로 실제 스테이지를 만들어 shim 경유 로드까지 확인한다.

## 2. 호스트 훅 (integration.patch)
upstream 파일에 남는 모듈 소유 코드. 모두 `manifest.json › integration.files`에 **파일별 anchors(어떤 hunk가 모듈 것인지)·hooks(적용 후 반드시 존재해야 하는 기호)**로 기록되어 있다.
- `server/node/server.cjs`: 서비스 생성 블록(play-set/secrets/route/remote/nas-sync + 라우트), 쓰기 게이트(`checkActiveSession`·`queueStorageOperation`의 `assertWrite`, `storageWriteContext`), 백업 가져오기/DB 스냅샷 복원의 `markRestore/clearRestore`, `loadPersistedFullDatabase`(+ `prepare/decodeDatabaseWithPersistentChatIds`), Android 임베디드(`embedded.*`).
- `server/node/file-kv.cjs` `kvExportFile`(순수 추가) · `server/node/risubard-memory-runtime.cjs` `capturePlaySetMemory`·`invalidateTransferCache`·`renameMemorySave`의 저장소 레인 직렬화 · `risubard-memory-save.ts` `export parseMemorySaveManifest` · `risubard-source-workspace.ts` `export resolveLegacySourceSnapshotWorkspace` · `src/ts/preset/adapter/buildRequest.ts` `export resolveEndpointUrl`(본문 무변경, export만).
- `server/node/queued-save-debounce.cjs`(0.9.83): 쓰기 게이트(`queueStorageOperation`의 `assertWrite`)가 persist 시작 전에 423 `NAS_SYNC_BUSY`/`TRANSFER_BUSY`로 거부한 지연 저장은 `onError`(persist 실패 기록 → 다음 `/api/patch` 응답의 `persistWarning` 토스트)로 가지 않고 같은 지연으로 재예약한다. flush·전체 쓰기·새 타이머가 대체한 옛 타이머의 거부는 재시도도 경고도 없이 버린다. persist가 실제로 던진 오류(I/O)는 그대로 `onError`. `server.cjs`는 `onDeferred`로 첫 지연만 info 로그. 근거: 0.9.82 PC 설치 검사 중 `[Storage] Queued persist failed … NAS_SYNC_BUSY` 1건(`tmp/noninterrupt-install-20261021/CLAUDE-INSTALL-REVIEW.md`).
- 클라이언트: `storage/nodeStorage.ts`(`transferRequest`·`syncRequest`·`syncTransaction`·`transferTransaction`), `globalApi.svelte.ts`(`pendingTrackedChanges`·`syncSaveHold`·`syncOwned`·`canonicalSaveSettled`), `bootstrap.ts`, `importSession.ts`, `process/index.svelte.ts`(`preSendSync`), `App.svelte`(busy 오버레이), `storage/database.svelte.ts`(`risuTransferMedia` 타입), `SystemBackup.svelte`, `ChatScreens/DefaultChatScreen.svelte`(원격 삭제 복원 UI), `risubard/memorySaveSlots.ts`(코덱 사용), `package.json`(`yauzl`·`yazl`), `.github/workflows/release.yml`(경로·전송기 빌드).
- 패치에 **들어가지 않는** 포크 변경(의도): canonical 복구(`pendingCanonicalRecovery`·`compatibilityCache.setRecoveryHandler`), local-AI, 라우팅 메뉴, persist-failure 재시도 등. 모듈 hunk에 인접해 섞여 들어오는 줄은 `excludeAdded`/`excludeAddedBlocks`/`rewriteAdded`(검토된 명시 목록)로 제거하며, 제거가 **삭제 줄**에 걸리면 도구가 실패한다. 알려진 잔존: `server.cjs` 인증 예외 경로 목록 한 줄에 `/api/local-ai/model` 문자열이 함께 들어간다(존재하지 않는 경로 비교, 무해).

## 3. 도구
```
node scripts/transfer-sync/check-upstream.mjs patch  [--report <json>]
node scripts/transfer-sync/check-upstream.mjs verify --target v0.9.76|<sha>|latest [--full] [--keep] [--report <json>] [--logs <dir>]
```
- `patch`: `manifest.upstream.base`(v0.9.71 = `64ebfb2`)와 현재 트리의 차이에서 anchors에 걸린 hunk만 모아 `integration.patch`를 다시 만든다. hooks 중 하나라도 kept hunk/base에 없으면 **실패**(조용히 빠지는 훅 없음). 생성한 패치는 base 체크아웃에 `git apply --check`로 자가 검증한다. 버린 hunk 목록은 report에 남는다.
- `verify`: 임시 격리 체크아웃(upstream 태그/SHA; `latest` = 가장 높은 `vX.Y.Z` 태그) → 모듈 디렉터리/파일 복사 → `git apply --reject`(거부 hunk = CONFLICT, 3-way 없음) → hooks 존재 → upstream 신기능 보존 probe(`verify.upstreamFeatureProbes`) → `node --check`. `--full`은 그 체크아웃에서 `pnpm install`, 모듈 서버/클라이언트 테스트, `svelte-check`, `pnpm build`까지 실행한다. **`--full` 없는 PASS는 구조 확인일 뿐 호환 증명이 아니다.** 단계 출력 전문은 `--logs` 폴더에 남는다.
- 자가 테스트: `server/node/transfer-sync-check-tool.test.ts`(파서·anchors·제외·블록 제외·재작성·문맥 재정리·누락 훅 보고), `server/node/transfer-sync-shims.test.ts`, `src/ts/transferSyncShims.test.ts`.

## 4. 주간 절차 (Codex 스케줄러가 호출, 작성자 Fable 5.1, 검증 Codex)
1. `git ls-remote --tags` 로 upstream 최신 안정 태그를 읽어 `manifest.upstream.verified`와 비교한다. 비교 기준은 upstream 태그/SHA이며 이 포크의 버전(0.9.8x)이 아니다.
2. 새 태그가 있으면 `verify --target <tag> --full --logs tmp/transfer-sync-weekly/<tag>/ --report …`를 돌린다.
3. PASS: `manifest.upstream.verified`를 그 태그/SHA/날짜로 갱신(검증된 패치에 대한 일상 pin 갱신은 추가 승인 불필요). CONFLICT/FAIL: report의 거부 hunk·누락 훅·실패 단계를 그대로 보고하고 "준비됨"이라 하지 않는다. 수정은 모듈 작성자가 하고, 다시 `patch` → `verify --full`.
4. 공개 push·설치·실기기 조작은 이 절차의 범위 밖이다.

## 5. 검증 기록
- **.80 동작 보존(현재 트리)**: 이동 전후 호스트 추적 파일은 바이트 동일(줄바꿈 정규화 후 65파일, Codex 독립 확인). 변경은 이동·shim·테스트·`DefaultChatScreen.svelte`의 import 두 줄 순서(동작 무관)만. 서버 전체 119파일 1324 통과/4 skip, 클라이언트 모듈 11파일 57 통과, `pnpm build` 성공(Codex 로그 `tmp/modular-transfer-20261021/codex-080-*.log`), svelte-check 0 errors, 패키징 스테이지 로드(Android·release 목록) 통과.
- **upstream v0.9.76 호환**: 구조 검증 PASS(패치 18파일 적용·훅 전부 존재·신기능 probe 보존). `--full` 1차(Codex)에서 드러난 결함 3건을 고쳤다 — 프로젝션 소유권 테스트의 레거시 키 2개 문서화(`risuBardBardChanEnabled`·`risuBardBardChanModelMode`, upstream이 인터페이스에서 제거), `file-kv.cjs` `kvExportFile` 훅 누락, 메모리 런타임 `renameMemorySave` 저장소 레인 직렬화 훅 누락. 2차 `--full`(r2, Codex 독립) **PASS**: 서버 모듈 152 통과/1 skip, 클라이언트 57, `svelte-check` 0 errors, `pnpm build` 성공(`tmp/modular-transfer-20261021/reports/codex-verify-076-full-r2.json`). 최종 패치는 r2와 두 줄만 다르다 — 종료 처리의 포크 전용 `recoverFailedCanonicalTransaction()` 호출 제거(전체 스위트 실행 전에 이미 반영), `GITHUB_REPO`를 대상 저장소 값으로 유지(전체 스위트 뒤 유일한 변경)(upstream 전체 서버 스위트의 `risubard-update-release.test.ts`가 잡아낸 통합 누출; `updater.cjs`·`update.sh`와의 일관성). 증거 순서: r2 패치에 종료 처리의 `recoverFailedCanonicalTransaction()` 제거까지 반영된 .76 체크아웃에서 **upstream 전체 서버 스위트** 111파일/2 skip, **1273 통과/4 skip, 실패 1건**(위 updater identity 누출, `codex-final-upstream-all-server.log`) → 그 뒤 바뀐 것은 `GITHUB_REPO` 문자열 한 줄만이며, 중립화한 뒤 **release-target·도구 회귀 2파일/9건 통과**(updater 5 + 도구 4, `codex-final-upstream-targeted.log`) → 최종 패치의 깨끗한 .76 구조 검증 exit 0, 단계별 원문 로그 포함(`reports/codex-final-structure.json`). 전체 서버 스위트를 최종 패치로 다시 돌리지는 않았다(변경이 문자열 한 줄이라 대상 재실행으로 충분하다는 검토자 판단). 로그 사본: `tmp/modular-transfer-20261021/codex-final-upstream-{all-server,targeted}.log`. `risubard-update-release.test.ts`는 `verify.serverTests`에 추가되어 주간 점검에 포함된다.

## 2026-10-22 동기화 사용성 수정(소스 작업, 설치 전)
- 서버 내부 도우미 `nas-sync-reconcile.cjs` 추가(구 경로 shim 17개 유지, 구현은 18개). 기존 persona 그룹 형식을 유지하며 항목 ID별 공통 이력 병합. 실제 수정/삭제 충돌은 자동 덮어쓰지 않고, 수동 선택도 무관한 추가 항목을 보존한다.
- 기기별 선택과 입력 미러는 로컬 상태로 취급한다. 구버전 수신에 필요한 선택 필드는 전송에 결정적 미러로 유지한다. `userNote` 옛 루트는 이력 보존·값 적용 없이 수신 확인, 페르소나 note에서 로컬 미러를 맞춘다. 전역 미러만 수정 중이면 적용을 보류한다.
- 본문이 같고 기억/연결 자료가 갈라진 대화는 복제하지 않고 확인 대기. 기억 파일을 임의 합치지 않는다. 실제 메시지가 갈라진 경우 기존 갈래 보존 계약 유지.
- 자동 동기화가 화면 첫 영역, 수동 전송은 접기. 이름과 차이 종류, 마지막 적용 Wiki/슬롯 파일 수를 표시한다. NAS 게시와 다른 기기 적용은 구별하며 상대 적용 완료라고 추정하지 않는다.
- 새 회귀 검사는 manifest에 포함한다. 작업 증거와 실제 Opus HIGH 리뷰는 `tmp/sync-ux-20261022/`. 이 항목은 최종 검수·실기기 설치 완료 선언이 아니다.

최종 판정(2026-10-22): Codex 구현·실제 Opus5.5HIGH 검수 완료. 동결13파일 재대조0불일치, 로컬 서버47/클라이언트46, 원작.76 full 서버181pass1skip/클라이언트69/type0error8warning/build PASS. 최종 Claude 로그 대조도 조건충족 확인. 사용자 안내·제한은 `SYNC-UX-20261022.md`, 검수 증거는 `tmp/sync-ux-20261022/OPUS-FINAL.md`, `FINAL-PROOF.json`. 기기 설치/실NAS 시험/공개배포는 미실행.
