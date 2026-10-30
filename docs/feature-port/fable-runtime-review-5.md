# Fable 5.1 xhigh 실행 기반 5차 검수

**RisuBard Android 런타임 재리뷰 (R4 패치 검증)**

범위: 제공된 서버 큐/flush, canonical 영속화, flush·chat 업로드 엔드포인트, shutdown, 클라이언트 저장 순서/즉시 flush, 두 테스트 파일, 매니페스트, EmbeddedServer.kt, 테스트 로그 2건. `persistCanonicalProjection`, `directWriteTracker`, `createQueuedSaveDebounce`, `/api/patch` 핸들러, `triggerSave` 본문, `flushServerDbNow` 본문, MainActivity.kt는 제공되지 않았으므로 해당 부분은 "미검증"으로 분리합니다. 장치 테스트가 없으므로 런타임 동작 주장은 전부 미검증입니다.

---

**1. R4-1 (pagehide 즉시 flush 복원 + Android 업로드 후 flush) — 소스상 수정 확인됨**

확인된 것:
- `flushImmediate()`가 `triggerSave()` 호출 직후 동기적으로 `flushServerDbKeepalive()`를 발사하고, Android UA에서만 `pending.then(flushServerDbKeepalive, () => {})`를 추가합니다. 이전 리뷰 지적(Android가 `pending.then`에만 의존해 pagehide 해제 시 flush를 놓침)은 구조적으로 해소됐습니다.
- `triggerSave`는 테스트 슬라이스 앵커가 `async function triggerSave(`이므로 항상 Promise를 반환 → `pending.then`이 동기 TypeError를 낼 위험은 없습니다.
- 브라우저 경로는 즉시 keepalive flush 1회뿐이며 `requestImmediateSaveImpl`에서는 flush를 호출하지 않음(테스트 "ordinary browser save" 통과) → "브라우저 저장 동작 유지" 조건 충족.
- `requestImmediateSaveImpl`의 Android 분기: `result === 'saved'` 후 `await flushServerDbNow(false, true)`, 실패 시 catch에서 배치 재큐잉 + `forceFullWriteOnRetry` 설정. 테스트가 "flush 실패 시 배치 유실 없음"을 실제로 검증합니다.

남은 문제/미검증:
- (미검증·중) `triggerSave`가 반환하는 Promise가 실제 업로드(및 Android in-save flush) 완료 후에 settle하는지는 확인 불가합니다. 테스트는 `triggerSave`를 외부 Promise로 stub했습니다. 만약 `triggerSave`가 플래그만 세우고 즉시 resolve하는 래퍼라면 "업로드 후 flush"는 두 번째 즉시 flush에 불과해 R4-1의 후반부가 사실상 빈 약속이 됩니다. `triggerSave` 본문 또는 실 `triggerSave`를 쓰는 테스트 1개가 필요합니다.
- (미검증·중) Android 백그라운드 시 WebView가 `pending` 체인을 끝까지 실행할 수 있는지는 MainActivity에 달려 있습니다. `onPause`에서 `webView.pauseTimers()`를 호출하면 `sleep()`·디바운스·재시도 타이머가 멈추고, `risubard-native-background` 이벤트가 그 전에 발행되지 않으면 세 번째 flush는 영원히 안 옵니다. 또한 Android는 앱 프로세스를 죽일 때 프로세스 그룹 전체를 SIGKILL 하므로(ProcessBuilder 자식은 같은 그룹), LMK/스와이프 종료에서는 node 측 graceful shutdown이 실행될 기회 자체가 없을 가능성이 큽니다. 즉 Android에서 실질적 보호막은 R4-2가 아니라 R4-1의 즉시 flush + in-save flush입니다. 이 가정은 장치에서 서버 로그로 확인해야 합니다.
- (관찰·하) Android 백그라운드 진입 시 `visibilitychange`, `pagehide`, `risubard-native-background`가 거의 동시에 `flushImmediate`를 3회 호출 → `triggerSave` 3회(`saveInFlight`로 직렬화되므로 무해) + `/api/db/flush` 최대 6~9회 큐잉. 각 flush는 `adoptSettledExternalProjection()`을 호출하므로 비용이 0이 아닙니다. 정말 중요한 첫 flush를 뒤로 미루지 않도록 짧은 창에서 합치는 것을 권합니다. 정확성 결함은 아닙니다.
- (관찰) Android는 즉시 keepalive flush → in-save flush → post-save flush 3중입니다. post-save flush는 `result !== 'saved'`(retry/noop)이거나 save가 throw한 경우에만 추가 가치가 있고 나머지는 중복입니다. 무해하지만 의도된 것인지 확인하십시오.

---

**2. R4-2 (정리 예외가 영속화를 우회하거나 ownerless 서버를 남기지 않음) — 소스상 수정 확인됨, 단 셧다운 flush 자체에 구멍이 남음**

확인된 것:
- 각 정리 단계가 개별 try/catch로 격리되어 어떤 단계의 throw/reject도 `flushPendingDb()`를 건너뛰지 못합니다. `finally`가 무조건 `process.exit(0)`를 호출하므로 `shuttingDown=true`로 좌초하는 경로는 "await가 영원히 settle하지 않는 경우"뿐입니다. 테스트 2건이 이 두 성질을 정확히 고정합니다.

남은 문제 (코드로 입증됨):
- (중) **flush 실패 시 디바운스 재무장이 없어 이후 flush와 셧다운 flush가 no-op이 됩니다.** `flushPendingDbWithinQueue`는 `clearTimeout` + `delete saveTimers[DB_HEX_KEY]`를 먼저 실행한 뒤 `persistDbCacheWithChats`를 호출합니다. 여기서 throw하면(예: `findStubFlagLossChats`가 결정적으로 throw하는 가드, 디스크 풀, kv 락) 메모리의 `dbCache`/`fullChatStore`는 dirty인데 타이머는 이미 사라진 상태입니다. 다음 `/api/db/flush`도, `shutdownGracefully`의 `flushPendingDb()`도 `if (saveTimers[DB_HEX_KEY])`를 통과하지 못해 아무것도 쓰지 않습니다. 디바운스 콜백 실패도 동일합니다(타이머는 이미 발사됨). 복구 주체는 "클라이언트가 새 쓰기를 보내는 것"뿐인데, pagehide 직전 flush가 실패한 브라우저나 셧다운 경로에는 그 주체가 없습니다. 트리거: chat 업로드 → `/api/db/flush?mode=canonical` → persist throw(500) → 클라이언트가 재시도 못 한 채 종료 → 셧다운 flush no-op → 유실. 수정은 작습니다: dirty 상태를 타이머와 분리한 플래그로 관리하고 flush가 타이머가 아니라 그 플래그를 보게 하거나, 실패 시 재무장하십시오.
- (중하) **셧다운 flush가 외부 변경 대기/채택 시 조기 반환하며 수락된 데이터를 버립니다.** `flushPendingDb()`는 기본 옵션이므로 `externalChangesAwaitingReview()`가 참이거나 `adoptSettledExternalProjection()`이 참이면 타이머를 정리하지도, 영속화하지도 않고 반환합니다. chat 업로드는 이미 200을 받았고 `fullChatStore`에만 존재하는데, 프로세스는 `exit(0)`합니다. 창은 업로드 수락 후 SAVE_INTERVAL 이내에 외부 변경이 감지되는 경우로 좁고, 감지 로직(미제공)에 따라 발생 가능성이 달라지지만, 제어 흐름 자체는 입증됩니다. 최소한 셧다운 시 이 경로에 들어가면 보류 중인 메모리 상태를 복구 파일로 떨어뜨리거나 error 로그를 남겨야 합니다.
- (하) 종료 코드가 항상 0입니다. flush 실패 후에도 `exit(0)`이라 감독자(Android/스크립트)가 "깨끗한 종료"와 "유실 종료"를 구분할 수 없고, 두 번째 테스트가 이 동작을 고정해 버렸습니다. 의도라면 명시하고, 아니라면 실패 시 비0 또는 마커 파일을 권합니다.
- (하) 행(hang) 감시가 없습니다. `flushPendingDb()`가 큐 앞의 긴 작업(대형 import 등) 뒤에 막히면 영원히 대기합니다. Android `stop()`은 5초+2초 후 kill하므로 ownerless는 되지 않지만, 데스크톱 SIGTERM/SIGINT는 두 번째 이후 시그널이 전부 무시되어 kill -9가 필요합니다.
- (하) Android `stop()`의 총 예산은 7초인데 셧다운 flush는 비-canonical 경로(legacy blob 전체 encode + kvSet + `compatibilityCache.materialize`)입니다. 큰 DB에서 7초를 넘기면 `kvSet` 도중 SIGKILL입니다. kv 쓰기 원자성이 보장되지 않으면 legacy blob 손상 가능. owner-EOF 셧다운은 `deferCompatibility: true` 경로를 쓰는 편이 안전합니다. (단 `stop()`은 자격증명 불일치/ConnectException 경로에서만 호출되므로 빈도는 낮습니다.)
- (하, Android 비해당) `console.log`가 try 바깥에 있습니다. Android는 stdout을 파일로 리다이렉트하므로 문제없지만, 데스크톱에서 부모가 먼저 죽어 stdout 파이프가 닫힌 경우 EPIPE가 비동기로 터져 flush 중 프로세스가 죽을 수 있습니다.

---

**3. "canonical flush가 chat + root/preset/module 영속화를 모두 배출한다" — 제공된 소스로는 검증 불가**

구조적으로 확인되는 것: `mode=canonical` → `flushPendingDbWithinQueue({materialize:false, deferCompatibility:true})` → `persistDbCacheWithChats(..., {directCollection: directWriteTracker.take(), deferCompatibility:true})` → `deferCompatibility`가 참이면 legacy blob encode/kvSet을 건너뛰고 `persistCanonicalProjection(fullDb, {directCollection, deferCompatibility})`만 호출합니다. 즉 **root/preset/module 변경이 디스크에 닿는 유일한 경로가 `persistCanonicalProjection`이고, 무엇을 쓸지는 `directCollection`이 결정합니다.**

검증 불가한 핵심: `directWriteTracker.take()`의 병합 의미론입니다. 코드상 `directCollection`은 단일 값(`'botPresets'` 같은 문자열 또는 `{kind:'chatState'}` 객체)으로 보입니다. "root 패치 → chat 업로드 → canonical flush" 순서에서 `take()`가 마지막 관측(chatState)만 반환하고 `persistCanonicalProjection`이 그것만 쓴다면, root 변경은 legacy blob에도(지연됨) canonical 파일에도 기록되지 않은 채 메모리에만 남고 프로세스 kill 시 유실됩니다. 혼합 관측 시 `take()`가 "전체 쓰기" 지시자(undefined/빈 배열 등)로 붕괴하는 것이 정상 설계일 것이라 추정되지만, 추정일 뿐입니다. 이 항목은 사용자가 명시적으로 검증을 요구한 것이므로 "통과"로 표기할 수 없습니다. 필요한 것: `directWriteTracker`와 `persistCanonicalProjection`의 `directCollection` 처리부, 또는 "root+chat 관측 후 take → 전체 쓰기"를 단언하는 테스트.

관련 조건부 우려(미검증): 지연된 canonical flush 이후 `dbCache`가 사라지면(`invalidateDbCache`, stub-flag-loss 가드의 `delete dbCache`) 다음 chat 영속화는 `persistChatStoreWithoutCache`가 `kvGet('database/database.bin')`의 **오래된 legacy blob**을 기준으로 재조립합니다. `compatibilityCache`가 그 사이 blob을 재생성하는지에 따라 root 데이터 되돌림이 가능합니다. 재현 시나리오를 한 번 테스트해 보십시오.

---

**4. 기타 지적**

- (하, 입증) `/api/db/flush`는 `externalEditSession`/`externalChangesAwaitingReview` 조기 반환은 `paused:true`로 구분하지만, `adoptSettledExternalProjection()`이 참이어서 아무것도 안 쓴 경우에도 평범한 `{success:true}`를 돌려줍니다. Android 클라이언트는 이를 "디스크 보존 완료"로 받아들여 `savetrys=0`으로 리셋합니다. `flushPendingDbWithinQueue`가 상태값을 반환하고 엔드포인트가 그것을 노출하게 하십시오. 아울러 클라이언트 `flushServerDbNow`가 `paused:true`를 성공으로 취급하는지도 미제공이라 확인이 필요합니다.
- (하, 입증) flush 성공 경로는 `clearPersistFailure()`를 호출하지 않습니다(디바운스 콜백만 호출). 이전 실패 경고가 성공적인 flush 뒤에도 다음 `/api/patch` 응답에 남아 오래된 토스트를 띄울 수 있습니다.
- (미검증) `createQueuedSaveDebounce`가 `saveTimers[key]`에 `clearTimeout` 가능한 핸들을 저장한다는 전제가 flush 경로 전체의 기반입니다. 객체를 저장한다면 `clearTimeout`은 무음 실패하고 타이머가 나중에 한 번 더 발사되어 이중 persist가 납니다(이때 `directWriteTracker`는 이미 소비됨).
- (관찰) flush는 등록된 디바운스 콜백을 버리고 자체 persist를 수행하므로, 콜백 내부의 후처리(`clearPersistFailure`, GC 로그 분리)는 flush 경로에서 재현되지 않습니다. 현재는 위의 `clearPersistFailure` 누락 외에 기능 차이는 없어 보입니다.

---

**5. Android 네이티브 (EmbeddedServer.kt, 매니페스트)**

- 런타임 정리는 인증 성공 후 `files/runtime` 아래 해시 이름 디렉터리만 삭제하며 user-data에는 손대지 않습니다. zip slip 검사, 트레일러까지 포함한 SHA-256 검증, `.complete` 마커 후 rename — 적절합니다. 기존 USB/사용자 데이터 보존 조건에 위배되는 변경은 보이지 않습니다.
- `start()`가 `@Synchronized`이고 내부에서 `stop()`이 최대 7초 블로킹합니다. 메인 스레드에서 호출되면 ANR입니다. 호출 지점(MainActivity) 미제공으로 확인 불가.
- 포트 재사용은 bind→close→node 재bind 사이에 경쟁 창이 있어 실패 시 90초 타임아웃까지 기다립니다. 기존 동작이며 우선순위 낮음.
- `target`이 `.complete` 없이 존재하는 비정상 상태(구버전 포맷 등)에서는 `renameTo`가 영구 실패합니다. 엣지.
- 매니페스트: `usesCleartextTraffic=true`는 127.0.0.1에 필요하지만, networkSecurityConfig로 localhost에만 한정하는 편이 낫습니다. 결함은 아님.

---

**6. 테스트·증거 평가**

- 로그는 vitest 요약뿐이라 테스트 이름이 없고 개수(8/12)로만 대응됩니다. graceful-shutdown 파일은 2개이므로 서버 측 나머지 10개는 미제공 파일 소속입니다.
- 두 테스트 파일 모두 소스 슬라이스 + `new Function` 방식의 구조 테스트입니다. `requestImmediateSaveImpl`/`flushImmediate`/`shutdownGracefully` 내부 제어 흐름은 잘 고정하지만, `triggerSave`·`flushServerDbNow`·서버 flush와의 통합은 검증하지 않습니다. 따라서 "패치됨"은 맞지만 "동작함"은 아직 아닙니다.
- `flushImmediate` 테스트의 마이크로태스크 순서(`.then` 등록이 `await pending`보다 먼저)는 올바르며, Android 2회/브라우저 1회 단언은 타당합니다.
- 셧다운 테스트가 "flush 실패 후 exit(0)"을 성공 조건으로 고정한 점은 재고 대상입니다(2절 참조).

---

**7. KEEP 조건**

- 기존 USB/사용자 데이터: 제공 범위 내에서 손대는 변경 없음.
- 브라우저 저장 동작: 즉시 저장 경로에 flush 없음, pagehide는 keepalive flush 1회 — 유지.
- 설치 없음: 판단에 반영(아래).

---

**8. 판정**

내부 테스트 진입: **가능(장치 복귀·16KiB 빌드 완료 후)**, 단 진입 전 2절의 "flush 실패 시 재무장 없음"은 수정을 권합니다. 셧다운·백그라운드 신뢰성이 직접 걸린 문제이고 수정 범위가 작습니다. 그 외 항목은 장치 테스트 중 다음을 반드시 관찰하십시오: (a) `risubard-native-background` 이후 서버 로그에 `/api/db/flush`가 실제로 도착·완료하는지와 타이밍, (b) MainActivity의 `pauseTimers` 호출 유무, (c) LMK/스와이프 종료 시 node에 graceful shutdown이 실행되는지(아마 아닐 것), (d) "root 패치 → chat 업로드 → canonical flush → 강제 종료" 후 root 변경 생존 여부.

릴리스: **보류**. 근거: canonical 투영의 root/preset/module 배출이 소스로 검증되지 않음(3절), 새 소스/APK8 장치 테스트 없음, 16KiB 바이너리 미완, 2절의 입증된 flush 재무장·셧다운 조기 반환 결함. 릴리스 승인은 요청되지 않았으므로 판단만 기록합니다.