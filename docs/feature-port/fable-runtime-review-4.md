# Fable 5.1 xhigh 실행 기반 4차 검수

<tool name="Edit">
<parameter name="file_path"><user-home>\.claude\plans\actual-fable-review-4-adaptive-codd.md</parameter>
<parameter name="old_str">- 재진입: `shuttingDown` 가드로 EOF→flush 진행 중 5s 뒤 SIGTERM은 no-op, 7s 뒤 SIGKILL.</parameter>
<parameter name="new_str">- 재진입: `shuttingDown` 가드로 EOF→flush 진행 중 5s 뒤 SIGTERM은 no-op, 7s 뒤 SIGKILL. 락과의 상호작용: 락의 `once` 핸들러는 서버 핸들러가 남아 있어 반환하고, `process.exit(0)`의 `exit` 리스너가 락을 해제 → 정상.
- **R4-2 (확정 구조, 트리거 미재현, 낮음)**: `liveFileEvents.close()`, `stopTunnel()`, `liveCharacterFiles.close()`, `await saveObservation.flush()`가 try 밖. 하나라도 throw/reject하면 `process.exit(0)` 미도달. `process.on(sig, () => shutdownGracefully(sig))`가 Promise를 버리므로 unhandled rejection. (a) `unhandledRejection` 로깅 핸들러가 있으면 프로세스가 `shuttingDown=true`로 남아 이후 SIGTERM/EOF 전부 무시 → `stop()` 경로는 7s 뒤 SIGKILL로 끝나지만 Java 사망(EOF) 경로는 영구 잔존 → 다음 기동 `DATA_ROOT_IN_USE` → force-stop까지 복구 불가. (b) 핸들러가 없으면 크래시 종료(락은 해제)되나 throw가 `flushPendingDb` 앞이면 flush 생략. PC도 동일(두 번째 Ctrl+C 무시).
- 권고: `stop()`의 graceful 5s는 대형 flush보다 짧을 수 있음. 호출 경로가 드물고 UI가 이미 "시작 중"이므로 15s 정도로 늘리거나, `flushPendingDb`의 원자성(tmp+rename)을 확인해 문서화.

## 5. Node 빌드 소스 재현성

- `build-node.sh`: NDK zip sha256, Node 소스 sha256(provenance와 일치), 헬퍼 git SHA 고정 — 핀 고정 정확. `sed` job-count 치환은 재실행에도 멱등. `LDFLAGS` 환경변수는 gyp Makefile의 `LDFLAGS.target ?= $(LDFLAGS)`로 전달되나 헬퍼가 덮어쓰는지는 미검증 — 단 결과 ELF를 `inspectElf(16384)`가 검사하므로 fail-closed.
- 경미: `download()`가 해시 불일치 시 잘못된 파일을 남겨 다음 실행이 다운로드를 건너뛰고 다시 실패(수동 삭제 필요). 헬퍼 미벤더링 → GitHub 가용성 의존(권고: `git archive` tarball sha256 기록). `cp` 대상 `patches/24/stubs/` 존재 가정.
- `cpu-features.h` shim: 0 반환 → zlib ARM CRC32/PMULL 가속 비활성(문서화됨). 잠재 함정: 비트 상수(CRC32=1, PMULL=2)가 NDK 실제값(`1<<6`, `1<<3`)과 다름 — 지금은 무해, 반환값을 실측으로 바꾸는 순간 오동작하므로 주석 필요. GPL-3.0-only 헤더가 `libnode.so`에 컴파일되어 들어감 — 프로젝트 라이선스와 일관되나 NOTICE에 반영 여부 확인.
- 미검증: tar 멤버명 `nodejs-v24.21.0-android-<arch>/bin/node`와 `tmp/android-node/<archiveArch>.tar.xz` 수동 복사 단계, lock 갱신(양 빌드 컴파일 중).

## 6. 기타 증거 판정

- 태블릿 키보드: **통과**. 가로 760→405, 세로 1240→885(IME 355px 일관), `innerHeight==vv.height≈css var==body`, 입력창 bottom 390/870 < 405/885. 세로에 `focus` 기록 없음(표기만).
- APK7 라우트 probe: 두 기기 통과, wiki 수정은 픽스처 documentId만 — "production 코드 불변"은 diff 미제공이라 독립 확인 불가, 증거와는 모순 없음.
- 의존성 trace: 내 집계 113(보고 112, 무의미). 범위는 memory 런타임/라우트/코덱이지 서버 전체 그래프가 아님 — 서버 기동 자체는 기기 증거가 커버. review-3 §6-4는 도달한 라우트에 한해 종결, 미도달 라우트의 지연 require는 잔존.
- 프로세스 체크: force-stop 후 Node 부재(`afterStop: []`) → force-stop은 EOF 경로를 타지 않음 → disk-ack 필요성의 전제 확인.

## 7. 확정 결함 요약

| ID | 위치 | 트리거/결과 | 최소 수정 | 심각도 |
|---|---|---|---|---|
| **R4-1** | `globalApi.svelte.ts` `flushImmediate` | Android에서 `pagehide`가 `WebView.destroy()` 중 발화(Back/recreate) → 체인된 keepalive flush 미실행, 즉시 flush도 없음(브라우저 대비 후퇴) | `const pending = triggerSave({skipBroadcast:true}); void flushServerDbKeepalive(); if (UA Android) void pending.then(flushServerDbKeepalive, () => {})` — 즉시 1회 + 저장 후 1회. 브라우저 경로 불변. | 낮~중 |
| **R4-2** | `server.cjs` `shutdownGracefully` | close/flush 호출 중 예외 → `process.exit` 미도달, 이후 신호 무시(핸들러 유무에 따라 잔존 or 크래시) | 본문을 `try { … } finally { process.exit(0) }`로 감싸고 `liveFileEvents.close()`·`stopTunnel()`·`liveCharacterFiles.close()`·`saveObservation.flush()` 각각 try/catch. | 낮음 |

## 8. 미검증(기기·추가 소스 필요)

1. chat-content 업로드가 `persistTrackedChanges` 안(flush 전)인지 밖인지; `/api/db/flush canonical`이 chat-content 디바운스를 drain하는지(경험적 증거만).
2. `canonicalOnly=true`가 root 설정·프리셋·모듈 상태까지 내구화하는지(증거는 chat·캐릭터 생성뿐).
3. `AndroidManifest.xml`: `configChanges`(회전이 recreate면 진행 중 저장 fetch가 destroy로 중단), Back 처리(기본 `finish`), 구 USB 앱 패키지명 분리.
4. `flushPendingDb` SIGKILL 중 원자성.
5. 16K: lock 갱신 → 플래그 없는 패키징 → verify → 16K 에뮬레이터; DT_NEEDED.
6. APK8 증거 전무(instrumentation·내구 저장 UI 테스트 pending).
7. transfers v2, BardWiki/save-slot 왕복.

## 9. 디버그 설치로 pending 테스트 실행 — **조건부 수용**

- 격리: `.debug` applicationId → 릴리즈/구 USB 앱 데이터와 분리(패키지명 상이 전제, §8-3).
- `am instrument`는 대상 패키지를 force-stop(프로세스 그룹 SIGKILL) 후 시작 → 디버그 앱의 미flush 디바운스 창(≤500ms + chat-content 갭) 손실 가능. 실행 전 앱을 Home으로 보내 native flush 후 2–3초 대기하거나, 도그푸드 데이터가 없는 기기에서 실행.
- Instrumentation 자체는 user-data를 변형(마커 파일, Keystore 키 삭제→`__password` 회전, 서버 3회 재시작, probe 픽스처 잔류). 전부 설계상 무손실(마커 assert)이나 디버그 데이터가 소중하면 백업.
- 서명: APK7 위에 설치 시 동일 debug keystore 필수. 불일치면 **uninstall로 해결하지 말 것**(데이터 삭제).
- 리플렉션(`origin`/`process` 필드)은 minify 없음 전제 → debug OK. 로그인 4회는 각기 다른 서버 프로세스라 429 플레이크 없음.
- 내구 저장 UI 테스트 설계: (a) 메시지 전송 → 저장 완료 신호(`/api/db/flush` 200 또는 saving=false) 확인 즉시 force-stop → 재기동 hydration 대기; (b) Home → 1초 내 `/api/db/flush` 관측; (c) Back → 재기동 → 마지막 메시지 확인. **R4-1을 먼저 적용**해야 (c)가 최종 동작을 검사함.

## 10. 단계 판정

디버그/내부 dogfood 유지. 릴리즈 전 닫을 것: 16K 양 ABI+lock+verify+에뮬레이터 · APK8 instrumentation · 내구 저장 UI 테스트(a/b/c) · **R4-1** · §8-1/2 소스 확인. R4-2는 권장.

---

## 실행 계획(승인 시)

1. `src/ts/globalApi.svelte.ts` `flushImmediate`: R4-1 최소 수정(즉시 keepalive flush 복원 + Android 체인 유지). `immediateSave.test.ts` 성격의 테스트는 `$effect.root` 안이라 추가 어려움 — 기존 vitest 전체 재실행으로 회귀 확인.
2. `server/node/server.cjs` `shutdownGracefully`: R4-2 try/finally. `data-root-lock.test.ts`의 비동기 종료 테스트 재실행.
3. `docs/feature-port/fable-runtime-review-4.md`에 본 리뷰 저장.
4. 검증: `vitest` 저장 관련 focused + `data-root-lock.test.ts` + `runtime-artifacts.node-test.mjs`; 이후 디버그 APK9 빌드 → §9 조건으로 instrumentation + 내구 저장 UI 테스트(a/b/c).
</parameter>
</tool>