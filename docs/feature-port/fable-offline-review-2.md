# 2차 Fable 검수 결과 (오프라인 공통 표시 자료 · yazl 패키징 수정 · 시험)

## 검토 범위와 전제
공급된 `runtime-archive.mjs`, `package-runtime.mjs`, `verify-runtime.mjs`, 회귀 테스트, README/OFFLINE-STATUS, index.html/main.ts, 글꼴 CSS·SOURCES·OFL 고지, 재현/검증 JSON·로그만 근거로 삼았다. 미공급 코드(`verify-node.mjs`, Android 측 ZIP 추출, 서버 fflate 사용처, 1차 검수 로그)는 추론으로만 다룬다.

## 1. 코드 확정 결함
**없음.** 아래는 실제 검토 결과다.

- **writer (`runtime-archive.mjs`)**: yazl은 파일을 순차로 열어 `pipe`로 outputStream→WriteStream에 흘리므로 파일 데이터 버퍼링은 유계다(요건 충족). `ZipFile` 'error'(stat/read 실패) → `outputStream.destroy(error)` → `pipeline` 거부 → `await written` throw 경로, `addDirectory`/`validateMetadataPath` 동기 예외 → catch에서 destroy 후 재throw, `written.catch(()=>{})`로 unhandled rejection 방지까지 일관된다. 경로 구분자 치환·`relative` 사용으로 yazl 메타경로 검증(절대경로·백슬래시·`..`)을 통과한다.
- **gate (`verify-runtime.mjs`)**: 모든 항목을 yauzl 읽기 스트림(Node zlib inflate)으로 끝까지 읽고 `node:zlib.crc32`(≥22.2, 목표 ≥22.12 충족)와 대조한다. inflate 오류는 `for await` 거부로 전파되며 `zip-gate-rejected-corrupt.log`(Z_DATA_ERROR, 비정상 종료)가 이를 실증한다. 기존 ELF/ABI/해시/추가 .so 거부·junction 가드는 유지됐고 테스트 4에서 재확인됐다.
- **테스트 5개**: 로그 5/5 통과. 실패 TTF 3종(이름이 `runtime-zip-failure.json`의 3개와 일치), 빈 파일, 한글 이름, 3.36MB 다중 청크, ENOENT/EISDIR, 재계산 해시+CRC 손상, 4KiB/정렬 불량/변조 ELF를 실제로 거친다.
- **표시 자료**: `fonts.css` 5블록의 `unicode-range`·순서가 `google-fonts-source.css`와 동일하고 URL→로컬 파일 매핑은 `SOURCES.json`과 일치한다. 에뮬레이터 요청 목록의 `/fonts/interface/*.woff2`, `/assets/KaTeX_*.woff2`가 index.html(print→all 스왑 링크)·`main.ts`의 CSS import 경로와 정합한다. OFL 파일은 12개 KaTeX family(20 face) 전부의 RFN 고지와 OFL 1.1 전문(1~5조·종료·면책)을 담는다.

## 2. 문서·근거의 확정 불일치 (모두 낮음, 정정 권고, 차단 아님)
1. **"재귀 검사" 과장**: `verify-font-review.cjs`의 도메인 잔존 스캔은 `dist/`와 `dist/assets/` 두 디렉터리만 보며 비재귀다(`dist/fonts/interface/fonts.css` 등 미검사). 공급 소스상 실제 잔존은 없으나 "모든 빌드 HTML/CSS/JS" 표현은 근거를 초과한다. 스캔을 재귀로 바꾸거나 문구를 좁혀야 한다.
2. **`runtime-zip-failure.json`의 `hash` 라벨**: APK 경로 항목의 hash가 `runtime.zip` 해시(c37ca8…)와 동일하다. 즉 내부 runtime.zip 해시이지 APK 해시가 아니다. 필드명/주석을 명시하지 않으면 오독된다(문서에서 인용하지 않아 허위 주장은 아님).
3. **NOTICE.md "dist/assets에 배치"**: 60참조 중 `KaTeX_Size3-Regular.woff2`는 CSS data URI로 인라인된다. OFFLINE-STATUS는 정확히 기술하므로 NOTICE만 보정.
4. **QA 한계 누락**: `emulator-offline-qa.json`의 "초기 홈 콘텐츠가 캐시였을 수 있음" 한계가 OFFLINE-STATUS 요약에 없다.
5. **APK18↔19 "실행 코드 동일"의 근거 범위**: `apk18-to-19-diff.json`은 runtime.zip 내부(2541 동일+2 변경) 비교이고, DEX/리소스/네이티브 동일성은 `apk19-build.log`의 UP-TO-DATE에 의한 추론이다. 문서에 "runtime 내용 비교 + Gradle 증분 기준"으로 적시 권고.
6. **자동 회귀의 빈 구멍**: DEFLATE 손상(inflate 오류) 거부는 수동 로그만 있고 테스트 3은 STORED 항목 CRC만 다룬다. yazl 'error' 이벤트 경로(stat/read 실패)는 어떤 테스트도 거치지 않는다. writer 교체의 핵심 안전망이므로 자동화 추가를 권한다.

## 3. 미검증 위험 (가설)
- **[중간] fflate 스트리밍 결함의 잔존 범위**: `fflate-repro.json`은 단일 `push(b,true)`에서도 실패하므로 fflate `Deflate/Gzip/Zip/ZipDeflate/AsyncZip*` 전부가 의심 대상이다. 그런데 `fflate`와 fflate 기반 `compression-streams-polyfill`이 여전히 runtime roots에 포함된다. 전송 아카이브는 yazl이라 했지만 다른 제품 경로(내보내기·백업·이미지 묶음 등)에서 같은 무증상 손상이 가능하다. 사용처 grep 및 같은 TTF fixture 회귀가 필요하다. 이번 범위(패키징)는 fflate를 더 쓰지 않으므로 차단 사유는 아니다.
- **[낮음] 빈 디렉터리 미기록**: writer는 파일만 추가하므로 빈 디렉터리 항목이 ZIP에 없다. APK18 실행 성공으로 현재 트리에는 문제가 없음이 간접 확인될 뿐이다.
- **[낮음] 비원자적 목적지 쓰기**: 실패 시 부분 `runtime.zip`이 남는다. `runtime.sha256`은 성공 후에만 기록되므로 gate가 불일치를 잡지만 `extractNodeBinary`의 `.part` 방식과 불일치한다.
- **[낮음] `compressionLevel` 옵션**: 설치된 yazl 버전이 이 옵션을 지원하는지 근거가 없다. 미지원이면 무시되고 기본 6이라 기능 영향은 없다.
- **[낮음] interface woff2 바이트 대조**: 이번 공급 스크립트는 URL 매핑만 검사하고 로컬 5개 woff2의 실제 SHA-256이 `SOURCES.json`과 일치하는지는 확인하지 않는다. 1차 검수 자료에 있다면 그 로그를 참조로 연결해야 한다.
- **[낮음] Dirent 기반 링크 처리**: 디렉터리 링크는 `isDirectory()`가 false라 `addFile`로 가서 실패한다. 스테이징은 `fs.cp(dereference:true)`라 해당 없음, 다른 호출자 주의.
- **[정보] OFL 고지 원문**: name table 저작권 연도·RFN은 TTF 미공급으로 대조 불가. 주장대로 수용하되 검증 로그 보존 권고.

## 4. 요건 대조
- 앱/데이터/프로바이더 설정 변경 없음: 공급 변경분(CSS import, 링크 교체, 글꼴 자료, 스크립트, 고지) 안에서는 없음. 미공급 영역은 판단 불가.
- 물리 설치/릴리즈 없음: `physicalDeviceActions:false`, APK19는 `assembleDebug`, 문서상 보류 유지. 충족.
- 무한 버퍼링 없는 스트리밍: 충족(위 writer 분석).
- 잘못된 ELF/ZIP 거부: 해시·CRC·inflate 오류·ABI·정렬·추가 라이브러리 모두 거부 실증. 충족.
- 16KiB·junction 가드·프로필·의존성 유지: 유지됨(새 패키지 추가 없음).

## 판정
**범위 내 수락.** 공통 표시 자료, yazl/Node zlib writer, 전수 inflate+CRC gate, 5개 회귀 테스트, OFL/NOTICE 고지에서 확정 코드 결함은 없다. 2절의 문서 정정(특히 "재귀 검사" 표현과 hash 필드 라벨)과 6항의 자동 회귀 보강은 비차단 조건이며, 3절의 fflate 사용처 감사는 별도 후속 과제다.

**수락하지 않는 것**: 오프라인 릴리즈 완성, ARM64 실기기 실행, 여러 턴/BardWiki 데이터 보존, AI 생성, PWA/일반 웹 서버 배포, APK19의 기기 실행(실행 근거는 APK18뿐). AI 아키텍처 결정은 사용자 답변 대기 상태로 유지한다.