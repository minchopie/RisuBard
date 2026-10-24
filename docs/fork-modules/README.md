# RisuBard 전체 기능 패치 모듈

기존 전송·동기화와 나머지 개인 패치를 함께 다시 적용하는 도구다. 실행 코드를 재작성하거나 앱 데이터 형식을 변경하지 않는다. 기존 분리 파일은 소유 파일 목록으로, 원작 파일 수정은 기능별 패치로 관리한다.

`features.json`은 파일 소유권, `manifest.json`은 생성한 패치와 소스 해시다. `transfer-sync`의 기존 integration.patch를 먼저 적용하고 나머지 기능 패치를 순서대로 적용한다. 공유 파일의 남은 연결 코드는 `host-bridges`에 모으므로 전체 모듈이 함께 필요하다. 선택 설치·플러그인 토글 방식은 아니다.

```powershell
node scripts/fork-modules/module-stack.mjs generate
node scripts/fork-modules/module-stack.mjs verify --target base --full --logs tmp/fork-modules-base
node scripts/fork-modules/module-stack.mjs verify --target v0.9.81 --full --logs tmp/fork-modules-upstream
```

모두 새 임시 체크아웃에서 실행한다. report.json의 work가 조립 결과 위치다. 설치본·save·NAS·장치는 건드리지 않는다. 원작 파일이 충돌하면 해당 기능에서 멈추며 원작 파일을 현재 포크 파일로 덮어쓰지 않는다. 새 파일도 원작에 다른 내용으로 생겼으면 중단한다.

새 패치를 만들면 features.json에 소유 파일을 등록하고 generate 후 전체 verify를 실행한다. 등록 누락·중복·원본 변경·누락된 연결 훅은 실패다. 패치 적용 성공만으로 호환 완료라 하지 않으며 --full은 서버/클라이언트/호환 검사·타입·웹 빌드를 실행한다. Android/Windows 네이티브 빌드와 실기기 전송은 별도 검증이다.

최신 원작 v0.9.81의 충돌은 `compat/v0.9.81/`의 호환 패치로 해결했다. 호환 패치는 원래 기능 패치를 대체하며 정확한 대상 커밋과 원래 패치 해시에 묶인다. 새 태그의 충돌은 별도 호환 패치를 작성·검수해야 한다. 패치의 실제 수정 경로도 담당 모듈 안인지 검사하며 LF diff만 받는다. 변경 없는 모듈에 출처 없는 어댑터를 붙이지 않는다.

`payloadTargets`는 원작과 파일 이름이 겹친 포크 문서/테스트를 다른 경로에 보존하는 명시적 대응표다. 현재 v0.9.81의 판본 문서 10개와 viewport 검사에만 사용한다. 원작 파일을 덮어쓰지 않는다. 공유 호스트를 포함한 모든 모듈을 함께 적용한다.

`--full`은 고정 lockfile 설치(`--frozen-lockfile`), Node 전용 검사(플레이 세트·Android 도구·기존 로컬 AI 모의 검사 포함), Vitest 전체 검사, 타입·공개 경계·웹 빌드를 수행한다. report.json에 입력 manifest 해시, 선택 패치/해시, Node/pnpm 버전과 실행 시각을 남긴다. 최신 원작 호스트는 의도적으로 바이트가 다르므로 패치 범위·호스트 훅·원작 기능 probe·전체 검사로 검증한다. 기준판만 호스트 재구성 동일성을 비교한다.

이 도구는 기존 개인 포크 소스와 기준 Git 커밋이 있는 작업 트리에서 실행한다. 새 clone의 Git 줄끝 설정이 다르면 원본 바이트 해시가 달라 검사가 중단될 수 있다. 변경을 확인한 뒤 `generate`로 해당 clone의 manifest를 다시 만들고 검사한다. 해시를 무시하거나 앱 파일을 원작 위에 통째로 복사하지 않는다. 현재 조립 대상은 개인판 0.9.90이다. 공개 릴리즈와 실제 기기 설치 결과는 구분해서 확인한다.

기존 Local AI 파일은 기존 기능 보존을 위해 남긴다. 기능을 활성화하거나 모델을 내려받는 작업은 하지 않는다. `history-docs`는 기존 문서/판본 이력이며 앱의 동작 모듈과 구분한다.

현재 검증과 인계는 [크로스오버](CROSSOVER-20261024.md)를 따른다.

새 clone은 `git -c core.autocrlf=false clone <개인 포크 URL>`처럼 패치 파일의 LF를 유지해서 준비한다. 이미 CRLF로 바뀐 호환 패치는 검수한 LF 원본으로 복원한 뒤 generate/verify를 실행한다. 전역 Git 설정을 바꿀 필요는 없다.

0.9.90의 열 번째 모듈 `app-update`와 Windows 로그 수정의 검수·보존·배포 경계는 [NAS 앱 패치 크로스오버](../app-update/CROSSOVER-20261024.md)를 따른다.
