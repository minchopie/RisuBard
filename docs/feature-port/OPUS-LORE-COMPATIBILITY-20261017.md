# RisuBard/MGE 로어 구조 — 실제 Opus 공동 검수

2026-10-17. 실행 명령은 실제 Claude Code의 `--model claude-opus-5-5 --effort xhigh`이며 응답의 modelUsage도 `claude-opus-5-5`로 확인했다. 모델 본문이 자신의 effort 값을 확인할 수 없다고 밝힌 것과, 실행기가 xhigh를 지정한 사실을 구분한다. 도구·MCP·훅은 끄고 코드 발췌/공개 카드 구조/합성 시험/비밀값을 제외한 설정 통계만 전달했다. 실제 DB·개인 대화·자격정보는 보내지 않았다.

1차 검수는 조건부 승인과 인과관계·증거 범위 정정을 요구했다. 예산만의 효과라는 해석을 철회하고 12조합 시험을 추가했다. 카드 가져오기에서 저장 요청 경계까지의 설정 보존 검사와 기존 Grimoire 메타데이터 이행 필요도 보완했다. 제품·기기·카드 수정/배포 승인으로 해석하지 않는다.

## 1차 실제 응답 원문

# Cross-review: RisuBard/MGE lore architecture assessment

**Reviewer:** Opus 5.5 (`claude-opus-5-5`). I cannot see my own effort setting, so I cannot attest to "Extra/xhigh." This review covers only the supplied payload. I ran nothing.

**Verdict:** The plan is approved with revisions. The facts mostly hold, but finding A's causal story is incomplete and the word "restore" is wrong.

## Confirmed mistakes in our reasoning

**1. A conflates budget with other loreSettings effects. (Proven, high)**
- Both replay runs used the same lore and query. Only the `loreSettings` object changed.
- "World: Ares, god of fighting" was selected at 800 but absent at 64000.
- At 64000 everything activated fits (about 10.5k tokens), so raising the budget cannot drop Ares. A non-budget parameter changed activation: recursion, matching mode or depth.
- The mock DB also leaves global recursive and matching settings undefined, so this was not a faithful replay of the device's globals.
- "1/19 because of 800" is therefore mostly true but unproven as the sole cause. It needs ablation.

**2. The pre-patch state was probably already incomplete. (Inference, high)**
- Pre-patch, the effective budget was the global 8000, not the card's 64000, because character `loreSettings` were null.
- The 19 always-entries total about 10,247 raw tokens (o200k) for release 1.2.27 and about 10,472 for candidate 1.3.0, more than 8000.
- The likely root cause is the missing per-character settings, which predates the reset. The reset made it much worse.
- This is untested at 8000 and the real tokenizer differs. Be candid that the earlier verification also missed this.

**3. "Restore original loreSettings" is a misnomer. (Proven by snapshot)**
- There is no device original; it was null before the patch. This step *applies* the card values for the first time.
- The test builds the character from AST-extracted `convertCharbook` output. That proves the converter emits settings, not that the app's real import/update path persists them.
- Since the device lacks them, an import or update path may drop them. A 1.3.0 update could repeat the loss.

**4. Only two global fields were compared before and after the reset. (Gap)**
- A "SETTINGS ONLY" reset may have reverted other globals too.
- Restoring global 8000 affects other characters, so it is a separate decision from per-character settings.

**5. E understates Wiki activity. (Proven in the snapshot only)**
- The snapshot has `risuBardAutoWikiEnabled: true`. Life's status is unknown.
- `resolvedRisuBardSettings(currentChat)` means per-chat overrides may differ from globals.

**6. C misses that the device already holds 749 lossy metadata records. (Proven by inventory)**
- Viewing the Grimoire tab persists `bardLore` metadata via `ensureBardLore`.
- Ticking the checkbox would use that stored keyed/retrieve mapping immediately.
- Any adapter must rebuild existing metadata, not just change future upgrades.

**7. C's budget point holds beyond the default.**
- 10,247 raw tokens also exceed the device's saved `maximumTokens` of 10000 (o200k measure, small margin, real tokenizer unknown).

## Per-finding status

**A — mechanism confirmed, attribution needs revision (see 1–3).**
- Severity: high, if the live device matches the snapshot (unverified). World-foundation lore would be missing every turn.

**B — accurate.**
- Note that the 4 non-regex entries are exactly 4 of the always-entries.

**C — confirmed from source.**
- `activationFor` ignores `alwaysActive`.
- `directMatch` does a substring test with no `useRegex` branch.
- Sparse scoring is limited to `retrieve` (line 181). Keyed regex entries are therefore unreachable unless linked, and links are empty.
- `splitAliases` splits on commas, so regex such as `{1,3}` would be fragmented.
- The query is Korean while lore bodies are English. Korean aliases appear to live in the regex keys, so sparse retrieval cannot substitute for regex evaluation.
- Severity: high, if Grimoire is enabled. The loss is silent, with no error, until `required` mapping exists.

**D — client-boundary claim confirmed.**
- `buildBoundedNarrativeInquiryFallback` source was not supplied. Only its test output and the server's `slice(-4096)` are shown.
- The synthetic envelope (about 6,000 chars) may be larger than real envelopes, and when the fallback runs is unshown.
- Inference: the main path applies `editprocess` scripts, while memory projections use raw `message.data`. That asymmetry would explain why the main request is clean but the Wiki is not.
- Severity: medium. It is conditional on real envelope length (roughly ≥3–4k chars at the message tail) plus the fallback triggering.

**E — sound as design guidance.**
- `getLoreBooksMain` reads `globalLore` by exact `comment`, independent of `bardLore` mode. Lua lookups survive Grimoire, but any title rewrite breaks them.
- Main history is trimmed to 12 messages (`risuBardResponseMessageCount`), so memory ownership materially affects continuity.

## Revised plan (proposed, not applied)

**0. Read-only preflight.**
- In the normal app UI, record:
  - version
  - global `loreBookToken`/depth/recursive/matching
  - MGE `loreSettings` and `bardLore.mode`
  - Auto-Wiki and Life state
  - per-chat overrides
- Diff against the snapshot.
- Export a character + settings backup. Delete nothing.

**1. Hermetic ablation (no device).**
- Grid: budget {800, 8000, 64000} × recursive {global, false} × depth {4, 5}, using the snapshot's real global values.
- Report always-coverage, plus where Ares and Sanctavel come from.

**2. Trace the real import/update path.**
- Check whether it persists `char.loreSettings` for 1.2.27 and 1.3.0, in a hermetic test.

**3. User decisions, kept separate.**
- (a) Apply card `loreSettings` (64000/4/false) to MGE via the UI.
- (b) Whether to restore global 8000.
- (c) Review the full key-level diff of globals before and after the reset, with secrets redacted.
- Keep legacy mode, leave the Grimoire box unchecked, and add a user-facing note not to tick it yet.

**4. Verify the actual request manifest.**
- Use prompt preview or a request log. Confirm all 19 always titles plus the scene entry appear, with runtime-tokenizer counts and total context under `maxContext`.
- If verification needs an online call, get explicit consent first.
- Claim only "request contains X," not "play quality fixed."

**5. Adapter (separate code review, later).**
- Map `alwaysActive` to `required`.
- Evaluate regex honoring `useRegex` and flags, with no comma-splitting.
- Preserve selective/`secondkey` semantics.
- Migrate stored metadata, including handling stale `sourceHash`.
- Preserve `comment` strings and IDs.
- Run a preflight that blocks enabling in the UI rather than throwing at request time.
- Set the hard limit at or above runtime-tokenized required tokens plus headroom.
- Any generated summaries or index-only text must follow CLAUDE.md's lore-style rule: no meta disclaimers in the card.

**6. Wiki.**
- First measure real MGE_STATE lengths (length only) and the fallback trigger conditions.
- Then strip the envelope from inputs only, at one boundary (client projection), mirroring Life 6.9.
- Add prose-retention tests. Never modify stored messages.

**7. Memory authority A/B.**
- Defer it, and get approval because online calls cost money.

**Not approved:** device or card writes, enabling Grimoire, a full fact-check, or any end-to-end success claim.

## 2차 실제 응답 원문

## RisuBard/MGE 2차 교차 검수 (Opus 5.5, 읽기 전용)

**범위:** 이번 payload에 들어 있는 소스 발췌, 시험 코드, 결과 JSON, 로그, 정정 보고서만 검토했다. 도구 실행이나 재현은 하지 않았다. 내 노력 설정(xhigh)은 스스로 확인할 수 없다. 로어 사실 전수 검사, 실기기 현재 상태, 모델 플레이 성공은 판단 범위 밖이다. 이 검수는 릴리즈나 기기 적용을 승인하지 않는다.

### 판정: 정정된 핵심 결론은 대체로 근거가 있다

- **소스로 증명된 것**
  - 런타임 재귀는 `char.loreSettings?.recursiveScanning ?? true`로 정해진다. 매칭도 캐릭터 필드로만 정해진다(195–203). 따라서 하니스에서 전역 재귀/매칭을 빠뜨린 것은 결함이 아니다.
  - 기존 경로의 예산 필터는 `alwaysActive`를 우대하지 않는다(738–753).
  - Grimoire의 `maxEntries`는 문맥 항목에만 적용된다(275).
  - Bard 모드는 `characterLore`를 선택 결과로 통째로 교체한다(159).
- **합성 실행으로 증명된 것**
  - 12조합 표는 원자료와 일치한다.
  - 8,000에서는 재귀와 무관하게 상시 13/19가 선택된다. "패치 전부터 부족했다"는 정정이 지지된다.
  - 64,000+재귀에서 14/19가 선택된다. "예산만의 문제"라는 귀속은 반증됐다.
- **범위 내에서 증명된 것:** 공개 가져오기 함수가 두 카드의 64000/4/false 설정과 749항목을 저장 호출 시점까지 유지한다.
- **적절한 정정:** '복원' 대신 '적용'이라는 표현, 이전 저장 검증의 한계 인정, 로컬 AI 종료 범위(Offline 앱·데이터·내장 Node 보존).

### 남은 실질적 문제

1. **A 제목이 여전히 예산 단독 귀속이다.** "로어 예산이 지나치게 작음"을 본문과 맞게 "캐릭터 `loreSettings` 부재 → 예산 부족 + 기본 재귀 확장"으로 고쳐야 한다. 근본 원인 후보는 전역 800이 아니라 설정 부재다.

2. **장면 로어 누락이 보고되지 않았다.**
   - 원자료에서 `Region: Sanctavel`은 800, 8,000, 64,000+재귀에서 모두 빠진다. 64,000+재귀꺼짐에서만 선택된다.
   - 표가 상시 19개만 세기 때문에 직접 매칭된 장면 로어의 손실이 가려진다.
   - 패치 전 상태(8,000/재귀 기본값)에서도 질의한 지역 로어가 없었다. 이는 A의 심각도를 높인다(합성 입력 한정).

3. **64,000+재귀에서의 탈락 기전은 강한 추론일 뿐이다.**
   - 활성 집합의 토큰 합과 탈락 사유를 기록하지 않았다.
   - 행렬은 `matchingMode`를 비워 두었다(카드는 `partial`). 매칭과 `maxRecursionSteps`를 분리하지 않은 것이다.
   - 19개 결론은 별도의 카드 설정 대조군이 보강한다. 다만 "64,000/꺼짐 행 = 카드 설정"으로 서술하면 안 된다.

4. **C에 실기기 근거가 없다는 점을 명시해야 한다.**
   - `snapshot-settings.json`의 `mgeEnvelopeLengths.count`는 두 시점 모두 0이다. 실제로 봉투가 없는지, 측정 패턴이 실제 카드 형식과 다른지 확인해야 한다. 그 전까지 C는 "소스상 경계, 기기 사례 미관측"으로 표기해야 한다.
   - 1690–1692의 `reason` 대입은 발췌 밖의 상위 분기(current-state-empty/source-changed) 안에 있음을 시사한다(추론). 따라서 "실제 호출 조건 포함"은 부분적인 주장이다.
   - `loadNarrativeInquiry`가 `fallbackInput`을 언제 쓰는지는 공급되지 않았다.
   - 블록이 실행될 때 확실히 쓰이는 것은 `retrievalRecentContext`(최근 4개 메시지, 임베딩 검색)다.

5. **가져오기 시험은 신규 CHARX 경로만 다룬다.**
   - `convertCharbook`은 세 필드가 모두 있어야 설정을 만든다(1094–1096).
   - 다음 경로가 설정을 잃는지는 1.3.0 배포 전 핵심 미확인 사항이다: 기존 캐릭터 업데이트/교체, 구 USB DB 이행, PNG/JSON 가져오기.
   - 가져온 `bardLore` 상태도 검사하지 않았다.

6. **특성화 시험임을 표기해야 한다.** 가정이 반증된 뒤 기대값을 관측값에 맞췄다. 따라서 "8개 통과"는 독립 확인이 아니라 회귀 고정이며, 근거는 원자료 행렬이다.

7. **이번 payload로 확인할 수 없는 주장들:**
   - 전역 변경 키 목록
   - Life 6.9 필터 범위
   - `nativeV2Analysis`/`prepareContext`
   - `database.svelte.ts:166`
   - GitHub 커밋과 카드 해시
   - 1.2.26→1.2.27 동일성
   - 저장된 Grimoire 상한 10,000
   - 인용 오류: 깊이를 읽는 줄은 `lorebook.svelte.ts:94`가 아니라 95다.

**참고:** 스냅샷의 MGE 캐릭터/채팅 모듈 수는 0이다. 그 저장본에서는 모듈 로어 모의의 영향이 작았을 가능성이 있다. 다만 전역 모듈과 Life 활성 여부는 여전히 미확인이다.

### 최소 후속 우선순위

1. **보고서 문구 정정**(1–4, 6, 7 항목): 비용이 들지 않고, 결론의 과장을 막는다.
2. **온라인 일반판 읽기 전용 사전 점검:** 기기 쓰기 없이 다음을 확인하고 백업만 한다.
   - MGE `loreSettings`
   - 전역 예산/깊이
   - 채팅별 재정의
   - 프롬프트 미리보기에 상시 19개와 장면 로어가 들어가는지, 실제 토크나이저 기준 합계
3. **사용자 결정 후:** 해당 캐릭터에만 카드 설정을 적용하고, 요청 매니페스트를 다시 확인한다. 전역값 변경은 별건으로 다룬다.
4. **1.3.0 배포 전:** 업데이트/교체 경로의 `loreSettings` 보존을 밀폐 시험한다.
5. **Wiki 필터 검토:** 실제 봉투 측정 패턴과 상위 분기 조건을 먼저 확인한 뒤, Wiki 입력 사본 필터를 검토한다.
6. **보류:** Grimoire 어댑터와 기억 A/B 비교.

## Codex 최종 대조·반영

- 결론은 핵심 근거 지지이며 무결함/릴리즈/실기기 승인으로 표현하지 않는다. 예산+재귀 제목, 산크타벨 지역 포함 여부, 각 탈락 사유를 직접 추적하지 않은 한계, 특성화 검사라는 성격을 반영했다.
- 실제 코드에서 미지정 매칭은partial, 최대재귀는0이므로 행렬에서 생략한 두 값은 카드와 유효값이 같다. 설정 객체 전체가 같다는 주장은 하지 않는다.
- 봉투0개 통계는 캐릭터 메타데이터의 chat.message 배열이 없는 상태를 센 결과였다. 실제 메시지 파일을 조사하지 않았으므로 기기에 봉투가 없다고 결론 내릴 수 없다. 소스/합성 경계 시험으로 한정했다.
- 상위 조회 조건은 서사문맥 opt-in 및 prepareContext 결과의null아님을 확인했다. 서버 fallback 실제 채택·모델 오작동은 미검증이다.
- 기존 업데이트/교체·USB DB 이행·PNG/JSON 전체 경로와 가져온bardLore상태/기기재시작은 이번 가져오기 검사로 입증하지 않았다. 설정 부재 시작 경로는 미확인이다.
- GitHub 커밋/카드 해시/원문 동일성/공식 문서/보조 소스는 Codex의 별도 조회 근거다. 모든 근거를 Opus가 독립 재현했다고 주장하지 않는다. 원문은 해석 대상이며 실제 앱/기기 수정에 대한 권한으로 취급하지 않는다.

두 호출 모두is_error=false,modelUsage=claude-opus-5-5. 실행기--effort xhigh. 최종 제품/카드 변경 없음.
