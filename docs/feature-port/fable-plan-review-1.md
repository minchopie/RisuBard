# Fable plan review 1

Model: claude-fable-5-1; effort: xhigh. Read-only review of supplied sources and user requirements. This is not implementation/device approval.

도구 없이, 제공된 대화·소스 발췌만으로 검토했다. 입력에 없는 코드·실기기 결과는 전제하지 않았다.

# 1) 판정: **Request Changes**

계획의 방향(독립 APK, 별도 설치, 기억 포함 전송, 비공개 repo 백업, 공동 검수)은 사용자 확정과 일치한다. 그러나 아래 때문에 지금 상태로 구현에 들어가면 중복·재작업 위험이 크다.

1. **최대 위험을 단일 해법으로 못 박았다.** "Node 24를 NDK로 빌드해 APK에 포함"은 Codex가 고른 수단이지 검증된 사실이 아니다. 입력 증거는 `package.json engines >=22.12.0`과 Termux 가이드(`nodejs-lts`, clang/make/python으로 네이티브 모듈 컴파일)뿐이다. 빌드 가능성, 런타임에 실제 필요한 네이티브 모듈, 16KiB 정렬, WebView의 `http://localhost` 처리 모두 미검증이다. 실패 시 절차가 "보고"뿐이고 사용자 결정 분기가 없다.
2. **형식 결정(`.risuplay v2`)이 RisuBard 기존 경로 확인 전에 내려졌다.** 증거상 RisuBard에는 `wikiTransferPackage.ts`(risubard-wiki v1), `importBackup`/`exportBackup`, `.bin`·save-folder 병합 가져오기, `new-character-packages.test.ts`·`live-character-files.test.ts`가 존재한다. 이들을 보기 전에 새 형식을 만들면 사용자가 요구한 "중복 없이"를 어긴다.
3. **"채팅의 기억"의 저장 단위가 정의되지 않았다.** 정본 디렉터리에 `characters`와 `risubard`가 분리돼 있고, 위키 패키지는 "사건·아크 플롯은 새 챗으로만", 제목 충돌 시 거부, scene 1개 제한을 둔다. 기억이 캐릭터 단위라면 "같은 캐릭터에 채팅만 추가 + 기억 유지"가 이 충돌 규칙과 바로 모순된다. "저장 시점"의 실체(파일·필드)도 미정의다.
4. **구 앱 → RisuBard 1회 이전 경로가 빠졌다.** 사용자가 고른 "별도 설치, 새 앱에서 자료를 복사해 확인"은 이 경로를 전제한다. RisuBard 문서의 `.bin` 가져오기와 risuChat JSON 읽기가 후보지만 계획에 없다.
5. **전송 기능을 어느 계층에 두는지 매트릭스가 없다.** 구 환경은 Android Java + PC C# 헬퍼 + 공통 TS였지만, RisuBard는 PC·Android 모두 같은 Node 서버를 돌린다. 계층을 정하지 않으면 PC 쪽 NAS·GitHub·Wi‑Fi가 헬퍼와 앱에 이중 구현된다.
6. **공동 검수가 구현 후 1회뿐이다.** 런타임 게이트·기능 인벤토리·형식 결정 시점에 검수가 없으면 큰 재작업으로 이어진다.

# 2) MUST(사용자 확정) vs 구현 선택

| 구분 | 항목 | 근거 |
|---|---|---|
| **MUST** | 독립 APK, 별도 설치(구 앱·데이터·설정 그대로) | 사용자 확정 답변 |
| **MUST** | RisuBard↔RisuBard 전송에 채팅의 BardWiki 기억·저장 시점 포함 | 사용자 확정 답변 |
| **MUST** | 대화 백업은 기존 비공개 `RisuAI-Mobile-Private` | 사용자 확정 답변 |
| **MUST** | 같은 캐릭터면 채팅만 추가, 카드 덮어쓰기 없음, 가져온 뒤 화면 강제전환·이어하기 팝업 없음 | 사용자 정정 원문 |
| **MUST** | NAS·같은 Wi‑Fi·USB(adb 내장, IP 선택, PIN 없음)·파일/공유·GitHub(같은 대화 최신 1개 유지)·요청 로그 열람·모바일 여백/하단 입력창·버튼 통합 UI | 기존 기능 목록, "축소 금지" |
| **MUST** | 기존 앱 ID·서명·PC 프로필·개인정보·API 연결 무변경 | KEEP, CODEX_HANDOVER |
| **MUST** | 계획·구현 후 Fable 5.1 xhigh 공동 검수, Ponytail ultra | 사용자 지시 |
| 선택 | Node **24** NDK 빌드 | engines는 ≥22.12. 버전·입수 방법은 스파이크로 결정 |
| 선택 | `.risuplay v2` 신설 | RisuBard 기존 패키지 경로 확인 후 결정 |
| 선택 | 버전 0.9.72, 앱 ID `app.risubard.personal`, 브랜치명 | 임의값. 0.9.72는 upstream 충돌 위험 |
| 선택 | 기존 USB 서명키 재사용 | 키를 새로 만들지 않는 쪽이 작음. 유지 가능 |
| 선택 | 업데이트 대상 `minchopie/RisuBard`로 교체 | 업데이터 코드 자체가 증거에 없음 |
| 선택 | 루프백 바인딩 + "앱 인스턴스 인증" | `AutoStorage.createAuth()`가 존재. 새로 만들지 말고 재사용 여부 확인 |
| 선택 | 구형 앱으로 보내는 "호환 내보내기" | 사용자는 구 앱을 보관만 함. 필요성 미확인 |
| 선택·주의 | 공개 저장소 코드에 비공개 repo 이름 하드코딩 | 저장소 **이름**이 공개됨. 사용자 확인 필요 |

# 3) 반드시 고칠 점과 최소 수정안

1. **런타임 게이트를 "해법 확정"이 아니라 "시간제한 스파이크 + go/no-go"로 바꾼다.** 후보를 작은 순서로 시도: ① Node ≥22 Android aarch64 프리빌트가 있으면 그것(nodejs-mobile 최신 릴리즈 재확인, Termux 패키지 바이너리의 재배치·라이선스 가능성 확인), ② 없으면 **Node 22 LTS**(engines 최소값) 소스 빌드. 통과 기준은 Codex가 쓴 것(시작→표본 저장→재시작 복원→모의 스트리밍→16KiB)에 **"프로덕션 node_modules의 `.node` 바이너리 목록과 server.cjs 로드 여부"**, **"백그라운드 전환 시 프로세스 생존/스트리밍 중단 동작"**을 추가. 실패 시 Codex가 대체하지 말고 사용자가 선택(추가 시간 / Termux 의존 방식 / 중단).
2. **형식 결정 전 "저장 단위 확인" 단계 추가.** 실제 데이터 루트에서 한 채팅의 BardWiki·저장 시점이 어느 파일(`characters/<dir>/chats/<id>/…` vs `risubard/…`)에 있는지 확인하고 "저장 시점"을 파일·필드로 정의한다. 캐릭터 단위라면 "같은 캐릭터에 채팅 추가 시 기억은 어떻게 합치는가"를 사용자에게 질문한다(위키 충돌 규칙 때문에 자동 병합 불가).
3. **형식은 한 개만.** NAS·GitHub·파일·Wi‑Fi·USB 모두 같은 패키지 파일을 나른다. 우선순위: RisuBard에 이미 캐릭터/채팅 단위 패키지(`new-character-packages`)나 부분 백업 병합 경로가 있으면 그것을 확장 → 없으면 기존 `.risuplay`에 `kind` 추가 수준의 최소 확장. "GitHub용 묶음"을 세 번째 형식으로 만들지 않는다.
4. **구 앱 → RisuBard 1회 이전 경로를 명시.** 후보: 구 앱 전체 백업(`.bin`) → RisuBard `.bin` 가져오기, 구 앱 `.risuplay v1`/risuChat JSON → RisuBard 읽기. 자동 실행 금지는 유지. 사용자 실데이터로는 사용자 기기에서만 확인.
5. **계층 매트릭스 작성(전송 5종 × Android/PC RisuBard/PC 헬퍼).** 원칙: 네트워크 로직(NAS·GitHub·Wi‑Fi)은 양 플랫폼이 공유하는 Node/TS 한 곳, OS API가 필요한 것(adb, Android 공유창·SAF, 키 저장)만 네이티브. 자격정보 저장은 RisuBard의 기존 `secrets` 저장소를 쓰고, 전송 파일·로그·요청 로그에서 제외한다는 기존 보증을 그대로 옮긴다.
6. **공동 검수 4회로 분할:** (a) 인벤토리+런타임 게이트 결과, (b) 저장 단위·형식 결정, (c) 구현 diff+테스트, (d) 실기기 로그. (c)·(d)는 사용자 요구의 "구현 후 검수"에 해당한다.
7. **Wi‑Fi 리스너는 앱 서버와 별개임을 명시.** 앱 서버는 루프백, 전송 리스너만 LAN.

# 4) 불필요한 구현(제거 또는 보류)

- **WebView 요청 로그 화면 별도 이식**: RisuBard에 `request-logs`가 정본으로 있음. 네이티브 계층 실패(SSL·페이지 로드)만 작게 남기거나 생략. 사용자 요구는 "볼 수 있게"이며 충족됨.
- **구형 앱으로 보내는 호환 내보내기**: 사용자 선택은 구 앱 보관. 요청 전까지 안 만든다(사용자 확인 1줄).
- **"앱 인스턴스 인증" 신규 작성**: `createAuth()` 재사용 가능성부터 확인.
- **Android 인앱 업데이터**: 기존 앱도 수동 APK 설치였다. Windows 업데이터만 upstream을 가리키는 경우 대상 1줄 수정.
- **package.json 0.9.72 범프**: upstream과 번호가 겹친다. 버전은 그대로 두고 릴리즈 태그(예: `android-usb-v1.4.1` 방식 계승)와 APK versionName 접미사로 구분.
- **"같은 이름 여러 개면 대상 선택" 신규 UI**: `applyCharacterChats`가 이미 예외로 요구함. 기존 흐름 재사용.
- **이중 저널**: `ImportQueue` 저널과 RisuBard 저장 저널이 겹치면 하나만. RisuBard 저장 경로가 트랜잭션 마커를 제공하면 `ImportHost.committed`에 연결만.
- **PC 헬퍼의 GitHub/NAS 탭**: PC RisuBard가 Node로 직접 하게 되면 중복. 헬퍼는 adb/USB·파일 열기로 축소(기능 축소가 아니라 위치 통합).

# 5) 수정한 단계별 계획(가장 작은 완전한 순서)

0. **인벤토리(읽기 전용, 병렬)**: 구 앱 문서·테스트·네이티브·헬퍼에서 기능 목록 → "RisuBard에 있음 / 공백 / 저장 구조로 대체" 표. 안정성 패치는 RisuBard 코드에서 해결 여부 대조. → 검수 (a).
1. **런타임 스파이크(병렬, 시간제한)**: 3)-1 기준. 데이터 루트는 앱 전용 내부 경로(`/sdcard` 거부 규칙 준수). → 검수 (a). 실패 시 사용자 결정.
2. **저장 단위·형식 결정**: 3)-2, 3)-3. 구 앱 → 새 앱 이전 경로 확정. → 검수 (b).
3. **Android 외피**: 새 앱 ID, 기존 WebView·SAF·공유·키보드 코드 재사용, Node 시작/종료, 루프백+기존 인증.
4. **전송 이식(각각 테스트 동반)**: 파일/공유 가져오기(공통 기반) → NAS → GitHub(비공개 검사·조건부 갱신·최신 1개·기존 `latest-*.json` 읽기) → 같은 Wi‑Fi → USB/adb 헬퍼. 수신은 검증→대기→적용→저장, 팝업·화면 전환 없음.
5. **UI 공백 보완**: 1.4.1의 "대화 선택→방법→보내기/받기" 한 화면, 여백·하단 입력창은 RisuBard에 없는 것만.
6. **릴리즈 파이프라인**: `check:public-boundary`에 기기명·NAS·개인 문서 패턴 추가, 비공개 저장소 이력 미포함, 해시·서명·검수 기록 첨부, 업데이터 대상 확인.
7. **검증·검수 (c)(d)** 후 게시 → 두 기기 설치 → 사용자 실데이터 왕복은 사용자 확인 항목으로 분리.

# 6) 계획만으로 확정할 수 없는 검증 gate

- Android: Node ≥22 실행 가능 여부, 필요한 `.node` 모듈, 16KiB 정렬, APK 크기·콜드스타트(TB710FU), WebView에서 `localhost` secure context·`crypto.subtle`, 백그라운드 프로세스 생존.
- 데이터: BardWiki·저장 시점의 실제 파일 위치와 단위, 위키 충돌 규칙과 "채팅만 추가"의 양립, 16 MiB 위키 vs GitHub 8 MiB 한도, RisuBard의 risuChat v2/`.risuplay v1`/`.bin` 읽기 실제 동작.
- 전송: 새 앱 ID에서 adb 경로(앱 전용 디렉터리 접근 방식), Wi‑Fi 포트·탐색 양 기기, NAS WebDAV 실연결, GitHub 실토큰(시험 자료만).
- 호환·공개: upstream 버전 충돌, GPL‑3.0 하에서 Java/C# 코드 공개 가능 여부(사용자 소유 코드면 가능), 비공개 repo 이름 노출 허용 여부.
- 모두 정적 승인과 별개로 실기기 로그로만 닫힌다.

**건너뛴 것/위험:** RisuBard 서버·클라이언트 내부(`NodeStorage`, 위키 저장 경로, 업데이터, 기존 패키지 가져오기)는 발췌만 봤고 실제 코드는 미확인이라 2)·4)의 "재사용 가능"은 후보이지 확정이 아니다. 가장 큰 위험은 런타임 게이트 실패 시 "독립 APK"를 충족할 수단이 없을 수 있다는 점이며, 그 결정은 Codex가 아니라 사용자가 내려야 한다.
