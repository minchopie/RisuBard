# 캐릭터·페르소나 배포 알림 (content-updates 모듈)

0.9.90-ver1에서 추가. 한 기기에서 캐릭터 카드나 페르소나 PNG를 NAS에 한 번 올리면, 같은 NAS 설정을 쓰는 다른 기기가 앱을 열거나 다시 돌아올 때 「새 캐릭터 카드가 올라왔어요. 지금 가져올까요? [네, 가져오기] [아니오]」를 묻는다.

## 동작

- **올리기**: 설정 > 시스템 > 백업 > 캐릭터·페르소나 배포 (NAS) (NAS 동기화 칸 아래). charx·json·png·risup을 고르면 이름·버전을 읽고(charx는 card.json, png는 persona/ccv3/chara 텍스트 청크), 배포 이름(기본: 캐릭터는 이름에서 버전과 끝의 "ver"를 뺀 것, 페르소나는 이름 그대로)을 정해 올린다. 같은 배포 이름으로 다시 올리면 그 항목이 새 판으로 바뀐다. 올린 기기는 그 판을 「올림」으로 기록해 묻지 않는다.
- **묻기**: Node/임베디드 런타임(PC 앱·Android 앱)에서 시작 8초 뒤 한 번, 앱이 다시 보일 때 10분 간격으로 확인한다. 화면 준비 전, 전송·동기화 적용 중, 응답 생성 중, 가져오기 진행·복구 대기 중, 다른 창이 떠 있을 때는 묻지 않는다. 묻는 창을 답 없이 닫으면 다음 확인 때 다시 묻는다.
- **네**: 파일을 받아 크기·SHA-256을 확인한 뒤 앱의 원래 가져오기로 들여온다.
  - 캐릭터: 원작 `importCharacterProcess` → 원작 0.9.90의 「설치된 봇 업데이트」 대화상자(후보 선택·변경 검토). 같은 캐릭터를 고르면 대화·채팅 폴더는 그대로 두고 카드 내용만 합치며, 바꾸기 전 카드는 휴지통에 3일 보관된다. 「새로 설치」·「취소」도 원작 그대로다. 취소하면 「아니오」로 기록한다.
  - 프롬프트 프리셋(0.9.92-ver1): 원작 `importPreset`로 읽는다(.risup·.risupreset·.preset.json). 같은 이름의 프리셋이 있으면 그 프리셋을 새 내용으로 바꾸되 id는 유지하고(채팅·봇 연결 유지), 내보낸 프리셋에서 비어 있는 이 기기의 연결값(API 키·프록시 키·주소 6개)은 그대로 둔다. 지금 쓰는 프리셋이면 활성 값도 새 내용으로 다시 불러온다. 이름이 다르면(버전이 이름에 들어 있으면 새 판도) 새로 추가하고, id는 배포 이름과 프리셋 이름으로 정해 모든 기기에서 같게 한다(NAS 동기화가 갈라지지 않게). SillyTavern 프리셋은 원작이 붙이는 공통 이름 대신 올린 파일 이름을 쓴다. JSON은 이름이 아니라 내용(카드 필드/프리셋 필드)으로 캐릭터와 프리셋을 가른다.
  - 페르소나: 같은 이름이 있으면 첫 번째 것의 설명·메모·그림만 바꾼다(id 유지 → 대화·봇 연결 유지). 그 페르소나가 지금 선택된 것이면 활성 값(설명·메모·그림)도 같이 바꾼다. 없으면 새로 추가한다.
  - 받는 동안 전송·동기화 적용·응답 생성이 시작되면 적용하지 않고 다음 확인 때 다시 묻는다. 가져오기가 실패해 되돌리기 복구로 들어가면 「아니오」로 기록하지 않는다.
- **아니오**: 이 기기에서 그 판(SHA-256)을 다시 묻지 않는다. 같은 배포 이름으로 새 판이 올라오면 다시 묻는다. 설정의 「다시 받기」로 기록을 지울 수 있다.

## 저장 위치와 형식

- NAS: 기존 NAS 연결 설정(전송·동기화와 같은 주소·계정)의 `.risubard-content-updates/` 폴더.
  - `<sha256>.<charx|png|json>`: 파일 이름이 내용의 SHA-256이라 같은 파일은 한 번만 저장된다.
  - `items/<sha256(배포 이름 key)>.json`: 배포 이름 하나당 기록 파일 하나 `{ key, kind, title, version, file, fileName, sha256, bytes, publishedAt, publishedBy }`. key는 `character:<배포 이름>`, `persona:<배포 이름>` 또는 `preset:<배포 이름>`(파일 `risup|risupreset|json`). 목록은 `items/`를 PROPFIND(Depth 1, NAS 동기화와 같은 방식)로 읽고 기록을 하나씩 받는다.
  - 올리기는 파일 임시 이름 PUT → MOVE(덮어쓰기 안 함, 이미 있으면 같은 내용) → 그 이름의 기록만 임시 PUT → MOVE(덮어쓰기) → 다시 읽어 확인. **이름이 다른 배포는 서로 다른 파일**이라 여러 기기가 동시에 올려도 잠금 없이 둘 다 남는다. 같은 이름을 두 기기가 동시에 올리면 나중 기록이 남는다. 밀린 쪽이 저장 뒤 확인하기 전에 바뀌었으면 「확인에 실패」로 알리고, 확인을 마친 뒤 바뀌었으면 새 판이 하나 더 올라온 것과 같다(다른 기기는 남은 판을 묻는다).
  - 배포 이름은 최대 200개(새 이름만 막고, 기록이 깨졌더라도 있는 이름의 새 판은 언제나 올릴 수 있다). 동시에 올라와 200개를 조금 넘어도 읽기는 256개까지 한다. 기록 하나는 16 KiB까지. 깨졌거나 이름이 맞지 않는 기록은 건너뛰고, NAS 읽기 오류는 그 확인 전체를 다음으로 미룬다.
- 기기: `<데이터>/content-updates/state.json` — 배포 이름별 이 기기의 결정(applied/declined/published, sha256, 시각). 임시 파일은 `content-updates/tmp/`에 두고 끝나면 지운다.
- 서버 경로: `/api/play-transfer/content-updates/{overview,decide,fetch,publish}` (기존 전송 인증·활성 세션 검사). 올리기 본문은 `application/x-risubard-content`로 보내 express.raw가 메모리에 담지 않고 파일로 흘려 쓴다.

## 앱 코드 업데이트 받아 두기 (0.9.92-ver2)

앱 코드 업데이트(app-update 모듈, NAS `.risubard-app-updates/`) 자체는 앱 시작 때 로더가 적용한다. 이 모듈은 그 사이를 채운다.

- 서버(`server/node/content-updates/app-code-watch.cjs`): 로더가 도는 곳(Android 임베디드 런타임, Windows 포터블 패키지, `RISUBARD_APP_UPDATE=0`이 아닐 때)에서만 켜진다. 시작 90초 뒤, 그 뒤 30분마다 `remote.latest()`를 확인하고, 지금보다 새롭고 런타임 지문이 같고 시작 때 두 번 실패한 패치가 아니면 로더 캐시에 받아 둔다(로더 `canTry`와 같은 규칙: 방금 되돌린(`rolled-back`) 패치는 받아 둬도 「준비됨」으로 알리지 않는다 — 다음 시작은 건너뛰고 그다음 시작이 다시 시도하므로): `<앱>/.app-updates/download-<uuid>.part` → `ready-<sha256>.zip`, 그다음 `ready.json`. 다운로드가 끝난 그 순간(await 없이) `ready.json`을 다시 읽어, 로더의 느린 시작 다운로드 등이 더 새 판을 이미 받아 뒀으면 그 판을 두고 이번 것은 버린다. 이 다운로드보다 오래된 다른 `ready-*.zip`만 지운다. 로더(bootstrap.cjs)도 늦게 끝난 시작 다운로드가 더 새 캐시를 덮어쓰지 않는다. 확인은 한 번에 하나, 10분 제한. 런타임 지문이 다르면 받지 않고 `full-package-required`로만 알린다. 코드를 설치하거나 사용자 데이터를 건드리지 않는다.
- 경로: `POST /api/play-transfer/content-updates/app-code` `{ check }` → `{ enabled, current, ready, state, version?, error? }`. `check: true`면 확인을 마친 뒤 답한다(클라이언트는 상태만 묻는다).
- 클라이언트(`src/ts/content-updates/appCodeUpdate.ts`, `startContentUpdates`가 시작): 시작 20초 뒤, 5분마다, 앱이 다시 보일 때 상태를 묻는다. 받아 둔 판이 있고 바쁘지 않으면(위 「묻기」와 같은 조건) 버전마다 한 번 「새 버전이 준비됐어요. 지금 적용할까요? [지금 적용] [나중에]」. 창을 답 없이 닫으면 다음 확인 때 다시 묻는다.
  - 지금 적용(Android 앱): 대기 창(`alertWait`)을 띄우고 창(window)의 capture 단계에서 키보드·포인터·터치 입력을 잡아 둔 채(채팅 입력칸·보내기·전역 단축키보다 먼저) 보내지 않은 입력칸 초안(원작 `chatDraft`: 입력칸은 대화상자로 포커스를 잃을 때 초안을 쓰고, 포커스 없이 바뀐 글은 800ms 지연 쓰기로 씀 → 1초 기다린 뒤 초안 읽기로 쓰기 대기열을 기다림. 가짜 이벤트는 보내지 않아 초안을 불러오는 중인 입력칸이 빈 초안을 쓰는 일이 없음. 초안 쓰기 실패는 원작대로 알리지 않음)과 `requestImmediateSave({ flushServer: 'canonical', rejectOnFailure: true })`를 합쳐 최대 60초 기다린다. 실패하거나 60초 안에 끝나지 않으면 이번 시도를 끝내고(늦게 끝나도 재시작 안 함) 알린 뒤 다음에 다시 묻는다. 묻기 전과 저장 뒤에 동기화 적용·전송·응답 생성·가져오기, 그리고 입력칸의 보내기 준비·전송(원작 화면의 지역 상태라 보내기/취소 버튼의 aria-label·title과 화면낭독 상태 문구로 판별. 한계: 보내기를 누른 직후 생성이 등록되기 전에 채팅 화면을 떠나 화면이 사라지면 볼 수 없음)를 보고, 이 업데이트의 대기 창이 다른 창으로 바뀌었으면 미룬다(그 창은 닫지 않음). 입력 잡기는 재시작 대기 15초 타이머로 넘긴 경우 말고는 어떤 결과·예외에서도 `finally`에서 풀고, 자기 대기 창만 닫는다. 그다음 네이티브 `app.restart`를 부른다. 15초 뒤에도 페이지가 남아 있으면(재시작 안 됨) 대기 창을 닫는다. 앱은 응답을 보낸 뒤 화면을 비우고 서버를 정상 종료(stdin 닫기 → 데이터 저장 후 종료)한 다음 다시 시작한다. 로더가 받아 둔 코드를 설치하고 화면이 다시 연결된다. `app.restart`가 없는 APK면 「앱을 완전히 닫았다가 다시 켜면 적용돼요」.
  - PC·브라우저: 「다시 켜면 적용돼요」만 알린다.
- 네이티브(transfer-sync 모듈 파일): `PlaySetController`의 `app.restart`, `MainActivity.restartServer()`, `EmbeddedServer.shutdown()`. 네이티브가 바뀌므로 런타임 지문이 바뀌어, 0.9.92-ver2는 모든 기기에 전체 APK·PC 패키지 설치가 한 번 필요하다.

## 모듈 구성

- 소유 파일(`features.json` content-updates): `server/node/content-updates/content-updates.cjs`(+test), `src/ts/content-updates/contentUpdates.ts`(+test), `src/lib/Setting/Pages/ContentUpdatesPanel.svelte`, 이 문서, 0.9.92-ver2부터 `server/node/content-updates/app-code-watch.cjs`(+test)·`src/ts/content-updates/appCodeUpdate.ts`(+test). 앱 코드 확인 경로는 같은 `registerRoutes`, 클라이언트는 `startContentUpdates`에서 시작하므로 연결 줄은 늘지 않는다.
- 연결(host-bridges): `server/node/server.cjs`에 경로 등록 1곳, `src/ts/bootstrap.ts`에 시작 1줄. 설정 화면 연결은 transfer-sync의 `TransferPanel.svelte` 2줄.
- 앱 데이터 형식·NAS 동기화 작업공간·기존 전송 프로토콜은 바꾸지 않는다. 캐릭터 적용은 원작 가져오기·업데이트 흐름만 쓴다.

## 한계

- 0.9.106 이하(평문 번호) 설치본의 PC 새 판 알림은 0.9.90-ver1을 새 판으로 알아보지 못한다(그 판의 비교 규칙). 0.9.90-ver1부터는 -verN 순서로 비교한다.

- 모듈(.risum)·플러그인은 대상이 아니다. 프롬프트 프리셋은 0.9.92-ver1부터 대상이다. 0.9.92-ver1보다 오래된 앱은 프리셋 기록을 알아보지 못해 건너뛴다(오류 없이 묻지 않음).
- NAS에 접속할 수 없으면 조용히 건너뛰고 다음 확인 때 다시 시도한다.
- 실제 NAS·실기기에서의 동작은 빌드 뒤 별도로 확인한다.
