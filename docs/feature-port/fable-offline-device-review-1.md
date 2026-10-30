# Fable 5.1 · xhigh 기기 내 AI 1차 검수

원본: tmp/offline-native/fable-review-1.json. 실제 종료0/is_error=false/modelUsage claude-fable-5-1. 초기 소스 기준이며 후속 수정과 실기기 승인 아님.

**전제**: 제시된 소스·로그만 근거. 미제시 코드(NodeStorage.localAIRequest/authFetch, tokenizeGGUFModel, P4 트리밍, Express 등록부, Kotlin, verify-node.mjs의 inspectElf, llama.cpp 해당 리비전)는 B절로 분리. 최종 수용 판단은 보류.

## A. 확정 결함 (소스로 입증)

**A1 [High·가용성] `src/ts/bootstrap.ts:54` + `src/ts/localAI.ts:10-11`**
- 재현: 오프라인 APK에서 `GET /api/local-ai`가 비-2xx(세션 미확립 401, 500 등)이거나 `realStorage.localAIRequest`가 없으면 `refreshLocalAI`가 throw → `loadData` 중단 → DB 로드 전 종료, 모든 채팅·온라인 기능 접근 불가.
- 수정: `try { await refreshLocalAI() } catch (e) { localAI.enabled = false; localAI.error = String(e) }` 후 부팅 계속(`available`은 유지해 설정 패널에서 재시도 가능).

**A2 [High·정합] `src/ts/localAI.svelte.ts:16`, `server/node/local-ai.cjs:26`**
- 신규 설치 기본 `enabled:true, model:null`(클라이언트도 status 수신 전 `enabled:true`). 채팅 → relay→ready→start 409; `encode()`(`tokenizer.ts:76`)도 같은 409로 reject → 토큰 카운트를 쓰는 모든 UI/프롬프트 조립이 예외. 모델 임포트 전까지 앱 사실상 불능이고 "온라인 설정 보존" 취지와 충돌.
- 수정(최소): 활성 판정을 단일 헬퍼로 — `localAIActive = () => localAI.available && localAI.enabled && !!localAI.model` — `modelPresetBinding.ts:70`, `request.ts:183,185,455,833`, `tokenizer.ts:76` 교체. 서버는 `settings()`에서 `enabled && !config.model` 거부.

**A3 [Medium·한도] `local-ai.cjs:173-191`**
- 서버가 `config.output`을 전혀 적용하지 않고 `req.body`를 그대로 전달. `max_tokens` 누락/과대 시 llama 기본 `n_predict=-1`로 n_ctx까지 생성. "explicit output limit"이 클라이언트 신뢰에만 의존. `req.body` 타입 검증도 없음.
- 수정: chat target에서 `body = { ...req.body, max_tokens: Math.min(Number(req.body?.max_tokens) || config.output, config.output) }; delete body.n_predict;` + `typeof req.body !== 'object'`면 400.

**A4 [Medium·한도] `localAI.svelte.ts:24,31` + `local-ai.cjs:81`**
- 프리셋 `maxContext = context`, 엔진 `--ctx-size context`, 응답 `max_tokens = output`. 프롬프트가 광고 예산을 채우면 생성 여유 0 → `--no-context-shift`에서 즉시 length 종료 또는 400. 추가로 llama-server가 chat template(BOS·역할 토큰)을 더하므로 `/tokenize(add_special:false)` 카운트는 과소.
- 수정(최소): `maxContext: state.context - state.output - 128` (`contextWindowTokens`는 유지). 트리밍이 maxContext를 쓰는지는 B4.

**A5 [Medium·작업 손실] `LocalAISettings.svelte:45`**
- `onDestroy(() => controller?.abort())`: 수 GB 임포트 중 설정 화면만 벗어나도 취소. 이전 모델은 보존되나 수 분 작업 손실, 원인 메시지도 표시 불가(컴포넌트 파괴).
- 수정: 해당 줄 삭제, `controller`를 모듈 스코프 store로 승격.

**A6 [Medium·서버 생존] `local-ai.cjs:29-45`**
- `initialized` IIFE가 `mkdir/readdir/rm` 예외로 거부되면 그 시점에 await하는 곳이 없어 unhandled rejection → Node 기본 정책으로 앱 서버 프로세스 전체 종료(온라인 기능까지).
- 수정: IIFE 본문 전체를 try/catch로 감싸 `config.enabled=false; lastError=…`로 흡수.

**A7 [Medium-Low·저장소 누수] `local-ai.cjs:41-44, 159-165`**
- 앱 사망이 `rename(159)` 이후 `persist(165)` 이전이면 새 `.gguf`가 영구 고아(초기화는 `.part`만 정리). settings 손상 분기(39)에서도 기존 파일이 미참조로 잔존. 수 GB 누수 → 이후 임포트 507.
- 수정: settings 로드 성공(또는 ENOENT)일 때만 `config.model?.file`과 다른 `*.gguf` 삭제. 손상 시엔 삭제 금지.

**A8 [Low] `local-ai.cjs:115`** — 취소 시 `lastError='This operation was aborted'`(영문)가 status.error로 UI 노출(LocalAISettings 마지막 `<p>`). 수정: `if (error.name !== 'AbortError') lastError = error.message`.

**A9 [Low·회복 불가] `local-ai.cjs:124,127`** — 엔진 hang + 클라 소켓 유지 시 `requests>0` 고착 → `settings()` 영구 409, 온라인 전환조차 불가. 수정: `settings()`에서 in-flight controllers abort 후 `stop()` 진행.

**A10 [Low] `LocalAISettings.svelte:20,36`** — ok 검사 전 `response.json()`; 401/423은 빈 본문 → "Unexpected end of JSON input". 수정: `.json().catch(() => ({}))`.

**A11 [Low·오도] `local-ai.cjs:30,56,95-96`** — 실행 파일 존재/실행권한 미확인. spawn ENOENT가 "GGUF 호환성·메모리" 메시지로 보고. 수정: 초기화에서 `fs.access(executable, X_OK)` 실패 시 `available=false`+오류 명시.

**A12 [Low·보안] `local-ai.cjs:71-74, 99-108`** — 포트 예약→close→spawn TOCTOU. Android는 모든 앱이 localhost 공유; 선점 서버가 200을 주면 Bearer key 유출 + 프롬프트가 그쪽으로 전달. 수정: `/props`의 `model_path`가 `path.join(directory, model.file)`와 일치할 때만 endpoint 채택(필드 존재는 리비전 확인 필요).

**A13 [Low] `local-ai.cjs:105-107`** — parallel=1이면 `n_ctx == --ctx-size`이고 llama.cpp는 n_ctx_train 초과도 허용하므로 422 분기 사실상 불능. 수정: `/v1/models` meta `n_ctx_train` 비교 또는 메시지 제거.

**A14 [Low·UX] `request.ts:456-459`** — 히스토리 어디든 `multimodals`가 있으면 거부 → 과거 온라인에서 이미지 첨부한 채팅은 오프라인에서 영구 불능. 수정: `multimodals` 제거 후 텍스트만 전송, 또는 마지막 사용자 턴만 검사.

**A15 [Low] `local-ai.cjs:208-216, 147-153`** — 검증 실패 시 미소비 `req`에 응답: 클라가 잔여 GB를 계속 보내거나, Transform 오류로 pipeline이 req를 destroy해 400 메시지 유실. 수정: 응답 후 `req.destroy()`.

## B. 미검증 리스크

**B1 [High] `tokenizer.ts:76 tokenizeGGUFModel`** 미제시. 업스트림은 Tauri `invoke('tokenize_gguf')` → Node/Android에서 실패. 확인: `/api/local-ai/tokenize` 경유, 오류 폴백, 호출 빈도(로어북 항목마다 HTTP), `--sleep-idle-seconds 120` 후 토큰 카운트만으로 모델 재로딩(수십 초) 유발 여부.

**B2 [High] NodeStorage.localAIRequest/authFetch** 미제시. 확인: (a) `init.signal` 전달 — 없으면 중단 버튼이 엔진 생성을 못 멈춤(CPU·parallel 1 큐 점유); (b) 내부 타임아웃 — 첫 토큰 수십초~분, 콜드스타트 최대 180s(`local-ai.cjs:92`); (c) 재시도 → 중복 생성; (d) `body: File` 버퍼링 → OOM; (e) `Content-Type` 완전일치 보존(`local-ai.cjs:209`).

**B3 [High]** 등록부 `express.json()` limit(기본 100kb) — 32k 문맥 chat/tokenize 본문 413. `limit` 확인.

**B4 [High]** P4 트리밍이 `preset.maxContext`인지 `db.maxContext`(온라인 128k)인지. 후자면 긴 채팅 전부 llama-server 400. `resolveChatMaxResponseTokens` 수정분이 diff에 없는데 테스트가 512를 기대 → 바인딩 경유 추정; 문맥도 동일 경로인지 확인.

**B5 [Medium]** Node http `server.requestTimeout`(기본 300s) — 대용량 업로드 5분 초과 시 408·소켓 파괴.

**B6 [Medium]** 전역 `compression()` 류 미들웨어 → SSE 버퍼링.

**B7 [Medium]** Android 12+ phantom process 제한: 백그라운드에서 CPU 쓰는 자식(llama-server) kill. foreground service 없이 생성 중 앱 전환 시 끊김 가능.

**B8 [Medium]** requestChatData 밖 네트워크: HypaMemory 임베딩(OpenAI), Google/DeepL 번역, 웹검색, TTS. "유료 네트워크 폴백 금지" 범위 정책 확정 필요.

**B9 [Medium]** 번들 libnode 버전: `fs.statfs`(18.15+), `os.availableParallelism`(18.14+), `Readable.fromWeb`(17+), 전역 fetch(18+). 테스트는 데스크톱 Node 통과만.

**B10 [Medium]** llama.cpp 리비전 가정: `--sleep-idle-seconds`, `--no-context-shift`, `LLAMA_API_KEY` env, `/props.default_generation_settings.n_ctx`, `tools/server/main.cpp` 교체와 `int llama_server(int,char**)` 외부 링크. x64 실행으로 부분 입증, ARM64 미실행. sleep 복귀 지연이 B2(b)와 상호작용.

**B11 [Medium]** 16KiB: `verify-local-engine.mjs`는 machine/sha256만 검사, `PT_LOAD p_align ≥ 0x4000` 검사 여부 미제시. "Verified 16KiB" 로그는 현재 근거 없음.

**B12 [Low]** `requestChatData` 재시도 루프가 로컬 409/400을 `retryLimit`만큼 반복하는지; `noRetry/fallbackEligible`가 실제 타입 필드인지.

**B13 [Low]** 비스트리밍(내부 출력) 중단 시 llama-server가 생성을 계속하는지 → parallel 1 큐 지연.

**B14 [Low]** `request.ts:185 tools=[]` — 어댑터가 truthy 검사면 `tools: []` 전송. `undefined`가 안전.

**B15 [Low]** `requestChatDataMain` 조기 반환이 P4 이전 정규화(온도/샘플링)를 건너뛰어 `temperature 0.8` 고정인지.

**B16 [Low]** 온라인 빌드: `useLegacyPackaging=true`가 기존 설정인지, UA 주입이 재시작/복원에서도 유지되는지.

**B17 [Low·성능]** `-DGGML_NATIVE=OFF`에 ARM 아키 미지정 → 베이스라인 armv8-a(dotprod/i8mm 미사용) 가능.

## C. 테스트 공백
- 서버 4건이 다루지 않음: 100kb 초과 본문, relay 취소 후 `start()` 계속 로딩, 스트림 중 엔진 크래시→`res.destroy()`, A7 고아 파일, settings 손상 시 모델 파일 보존, 전송 중간 취소(현재는 선-abort signal만), sleep/wake.
- 클라이언트 테스트는 바인딩·프리뷰만. `localAIFetch`→authFetch 실경로, `encode()` 경로 없음.