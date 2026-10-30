# RisuBard 포팅 재검토 (수정 후 소스·테스트·로그만 근거, 정적 읽기)

## 총평

이전 검토에서 확정으로 올린 A(12노드 교착), A-2(combineTranslation 교착), B(editdisplay/마크다운 누락), C(폴백 시 줄 결합), 그리고 미확정으로 올린 resolver 루프 TypeError는 **모두 제공된 소스에서 제거되었고**, `tmp/ports1-html-repro.log`가 수정 전 재현(4건 실패, 메시지가 각 결함과 정확히 대응), `tmp/ports1-html-fixed.log`와 `client-suite-ports2.log`가 수정 후 통과를 보여 코드 읽기와 모순이 없습니다. 수정된 번역 경로를 제어 흐름 기준으로 다시 따라간 결과 **새로운 확정 결함은 찾지 못했습니다.** 다만 "확정 수정의 부수 효과로 바뀐 동작"이 둘 있고, Android 백업 보존 조건에 대해 이전보다 더 강한 근거가 생긴 우려가 하나 있어 아래에 분리합니다. 네트워크·기기 증거는 여전히 비어 있으며 그 목록도 따로 정리했습니다.

증거 분류는 세 겹으로 읽었습니다. (1) **모의(mock)**: vitest + happy-dom, `fetch`/`globalFetch` 스텁, 가짜 타이머 — 번역 경로 전부가 여기에 속합니다. (2) **에뮬레이터**: x64 API 에뮬레이터에서 APK11이 띄운 임베디드 서버에 대해 별도 Node 프로세스(`runtime-probe.cjs`)가 HTTP로 검증한 것 — 서버 라우트와 파일시스템 증거이지 WebView/UI 증거가 아닙니다. (3) **네트워크**: Google/Gemini 실제 호출은 주장되지 않았고 소스상으로도 없습니다.

---

## 수정 경로 확인 (이전 확정 결함 해소 여부)

**A — 11노드 경계 교착.** `translateNode`의 TEXT_NODE 분기가 `promises.length > 10`에서 `await translateTranslationChunks(true, 0)`을 먼저 실행한 뒤 `await Promise.all(promises)`로 들어갑니다. 강제 flush는 현재 배치를 동기적으로 캡처하고 새 배치를 push한 뒤 `translate()`를 기다리므로, 대기 중인 11개 `translateNodeText`의 resolver는 flush 완료 시점에 모두 호출됩니다. 12번째 노드는 새 배치로 들어가 최종 `translateTranslationChunks(true, 0)`에서 처리됩니다. 교착 조건이 사라졌습니다. 23노드 이상(경계 두 번)도 같은 구조가 반복되므로 코드상 문제없습니다. 길이 트리거(5000자)로 이미 flush되어 현재 배치가 비어 있을 때 경계 flush가 오면 빈 배치를 하나 더 push하고 `!text`로 반환하는데, 이후 `Promise.all`이 떠 있는 길이-flush의 resolver를 통해 완료되므로 무해합니다.

**A-2 — combineTranslation 순차 await.** 슈퍼청크 모드에서는 `promises.push(translateNodeText(newNode, true))`로 바뀌어 flush 전 대기가 없어졌습니다. 비슈퍼청크 모드(데스크톱 Google/DeepL)는 기존 `await` 그대로여서 데스크톱 동작이 유지됩니다.

**B — editdisplay/마크다운 누락.** 슈퍼청크 분기가 `translated = await prm`으로 끝나고 조기 반환하지 않으므로 `reprocessDisplayScript === true`면 `processScriptFull(..., 'editdisplay', chatID)`와 `applyMarkdownToNode`가 그대로 실행됩니다. 테스트 2가 `chatID=7`로 호출 인자까지 단언합니다.

**C — 폴백 반환값.** `runTranslator`가 `if (transientFallback) return text`로 **원래 입력 문자열**을 캐시 없이 반환합니다. 배치 쪽에서는 `translated === text` 비교로 노드별 원문을 그대로 resolve하므로 `<pre>` 내부 개행이 보존됩니다. 테스트 3이 `'  first\nsecond\n\nthird  '` 정확 일치와 `<pre>first\nsecond</pre>` 보존을 모두 단언합니다. 뒤따르는 `if (!transientFallback)` 블록은 이제 항상 참이라 중복이지만 무해합니다.

**TypeError — 구분자 초과.** 불일치 시 노드별 재번역 후 `return`하고, `split.forEach`는 길이가 같을 때만 실행되므로 `resolvers[i]`가 undefined인 호출이 없습니다. 재번역 도중 예외가 나면 catch가 모든 resolver를 원문으로 다시 호출하는데, 이미 resolve된 Promise에 대한 재호출은 no-op이라 안전합니다.

**실패 배치 전파.** `translationError ??= error` 후 resolver를 전부 원문으로 settle하고, `translateHTML` 말미에서 `Promise.all` 이후 throw합니다. `translationError` 대입이 resolver 호출보다 앞서므로 노드가 깨어났을 때 오류가 이미 기록되어 있습니다. Android Google은 `translateMain`이 던지지 않고 폴백하므로 이 경로는 사실상 deeplX(그리고 DeepL API 응답 형태 이상으로 `result.startsWith`가 던지는 경우)에서만 활성화됩니다. 테스트 6이 deeplX로 이를 덮습니다.

executor 안에서 `translateTranslationChunks(false, len)`을 await 없이 호출하는 떠 있는 Promise는 그대로지만, 본문이 try/catch로 감싸져 있고 try 바깥 코드는 배열 push/join뿐이라 unhandled rejection 경로가 사실상 없습니다.

---

## 확정 결함

제공된 수정 소스의 제어 흐름만으로 결정되는 **새 결함은 없습니다.** 다만 아래 두 항목은 결함은 아니지만 "확정 수정 외 동작 유지" 조건에 비추어 사용자가 알고 승인해야 하는 **확정된 동작 변화**입니다.

**1. deeplX(데스크톱 포함) 동작이 함께 바뀜.** `needSuperChunkedTranslate()`가 deeplX에도 참이므로 (a) 텍스트 노드 12개 이상이면 11개 단위로 배치가 잘려 요청 수가 늘고, (b) combineTranslation이 배치 경유로 바뀌며, (c) 구분자 초과 시 TypeError 대신 노드별 결과가 유지되고, (d) 배치 오류가 노드 settle 후 전파됩니다. 이전 검토의 코드 읽기 기준으로 (a)(b)는 원래 교착이었고 (c)는 예외였으므로 "고장→동작"의 변화이지만, deeplX 수정 전 재현 로그는 제공되지 않았습니다(repro 로그는 Android Google만). 공유 경로 수정의 의도된 부수 효과로 수용할지 명시적으로 결정하시기 바랍니다.

**2. 데스크톱 Google의 빈/비정상 응답 처리.** `if (!Array.isArray(res?.[0]) || res[0].length === 0) return mobileGoogle ? fallback() : text`는 데스크톱에서도 원문을 반환하고 세션 캐시에 적재합니다. 수정 전 데스크톱 소스는 제공되지 않아 비교 확정은 못 하지만, 일반적인 상류 구현(`res[0].map(...)`)이라면 비배열은 TypeError 전파, 빈 배열은 빈 문자열 캐시였을 것입니다. 지금 동작이 덜 해롭긴 하나 "현재 번역기 동작 유지" 범위를 넘는지 확인이 필요합니다.

---

## 미확정이지만 근거가 강해진 우려

**프로토타입 런타임 보존 조건이 과도할 가능성.** 제공된 서버 소스는 시작 시 `if(!existsSync(backupsDir)) mkdirSync(...)`로 백업 디렉터리를 **무조건 생성**합니다. 프로토타입 서버도 같은 코드였다면(그리고 `embedded.enabled`가 없어 `process.cwd()/backups`를 썼다면), 백업을 한 번도 만들지 않은 프로토타입 런타임에도 빈 `backups`가 존재하고, Kotlin의 `File(old, "backups").exists()`가 참이 되어 해당 런타임(수십 MB)이 영구 보존됩니다. 프로토타입 소스가 없어 확정은 아니지만, 현재 소스가 그 패턴을 보여주므로 이전보다 개연성이 높습니다. `risu-backup-*.bin` 존재 여부로 판정하면 해소되나 코드 변경이므로 여기서는 지적에 그칩니다.

ProcessBuilder `.directory(runtime)`가 `runtime/<hash>`이므로 `process.cwd()/backups`는 보존 검사의 깊이와 **현재 소스 기준으로** 일치합니다. 프로토타입 Kotlin도 같은 cwd였다는 전제는 제공 범위 밖입니다.

---

## 미확정 위험 (네트워크·기기·미제공 소스)

### 번역 (전부 모의로만 검증됨)

- Google `translate_a/single`이 `■`를 개수 그대로 보존하는지는 여전히 네트워크 검증이 없습니다. 보존되지 않으면 **모든 배치**가 노드별 재번역으로 떨어져 배치당 요청 1회가 낭비되고 11노드 배치는 11회 × 250ms로 늘어집니다. 앞뒤 공백이 붙어 돌아오면 trim 없이 노드에 들어갑니다(일반 흐름에서는 시각적 영향 작음, `<pre>`는 영향).
- **GET URL 길이**: 길이 트리거로 5000자 이상이 한 요청에 실리는 경우(긴 문단 몇 개로 구성된 메시지)는 Android에서만 새로 발생합니다. 데스크톱은 노드 단위로 보내므로 이 크기에 도달하지 않습니다. 영문 5000자도 인코딩 후 8KB 근처이고 CJK나 reverse 번역이면 훨씬 커져 414/400 가능성이 있습니다. 실패 시 4xx는 Gate를 차단하지 않고 `!f.ok`로 폴백(원문)하므로 치명적이진 않지만 해당 메시지는 번역되지 않습니다.
- `navigator.userAgent`에 `RisuBardAndroid/`를 넣는 WebView 설정 소스는 제공되지 않았습니다. 이것이 빠지면 Android가 데스크톱 경로(직접 fetch, 무직렬화)로 조용히 떨어지며, 테스트는 UA를 스파이로 강제하므로 이를 검출하지 못합니다.
- WebView에서 CORS 헤더 없는 429가 실제로 TypeError로 나타난다는 전제, 60초 차단 후 UI의 "번역 재시도"가 `translateHTML`을 재호출하는지, `useExperimentalGoogleTranslator`의 `translate.google.com/m` 경로가 Gate를 우회하는 점은 이전과 동일하게 미확정입니다.
- `console.log(html)`이 `translateHTML` 진입마다 메시지 HTML 전체를 찍습니다. 상류 기존 코드이지만 Android WebView 콘솔은 기본적으로 logcat으로 가므로 Kotlin 주석("bodies를 logcat에 보내지 않음")의 취지와 어긋납니다. 변경 범위 밖이라 지적만 합니다.

### Android 백업/런타임

- `embedded.enabled`와 `savePath` 정의가 제공되지 않았습니다. 프로브가 `/api/backup/server/path === userData/backups`를 단언해 통과했으므로 에뮬레이터 환경에서는 기대값과 일치하지만, 정의 자체는 보지 못했습니다.
- `readBackupsDirConfig()`가 KV `config/server-backup-path`를 기본값보다 우선합니다. 과거 프로토타입에서 이 키가 `runtime/<hash>/backups`류 절대경로로 저장되어 있었다면 `mkdirSync(recursive)`가 옛 런타임 아래에 디렉터리를 재생성하고 보존 조건까지 만족시킵니다. `isManagedBackupPath`는 `backups`를 관리 경로로 보지 않아 이를 막지 않습니다. KV 내용은 확인 불가.
- 프로브는 백업 파일만 삭제하고 `inlay/runtime-probe-image`와 메모리 위키 문서(`runtime-probe-character`)는 사용자 데이터에 남깁니다. 에뮬레이터에서는 무관하지만 실기기에서 같은 프로브를 돌리면 테스트 흔적이 남습니다.
- 사용자 기술대로 APK11은 번역 수정이 포함되지 않은 빌드이고, 실기기 설치는 보류 상태이며, 보존된 프로토타입 백업의 마이그레이션/접근 UI는 없습니다. 에뮬레이터 로그(`serverBackupWritten: true`, 반환 파일명이 사전 목록에 없음, stat 크기 = 보고 크기 > 0)는 **서버 저장 라우트가 user-data/backups에 실제로 기록함**을 증명하는 범위까지입니다. 앱 UI에서의 백업 흐름은 증명되지 않았습니다.

### Gemini

이번 제출에 변경이 없으므로 이전 검토의 미확정 항목(단일 model 턴 순서, 이어쓰기 지시문 반응, 툴콜 병합 조건 변화, 서명만 있는 턴)이 그대로 남습니다.

---

## 테스트·증거 평가

**HTML 테스트 6건은 각각 이전 결함에 정확히 대응**하고, `settled()`가 10초 가짜 시간 안에 settle을 단언하므로 교착을 실제로 검출합니다(repro 로그가 이를 증명). 아래는 남은 커버리지 공백입니다.

- combineTranslation의 **다중 문장(`<br>` 재구성) 경로**(`sentences.length > 1`)와 `processedTranslated !== translated`일 때의 **노드 교체 경로**는 테스트되지 않았습니다. 코드 읽기로는 문제없으나 배치 지연 뒤 `replaceChild`가 일어나는 타이밍은 실행 검증이 없습니다.
- 경계 flush 두 번 이상(23노드+), 길이-flush 직후 빈 배치에 경계 flush가 겹치는 경우, 노드 텍스트 자체에 `■`가 포함된 경우는 직접 단언되지 않았습니다.
- Android Google에서 `translationError` 경로는 구조상 도달하지 않으므로 deeplX 테스트가 유일한 커버이며, 이는 곧 위 "동작 변화 1"이 테스트로 고정되었음을 뜻합니다.
- `ports1-html-fixed.log`는 파일명 없이 4파일/68건 집계만 있습니다. 전체 스위트 4709건 통과와 HTML 테스트가 포함된 485파일 구성은 일치하므로 신뢰하되, 어떤 파일이 68건에 들어갔는지는 로그로 확인할 수 없습니다.
- `googleAndroidRetry.test.ts`의 `doingChat: {}` 모의는 `translate()`만 쓰므로 괜찮지만 `translateHTML`을 호출하면 `get()`에서 실패할 형태입니다. 현재 용도에는 영향 없습니다.
- 타입체크 0오류/8경고(BardPainterTools CSS)는 이번 변경과 무관합니다.

---

## 결론

이전 검토의 확정 결함 네 건(A, A-2, B, C)과 TypeError는 제공된 소스에서 해소되었고, 수정 전/후 로그가 이를 뒷받침합니다. 수정된 `translateHTML`·`runTranslator`·`translateMain` 경로를 다시 읽어 **새 확정 결함은 발견하지 못했습니다.** 승인 전 명시적으로 결정할 것은 deeplX와 데스크톱 Google 빈 응답 처리의 동작 변화 두 가지이고, 코드 변경 없이 넘기기 어려운 설계 확인 사항은 빈 `backups`에 의한 과보존 가능성입니다. 네트워크 측(`■` 보존, GET URL 길이, WebView UA/CORS 동작)과 기기 측(번역 수정이 포함된 APK, 실기기, UI 경유 백업, 프로토타입 백업 접근)은 증거가 없으며, 이 검토는 그 공백을 메우지 않는 범위 한정 코드 검토입니다.
