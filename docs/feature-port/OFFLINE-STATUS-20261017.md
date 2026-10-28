# Offline 버전 준비 및 확인 범위

**최신 사용자 결정(2026-10-17): 기기 내 로컬 AI 모델 개발·최적화 종료.** 아래 구현 이력은 보존한다. 일반판/온라인 API를 앞으로의 작업 대상으로 하며, 기존 Offline 앱·모델·대화는 삭제하지 않는다. 로컬 글꼴·수식·파일 열기 및 앱 구동용 Node 서버는 그대로 둔다. [현재 구조 검토](LORE-COMPATIBILITY-20261017.md).

사용자 요청: 기존 기능이 오프라인에서도 최대한 비슷하게 작동하는 offline 버전을 추가한다. 실기기 설치 보류는 유지한다.

## 이번 공통 변경

- `src/main.ts`: 기존 설치 의존성 KaTeX 0.16.27의 CSS를 import한다. Vite가 수식 글꼴을 함께 묶고 URL을 다시 작성한다.
- `index.html`: KaTeX CDN 링크를 제거하고, 기존 Google Fonts 링크를 `/fonts/interface/fonts.css`로 바꾼다.
- `public/fonts/interface/`: 기존 Tilt Prism·Yellowtail의 WOFF2 5개와 원래 CSS의 글꼴·범위 정의를 유지한다. 변경은 파일 URL과 출처 설명뿐이다. 원본 바이트의 해시·주소는 `SOURCES.json`, 라이선스는 같은 폴더에 둔다.
- `public/fonts/KaTeX-LICENSE.txt`: 설치된 KaTeX 패키지의 라이선스 원문을 배포 자료에 포함한다.
- `public/fonts/KaTeX-Fonts-OFL.txt`, `NOTICE.md`: 실제 TTF의 name 테이블에서 확인한 별도 OFL 1.1 저작권·Reserved Font Name 고지와 라이선스를 보존한다. MIT 코드 라이선스와 글꼴 라이선스를 구분한다.
- `scripts/android/runtime-archive.mjs`: 기존 의존성 yazl/Node zlib로 런타임 ZIP을 스트리밍 작성한다. `package-runtime.mjs`가 이를 호출하며, `verify-runtime.mjs`는 해시뿐 아니라 모든 항목의 압축 해제와 CRC도 확인한다.

기존 앱과 offline 버전 모두에 필요한 표시 자료 및 그 자료의 패키징만 공통으로 바꾼다. 제품의 캐릭터·채팅·설정·서버·모델 선택·앱 ID는 이번 변경에서 바꾸지 않았다. 아래 에뮬레이터의 합성 시험 자료만 시험 중 추가 저장했다.

## 실제 검사

1. 최초 내부 빌드에서 HTML에 `/node_modules/katex/dist/katex.min.css`를 직접 링크하는 방법은 **실패**했다. CSS만 복사되고 상대 글꼴 경로가 재작성되지 않아 브라우저가 HTML fallback을 글꼴로 읽었다. 이 방식은 제거했다. 실패 로그: `tmp/offline-version/assets-browser-before.log`.
2. 정식 CSS import로 수정한 웹 빌드와 기존 startup 검사 1개가 통과했다.
3. Playwright의 별도 브라우저 세션에서 127.0.0.1만 허용하고 다른 요청을 차단했다. 실제 빌드의 CSS와 저장된 글꼴을 사용하는 합성 화면에서 Tilt Prism·Yellowtail·KaTeX Main·KaTeX Math가 모두 로드됐으며 글꼴 요청의 응답은 200 / font/woff2였다. 외부 요청과 실패는 0개였다.
4. 수식과 두 글꼴을 화면 캡처로 확인했다. `output/playwright/offline-assets.png`, 실제 검사 코드/결과는 `tmp/offline-version/assets-browser-check-fixed.js`, `assets-browser-result-fixed.log`에 있다.

위 1~4는 CSS와 글꼴 fixture 검사다. 그 후 아래의 실제 내부 APK 검사를 추가했다. AI 응답 생성·실기기 동작·전체 offline 버전 완성을 뜻하지 않는다.

## 패키징 실패 재현 및 수정

초기 재패키징(APK17 내부 시도)의 fflate 0.8.2 스트리밍 DEFLATE가 KaTeX TTF 3개를 손상시켰다. Python/Node zlib에서 `invalid distance too far back`으로 재현했다. 동일 파일을 fflate 동기 압축 또는 Node zlib로 압축하면 원본과 일치한다. 기존 APK16은 같은 전수 압축 해제에서 실패 0개였다. 기록: `runtime-zip-failure.json`, `fflate-repro.json`.

이미 설치되어 전송 ZIP에 사용하는 yazl로 교체했다. 회귀 검사 5개는 실제 실패 TTF 3개·빈 파일·한글 이름·여러 청크의 자료, 입력/출력 오류, ZIP 해시를 다시 계산한 CRC 손상, DEFLATE 손상, yazl 비동기 오류, 기존 16KB/Windows 링크 검사를 포함한다. 새 gate는 실제 손상 런타임을 거부했다. APK18에서는 566개 소스/웹 파일 대조·양 ABI 16KB·ZIP/서명/정렬 검사가 통과했다. 시험 로그는 `tmp/offline-version/`에 보존한다. 손상된 APK17은 설치하지 않았다. 과거 `runtime-zip-failure.json`의 `hash`는 경로가 APK여도 **내부 runtime.zip의 해시**다. 원기록은 보존하고 APK 해시로 인용하지 않는다.

## 실제 에뮬레이터 오프라인 검사

- 대상은 API36 x86_64, PAGE_SIZE=16384인 내부 에뮬레이터다. 물리 TB710FU·SM-S938N은 조작/설치하지 않았다.
- 검사 APK18 SHA-256: `af33431c7d1a8c03d1ea3588daa2fd02d2cf5719352cc79243aba679b0c84852`. 기기에 설치된 APK 해시가 같고 UID10213·최초 설치 시각이 유지됐다.
- 비행기 모드 ON, Wi-Fi/모바일 통신 OFF, 기본 네트워크 none, IPv4 route 없음, WebView `navigator.onLine=false`를 확인했다.
- 실제 앱의 내부 Node 서버와 WebView에서 시작·합성 캐릭터/첫 메시지 열기·4개 글꼴 로드가 통과했다.
- 초기 홈의 Realm 콘텐츠는 캐시였을 수 있으므로 네트워크 없이 새 콘텐츠를 받은 증거로 삼지 않는다.
- `SAVE 01` 새 슬롯 생성 후 강제 종료/재시작, 슬롯 보존 및 실제 불러오기 버튼/확인창을 통한 복원이 통과했다. 이 표본은 첫 인사만 있고 TURN 0인 합성 채팅이다. 여러 턴·비어 있지 않은 BardWiki·실제 게임 기록 보존 검사가 아니다.
- 결과: `emulator-offline-qa.json`. 캡처: `output/playwright/emulator-offline-slot-before.png`, `emulator-offline-slot-loaded.png`. 검사 뒤 에뮬레이터 네트워크 설정을 원상 복구했다.

최종 내부 APK20 SHA-256은 `a88b65221d23463487e25cfbf8a9e5151e150d1d62c1d438ddd2626709fb69d6`이다. APK18→20의 모든 ZIP 항목 바이트를 실제 비교했다. 외부 APK의 DEX·매니페스트·리소스·네이티브 라이브러리를 포함한 20항목은 동일하고 `assets/runtime.zip`과 그 해시만 달라졌다. 내부 런타임은 2,541파일이 동일하고 차이는 `NOTICE.md` 및 추가한 `dist/fonts/KaTeX-Fonts-OFL.txt` 두 고지 파일뿐이다. 서명 블록은 ZIP 항목 비교 대상이 아니며 최종 APK의 서명은 별도로 검증했다.

APK20은 567개 소스/웹 파일 대조·ZIP 전체 압축 해제·양 ABI 16KB·서명/정렬 검사를 통과했다. 에뮬레이터 실행은 APK18의 결과이며 APK20 설치로 바꿔 말하지 않는다. 근거: `apk18-to-20-diff.json`, `apk20-source-verification.json`, `apk20-file-verification.json`, `apk20-signature.log`, `apk20-zipalign.log`. APK16·18·중간 고지 후보19·최종20은 각각 보존돼 있다. 최종 파일 위치는 `tmp/offline-version/apk20-final/mapping.json`을 따른다.

## 실제 Fable 1차 검수와 후속 확인

`claude-fable-5-1`, effort=xhigh, is_error=false, 종료0. 공통 표시 자료 범위 내 수락·공급 자료에서 확정 결함 없음. 원문 `fable-offline-assets-review-1.md`. 이는 이후 추가한 압축 수정의 승인이나 offline 앱 완성 승인이 아니다.

후속 정적 검사에서 KaTeX 20 face/60 파일 중 59개는 파일, 1개(`KaTeX_Size3-Regular.woff2`)는 CSS data URI이며 모두 원본 바이트 해시와 일치했다. Google Fonts 5개 CSS 블록의 원본 URL과 저장 파일 매핑도 대조했다. 빌드 HTML/CSS/JS에 해당 3개 CDN 도메인 문자열은 남지 않았다. `font-review-followup.json`에 기록했다. CSS 원본의 SHA-256은 `c25fac4c904b5c965a6af158abdb35d1787da60206be3861eee45be9f8f4ef2a`이며 초기 수신 UA 전체 문자열은 기록되지 않았다. KaTeX 글꼴 메타데이터의 OFL 고지는 실제 확인 후 위 파일로 추가했다. 공식 본문 참고: https://openfontlicense.org/open-font-license-official-text/ . Web PWA 캐시나 일반 웹 서버 배포는 검사하지 않았다.

## 실제 Fable 2차 검수와 반영

실제 `claude-fable-5-1`, effort=xhigh, is_error=false, 종료0. 원문 [fable-offline-review-2.md](fable-offline-review-2.md)는 표시 자료·ZIP 작성/검사 코드·제출한 시험 근거를 **범위 내 수락, 확정 코드 결함 0건**으로 판정했다. 원본 요청·응답·입력 해시는 `tmp/offline-version/fable-offline-review-2.*`에 보존했다. 아래 비차단 보완을 자체 검증했다.

- 빌드 도메인 검사를 전체 `dist/`의 HTML/CSS/JS에 재귀 적용하고 글꼴 원본/배포 해시를 다시 대조했다. 결과 `font-review-followup.json`.
- 위의 과거 ZIP 해시 의미, 홈 캐시 가능성, 실제 APK 비교 범위를 명확히 했다. NOTICE는 CSS 인라인 글꼴도 명시한다.
- 회귀 테스트에 해시를 다시 계산한 DEFLATE 손상과 yazl 비동기 오류를 추가했다. 최종 5/5 통과: `archive-tests-review2.log`.
- 남은 fflate 사용처를 조사했다. CharX 바이너리의 기본 압축 수준0으로 실패 TTF3종을 처리하고, 수준6의 합성 채팅 JSON을 처리한 표본은 모두 원본과 일치했다. `fflate-remaining-callers.json`에 범위를 기록했다. 모든 JSON 입력·압축 polyfill 조합의 안전성을 입증한 것은 아니며 관련 제품 코드는 바꾸지 않았다.

검수에 제출한 writer·packager·gate·index/main 및 글꼴 자료의 해시는 현재와 같다. 검수 이후에는 테스트·NOTICE 문구·검증 보조 스크립트·문서만 보완했다(`review2-followup-input-hashes.json`). 이 후속 수정까지 Claude가 다시 검사했다고 표현하지 않는다. 오프라인 AI·ARM64 실기기·전체 통합·정식 배포 승인은 이번 판정 범위 밖이다.

## 후속 범위 및 남은 검증

| 영역 | 실제 코드 상태 | 남은 일 |
|---|---|---|
| Android 앱 서버·사용자 자료 | 내부 에뮬레이터에서 네트워크 없이 시작·합성 자료·TURN 0 슬롯 저장/복원 통과 | 실제 두 ARM64 기기·여러 턴/기억이 있는 데이터 |
| AI 응답 | 사용자 답변에 따라 Android 기기 자체 llama.cpp/GGUF 실행으로 구현. 별도 Offline APK에서 실제 로컬 생성 확인 | 최종 공동 검수·ARM64 실기기·큰 카드/기억 품질. 상세는 OFFLINE-ON-DEVICE-20261017.md |
| 임베딩·요약·음성 | `process/transformers.ts`는 원격 모델 경로와 사용자 캐시를 사용한다 | 필요한 모델의 사전 확보·로컬 경로·실제 오프라인 실행 |
| PDF·Python·소스맵 | PDF cMap, Pyodide, source-map WASM에 CDN 경로가 남아 있다 | 선택한 offline 범위에 맞는 로컬 패키징과 검사 |
| 업데이트·번역·외부 API·NAS·GitHub | 기존 외부 연결 경로 유지 | offline 버전의 표시·오류·재시도 정책과 온라인 버전 보존 |

2026-10-17 후속 답변으로 **태블릿·스마트폰 자체 실행**이 확정됐다. 별도 RisuBard Offline 내부 APK와 네이티브 엔진 구현·실행 시험은 [기기 내 AI 기록](OFFLINE-ON-DEVICE-20261017.md)을 따른다. 이 문서 위의 APK18~20은 공통 표시 자료 단계의 당시 기록이며, 최신 Offline APK와 혼동하지 않는다. 정식 버전·배포 및 물리 기기 설치는 미실행이다.
