# Fable 5.1 xhigh · 실제6차 검수

실제 CLI exit0/is_error=false/modelUsage claude-fable-5-1.

## 결론

새 서버 코드(시작 GC 격리 / 세션 한정 수동 전환 / 시작 디렉터리 sync)는 공급된 소스·테스트와 주장이 일치하고, 차단급 결함은 찾지 못했다. 코드 판독으로 확정되는 경미한 결함 2건과 미검증 위험 몇 건이 있다. 이전 A/B 수정 영역(relay/SSE/클라이언트 파서)은 이번 변경이 건드리지 않아 그대로 유효하다. 릴리스/실기기 승인은 아니다.

## 변경 1~4 대조 확인

1. **항목별 GC 격리**: `.part`/비선택 GGUF 각각 `try/catch`, 실패 시 경고만 설정하고 루프 계속. 테스트 7이 디렉터리형 `.part`로 ERR_FS_EISDIR 경로를 재현하고 모델·PUT 보존, 디렉터리 잔존을 확인한다. r5-gc-before.json과 대응이 맞다.
2. **수동 전환**: `idle(value?.enabled === false)`만 초기화 오류 검사를 건너뛰고, `initializationError` 분기에서 `config = next`만 하고 `persist`를 호출하지 않는다. `enabled:true`는 `idle(false)`에서 그대로 던진다. `relay`/`importModel`은 여전히 초기화 오류를 던진다. 테스트 6이 settings.json ENOENT로 미저장을 증명한다.
3. **시작 sync**: `collectModels`일 때만 `syncDirectory()`, 실패 시 GGUF GC만 끄고 `.part` 정리는 계속. `preserveUnlinkedModels`는 바꾸지 않으므로 다음 시작에 재시도된다. Linux 3/3, skip 0 증거와 코드가 맞다.
4. **즉시 회수 / 안내 문구**: `durable && previous`일 때만 이전 파일 삭제, 메시지는 설정·가져오기 양쪽에 맞는 문장. 가져오기 쪽 "재적용 후 재시작" 안내는 실제로 재적용이 orphan을 지우지 않으므로 재시작 요구가 논리적으로 맞다.

## 증명된 결함 (코드로 확정, 경미)

- **`lastError` 덮어쓰기**: 초기화에서 설정 손상 메시지("모델을 다시 선택해 주세요") 또는 sync 실패 메시지가 설정된 뒤, 삭제 실패가 하나라도 있으면 "일부 임시 모델 파일을 정리하지 못했어요. 기존 모델과 대화는 계속 사용할 수 있어요"로 덮인다. 설정 손상 상태(`model: null`)에서는 "기존 모델 계속 사용 가능"이 거짓 안내가 되고 재선택 지시가 사라진다. 메시지 우선순위 또는 병합이 필요하다. 테스트 없음.
- **초기화가 settings.json을 읽기 전에 실패하면 저장된 모드가 무시됨**: `fs.access(executable)`/`mkdir` 실패 시 `config`는 기본값 `enabled:true`로 남아 status가 "기기 내 AI 사용"을 보고한다. 사용자가 과거에 정상 저장한 `enabled:false`(온라인 모드)가 있어도 매 세션 수동 전환을 다시 해야 하며, "앱을 다시 열면 이전 모드로 돌아가요"의 "이전 모드"가 사실상 기본값이다. 실행 파일 검사 전에(또는 독립적으로) settings.json을 읽어 저장된 명시적 선택을 반영하는 것은 자동 온라인 대체 금지와 충돌하지 않는다. 실행 파일 부재 테스트는 이 경로를 settings.json 없는 상태로만 검증한다.
- (부수) `initializationError.message` 원문이 `status.error`로 그대로 노출된다(시스템 경로 포함 가능). 수동 전환 후에는 원인 문구가 세션 한정 메시지로 교체되어 원인이 UI에서 사라진다.

## 범위 내 제한으로 수용 (문서화된 대로)

- 설정 손상 orphan GGUF는 새 가져오기 성공 후 재시작까지 보존, 삭제 UI 없음.
- 빈 char 버블(Turn4/Turn9)은 `index.svelte.ts`가 첫 청크 전 메시지를 push하는 기존 구조; 이번 변경 아님.
- 문맥 초과 422(`remaining < 1`)는 코드와 일치하는 현재 계약.

## 해명 평가

Turn4/9/11/12, BardWiki, SSE wire(`format_oai_sse(json{{"error",…}})` → `data: …\n\n`, 예외 경로도 동일 형태), `normalizeHttpStatus`(2xx만 null, 3xx도 오류 객체), `onDevice ? localAIFetch : …`와 `useServerJob = !onDevice && …`(job journal 미사용)은 모두 공급 소스와 일치한다. 공급 발췌로 확인 불가한 것: 발췌가 해당 커밋 해시의 것이라는 점, APK23 시험 한도가 96이었다는 점(96은 APK26 설정에서만 보임).

## 미검증 위험

- **APK27 없음**: 변경 1~3의 Android 실측은 없다. APK26 증거는 전부 수정 전이다.
- **디렉터리 fsync가 영구 실패하는 FS/기기**: 시작 GC와 즉시 회수가 모두 비활성화되어 GGUF가 무한 누적되고 삭제 수단이 없다. 테스트 기기에서는 sync가 성공했으나 범용성은 미확인.
- `fs.readdir` 실패는 여전히 전체 초기화 실패로 승격된다(mkdir 성공 뒤라 가능성 낮음).
- `bootstrap.ts`가 DB 로드 전에 `await refreshLocalAI()`를 한다. 타임아웃 유무, 실패 시 `localAI.available/enabled` 기본값, 그리고 `available=false`일 때 `LOCAL_AI_PRESET`이 `makeProxiedFetch`로 어디에 요청하는지는 공급 소스에 없어 판단 불가. "자동 온라인 대체 금지"와 직접 관련되므로 다음 라운드에 소스 제시를 권한다.

실기기 설치·배포 HOLD 유지에 동의한다.
