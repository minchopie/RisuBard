# RisuBard 포팅 후속 재검토 (R2 대응분, 정적 읽기)

## 총평

R2 대응에서 바뀐 네 곳(데스크톱 Google 형상 검증의 Android 한정, `EmbeddedServer`의 빈 `backups` 처리, `makeLuaFactory` 생성자 옵션, MainActivity UA 확인)을 제공 소스로 다시 따라갔고, 각각 R2가 요구한 방향과 일치함을 확인했습니다. deeplX 공유 경로 수정은 사용자 결정으로 수용된 것으로 읽었으며 새로 지적할 내용은 없습니다.

다만 이번에 번역 경로를 다시 읽으면서 **이전 두 차례 검토와 R2 대응 모두가 놓친 소스상 결함을 하나 찾았습니다.** `PrivateMobileGoogleTranslateGate`가 기본 생성 시 네이티브 `fetch`를 인스턴스 속성에 담아 메서드 호출 형태로 부르는데, Chromium 계열(Android WebView 포함)에서는 이 호출이 `Illegal invocation` TypeError를 던지고, Gate의 catch가 이를 "네트워크 실패"로 삼켜 **Android Google 번역이 항상 원문 폴백**으로 끝나게 됩니다. 모든 현재 테스트는 `fetch`를 `vi.fn`/주입 함수로 대체하므로 구조적으로 이를 검출하지 못합니다. 아래 "확정 결함" 절에서 근거와 반증 조건을 분리해 적었습니다.

증거 계층은 이전과 같습니다. 번역 쪽은 전부 모의(vitest + happy-dom, 가짜 타이머, 스텁 fetch), Android 쪽은 APK11 에뮬레이터 프로브(번역 수정 미포함)이며 빈-백업 instrumentation은 아직 실행되지 않았습니다. 실제 Google/Gemini 호출, 실기기, UI 경유 흐름은 증거가 없습니다.

---

## R2 대응 항목별 확인

**1. deeplX 공유 경로.** `needSuperChunkedTranslate()`가 deeplX와 Android Google을 같은 배치 경로로 보내는 구조는 그대로이고, 교착·resolver 초과·오류 settle 수정이 공유된다는 R2 설명은 소스와 일치합니다. 데스크톱 deepl(공식 API)은 `isExpTranslator`에는 들지만 배치에는 들지 않아 노드 단위 `translate()` 경로가 유지됩니다. 수용 결정으로 기록하고 더 다루지 않습니다.

**2. 데스크톱 Google 형상 검증.** 현재 조건은 `(mobileGoogle && !Array.isArray(res?.[0])) || !res[0] || res[0].length === 0`입니다. 데스크톱에서 `[]`(missing)와 `[[]]`(empty)는 원문 반환, `[{}]`(truthy 비배열)는 `res[0].map`에서 TypeError 전파로, 추가된 세 테스트의 단언과 제어 흐름이 정확히 대응합니다. 데스크톱은 `onFallback`이 호출되는 경로가 전혀 없어(`!f`는 fetch 응답에서 항상 거짓, json 실패는 재throw, 형상 실패는 `text` 직접 반환) 세션 캐시 적재 동작도 그대로입니다. 다만 "상류 64ebfb23이 이미 이렇게 동작했다"는 R2의 전제는 상류 소스가 제공되지 않아 **여기서는 검증 불가**이며, 세 테스트는 상류 동등성을 증명하는 것이 아니라 현재 동작을 고정하는 테스트입니다.

**3. EmbeddedServer 빈 `backups`.** `if (backups.exists() && backups.list()?.isEmpty() != true) return@runCatching`의 분기를 모두 따져보면: 존재+비어있지 않음 → 보존, 존재+`list()==null`(읽기 불가, 또는 `backups`가 디렉터리가 아닌 파일, 또는 외부로 향한 심볼릭 링크 등) → 보존, 존재+빈 배열 → 삭제 진행, 미존재(끊어진 링크 포함) → 삭제 진행. R2가 설명한 "비어있거나 읽을 수 없으면 보존, 확인된 빈 디렉터리만 정리"와 일치하고 보수적입니다. instrumentation의 두 케이스(비어있지 않은 백업 보존, `backups`만 빈 런타임 제거)는 이 분기와 정확히 맞물리며, 삭제가 `runCatching` 안에서 조용히 실패하더라도 `check(!emptyRuntime.exists())`가 잡습니다. **코드 읽기상 문제없음, 실행 증거는 아직 없음.** 보존 휴리스틱이 `backups` 디렉터리만 인식한다는 점은 변경 전과 동일하며, 프로토타입이 그 밖의 위치에 사용자 데이터를 뒀는지는 프로토타입 소스 없이 판단할 수 없습니다(변경으로 인한 후퇴는 아님).

**4. Lua 생성자 옵션.** `tmp/lua-unicode-bootstrap.cjs`는 `process.argv[1]`을 한글 경로로 강제한 뒤 옵션 유무로 `createEngine`을 비교하고, 원본 로그는 `Aborted(Assertion failed)`로 끝나 JSON이 없고 수정본은 통과 JSON을 찍습니다. 이는 **Node 환경에서 비ASCII argv[1]이 Wasmoon 부트스트랩을 중단시키고 `{ _: './risubard' }`가 이를 피한다**는 사실을 충분히 증명합니다. 기전은 Emscripten이 Node에서 `ENV._`를 `process.argv[1]`로 채우고 환경 문자열을 ASCII로 직렬화할 때 단언하는 것으로 추정되며(로그 메시지와 부합), 이는 제 추론입니다. 세 가지를 분리합니다. (a) Android WebView는 Emscripten 웹 환경이라 프로그램 경로가 argv에서 오지 않으므로 이 옵션은 Android 클라이언트에서 **사실상 무효**이고, 관찰 가능한 차이는 Lua `os.getenv("_")`가 `./risubard`를 돌려주는 정도입니다. (b) 효과가 있는 곳은 Node가 호스트인 실행(USB 앱, 한글 경로의 vitest, `runtime-probe.cjs`)입니다. (c) "현재 scripting 테스트 통과"는 이 변경의 증거가 되기 어렵습니다—저장소 경로 자체가 한글이므로 `scriptings.test.ts`가 실제 Wasmoon을 로드했다면 변경 전 전체 스위트(4709 통과)에서 이미 실패했어야 하고, 통과했다는 것은 이 테스트가 엔진을 모의한다는 쪽을 시사합니다. 상류 동작 보존 관점에서 위험은 낮고, 유지해도 무방합니다. R2가 말한 "그 한 줄만 이식"은 상류 파일이 없어 diff로 확인하지 못했습니다.

**5. MainActivity UA.** `userAgentString = "$userAgentString RisuBardAndroid/${BuildConfig.VERSION_NAME}"`로 `isBardAndroid()`의 부분 문자열 검사와 일치함을 소스로 확인했습니다. 이전의 "UA 누락 시 데스크톱 경로로 조용히 떨어짐" 우려는 소스 수준에서 해소되었고, 그 결과 Android에서는 Gate 경로가 실제로 활성화됩니다—아래 결함이 살아나는 전제이기도 합니다. 부수 메모: 이 UA는 WebView가 로드하는 모든 외부 리소스(채팅 내 외부 이미지, translate.googleapis.com)에 전송되어 앱을 식별하는 지문이 됩니다. 결함은 아니고 수용 여부 문제입니다.

**6. 네이티브 서버 출력.** `redirectErrorStream(true)` + `Redirect.appendTo(cacheDir/embedded-server.log)`, 2MB 회전으로 서버 프로세스의 stdout/stderr가 앱 전용 파일로 가는 것은 확인했습니다. 회전은 프로세스 시작 시에만 평가되므로 장시간 실행 중에는 한도를 넘을 수 있습니다(사전 존재, 경미). 서버 코드 자체가 본문을 찍지 않는다는 주석은 서버 소스가 없어 확인하지 못했습니다.

---

## 확정 결함 (신규, 소스상 확정 · 기기 미실행)

**Gate 기본 생성 시 네이티브 `fetch`의 `this` 바인딩.**

`privateMobileGoogleTranslate.ts`:

- `this.fetchImpl = options.fetchImpl ?? fetch` — 모듈 스코프의 전역 `fetch`를 인스턴스 속성에 저장.
- `const result = await this.fetchImpl(url, { method: 'GET' })` — 멤버 호출이므로 `this`가 Gate 인스턴스.
- `translator.ts`의 `const mobileGoogleGate = new PrivateMobileGoogleTranslateGate()`는 옵션 없이 생성.

WebIDL 규격상 네이티브 `fetch`는 `Window`(WorkerGlobalScope) 인터페이스의 연산이며, `this`가 null/undefined가 아니면서 해당 인터페이스를 구현하지 않는 객체일 때 TypeError를 던집니다. Chromium은 이를 `Failed to execute 'fetch' on 'Window': Illegal invocation`으로 보고하며, `obj.f = window.fetch; obj.f(url)` 패턴에서 널리 재현되는 동작입니다. Android System WebView는 같은 Blink 바인딩을 씁니다.

결과 경로를 따라가면: Gate의 `try` 안에서 동기 TypeError → 빈 `catch` → `blockedUntil = now + 30초`, `return null` → `translateMain`의 `!f` → `fallback()` → `onFallback` 설정, 30초 간격 "Google 번역을 잠시 사용할 수 없어…" 알림, 원문 반환 → `runTranslator`가 캐시 없이 원문 반환 → 배치는 `translated === text`로 노드별 원문 resolve. 즉 **교착·손상 없이 깔끔하게 실패하지만, Android Google 번역은 단 한 건도 성공하지 못하고 "재시도"로도 복구되지 않습니다.** catch가 예외 종류를 기록하지 않으므로 콘솔에도 흔적이 남지 않습니다.

테스트가 놓치는 이유: `googleAndroidRetry`/`googleAndroidHtml`은 `vi.stubGlobal('fetch', vi.fn(...))`로 `this`에 무관한 함수를 넣고, Gate 단위 테스트는 `fetchImpl`을 주입합니다. 기본 생성자 + `this`에 민감한 fetch 조합을 실행하는 테스트는 없습니다. 이전 APK11에는 번역 수정이 없었으므로 에뮬레이터 증거도 이 경로를 지나지 않았습니다.

반증 조건을 명시합니다. 클라이언트 번들 어딘가에서 `window.fetch`를 일반 JS 함수로 덮어쓰고 있다면(예: `globalApi.svelte`의 패치—제공되지 않음) 이 결함은 발현하지 않습니다. 그 외에는 소스만으로 결정됩니다. 기기 로그는 없으므로 "소스상 확정, 런타임 미확인"으로 분류하되, 다음 APK 전에 반드시 해소할 항목으로 봅니다. 확인 비용은 작습니다—WebView 디버그 콘솔에서 `({f: fetch}).f('/')` 한 줄, 또는 `function(this: unknown, ...){ if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation') }` 형태의 스텁으로 기존 Android 테스트를 한 번 더 돌리면 현재 코드에서 실패가 재현되어야 합니다.

수정 방향(여기서는 적용하지 않음): 지연 해석 래퍼 `(input, init) => fetch(input, init)` 또는 `fetch.bind(globalThis)`. 전자는 테스트에서 import 이후 스텁도 잡히므로 더 안전합니다. 같은 스텁을 쓰는 회귀 테스트를 Gate 기본 생성 경로에 하나 추가해야 이 블라인드 스폿이 닫힙니다. 참고로 `translateMain`의 데스크톱 분기 `await fetch(url, ...)`는 직접 호출이라 `this`가 undefined이고 영향이 없습니다—데스크톱은 무관합니다.

---

## 번역기 console 로깅 경계 평가 (런타임 증거 없이, 소스 기준)

제공 소스에서 확인되는 로그 지점:

- `translateHTML`: `console.log(html)`이 DOM 파싱 직전에 무조건 실행됩니다. LLM·bergamot(htmlTranslation) 경로는 그 이전에 반환하므로 **google/deepl/deeplX 경로의 모든 메시지 번역 호출마다 메시지 HTML 전문**이 찍힙니다. `tmp/ports2-fixes.log`의 stdout 블록(5.6KB짜리 span 두 개 포함)이 이 지점이 실제로 호출 때마다 실행됨을 보여줍니다.
- `translateLLM`: `console.log(arg.translatorNote)`, `console.log(translatorNote)` — 캐시 미스 시마다 캐릭터 작성 번역 노트.
- `scriptings.ts`: `console.log('Running Lua code:', code)`로 트리거 스크립트 전문(엔진 재생성 시마다), `logMain`으로 스크립트가 고른 값, 런타임 오류의 `console.error(error)`.

싱크 측: MainActivity의 `WebChromeClient`는 `onShowFileChooser`만 재정의하고 `onConsoleMessage`를 다루지 않습니다. Android WebView의 문서화된 기본 동작은 클라이언트가 소비하지 않은 콘솔 메시지를 logcat으로 보내는 것이므로, **그 기본 동작이 적용된다면** 위 내용이 logcat에 들어갑니다. 이 부분은 플랫폼 문서에 근거한 서술이고 이 검토에서 기기로 확인한 바는 없습니다. logcat의 노출 면은 adb 연결 호스트, 버그리포트/피드백 번들, 시스템 로그 버퍼이며, 서드파티 앱은 READ_LOGS 없이는 읽지 못합니다. logcat은 항목당 길이 제한이 있어 긴 메시지는 잘리므로 노출이 줄어들긴 하지만 사라지진 않습니다.

경계 판단: Kotlin 주석 "bodies/credentials를 logcat으로 보내지 않음"은 **네이티브 서버 프로세스**에 대해 성립하며 소스로 확인됩니다. WebView JS 콘솔은 별개의 채널이고 어떤 코드도 이를 막지 않습니다. 상류에서는 같은 로그가 브라우저 devtools에만 머물러 수용 가능했지만, Android에서는 싱크가 반영구 시스템 로그로 바뀌므로 **기능 결함이 아닌 프라이버시 경계 불일치**이며, 이번 포팅이 만든 것은 아니고 포팅이 새 싱크로 옮긴 것입니다. 배포 전 선택지는 (a) 네이티브에서 `onConsoleMessage`를 소비해 릴리스 빌드의 콘솔→logcat 전달을 끊는 것(클라이언트 코드 변경 없음, 디버그 편의 감소), (b) 해당 `console.log` 제거·게이팅(상류와 드리프트), (c) 문서화 후 수용입니다. 결정 사항으로 남깁니다. 디버그 빌드는 `setWebContentsDebuggingEnabled(true)`로 USB 호스트의 chrome://inspect 접근이 가능하며 이는 의도된 범위입니다.

---

## 미확정 위험

### 번역 (모의로만 검증)

- 위 `fetch` 바인딩 결함과 별개로, Google이 `■` 개수를 보존하는지, GET URL 길이(배치 ~5000자, CJK·역방향 시 수 배), WebView에서 CORS 없는 429가 TypeError로 보이는지, UI의 "번역 재시도"가 `translateHTML`을 재호출하는지, `useExperimentalGoogleTranslator`의 Gate 우회는 이전과 동일하게 증거가 없습니다. 특히 Gate의 catch는 Illegal invocation과 CORS TypeError를 구별하지 못하므로, 기기에서 "항상 폴백"이 관찰되더라도 원인을 바로 가르기 어렵다는 점을 염두에 두어야 합니다.
- 배치 오류(`translationError`)가 기록된 뒤에도 남은 배치를 끝까지 시도하고 마지막에 throw합니다. 결함은 아니지만 공급자 장애 시 요청이 낭비되며, 테스트는 결과만 단언합니다.
- 번역 도중 `translatorType`이 바뀌면 `translateNodeText`는 배치에 넣고 `translateTranslationChunks`는 조기 반환해 resolver가 영영 호출되지 않을 수 있습니다. 상류 deeplX 구조에도 있던 것으로 보이며 새 위험은 아닙니다.

### Android

- 빈-백업 instrumentation은 미실행입니다. 실행되더라도 에뮬레이터에서 합성 디렉터리로 분기를 증명하는 것이지 실제 프로토타입 레이아웃과의 일치를 증명하진 않습니다.
- `embedded.enabled`/`savePath`, KV `config/server-backup-path` 선점, 프로브가 남기는 `inlay/runtime-probe-image`와 위키 문서는 이전과 동일합니다.
- 번역 수정이 포함된 APK, 실기기, UI 경유 백업, 시스템 피커 UI는 모두 미검증이며 HOLD가 유지됩니다.

### Lua (사전 존재, 변경 없음, 조치 요청 아님)

- `getCharacterLastMessage`/`getUserLastMessage`가 두 번 `declareAPI`되어 뒤 것이 앞 것을 덮습니다.
- `setDescription`이 인자 `desc` 대신 바깥 클로저의 `data`를 타입 검사해 `data`가 `OpenAIChat[]`인 모드에서 던집니다.
- `ensureLuaFactory`의 대기자 경로는 팩토리 실패를 삼키고 반환해 다음 줄 `luaFactory.createEngine`에서 TypeError가 납니다(교착은 아님).
- 세 가지 모두 상류 패턴으로 보이며 상류 소스가 없어 단정하지 않습니다.

### Gemini

이번 제출에 변경 없음. 이전 미확정 항목 그대로.

---

## 테스트·증거 정합성

- `ports2-fixes.log`: 5파일 36건 = Gate 4 + Retry 8 + HTML 6 + chatScriptScope 5 + scriptings 13, 로그 항목 수와 일치. `lua-bootstrap-tests.log`: 2파일 18건 = scriptings 13 + chatScriptScope 5로 일관.
- `settled()`는 10초 가짜 시간 안의 settle을 단언하고 거부도 올바르게 전파하므로(`finally().catch()`로 unhandled 방지) 교착 검출기로 유효합니다.
- 데스크톱 형상 테스트 3건은 현재 동작을 고정합니다. 상류 동등성은 R2의 상류 읽기에 의존합니다.
- **커버리지 공백(신규)**: Gate 기본 생성 + `this`-민감 fetch. 현재 모든 Android 테스트가 이 경로를 우회합니다.
- 기존 공백(이월): combineTranslation의 `<br>` 다중 문장 경로와 `replaceChild` 타이밍, 23노드 이상, 길이-flush 직후 경계-flush, 노드 텍스트 내 `■`.
- 이전 전체 스위트 로그(4709)에는 Lua 한 줄과 데스크톱 형상 테스트가 없다는 R2 설명은 시간순으로 타당하며, 현재 전체 빌드 테스트 결과는 아직 제공되지 않았습니다.

---

## 결론

R2 대응 네 건은 제공 소스와 테스트가 요구 사항대로 바뀌었음을 확인했고, deeplX 공유는 수용 결정으로 기록합니다. 빈-백업 로직은 코드상 정확하나 실행 증거가 없고, Lua 한 줄은 Node 호스트에서 유효·Android에서 무효이며 위험은 낮습니다. UA는 소스로 확인되었습니다.

새로 올린 **Gate의 `fetch` `this` 바인딩 결함**은 제공 소스와 표준 브라우저 의미론만으로 결정되며, 유일한 반증 조건은 제공되지 않은 전역 fetch 덮어쓰기입니다. 이것이 해소되고 `this`-민감 스텁 회귀 테스트가 추가되기 전까지는 Android Google 번역 경로가 기기에서 동작한다고 볼 근거가 없습니다. 콘솔 로깅 경계는 기능 결함이 아니라 배포 전 결정 사항이며, 네이티브 서버 로그 격리와는 별개 채널임을 분명히 합니다. 이 검토는 범위 한정 코드 검토이며 릴리스 승인이 아니고, 물리 설치 HOLD는 유지되어야 합니다.
