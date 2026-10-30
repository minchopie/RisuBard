# Fable plan review 2

Model: claude-fable-5-1; effort: xhigh. Read-only review of supplied sources and user requirements. This is not implementation/device approval.

# 2차 독립 재검수 — 판정: **계획 승인(조건부)**, 구현 성공 승인 아님

도구·파일 변경 없이, 제공된 대화·소스 발췌만으로 봤다. Codex 수정안은 사용자 확정 요구(독립 APK·별도 설치·기억+저장 시점 포함 전송·비공개 repo·4회 공동 검수·축소 금지)와 모순이 없다. 1차 지적 6건 중 5건은 새 소스로 닫혔고, **1건(수신 적용의 계층)** 만 수정안 문장이 증거와 어긋나 구현 전 한 단락 교체가 필요하다. 사용자에게 새로 물을 항목은 없다.

## 1. 1차 지적 해소 확인 (증거 대조)

- **런타임(#1)**: "재배포 가능한 ≥22.12 프리빌트 우선 → Node24 NDK 빌드 → 실패 시 사용자에게 근거·대안 제시, Termux/원격 전용 임의 전환 금지"로 go/no-go 구조가 됐다. 해소.
- **형식(#2)**: `characterPackage.ts:25-55`의 `risuCharacterPackage v1`에는 memory/save 항목이 없고 `316-318`에서 `chat.id`를 v4로 재할당한다. `protocol.ts:108,117`은 version≠1·미지 kind를 거절한다. 따라서 "기존 `.risuplay`를 v2로 확장, 전송 5종 단일 형식, v1에 몰래 kind 추가 금지"는 증거 기반 결정이다. 해소.
- **저장 단위(#3)**: `risubard-memory-workspace.ts:217-228`(chat 단위 workspace: `narrative-state.json`, `events.jsonl`), `risubard-memory-save.ts:21-46,271-287`(슬롯 = `chat.bin` + `risubard-save.json` + 페이지 목록, `sourceChatId` 보유), `risubard-memory-save-store.ts:36-42`(캐릭터 공용 content-addressed 페이지). "저장 시점"이 파일 집합으로 정의됐고, 캐릭터 단위 공유기억 자동병합 문제는 없다. 1차에서 우려한 제목충돌 규칙은 wiki 문서 전송 패키지 쪽이며 chat workspace 수신에는 무관해 보인다(확인은 gate). 해소.
- **1회 이전(#4)**, **계층 매트릭스(#5)**, **검수 4회(#6)**: 명시됨. PC NAS가 Rust(`pc_nas.rs`)라는 추가 증거로 "공통 Node HTTP + 네이티브 비밀저장(Keystore/DPAPI)"이 Tauri를 끌어오지 않는 최소안임에 동의.
- **업데이터**: `server.cjs:1477-1478,1514` — `GITHUB_REPO` 상수 하나가 check와 download URL을 둘 다 결정하고 `RISU_UPDATE_URL`은 check만 덮는다. Codex의 "둘 다 고정, 확인 URL만 override 금지"와 정확히 일치. Android는 `platformMap(1508)`에 없어 인앱 업데이트 대상이 아니므로 1차 "Android 업데이터 불필요"와도 일치. **0.9.72**: `GITHUB_REPO`가 minchopie로 바뀌면 upstream 태그와 비교되지 않으므로 1차의 충돌 우려는 철회한다. 빌드 직전 fork 태그 확인만 유지.
- **구앱 호환 보내기**: 1차에서 "보류"라 했으나, 사용자의 "기존 기능 모두 유지"로 범위가 분명하고 v1 코드는 가져오기용으로 어차피 남는다. Codex 판단을 따른다. 조건은 수정안에 이미 있는 대로 — 별도 옵션이 아니라 같은 보내기 화면에서 대상 capability로 형식이 정해지고 Bard 제외를 사전 표시. 사용자에게 재질문하지 않는다.
- **비공개 repo 이름 하드코딩**: "로컬 설정, 공개 기본값 없음"으로 해소.

## 2. 남은 차단 1건: "적용은 앱 서버 한 경로"가 증거와 어긋남

**근거**
- `characterPackage.ts:832-875`: 채팅 추가는 렌더러에서 `getDatabase()` → `importChatsToCharacter(..., 'append')` → `setDatabase(db)`로 끝난다. 채팅 본문의 정본은 클라이언트 메모리 DB이고 서버는 그 blob을 저장만 한다.
- `importTransaction.ts`: 저널·롤백도 클라이언트 주도(`deps.write/journal/removeOwners/cleanup`), owner 타입은 `'character' | 'module'` 뿐이다.
- `risubard-memory-save.ts:288-322`: Bard 쪽은 서버 파일계이며 `forkMemoryWorkspace` → 쓰기 → `completeMemoryWorkspaceFork({action:'finalize'})`의 forkToken 2단계 커밋이 **이미** 있다.
- `resolveMemoryWorkspace:217-224`: workspace 디렉터리가 `characterId + chatId`로 키되므로 새 `chat.id`가 확정돼야 최종 위치가 정해진다.

**문제**: 수정안 2절 마지막 "적용은 앱 서버 한 경로에서 journal+staging으로 처리해 chat/Bard workspace/slot/… 이 함께 복구"를 그대로 구현하면 서버가 DB blob을 디코드·수정하는 엔진이 새로 필요하고, 그렇게 써도 클라이언트의 다음 `setDatabase`가 덮어쓴다. 수정안 스스로 "별도 선형 갱신 엔진 없음", "ImportTransaction을 필요한 범위만 확장"이라 했으므로 문장끼리도 충돌한다. 구현자가 이 문장을 따르면 재작업이 확정이다.

**최소 수정(계획 문장 교체, 새 사용자 결정 불필요)**
1. 수신 적용을 **두 도메인 커밋**으로 명시: (a) 서버 — 받은 workspace·슬롯·페이지를 기존 fork staging(forkToken)으로 쓰되 finalize 보류; (b) 클라이언트 — `ImportTransaction`의 owner에 `'chat'`(characterId+chatId)을 추가하고 `importChatsToCharacter 'append'`로 새 `chat.id` 확정 후 DB 저장; (c) DB 저장 durable 확인 후 서버 finalize. 실패·재시작 시 미finalize fork와 `chat` owner를 기존 rollback으로 제거한다.
2. 순서 근거: workspace 이름이 새 `chat.id`에 의존하므로 (b)의 id 확정이 (a)보다 앞서거나, (a)를 임시 destination으로 staging 후 finalize 시점에 최종 chatId로 두는 방식 중 하나를 (b) 검수에서 택한다. 둘 다 기존 fork API 범위다.
3. "helper는 DB 직접 수정 안 함"은 그대로. "서버 한 경로"는 **"Bard 파일은 서버 한 경로, chat 레코드는 기존 클라이언트 import 경로"** 로 바꾼다.
4. 팝업 MUST: 재사용 대상은 `importPersonas/importChatsToCharacter/importGalleryToCharacter/importInlays` 내부 함수이지, `alertConfirm`(840-848)·`alertWait`(153)가 있는 `importPackageToCharacter` 래퍼가 아님을 명시한다.

## 3. 차단은 아니나 계획에 반영할 최소 수정

- **GitHub 8 MiB**: 수정안은 "기존 8 MiB 정책 유지, 초과는 실패+안내". 그런데 v2는 `chat.bin`·페이지·wiki까지 싣고 GitHub는 사용자 MUST 전송 수단이다. `protocol.ts:20-22`의 8 MiB는 manifest 가드이지 archive 한도가 아니다(주석). 수정: 8 MiB가 GitHub API 하드 한도인지 구 앱의 자체 한도인지 인벤토리(a)에서 확인하고, 자체 한도면 v2 표본 크기에 맞춰 재설정하거나 blob 단위 업로드(기존 "최신 1개" 규칙 유지)로 계획한다. "내용 축소 안 함"은 그대로. 사용자 질문 아님.
- **Node 순서**: 24 소스 빌드 실패 시 사용자 결정으로 가기 전 Node 22 LTS 소스를 한 번 더 시도(engines 최소값). 시간제한 유지.
- **중복 수신·캐릭터 매칭 키**: 중복 판정은 v1 `setId/revision/ancestors`(`protocol.ts:11-13`) + 로컬 적용기록(setId→로컬 chatId). 캐릭터 매칭은 `chaId` 우선, 없으면 이름 → 여러 개면 기존 선택 흐름. 전체 `.bin` 1회 이전이 `chaId`를 보존하는지에 따라 달라지므로 (b)에서 확정.
- **Node↔네이티브 비밀 통로**: "네이티브가 요청 단위로 Node 루프백 API에 토큰을 주입" 방향이면 Node가 Keystore/DPAPI를 당기는 새 IPC가 불필요하다. 설계 제안이지 요구가 아니다.

## 4. 미검증 gate (승인과 분리, 실기기·표본으로만 닫힘)

- **런타임**: 프리빌트 존재·라이선스, NDK 빌드 성공, `.node` 목록과 `server.cjs` 로드, 16 KiB 정렬, WebView `localhost` secure context·`crypto.subtle`, 백그라운드 생존/스트리밍 중단, 콜드스타트·APK 크기(TB710FU/SM-S938N).
- **데이터**: save-store 해시가 `protocol.ts` digest(64 hex)와 같은 알고리즘인지 — 같으면 슬롯 페이지를 `blobs/<hash>`로 그대로 싣고 `SavedFileEntry{path,hash,size}`를 v2 레코드로 재사용 가능. `chat.bin`에 원 chatId·messageId가 박혀 있을 때 리매핑된 chat에서 "슬롯 불러오기"가 동작하는지(`createMemorySaveSlot:306-310`은 `chatBytes`를 그대로 씀). `events.jsonl`·`chat.bin` 같은 비JSON 파일은 `records`가 아닌 `blobs`로만 실릴 수 있음(`protocol.ts:120`) — v2 설계에 반영. wiki 전송 패키지의 제목충돌 규칙이 chat workspace 수신과 무관한지. risuChat v2/`.risuplay v1`/`.bin` 읽기 실동작.
- **전송**: 새 패키지명에서 adb 접근 경로, Wi‑Fi 탐색 양방향, NAS 실연결, GitHub 실토큰(시험 자료만), v2 실제 크기 분포.
- **릴리즈**: Windows self-update 에셋명 `RisuBard-v<ver>-win-x64.zip` 규칙(`server.cjs:1513`) 준수, fork 태그 중복, public-boundary 패턴, 서명 개인키 미포함.

## 5. 한계

서버·클라이언트는 발췌만 봤다. §2의 "클라이언트 DB 정본" 결론은 `characterPackage.ts`·`importTransaction.ts` 패턴에서 나온 것이므로, 서버가 chat을 DB에 직접 넣는 기존 경로가 있다면 그 코드를 제시해 반박하면 된다. 그 경우에도 "클라이언트의 다음 저장이 덮어쓰지 않는가"는 답해야 한다. 도구·파일 변경 없이 텍스트로만 답했다.
