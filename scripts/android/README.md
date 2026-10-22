# 독립 Android 런타임 내부 빌드

현재는 개발용 기반이다. 전송 통합·16KiB 실행·최종 공동 검수 전 정식 배포본으로 표시하지 않는다. 2026-10-17 사용자 요청에 따라 실제 태블릿·스마트폰 설치는 보류한다.

필요 도구: 프로젝트의 Node/pnpm, Python 3(표준 tarfile로 xz 추출), JDK 17, Android SDK 35, Gradle 8.9. Windows의 SDK 경로에 한글이 있으면 ASCII 경로의 junction을 `ANDROID_HOME`으로 지정한다. 개인 SDK 경로·서명키는 커밋하지 않는다.

## Node 자체 빌드

`Dockerfile.node`의 고정 Ubuntu 이미지에서 `build-node.sh arm64`와 `build-node.sh x64`를 실행한다. Node 24.21.0 소스·NDK r29의 해시와 빌드 헬퍼 커밋은 `node-build-provenance.json` 및 스크립트에 고정했다. 각 컨테이너에 `/build` 캐시 볼륨, `/export` 산출물 폴더, 이 스크립트 폴더를 연결한다. 동시 빌드의 합계 작업 수는 호스트 자원 안에서 정한다(`RISUBARD_NODE_JOBS`). 이미 실행 중인 빌드를 재실행하지 않는다.

성공 후 `/export/node-android-<arm64|x64>-24.21.0-16k.tar.xz`와 `NODE-LICENSE`가 생성된다. 파일이 존재한다는 사실만으로 성공을 판단하지 않고 해당 빌드의 종료 코드·최종 로그를 확인한다. 이전 빌드 파일이 같은 경로에 있을 수 있다.

아카이브의 정확한 멤버 `nodejs-v24.21.0-android-<arch>/bin/node`를 추출해 ARM64/x86_64 ELF와 16KiB LOAD 정렬, 동적 의존성을 검사한다. 이전 캐시를 보존한 뒤 각 아카이브를 `tmp/android-node/arm64.tar.xz`, `tmp/android-node/x64.tar.xz`로 준비하고 검증된 SHA-256만 `runtime-lock.json`에 반영한다. 현재 양 ABI lock 모두 자체 16KiB 빌드로 갱신됐고 바이너리 검사는 통과했다. x86_64는 16KiB 에뮬레이터 실행도 통과했으나 새 ARM64 바이너리 실행은 실기기 설치 보류에 따라 미검증이다.

자체 `compat/cpu-features.h`는 선택적 zlib ARM 가속을 비활성화하고 이 프로젝트의 GPL-3.0-only로 제공한다. 기능 비트는 항상 0을 반환하는 용도이며 가속을 활성화할 때 NDK 실제 비트 정의와 탐지를 함께 검증해야 한다. Node 및 사용 패치의 라이선스는 `android-app/notices/`에 보존한다.

## 내부 검사와 패키지

저장소 루트에서:

```powershell
node --test scripts/android/runtime-artifacts.node-test.mjs
node node_modules/vite/bin/vite.js build --sourcemap
node scripts/android/package-runtime.mjs
node scripts/android/verify-runtime.mjs
```

`package-runtime.mjs`는 서버·웹·공통 전송 코드와 실제 의존성을 스테이징하고 ZIP/네이티브 해시를 함께 생성한다. ZIP은 기존 yazl/Node zlib 스트리밍 경로를 사용한다. `--allow-4k-prototype`는 초기 프로토타입 재현용이며, 4KiB 바이너리는 현재 debug·release 빌드 모두 통과하지 못한다. `verify-runtime.mjs`는 `app/src/main`의 실제 ZIP 해시·모든 항목의 압축 해제/CRC·`jniLibs` 파일 집합·바이너리 해시/ABI/16KiB 정렬을 검사한다. 최종 APK에 들어간 네이티브 파일 전수 검사는 별도로 수행한다.

`android-app`에서 `gradle assembleDebug assembleDebugAndroidTest`는 준비된 런타임을 검증한 뒤 설치 없이 APK만 만든다. `preDebugBuild`도 16KiB 검사를 필수로 실행하므로 4KiB `libnode.so`를 `src/main/jniLibs`에 넣으면 빌드가 실패한다. `assembleRelease`는 웹 빌드 → 런타임 재패키징(프로토타입 허용 없음) → 검증 → Android 빌드 순서로 실행한다. 버전은 루트 `package.json`에서 파생되고(versionCode = major·1,000,000 + minor·10,000 + patch), 정식 서명은 저장소 밖 키를 `release-signing.mjs create`로 한 번 만든 뒤 `release-build.mjs`(JAVA_HOME·ANDROID_HOME·RISUBARD_GRADLE)가 보호 저장소에서 비밀번호를 읽어 환경변수로만 Gradle에 넘기고, 산출 APK의 badging·서명·zipalign 16 KiB·런타임 ZIP·원본 대조를 `apk-verification.json`에 기록한다. debug 키는 release에 쓰이지 않는다.

## 검증 범위

합성 자료로 서버 시작·기존 쿠키/JWT 연결·암호화 키 복구·이미지/Lua·스트리밍·저장·프로세스 정리를 검사한다. 4KiB 기기 결과와 16KiB 에뮬레이터 결과를 구분한다. 두 기기에 설치된 APK7과 이후 로컬 빌드를 혼동하지 않는다. 최신 상태와 아직 끝나지 않은 항목은 `docs/feature-port/STATUS.md`를 따른다.

## Android 기기 내 AI 추가 빌드

`RisuBard Offline`은 `gradle -Poffline=true assembleDebug`로 빌드한다. 앱 ID는
`app.risubard.personal.offline`(debug는 `.debug` 추가)이며 일반판의 데이터를 공유하거나
덮어쓰지 않는다. 일반 빌드에는 llama 엔진을 넣지 않는다. 공통 웹/서버 런타임 준비는 위와 같다.

엔진 빌드에는 Linux CMake, Ninja, NDK r29가 필요하다. llama.cpp의
`ea0c4c2c85fb183ec0fbd30a1af4e4275a18a064`를 checkout하고
`ANDROID_NDK_HOME`을 지정한 뒤 다음 명령을 ABI별로 실행한다.

```sh
bash scripts/android/build-local-engine.sh /path/to/llama.cpp /build/arm64 arm64-v8a /export/arm64
bash scripts/android/build-local-engine.sh /path/to/llama.cpp /build/x64 x86_64 /export/x64
```

스크립트는 고정 Git 객체에서 소스를 추출하고 프로세스 소유자 종료 가드만 entry point에
적용한다. CPU 기본 명령만 사용하고 웹 UI·OpenSSL·외부 도구 실행은 포함하지 않는다.
실제 생성된 두 ELF 파일로 다음을 실행한다. 16KiB/ABI/소유자 가드 검증을 통과한 파일만
앱의 별도 `src/offline/jniLibs`와 해시 목록으로 복사한다.

```sh
node scripts/android/package-local-engine.mjs /export/arm64/libllama-server.so /export/x64/libllama-server.so
node --test scripts/android/local-engine.node-test.mjs
node scripts/android/verify-local-engine.mjs
```

기기에서 AI 설정의 **GGUF 모델 파일 선택**으로 단일 텍스트 모델을 가져온다.
파일 선택 이후에는 외부 서버 없이 메인 대화와 앱의 보조 LLM 요청을 실행한다.
문맥/응답 길이는 이 패널에서 별도로 설정하고 온라인 모델 설정은 보존한다.
모델 준비 실패 시 온라인 API로 자동 전환하지 않는다. 모델 파일은 APK와 채팅 백업에
자동 포함하지 않으며 모델별 라이선스와 메모리 요구량을 확인해야 한다.
이미지 인식·외부 웹 검색·온라인 임베딩·NAS/GitHub 등 인터넷을 요구하는 기능까지
오프라인으로 바꾸는 것은 아니다. 확인한 범위는 `OFFLINE-ON-DEVICE-20261017.md`를 따른다.
