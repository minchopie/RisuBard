# Actual Fable 5.1 xhigh compatibility review 1

# RisuBard 포팅 독립 검토 (제공된 소스·테스트·로그만 근거)

## 총평

제공된 세 영역(로어북 깊이/정규식 키 수정, Android 전용 Gemini 마지막 model 턴 이어쓰기, Android 전용 Google 번역 직렬화·백오프·배칭)과 Android 백업 경로 보존 로직을 코드 흐름 기준으로 읽었습니다. 로어북 diff와 Gemini 정규화 자체는 제공된 테스트와 코드 읽기로 의도대로 동작한다고 판단합니다. 반면 Google 번역 포팅은 `translateHTML` 안에서 **확정적인 교착(hang)** 을 새로 노출합니다. 이는 네트워크나 Gate와 무관하게 Promise 흐름만으로 재현되며, 제공된 어떤 테스트도 이 경로를 건드리지 않습니다. Android 백업 경로는 서버 쪽 `DEFAULT_BACKUPS_DIR` 소스가 제공되지 않아 프로브 로그의 보고값만 확인 가능합니다.

아래에서 "확정"은 제공된 소스의 제어 흐름만으로 결과가 결정되는 항목, "미확정"은 외부 동작(Google/Gemini 응답, 제공되지 않은 모듈, 런타임 환경)에 따라 달라지는 항목입니다. 저는 도구를 쓰지 않았으므로 실행 결과가 아니라 정적 추론임을 전제로 읽어 주세요.

---

## 확정 결함

### A. Android + Google 번역에서 `translateHTML`이 영원히 끝나지 않음 (심각)

`needSuperChunkedTranslate()`가 이제 Android+`google`에서 true를 반환하므로 `translateHTML`의 "슈퍼청크" 경로가 기본 번역기에서 활성화됩니다. 이 경로의 구조는 다음과 같습니다.

`translateNodeText`는 슈퍼청크 모드에서 노드 텍스트를 `translationChunks` 마지막 배치에 밀어 넣고 `await prm`으로 **해당 배치가 flush될 때까지 대기**합니다. flush는 두 곳에서만 일어납니다. 하나는 *이후* 노드가 들어올 때 호출되는 `translateTranslationChunks(false, len)`이 누적 길이 5000 이상을 확인하는 경우이고(이때도 flush 대상은 *이전* 노드들이지 지금 대기 중인 노드가 아님), 다른 하나는 `await translateNode(dom.body)`가 **끝난 뒤** 호출되는 `translateTranslationChunks(true, 0)`입니다.

그런데 `translateNode`의 TEXT_NODE 분기에는 `if(promises.length > 10){ await Promise.all(promises); promises = [] }`가 있습니다. 12번째 텍스트 노드에 도달하면 앞선 11개 노드의 `translateNodeText` Promise를 기다리는데, 그중 공백이 아닌 노드가 하나라도 있으면 그 Promise는 flush를 기다리고 있고, flush는 트래버설이 끝나야 일어나므로 **상호 대기**가 됩니다. 누적 텍스트가 5000자 미만인 한(사실상 모든 일반 메시지) 어떤 flush도 선행하지 않습니다.

재현: Android 빌드(UA에 `RisuBardAndroid/` 포함), `translatorType === 'google'`(기본값), 메시지 HTML의 텍스트 노드가 12개 이상(예: `<em>`/`<strong>`/따옴표가 섞인 문단 2~3개면 충분)이고 총 텍스트가 5000자 미만 → `translateHTML` Promise가 resolve되지 않음. Gate 호출도, fetch도, 오류 알림도 없음. 대형 임포트 채팅을 번역하려는 포팅 목적 자체가 막힙니다.

두 번째 트리거는 더 짧습니다. `db.combineTranslation`이 켜져 있으면 `<p>` 요소에서 `await translateNodeText(newNode, true)`를 **순차적으로 await**합니다. 슈퍼청크 모드에서는 이 await가 첫 번째 `<p>`의 첫 문장에서 바로 flush를 기다리므로, 텍스트 노드 개수와 무관하게 첫 문단에서 멈춥니다.

이 두 결함은 같은 파일의 deeplX 경로에 원래부터 존재하던 구조이지만, 이번 포팅이 Android의 기본 번역기에 같은 구조를 적용함으로써 신규로 노출됩니다. `googleAndroidRetry.test.ts`는 `translate()`만 호출하고 `translateHTML`을 다루지 않으며, 62건 로그는 테스트 이름이 없어 세 번째 파일이 이 경로를 커버하는지 확인할 수 없습니다. 가장 우선 수정·재검증이 필요한 항목입니다.

### B. combineTranslation 경로에서 editdisplay 스크립트·마크다운 재적용 누락 (A 수정 후에도 남음)

슈퍼청크 분기는 `node.textContent = await prm; return`으로 조기 반환하므로 `reprocessDisplayScript === true`로 호출된 경우에도 `processScriptFull(..., 'editdisplay')`와 `applyMarkdownToNode`가 실행되지 않습니다. combineTranslation은 `getNodetextToSentence`로 인라인 마크업을 평문화한 뒤 번역 후 마크다운을 다시 입히는 설계인데, Android Google에서는 복원 단계가 사라져 번역된 문단의 강조/서식이 데스크톱 Google과 달리 소실됩니다. A의 교착 때문에 현재는 도달조차 못 하지만, 교착을 flush 보강 등으로 고치면 그대로 드러납니다.

### C. 폴백이 "원문"이 아니라 줄이 붙은 텍스트를 반환 (경미)

Gate가 null/비정상 응답을 돌려줄 때 `translateMain`의 `fallback()`은 `text`를 반환하는데, 이 `text`는 `runTranslator`가 `\n` 분할 후 **구분자 없이 이어 붙인** 청크입니다(`chunks[last][0] += texts[i]`). 슈퍼청크 배치에서도 `'a\n■\nb'`가 `'a■b'`로 바뀐 뒤 그대로 돌아오고 `split('■')`로 복원되므로 노드 매핑은 유지되지만, 노드 내부 단일 개행(예: `<pre>` 코드 블록)은 `'line1line2'`처럼 붙은 채 표시됩니다. 데스크톱은 네트워크 실패 시 예외가 전파되어 호출자가 원본 HTML을 유지하는 반면, Android 폴백은 변형된 텍스트를 노드에 써 넣습니다. 채팅 데이터는 건드리지 않고 표시만 영향받습니다.

---

## 미확정 위험

### 번역

Google `translate_a/single`이 `■`를 그대로 보존하는지, 앞뒤 공백을 넣는지, 문장 재배열 시 `■` 경계를 넘나드는지는 네트워크 검증이 없어 확인할 수 없습니다. 공백이 붙으면 `split[i]`가 trim 없이 노드에 들어가고, 개수가 어긋나면 "일대일 재시도" 경로가 노드 수만큼 Gate 요청을 발행해 250ms 간격으로 늘어집니다(이미 429로 차단된 상태면 즉시 원문). 또한 일대일 루프 후 두 번째 루프가 `split.length`만큼 `resolvers[i]`를 다시 호출하는데, `split.length > resolvers.length`면 TypeError가 Promise 실행자 안에서 발생해 unhandled rejection이 됩니다(기존 deeplX 구조와 동일).

`useExperimentalGoogleTranslator`가 켜진 경우 `translate.google.com/m` 경로는 `globalFetch`로 직렬화 없이 나가므로 버스트 억제가 적용되지 않습니다. 폴백 안내문이 요구하는 "번역 재시도" UI가 실제로 `translateHTML`을 재호출하는지는 제공 범위 밖입니다. Gate가 429 한 번에 60초 전역 차단되는 설계는 의도로 보이나, 사용자의 대화형 번역 요청도 같은 큐에 묶여 지연된다는 점은 인지해야 합니다.

### Gemini

`normalizePrivateMobileGeminiContents` 자체는 테스트와 코드로 의도대로 동작합니다. 남는 위험은 모두 Gemini 서버 동작에 의존합니다. (1) contents가 model 턴 하나뿐인 경우(시스템 프롬프트 + 프리필만 있을 때) `[model, user]` 순서를 Gemini가 받아들이는지. (2) 모델이 이어쓰기 지시문 자체에 반응("계속하겠습니다…")할 가능성. (3) 설계상 변화로, 툴콜 응답 병합 조건 `chat[len-2].role === 'model'`이 continuation 삽입 이후 더 이상 프리필 턴과 병합하지 않습니다. 이는 Android에서만 발생하는 동작 차이이며 테스트에 명시되어 있지 않습니다. (4) 마지막 model 턴이 서명(`thought/thoughtSignature`)만 있고 텍스트가 없는 경우에도 continuation이 붙는데, 그 요청이 유효한지는 확인 불가입니다. `fallBackGemini`의 `RESOURCE_EXHAUSTED` 무한 재귀(백오프 없음)는 기존 동작이며 이번 변경 범위가 아닙니다.

### Android 백업/런타임

서버 쪽 `DEFAULT_BACKUPS_DIR` 변경 소스가 제공되지 않았습니다. 제가 확인할 수 있는 것은 `runtime-probe.cjs`가 `/api/backup/server/path`의 보고값이 `user-data/backups`와 같다고 단언했고 에뮬레이터 로그에 `stableBackupDirectory: true`가 찍혔다는 점뿐입니다. 실제 백업 생성이 그 경로에 기록되는지는 프로브가 검증하지 않습니다.

`EmbeddedServer.start`의 보존 로직 `File(old, "backups").exists()`는 인스트루먼테이션으로 확인됐으나 다음은 미확정입니다. 보존된 `runtime/<hash>/backups`는 앱 UI나 복구 내보내기(`shutdown-recovery/*.bin`만 대상)에서 접근할 수 없고, 새 경로로 옮기는 마이그레이션 코드도 제공 범위에 없습니다. 즉 "보존"은 되지만 사용자는 꺼낼 수 없습니다. 과거 프로토타입의 `process.cwd()`가 `runtime/<hash>`가 아닌 하위 디렉터리였다면 `backups`가 다른 깊이에 있어 삭제됩니다. 서버가 시작 시 빈 `backups` 디렉터리를 만들었던 프로토타입이면 백업이 없어도 런타임 전체(수십 MB)가 영구 보존됩니다. 모두 결함이라기보다 설계 확인이 필요한 지점입니다.

---

## 로어북 변경 검토 (결함 미발견)

`slice(Math.max(0, length - depth))`는 올바른 수정입니다. 예전 코드는 `depth > length`일 때 음수 시작값이 뒤에서부터 세어져, 예컨대 메시지 3개·깊이 5면 `slice(-2, 3)`이 되어 **첫 메시지를 누락**했습니다. 테스트 `'needle', depth 4`(메시지 3개, 첫 메시지에 키)는 구 코드에서 실패하고 신 코드에서 통과하므로 회귀 검출력이 있습니다. NaN/음수 `@@scan_depth`에 대한 결과는 구·신 코드가 동일합니다.

정규식 분기는 `lastIndexOf('/')`로 소스와 플래그를 분리하도록 바뀌었습니다. 구 코드는 `'/needle/i'`를 `RegExp('/needle','i')`로 만들어 선행 슬래시를 리터럴로 요구했고, 두 번째 메시지부터는 이미 변형된 `arg.keys[0]`을 다시 분해해 `RegExp('', 'needle')`로 예외를 내며 false를 반환했으며, 플래그 없는 `'/needle/'`는 빈 플래그가 falsy라 아예 시도되지 않았습니다. 세 케이스 모두 테스트가 신 코드에서만 통과하므로 수정과 테스트가 대응합니다. 다만 `expect(entry.key).toBe(key)` 단언은 `fullLore`가 복제본이라 구 코드에서도 항상 참이므로, "키 변조" 회귀 검출은 이 단언이 아니라 두 번째 호출의 매칭 단언이 담당합니다.

변경되지 않은 기존 특성으로, 정규식 엔트리의 키 하나라도 `/`로 시작하지 않으면 함수 전체가 false, 정규식 분기는 소문자화·주석 제거를 거치지 않음, `exclude_keys_all`의 all 모드가 "모든 메시지×모든 키" 교집합인 점은 그대로입니다. 포팅 범위가 아니므로 지적에 그칩니다.

---

## 테스트·증거 평가

로어북 41건, Gemini 9건, Android 인스트루먼테이션 결과는 제공된 코드와 모순 없이 읽힙니다. Gemini 테스트는 `previewBody`만 통과하므로 `requestGoogle` 이후(툴콜 재귀, 스트리밍)의 continuation 처리는 코드 읽기로만 확인했습니다. Google 번역 로그는 테스트 이름 없이 집계만 있어 `translateHTML`/배칭 경로가 포함되는지 판단할 수 없고, 제공된 두 테스트 파일은 Gate 단위 동작과 `translate()`의 캐시 배제만 다룹니다. 이는 결함 A가 통과 로그에도 불구하고 살아 있는 이유입니다. 제공자 네트워크 주장이 없다는 전제는 소스와 일치합니다.

---

## 결론

로어북과 Gemini 정규화는 기존 요청 동작과 채팅 데이터를 건드리지 않으면서 의도한 수정을 달성합니다. Google 번역 포팅은 **A(교착)** 가 확정이며 Android 기본 설정에서 일반적인 메시지로 재현되므로, 이 상태로는 통합/UI 단계로 넘길 수 없습니다. 수정 방향은 코드 변경 범위이므로 여기서 다루지 않되, 검증 시에는 12개 이상 텍스트 노드와 combineTranslation 두 트리거를 모두 포함하는 `translateHTML` 단위 테스트가 필요합니다. Android 백업 경로는 프로브 보고값까지는 확인됐으나 서버 소스, 실제 백업 기록, 보존된 프로토타입 백업의 접근 경로는 추가 증거가 필요합니다.
