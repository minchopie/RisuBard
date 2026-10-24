# Fable plan review 3

Model: claude-fable-5-1; effort: xhigh. Read-only review of supplied sources and user requirements. This is not implementation/device approval.

# 3차 독립 검수 — 판정: **계획 승인(계획상 차단 0건)**. 구현·실기기 성공 승인 아님

도구·파일 변경 없이 제공된 발췌와 대화만 대조했다. 사용자 확정 범위(독립 APK·별도 설치·기억+저장 시점 전송·비공개 repo·4회 공동검수·축소 금지)와 모순되는 결정은 없고, 2차 차단 1건은 증거와 맞게 닫혔다. 사용자에게 새로 물을 항목은 없다.

## 1. 2차 차단(서버/클라이언트 commit 경계) 해소 확인
- 수정안 2절 (1)~(4)는 2차 최소수정과 일치한다: ID 선확정 → 서버 staging(forkToken, finalize 보류) → 클라이언트 내부 함수로 append → flush 확인 → finalize. `importChatsToCharacter`의 chat.id 재발급(316-318)에 사전 idMap을 주입하는 것은 2차가 제시한 두 순서 중 "id 확정이 staging에 앞서는" 쪽이며 기존 fork API 범위다.
- "(3) canonical flush 완료 확인"은 새 증거 `NodeStorage.flushDatabase:247-257`(`/api/db/flush?mode=canonical`, 쓰기와 같은 갱신 인증, import install용 cancellable signal)로 뒷받침된다. 즉 클라이언트가 durable 여부를 확인할 기존 입구가 실제로 있다.
- ImportTransaction owner에 chat 추가, 서버 수신기록과 저널 단일화, `importPackageToCharacter` 래퍼(alertConfirm/alertWait) 제외, "helper는 DB 직접 수정 없음" 유지 — 모두 반영. 문제였던 "서버 한 경로" 문장은 사라졌다.

## 2. 비차단 권고 반영 확인
- Node: 프리빌트 ≥22.12 → 24 NDK → 22 LTS 1회 → 사용자 결정. 임의 축소 없음. 반영.
- 8 MiB: `GitHubChatUpload.kt:203 MAX_BYTES=8*1024*1024`로 자체 한도임이 확인됐다. 구 JSON 경로는 유지, v2는 공식 Contents 한도 안에서 단일 파일·Node 스트리밍 업로드·immutable raw 해시검증. 축소·조각 프로토콜 없음. 100,000,000바이트는 문서상 100 MiB보다 보수적이므로 안전하다.
- 해시: `createHash('sha256')…digest('hex')`(147)로 2차 gate였던 "`SavedFileEntry{path,hash,size}` 재사용"의 근거가 확정됐다. 바이너리/JSONL/Markdown→blobs, 메타/ref map→records는 `protocol.ts:120`과 일치.
- 중복 판정(출처 ID+로컬 적용기록), 수정본은 새 채팅으로 보존, 미참조 페이지만 정리, 기존 캐릭터/채팅/에셋 미삭제 — 데이터 보존 규칙과 모순 없음.

## 3. 남은 실행 전 모호성 — 차단 아님, (a)/(b) 검수에서 문장만 확정
1. **복구 판정 주체**: "durable chat이 예정 ID/hash로 확인되면 finalize 재개"에서 확인 주체를 **클라이언트(DB 로드 후)** 로 명시할 것. 서버가 판정하려면 2차에서 배제한 DB blob 디코드가 다시 필요해진다. 서버는 flush 완료 여부와 staging 상태만 답한다.
2. **첫 실행 인증**: `checkAuth:629-633`의 incorrect 분기는 `alertInput` 모달이다. native가 secret을 listen 전에 공급하면 `unset`(3537)은 피하지만, WebView가 success 분기에 들어가도록 하는 기존 입구(JWT `risu-auth` 헤더 선주입 또는 session cookie 3541-3547) 중 하나를 Android 조건부로 지정해야 비밀번호 프롬프트가 뜨지 않는다. 또한 Keystore secret 유실(기기 복원·자격 변경) 시 native가 listen 전에 credential을 재공급해 자기 데이터가 잠기지 않도록 규정할 것. 서버 password 저장 위치는 발췌에 없어 (a)에서 확인. 데이터 보존과 직결되므로 gate 항목으로 올린다.
3. **(3)~(4) 사이 비노출**: "정상 목록에 노출"이 새 chat 스키마 필드(draft 플래그)를 뜻하지 않고, 배타 구간 + "복구를 편집/자동저장 전에" 순서로 달성한다고 적을 것. 그래야 storage/compat 검사와 구 앱 호환이 그대로 유지된다.
4. **1회 이전 범위**: 구 앱(a2641e7d)에 Bard workspace/슬롯 파일이 존재하는지 인벤토리에서 확정. 있다면 전체 .bin 외 파일계도 동반해야 "저장 시점 보존"이 성립한다. 없다면 현 계획대로 충분하다.

네 항목 모두 기존 코드 입구를 쓰는 범위이며 새 선택지가 아니다.

## 4. 미완료 명시
- 코드 변경 0, 빌드 0, 장치시험 0. Node aarch64 바이너리 미확보, 16 KiB page size 미측정, WebView loopback secure context 미확인, GitHub 실업로드·100 MB 경계·413 미검증(제공 근거도 "미시험"), chat.bin 리매핑 후 실제 슬롯 load 미확인, Wi‑Fi/NAS/USB 실연결 미확인.
- 따라서 이 승인은 "계획 문서가 사용자 요구·소스 증거와 모순 없이 실행 가능 상태"라는 의미다. (a)~(d) gate 통과 전에는 stable 완료로 게시할 수 없고, 실기기 미연결이면 "실기기 검증 미완료"로 표시해야 한다.

## 5. 한계
서버 `/api/db/flush` 라우트 본문, password 저장, ImportTransaction rollback 세부, 구 앱의 Bard 파일 유무는 발췌에 없다. 반대 증거가 있으면 §3 각 항목을 해당 코드로 반박하면 되며, 그 경우에도 "클라이언트의 다음 저장이 덮어쓰지 않는가"는 여전히 답해야 한다.
