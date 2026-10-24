# Fable 5.1 xhigh · 실제7차 검수

CLI exit0/is_error=false/modelUsage claude-fable-5-1. 결과는 아래 범위에 한정한다.

## R6 최종 후속 재검토 (소스·증거 기반, 실기기/배포 판단 제외)

### 1. 변경 3건 소스 확인 결과

**1) 정리 경고 `||=`** — 확인됨. `lastError ||= '일부 임시 모델 파일을 정리하지 못했어요. 저장 공간을 확인해 주세요.'`는 앞서 설정된 손상 설정 경고(`모델을 다시 선택해 주세요`)와 sync 경고(`이전 모델 파일을 보존했어요`)를 덮어쓰지 않습니다. "기존 모델과 대화는 계속 사용할 수 있어요" 단정 문구도 제거되었습니다. 회귀 테스트(`a cleanup warning does not hide corrupt-settings recovery instructions`)는 `.part` 디렉터리 + `'broken'` 설정으로 실제 경로를 재현하며, `fs.rm(dir, {force:true})`가 비재귀라 ERR_FS_EISDIR로 실패하는 전제도 맞습니다. 수정 전 증거(`corruptInstructionLost: true`)와 일치합니다.

**2) 설정 선독 후 실행 파일 검사** — 확인됨. `readFile(settings.json)` → `validateSettings` → 모델 레코드 검증이 `fs.access(executable, X_OK)` 앞에 위치하고, 초기화 경로에 쓰기(`persist`)가 없습니다. 실행 파일 부재 시 `config`는 저장값(enabled=false, 2048/32)을 유지한 채 `initializationError`만 설정되고, `settings(enabled=false)`는 `idle(true)`를 통과해 세션 한정으로만 반영됩니다. 테스트의 `savedOnline` 블록이 상태값과 파일 불변을 모두 검증합니다. `beforeStored`(true/4096/512) 증거와 대비됩니다.

**3) 클라이언트 상태 GET 시간 제한** — 확인됨. `AbortSignal.timeout(5000)`은 `refreshLocalAI`의 `init`에만 실리고, `authFetch`는 `...init`으로 signal을 fetch에 전달하므로 다른 authFetch 호출에는 영향이 없습니다. Offline UA에서 `available=false`는 `Object.assign` 이전에 throw되어 기존 상태를 유지하고, 일반판은 그대로 수용합니다. 테스트 3건은 각 분기를 1:1로 커버합니다.

### 2. 검증된 결함

**차단 수준 결함 없음.** 아래는 경미한 정확성/표현 문제입니다.

- **a. 경고 병합 시 정보 손실(설계적 선택)**: `||=`로 인해 손상 설정 경고 또는 sync 경고가 있으면 `.part` 정리 실패 사실은 사용자에게 전달되지 않습니다. 복구 안내 보존이 우선이라는 판단은 타당하나, 한 번에 하나의 경고만 노출된다는 점은 문서에 명시할 가치가 있습니다.
- **b. 손상 설정 + 실행 파일 부재 조합**: `lastError`가 먼저 손상 경고로 설정되지만 외부 `.catch`에서 `error.message`로 덮어써져 실행 파일 오류만 보입니다. 실행 파일 복구 후 재시작 시 손상 경고가 다시 나타나므로 순서상 자연스럽지만, 두 문제가 동시 존재한다는 사실은 숨겨집니다.
- **c. 새 정리 경고 문구**: "저장 공간을 확인해 주세요"는 EISDIR/EACCES 원인(디렉터리, 권한)에 대한 안내로는 부정확합니다. 단정 문구 제거 자체는 올바릅니다.
- **d. 부트스트랩 오류 표시**: `localAI.error = String(error)`는 `"Error: ..."`/`"TimeoutError: ..."` 접두어를 그대로 노출합니다(기존 코드이지만 신규 Offline 오류/timeout 메시지가 이 경로로 들어오게 됨).
- **e. 테스트명 과장**: `failed status lookup preserves the last explicit mode`는 사전에 `state.enabled=false`를 둔 상태만 검증합니다. 실제 부팅 시 "유지되는 상태"는 빌드 기본값(`enabled: isOfflineBuild`=true)이므로, 서버에 enabled=false가 저장된 사용자가 timeout을 겪으면 UI는 기기 내 AI 모드로 뜨고, 첫 전송은 relay의 `config.enabled=false` 검사로 409가 납니다. 온라인 자동 전환이 아니라는 원칙과는 부합하나, "마지막 명시적 선택 보존"이라기보다 "오프라인으로 fail-closed"가 정확한 설명입니다.

### 3. 미검증 위험

- `refreshLocalAI`의 다른 호출처(설정 패널 등)가 제시되지 않았습니다. Offline 빌드에서 새 throw 분기가 해당 UI에서 어떻게 처리되는지 확인되지 않았습니다.
- 5초 타이머는 `forageStorage.Init()`·`checkAuth()`·`createAuth()` 이전에 시작됩니다. 사용자 스스로 인정한 대로 전체 부팅 보장은 아니며, 역으로 저사양 기기에서 인증 단계가 길어지면 네트워크 호출 전에 TimeoutError가 날 수 있습니다. Android 임베디드에서 `checkAuth`가 사용자 입력을 기다리지 않는지는 제시 소스로 확인 불가합니다.
- 테스트 3은 `AbortSignal.timeout`을 mock하고 `localAIRequest`를 mock하므로 `authFetch`→`fetch` 전달은 소스 육안 확인에 의존합니다(소스상 `...init` 전개는 명확).
- APK27 증거는 모두 R6 최종 수정 이전 빌드이며, 정리 경고 문구가 구 문구임이 이를 확인해 줍니다. 수정 1·2·3의 실기기 효과는 APK28 검증 전까지 소스+단위 테스트 수준입니다.

### 4. 기존 수용 제한(변경 없음, 재확인)

- 손상 설정 후 `persist(..., preserveUnlinkedModels=true)`로 고정되어 성공적 import 전까지 orphan `.gguf` 보존 — 코드상 그대로.
- 성공적 `start()`가 `lastError=''`로 모든 경고(sync 경고 포함)를 지움 — 기존 동작.
- EACCES 등 raw 오류 메시지 노출(APK27 `before` 증거) — 기존.
- 빈 버블(최종 채팅 Turn 4·9), 문맥 초과 422, 진행 중 생성 journal 없음 — 문서화 범위 그대로.

### 5. 증거 정합성

서버 12건은 테스트 파일 내 12개 `test(` 블록과 수가 일치하며 신규 테스트가 포함됩니다. Linux durability 3건 skip 0으로 실제 POSIX 경로 실행이 확인됩니다. 클라이언트 139건은 구성 세부를 검증할 수 없으나 집중 파일 3건 포함은 소스로 확인됩니다. `r6-before-proof.json`의 두 플래그는 각각 수정 1·2의 수정 전 결함과 대응합니다.

**요약**: 서술된 3건은 소스와 테스트가 주장대로 구현되었고 직접 회귀는 발견되지 않았습니다. 위 2-a~e는 문서/문구 수준이며, 3항 미검증 항목은 APK28 실기기 검증과 `refreshLocalAI` 호출처 확인으로 닫아야 합니다.
