# RisuBard 전체 기능 패치 모듈

기존 전송·동기화와 나머지 개인 패치를 함께 다시 적용하는 도구다. 실행 코드를 재작성하거나 앱 데이터 형식을 변경하지 않는다. 기존 분리 파일은 소유 파일 목록으로, 원작 파일 수정은 기능별 패치로 관리한다.

`features.json`은 파일 소유권, `manifest.json`은 생성한 패치와 소스 해시다. `transfer-sync`의 기존 integration.patch를 먼저 적용하고 나머지 기능 패치를 순서대로 적용한다. 공유 파일의 남은 연결 코드는 `host-bridges`에 모으므로 전체 모듈이 함께 필요하다. 선택 설치·플러그인 토글 방식은 아니다.

```powershell
node scripts/fork-modules/module-stack.mjs generate
node scripts/fork-modules/module-stack.mjs verify --target base --full --logs tmp/fork-modules-base
node scripts/fork-modules/module-stack.mjs verify --target v0.9.81 --full --logs tmp/fork-modules-v081
node scripts/fork-modules/module-stack.mjs verify --target v0.9.84 --full --logs tmp/fork-modules-v084
node scripts/fork-modules/module-stack.mjs verify --target v0.9.86 --full --logs tmp/fork-modules-v086
```

v0.9.86(`5c25a31f…`) 어댑터는 `compat/v0.9.86/`에 있다. 충돌한 transfer-integration·model-compat·distribution·host-bridges와 storage-recovery만 새로 두고 나머지는 .84 어댑터나 기준 패치를 그대로 쓴다. storage-recovery는 원작 `trash-cleanup.cjs`/`.test.ts`를 targetHosts(원작 SHA)로 소유해 기본 자동삭제를 끄고(`RISUBARD_TRASH_RETENTION_DAYS` 명시 시만 정리) transaction-recovery·shutdown-recovery를 보존한다. model-compat는 기준판에 이미 있는 Wiki 프리셋·문체 7경로를 ordinary host로 소유하며 기준판 내용은 그대로이고 .86 어댑터만 기존 저장 목록·선택·문체 값을 보존한다.

모두 새 임시 체크아웃에서 실행한다. report.json의 work가 조립 결과 위치다. 설치본·save·NAS·장치는 건드리지 않는다. 원작 파일이 충돌하면 해당 기능에서 멈추며 원작 파일을 현재 포크 파일로 덮어쓰지 않는다. 새 파일도 원작에 다른 내용으로 생겼으면 중단한다. 세 대상의 `--full`은 서버 검사가 무거우므로 동시에 돌리지 말고 순서대로 실행한다.

새 패치를 만들면 features.json에 소유 파일을 등록하고 generate 후 전체 verify를 실행한다. 등록 누락·중복·원본 변경·누락된 연결 훅은 실패다. 패치 적용 성공만으로 호환 완료라 하지 않으며 --full은 서버/클라이언트/호환 검사·타입·웹 빌드를 실행한다. Android/Windows 네이티브 빌드와 실기기 전송은 별도 검증이다.

원작 v0.9.81과 v0.9.84의 충돌은 `compat/v0.9.81/`, `compat/v0.9.84/`의 호환 패치로 해결한다. 호환 패치는 원래 기능 패치를 대체하며 정확한 대상 커밋(`targetSha`)과 원래 패치 해시(`sourceSha256`)에 묶인다. 새 태그의 충돌은 별도 호환 패치를 작성·검수해야 한다. 패치의 실제 수정 경로도 담당 모듈 안인지 검사하며 LF diff만 받는다. 변경 없는 모듈에 출처 없는 어댑터를 붙이지 않는다.

`payloadTargets`는 원작과 파일 이름이 겹친 포크 문서/테스트를 다른 경로에 보존하는 명시적 대응표다. v0.9.81은 판본 문서 10개와 viewport 검사, v0.9.84는 판본 문서 13개와 viewport 검사에 사용한다. 원작 파일을 덮어쓰지 않는다. 공유 호스트를 포함한 모든 모듈을 함께 적용한다.

## 대상 전용 호스트 (`targetHosts`)

어떤 원작 파일은 한 대상 커밋에만 있고 기준판(.71)에는 없다(예: v0.9.84의 `server/node/risubard-story-order.test.ts`). 그런 파일을 그 대상의 어댑터가 고쳐야 하면 어댑터 항목에 `targetHosts: [{ path, sha256 }]`로 경로와 **원작 바이트 SHA-256**을 함께 선언한다. 현재 v0.9.84 `storage-recovery` 어댑터가 위 검사 파일 하나(원작 SHA `76395b67…94e5`)를 소유한다.

- 일반 입력이 아니다. `inventory`/`manifest.inputs`에 들어가지 않고 payload로 복사되지 않으며, 기준판·다른 대상의 패치 범위를 넓히지 않는다. report.json은 입력 수와 별도로 `targetOnlyHosts`를 기록한다.
- generate와 verify 시작(`checkedSource`)은 같은 검증을 한다: 경로 형식, 기존 hosts/files와 중복 없음, 같은 대상의 다른 어댑터와 중복 없음, 기준판 Git에 없음(`git cat-file -e base:path`), 어댑터 diff가 그 경로를 실제로 수정함, features와 manifest의 선언 일치.
- 선택한 대상 verify에서만 체크아웃된 원작 파일의 바이트를 선언 SHA와 대조한다. 최초 적용 전과, 전체 역적용 뒤 재적용 전에 각각 확인하므로 역적용이 원작 바이트를 그대로 복원했음이 증명된다. 기준판/.81 검증은 .84 Git 객체를 요구하지 않는다.
- 원작 검사 이름을 upstream probe로 추가하지 않는다. probe는 원작 원문에 있는 문구만 가능하다.

`--full`은 고정 lockfile 설치(`--frozen-lockfile`), Node 전용 검사(플레이 세트·Android 도구·기존 로컬 AI 모의 검사 포함), Vitest 전체 검사, 타입·공개 경계·웹 빌드를 수행한다. report.json에 입력 manifest 해시, 선택 패치/해시, Node/pnpm 버전과 실행 시각을 남긴다. 최신 원작 호스트는 의도적으로 바이트가 다르므로 패치 범위·호스트 훅·원작 기능 probe·전체 검사로 검증한다. 기준판만 호스트 재구성 동일성을 비교한다.

## 소스 작성본과 조립 결과의 구분

- **소스 작성본**: 이 저장소의 작업 트리 = 원작 .71 기준 커밋 + 개인 0.9.98 변경 + `compat/`. 여기서 generate를 실행하고 개인 입력을 편집한다. 작업 트리가 CRLF여도 host는 줄끝을 정규화해 비교한다.
- **조립 결과(report.work)**: verify가 선택 대상 원작 위에 패치와 payload를 얹은 임시 체크아웃이다. v0.9.84 조립본이 실제 최신 원작 런타임이며 Android/Windows 빌드 입력은 이 조립본이다. 작업 트리의 .71 파일을 .84 런타임으로 오해하지 않는다.
- 현재 조립 대상은 개인판 0.9.98이고 검증 원작은 base(.71)·v0.9.81·v0.9.84다. 이 문서의 예전 0.9.90 서술과 v0.9.81만의 호환 기록은 이력이다. 공개 릴리즈와 실제 기기 설치 결과는 구분해서 확인한다.

## 모듈 키트 (manifest closure)

다른 작업 트리로 옮길 때는 작업 트리 전체 스냅샷이 아니라 **manifest closure**만 담는다: `manifest.inputs`의 개인 입력 전부(hosts+files), `tooling`, `transfer`/`modules[].patch`/`compatibility[].patches` 경로, `features.json`, `manifest.json`. 받는 쪽은 고정 기준 커밋(`manifest.base`)을 `git -c core.autocrlf=false` 체크아웃으로 준비하고 그 위에 키트 파일만 덮은 뒤 `verify`로 inventory/해시가 맞는지 확인한다. 수정하지 않은 원작 파일은 Git이 제공하며 키트에 넣지 않는다. 작업 트리 raw 스냅샷(ZIP)은 원작 파일의 줄끝/미소유 파일 때문에 inventory 검사를 통과하지 못하므로 참고용일 뿐 유효한 키트가 아니다. 대상 전용 호스트 원문은 대상 Git 체크아웃이 제공한다.

이 도구는 기존 개인 포크 소스와 기준 Git 커밋이 있는 작업 트리에서 실행한다. 새 clone의 Git 줄끝 설정이 다르면 원본 바이트 해시가 달라 검사가 중단될 수 있다. 변경을 확인한 뒤 `generate`로 해당 clone의 manifest를 다시 만들고 검사한다. 해시를 무시하거나 앱 파일을 원작 위에 통째로 복사하지 않는다.

기존 Local AI 파일은 기존 기능 보존을 위해 남긴다. 기능을 활성화하거나 모델을 내려받는 작업은 하지 않는다. `history-docs`는 기존 문서/판본 이력이며 앱의 동작 모듈과 구분한다.

현재 검증과 인계는 [크로스오버](CROSSOVER-20261024.md)를 따른다.

새 clone은 `git -c core.autocrlf=false clone <개인 포크 URL>`처럼 패치 파일의 LF를 유지해서 준비한다. 이미 CRLF로 바뀐 호환 패치는 검수한 LF 원본으로 복원한 뒤 generate/verify를 실행한다. 전역 Git 설정을 바꿀 필요는 없다.

0.9.90의 열 번째 모듈 `app-update`와 Windows 로그 수정의 검수·보존·배포 경계는 [NAS 앱 패치 크로스오버](../app-update/CROSSOVER-20261024.md)를 따른다.
