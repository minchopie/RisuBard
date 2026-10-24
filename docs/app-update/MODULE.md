# NAS 앱 코드 자동 패치 모듈

일반 Android APK와 Windows 포터블의 **서버가 새로 시작될 때** 기존 NAS 설정에서 앱 코드를 확인한다. 기존 대화 동기화와 별도이며 새 계정·키·암호화·등록 절차는 없다. 앱 서버가 살아 있는 상태에서 화면만 다시 여는 동작은 새 서버 시작이 아니다. 플레이 중에는 코드 적용·강제 재시작·업데이트 팝업을 수행하지 않는다.

## 사용자 흐름

1. 이 모듈이 들어 있는 정식 APK/PC 패키지를 한 번 설치한다. 기존 앱을 삭제하거나 데이터를 초기화하지 않는다.
2. 기존 NAS 연결이 있으면 시작 시 `<저장 폴더>/.risubard-app-updates/latest.json`을 확인한다. 집/외부 경로와 기존 인증을 재사용한다.
3. 빠른 다운로드는 시작 단계에서 적용한다. 2초 안에 끝나지 않는 다운로드는 기존 버전으로 플레이하는 동안 마치고, 다음 서버 시작에 적용한다. NAS가 없거나 확인이 실패해도 기존 앱이 실행된다.
4. 파일은 임시 폴더에 내려받아 검증한다. 새 코드가 서버 기동에 성공해야 적용을 확정한다. 중단·시작 실패는 이전 앱 코드로 복구하며, 같은 실패 패치는 기존 버전으로 시작하는 회차를 사이에 두고 한 번만 재시도한다.
5. 네이티브 앱·Node·의존성·로더가 달라 호환되지 않으면 코드 패치를 적용하지 않고 기존 버전을 유지한다. 이 경우 전체 APK/PC 패키지 업데이트가 필요하며 서버 로그에 표시한다.

## 코드와 보존 경계

- `server/node/app-update/`: 고정 로더·NAS 전송·임시 준비·복구 기록. 이 로더 자체는 코드 패치 대상이 아니며 전체 패키지로 업데이트한다.
- `server/node/server.cjs`: 시작·잠금 소유·정상 기동 세 연결점. 기존 `host-bridges`가 소유한다.
- `scripts/app-update.mjs`: 공통 런타임 지문, 코드 ZIP 생성, NAS 게시. Android/Windows가 같은 지문을 사용한다.
- `EmbeddedServer.kt`·`MainActivity.kt`: 기존 Wi-Fi 정보를 시작 시 전달한다. 새 위치 권한 요청 없음.
- `portable-update.cjs`·`portable-smoke.cjs`: 전체 패키지 검증에서는 NAS 패치를 끈다.
- Windows 파일 교체 재시도는 기존 `file-store.cjs` 공통 경로, 로그 잠금은 `logs.cjs`에서 수정한다.

대화·캐릭터·페르소나·API/NAS 인증·백업·SSL 인증서는 코드 패치 대상이 아니다. `save`, `backups`, 사용자 데이터 경로, 저장 루트 결정 코드, 고정 로더는 교체할 수 없다. 새 보안 계층 대신 기존 NAS 연결을 그대로 사용하며, 해시·경로 확인은 손상 파일과 데이터 덮어쓰기를 막기 위한 것이다.

`.app-updates`에는 앱 코드만 보관한다. 교체 전에 전체 파일 목록·원본 백업·적용 기록을 기록하고 `package.json`을 마지막에 교체한다. 전체 패키지를 새로 설치한 흔적이 있으면 오래된 패치의 복구 기록으로 새 패키지를 덮어쓰지 않는다. 정상 기동 뒤에는 직전 코드 백업 하나만 남긴다. 저장 데이터 형식 변경을 포함한 패치는 이 경로로 배포하지 않는다.

## 릴리즈 작업

```powershell
# 코드 검수 후, APK/PC 패키징 전
node scripts/app-update.mjs fingerprint
# 웹 빌드 후, 새 비어 있는 출력 폴더
node scripts/app-update.mjs pack tmp/app-code-VERSION
# APK/Windows의 runtime.json 지문 동일성, 코드 ZIP·자료 보존 검증 후
node scripts/app-update.mjs publish tmp/app-code-VERSION <기존-PC-save-경로>
```

기존 PC의 보호된 NAS 설정을 읽는다. 주소·계정·비밀번호를 명령줄이나 배포 파일에 넣지 않는다. 게시 작업은 한 번에 하나만 실행한다. 임시 ZIP 업로드→다운로드 해시 검증→불변 파일 이름으로 MOVE→최신 manifest를 마지막에 게시한다. 실패 시 기존 최신판 지시자를 유지하고 무관한 NAS 파일은 삭제하지 않는다.

배포 전에 `server.cjs`의 시작·잠금·기동 연결점, 저장 스키마 무변경, 데이터 보존, 양 플랫폼 런타임 지문, 전체 모듈 재적용을 확인한다. 고정 로더가 호출하는 기존 `transfer-remote`의 request/bounded/drain, `transfer-secrets`의 createTransferSecrets, `nas-route`의 createNasRoute/detectWindows 계약도 유지해야 한다. 해당 계약이나 저장 형식이 바뀌면 전체 패키지로 배포한다. 파일 검사·격리 서버 기동·실제 NAS 왕복·Android 실기기 결과는 각각 별도로 기록한다.

CommonJS 재진입은 앱 코드를 시작하기 전에만 사용한다. 공식 동작 근거: [Node.js CommonJS 캐시](https://nodejs.org/download/release/v22.23.3/docs/api/modules.html#requirecache). 네이티브 앱 업데이트를 숨겨서 설치하는 기능은 아니다.
