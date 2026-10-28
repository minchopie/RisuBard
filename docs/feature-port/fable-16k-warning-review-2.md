# 16KiB 경고 수정 2차 검토 (읽기 전용, 제공 자료만 근거)

## 판정: 범위 내 수용

round1 확정 결함(A-1~A-3)은 소스+회귀 증거로 해소됐고, 증거 공백(B-1~B-4)은 제출 자료로 메워졌다. 새로 입증된 결함은 없다. ARM64 런타임(B-5)은 여전히 미실행이며 보류 준수로 수용 범위 밖에 둔다.

## A. round1 결함 해소 검증

**A-1 (무음 통과 경로) — 해소 확정.**
- 코드: 두 스크립트 모두 `await realpath(argv[1]) === await realpath(fileURLToPath(import.meta.url))`. `fs/promises.realpath`는 `realpath.native` 의미(GetFinalPathNameByHandle)라 junction·8.3 단축명·대소문자가 양쪽 동일하게 정규화된다. 로더가 `--preserve-symlinks-main` 유무와 무관하게 어느 쪽 경로를 주더라도 수렴하므로 비교가 안정적이다. 정규화 실패는 TLA 거부로 exit≠0, fail-closed.
- 회귀: `link-before.log`(86:5)는 수정 전 4K 바이너리에서 "Missing expected rejection" — 즉 exit 0으로 가드 본문이 안 돌았다는 직접 증거이자 로더가 junction을 realpath했다는 증거. `node-link-before.log`(88:5)는 verify-node 쪽 동일 결함. 두 로그의 줄 번호 차이(86→88)는 verify-node 검사 라인(`binaryArgs`·두 번째 `rejects`) 추가 전후 레이아웃과 일치해 2단계 재현 서술과 정합. `link-final.log` 4/4 통과.
- 라이브러리 import 경로: 테스트·package-runtime에서 argv[1]은 실존 메인 스크립트이므로 realpath 성공·불일치→부작용 없음. `resolve` import 제거는 verify-node 내 다른 사용처가 없어 안전.
- stdout 마커 미도입: 가드가 실제 실행되고 실패가 예외로 전파되므로 추가 불필요하다는 판단에 동의.

**A-2/A-3 (README) — 해소.** "`app/src/main`의 … `jniLibs` 파일 집합" 명시, "최종 APK 네이티브 전수 검사는 별도" 분리, 실패 지점을 "4KiB `libnode.so`를 `src/main/jniLibs`에 넣으면"으로 교정. 캐시 교체는 lock 해시 불일치로 package 단계에서 실패한다는 round1 지적과 더 이상 충돌하지 않는다.

**A-4** — flavor 없음, 변경 불요. 기록만 유지.

## B. 증거 확인

- **B-1**: `apk-reviewed-build.log`에 `:app:verifyRuntimeForDebug` → `Verified 16KiB runtime: [ 'arm64-v8a', 'x86_64' ]` → `:app:preDebugBuild` → … `packageDebug UP-TO-DATE`. 게이트는 입출력 미선언으로 매 빌드 실행(1 executed)되고 APK는 재생성되지 않아 "최종 APK 무변경" 주장과 정합. `apk-reviewed-hashes.json`의 preserved/after 동일 `b3ef9a…`.
- **B-2**: 페이지 크기 16384 기록됨.
- **B-3**: 설치본 `base.apk` SHA = `b3ef9a…` = `apk-verification.json` = 보존 APK16. 패키지명 `.debug` 접미사도 Gradle 설정과 일치. 동일 바이트 확인 후 계측 재실행 생략은 타당.
- **B-4**: 격리 fixture에서 실제 검증기가 구 바이너리를 `LOAD segment must support 16384-byte pages`로 거부. 스택 위치(verify-node.mjs:61:16, verify-runtime.mjs:19:21/26:44)가 수정 후 파일 레이아웃과 정확히 일치하고, 18행 해시 검사 통과 후 19행 정렬 검사 실패라는 흐름도 "해시 맞춘 매니페스트 + 실 ELF" 서술과 정합. 원본 라이브러리 미변경.
- **B-6**: `release-task-graph.log`(dry-run)로 `buildWeb → packageRuntime → verifyRuntime → preReleaseBuild` 체인 무변경 확인. 동시 호출은 주장·필요 모두 없음. 기존 구조의 잔여 위험으로만 남기고 차단 사유로 삼지 않는다.

## C. 신규 결함

**없음.** 비차단 메모만 남긴다(수용 조건 아님):

1. TLA 가드로 두 모듈은 import 시점에도 fail-closed다. argv[1]이 실존 경로가 아닌 호출 형태(`node -e … <비경로인자>`, `--experimental-test-isolation=none`+glob 등)에서 import 자체가 실패하고, CJS `require()`는 ERR_REQUIRE_ASYNC_MODULE가 된다. 현재 호출자(Gradle CLI, `.mjs` import, node:test 기본 프로세스 격리)에는 해당 없음. 설계 의도와 일치하므로 결함 아님.
2. `emulator-page-size.log`는 값만 있고 명령·기기 식별이 없으며, `old-real-binary-rejected.log`에는 바이너리 SHA가 찍히지 않는다. 로그 형태는 서술과 모순 없이 일치하므로 수용하되, 동일 인스턴스·동일 파일 연결은 제출자 절차 서술에 의존함을 기록한다.

## D. 수용 범위

**수용**: 경고 원인(4K LOAD) 제거, 디버그·릴리스 양 체인의 16KiB 게이트 실제 실행 및 junction 경로 무음 통과 차단, APK `b3ef9a…` 내 양 ABI 16K 레이아웃, x86_64 16K 에뮬레이터 실행 성공, 사용자 데이터·릴리스 파이프라인·Node≥22.12 호환 유지, 물리 설치 보류 준수.

**불수용 서술 유지**: "ARM64 16KiB 런타임 검증 완료"(0회 실행), 실기기 설치본이 신 APK라는 단정. 실기기의 기존 경고는 설치본이 바뀌지 않았으므로 그대로 보이는 것이 정상이며 이는 숨김과 무관한 사실 기술이다.

본 검토는 제공된 소스·diff·로그·JSON 판독만으로 이뤄졌고 어떤 실행·편집·설치도 수행하지 않았다.