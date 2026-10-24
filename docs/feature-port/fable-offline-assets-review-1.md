# RisuBard 오프라인 공통 자료 변경 — 독립 교차 검수 (Fable 5.1, 공급 자료만 사용, 읽기 전용)

## 0. 검수 범위와 전제

검토 대상은 공급된 diff(`index.html`, `src/main.ts`), `public/fonts/interface/*`, `public/fonts/KaTeX-LICENSE.txt`, `scripts/android/package-runtime.mjs`, 상태 문서, `tmp/offline-version/`의 검사 스크립트·결과·로그뿐이다. 서버 코드(`server/node`), `vite.config`, `styles.css`, `NOTICE.md`, `google-fonts-source.css`, 실제 dist 산출물은 공급되지 않았으므로 그에 의존하는 항목은 "미검증 위험"으로만 분류한다. 전체 오프라인 AI 미구현은 사용자 지시대로 신규 회귀로 취급하지 않고, 문서가 완료를 주장하는지만 본다.

---

## 1. 확정 결함 (proved defects)

**없음.** 공급된 diff와 자료 안에서 실제 동작을 깨뜨리는 결함을 찾지 못했다. 근거는 아래 2절의 항목별 추적이다. 억지로 결함을 만들지 않는다.

---

## 2. 항목별 추적 결과 (회귀 없음을 확인한 근거)

### 2-1. CSS 로딩·캐스케이드

- **원래 순서**: `<style id="startup-shell-style">` → `<link katex CDN (print→all)>` → `<link Google Fonts (print→all)>` → main 청크 CSS(`styles.css` → `nodeonly-standard.css`).
- **변경 후 순서**: `<style startup-shell>` → `<link /fonts/interface/fonts.css (print→all)>` → main 청크 CSS(`katex.min.css` → `styles.css` → `nodeonly-standard.css`).
- `media="print"` + `onload` 트릭은 로드 타이밍만 바꾸고 스타일시트의 문서 내 캐스케이드 위치는 바꾸지 않는다. 따라서 원래도 KaTeX 규칙이 앱 CSS보다 앞이었고, 변경 후에도 `main.ts` import 순서상 KaTeX가 `styles.css`보다 앞이다. **동일 특이도 규칙의 승자 관계가 보존**된다. 회귀 아님.
- 실질적 차이 한 가지: KaTeX CSS가 이제 `startup.ts`가 동적 import하는 `main` 청크의 CSS(`main-DZAGdlct.css`)와 함께 로드된다. 즉 startup 화면 단계에는 KaTeX 스타일이 없다. 공급된 `index.html`/`startup.ts`에 수식 렌더링은 없으므로 영향 없음.
- Vite의 `index.html` 처리: `/fonts/interface/fonts.css`는 `public/` 파일이고 `media` 속성이 있으므로 Vite가 import로 변환하거나 해시 자산으로 복사하지 않고 그대로 둔다. fixture 요청 목록에 `/fonts/interface/fonts.css`가 원 경로로 나타나는 것이 이와 일치한다. 또한 첫 시도(`/node_modules/katex/dist/katex.min.css` 직접 링크)가 실패한 원인 설명(CSS만 복사되고 내부 `url()` 미재작성)과도 정합한다.
- `startupExperience.test.ts`의 `preload < 첫 rel="stylesheet"` 조건은 fonts 링크가 첫 stylesheet가 된 뒤에도 성립. 로그 1/1 통과와 일치.

### 2-2. 생성된 글꼴 경로

- `fonts.css`의 `url(./tilt-prism-*.woff2)`는 `/fonts/interface/`에 대해 상대 해석 → fixture에서 `/fonts/interface/tilt-prism-latin.woff2`, `/fonts/interface/yellowtail-latin.woff2`가 200 / `font/woff2`로 응답. 경로 정상.
- KaTeX: Vite가 `url(fonts/KaTeX_*)`를 `/assets/KaTeX_*-<hash>.woff2`로 재작성했고(`KaTeX_Math-Italic-t53AETM-.woff2`, `KaTeX_Main-Regular-B22Nviop.woff2` 200 / `font/woff2`), 검사 스크립트가 59개 참조 모두 `dist` 내 존재(size>0)를 단언했다. `path.join('dist', '/assets/...')`는 Windows에서도 `dist\assets\...`로 정규화되므로 단언이 유효하다.
- `fontResponses`에 `contentType.includes('html')` 거부 조건이 있어, 첫 시도에서 발생한 "HTML fallback을 글꼴로 읽음" 회귀는 fixture 수준에서 재발 시 잡힌다.

### 2-3. fonts.css 정의 보존

- Tilt Prism 3 서브셋(vietnamese/latin-ext/latin), Yellowtail 2 서브셋(latin-ext/latin), `font-display: swap`, `format('woff2')`, `unicode-range` 전부 Google css2 출력 형식과 일치한다. 검사 스크립트는 CRLF 정규화 + URL 치환 + 첫 줄 주석 제거 후 문자열 동일성을 단언했고 통과했다. CRLF 정규화 자체는 브라우저 파싱에 영향이 없으므로 "exact" 요구를 훼손하지 않는다.
- 바이너리: 7개 파일 모두 `SOURCES.json` sha256·바이트 수 일치, `dist` 복사본 해시 일치, woff2 매직(`wOF2`) 확인. 바이트 미변경 요건 충족.

### 2-4. 패키징·라이선스

- `package-runtime.mjs`의 `included` 필터(`\.(test|node-test|bench\.test)\.|\.map$`, `node_modules` 세그먼트 제외)는 `dist/fonts/interface/*.woff2`, `dist/fonts/*.txt`, `dist/assets/KaTeX_*.woff2|woff|ttf` 어느 것도 걸러내지 않는다. 따라서 **재패키징 시** 신규 자료가 runtime.zip에 포함된다. 이번 범위에서 재패키징은 하지 않았고 문서도 APK16 미포함을 명시한다. 일치.
- Tilt Prism: OFL 1.1 원문 + 저작권 표시 포함(OFL 조건 2 충족, RFN 없음). Yellowtail: Apache 2.0 원문 포함(§4(a) 충족, 바이트 미변경이므로 §4(b) 무관). KaTeX: 패키지 `LICENSE`와 해시 동일 확인.
- 패키지 변경 없음, KaTeX 0.16.27 = 제거된 CDN 버전. 요건 충족.

### 2-5. 문서의 범위 주장

- `OFFLINE-STATUS-20261017.md`는 "빌드 CSS와 글꼴의 오프라인 표시 검사"임을 명시하고, 앱 전체 시작·AI 생성·WebView·APK 설치 성공을 뜻하지 않는다고 적었으며, 모델 실행 위치 미결·미구현 표(PDF cMap, Pyodide, source-map WASM, transformers 원격 경로 등)를 유지한다. **완전 오프라인을 주장하지 않는다.** 문서 서술(127.0.0.1만 허용, 4개 글꼴 로드, 200/font/woff2, 외부 0·실패 0)은 `asset-verification.json`과 일치한다.

---

## 3. 미검증 위험 / 검사 엄밀성 격차 (unverified risks)

중요도 순. 모두 "확정 결함 아님", 공급 자료로 결론 내릴 수 없거나 검사가 다루지 않은 영역이다.

**R1 [낮음~중간] KaTeX `url()` 참조 59개 vs 기대 60개 — 설명 없는 불일치**
katex.min.css 0.16.x는 @font-face 20개 × (woff2/woff/ttf) 3 = 60개 `url()`이라는 것이 내 기억이다(공급 자료로 재확인 불가). 59라면 하나가 Vite `assetsInlineLimit`로 data URI 인라인되었거나(필터가 `KaTeX_` 포함 여부로 걸러내므로 집계에서 빠짐 — 오프라인에는 무해), 또는 실제로 누락된 것이다. 어느 쪽이든 나머지 포맷이 남아 있어 오프라인 표시는 깨지지 않지만, 검사 스크립트가 `refs.length>0`만 단언하므로 **원인이 기록되지 않았다**. 정확한 개수(또는 20 family 전수)와 data URI 허용을 명시적으로 단언하도록 보강 권장.

**R2 [낮음~중간] 서브셋 ↔ 파일 매핑은 교차 검증되지 않음**
CSS 비교는 양쪽 URL을 `FONT_URL`로 치환하므로, 예컨대 latin-ext 바이트가 `tilt-prism-latin.woff2`로 저장되어 있어도 통과한다. 해시 검사는 "파일 ↔ SOURCES.json" 만, Google CSS 블록의 URL ↔ SOURCES.json `source` 대응은 어느 검사도 보지 않는다. fixture의 `document.fonts.load`도 unicode-range로 face를 고르므로 내용물 바뀜을 잡지 못한다. 크기 분포(8960 < 33632 < 39360)는 정상 매핑에 부합해 보이나 확인은 아니다. 블록별 URL 대응 단언 추가 권장.

**R3 [낮음~중간] KaTeX *글꼴 파일* 자체의 고지 범위**
`KaTeX-LICENSE.txt`는 KaTeX 프로젝트(MIT) 라이선스다. 동봉되는 `KaTeX_*.woff2/woff/ttf`는 별도 저작권 메타데이터(상위 유래 글꼴 포함)를 갖는 파일이며, 이전에는 CDN에서 받아오던 것을 이번 변경으로 **앱이 직접 재배포**하게 된다. 공급 자료에 `NOTICE.md`·`android-app/notices` 변경이 없고 내용도 보이지 않아, 재배포 고지가 충분한지 판단할 수 없다. 재패키징 전 글꼴 name 테이블/상류 저장소 라이선스 확인 및 NOTICE 반영 여부 점검 권장.

**R4 [낮음] 잔존 외부 참조·버전 고정에 대한 정적 단언 부재**
검사는 `dist/assets/main-*.css`의 KaTeX 참조만 본다. 빌드 산출물 전체(`dist/**/*.{html,css,js}`)에서 `fonts.googleapis.com` / `fonts.gstatic.com` / `cdn.jsdelivr.net/npm/katex`가 남아 있지 않다는 단언, `katex/package.json`의 version === `0.16.27` 단언이 없다. "이 스타일·글꼴에 대한 런타임 인터넷 fetch 없음"과 "KaTeX 버전 보존"을 회귀 테스트로 고정하려면 필요하다.

**R5 [낮음] 실제 앱 경로·Android 런타임 서버 미검증 (문서가 이미 고지)**
fixture는 `main-DZAGdlct.css`를 직접 `<link>`했다. 실제 앱은 `__vitePreload`가 동적 청크의 CSS를 head에 주입하는 경로를 거친다. 또한 4183 포트 서버의 정체(vite preview인지 `server/node`인지)가 로그에 없어, Android 런타임 Node 서버의 `/fonts/**` 정적 제공·MIME·헤더(CSP 등)·라우트 충돌 여부는 미확인이다. 공급 자료에는 CSP 메타가 주석 처리되어 있지만 서버 측 헤더는 볼 수 없다.

**R6 [낮음] Google CSS 기준선의 출처 기록**
`tmp/offline-version/google-fonts-source.css`는 공급되지 않았고, 어떤 UA·시점으로 받았는지와 그 해시가 `SOURCES.json`에 없다. "원래 CSS 정의 유지" 주장은 tmp 산출물에 의존한다. CSS 기준선 해시와 UA를 SOURCES.json에 추가하면 재현 가능해진다.

**R7 [낮음] PWA/서비스 워커 precache (해당 시)**
`manifest.json`이 링크되어 있다. 서비스 워커가 존재하고 precache glob이 woff2를 제외한다면 웹 PWA 오프라인에서는 글꼴이 캐시되지 않을 수 있다. APK(루프백 서버)와는 무관. 서비스 워커 존재 자체를 공급 자료로 확인할 수 없다.

**R8 [비고] 사소한 정리 사항**
`KaTeX-LICENSE.txt`가 `/fonts/`에 있으나 KaTeX 글꼴 산출물은 `/assets/`에 놓인다(기능 문제 없음, 위치 설명을 SOURCES/문서에 한 줄 추가하면 충분). `asset-verification.json`의 `*Match: true` 필드는 단언 통과 후 쓰는 상수라 "자가 보고"임을 인지할 것. fixture 스크립트의 CSS 파일명 해시는 다음 빌드에서 바뀌므로 재사용 시 갱신 필요.

---

## 4. 판정 (범위 한정)

**범위 한정 수락(ACCEPT, scoped).**

- 수락 범위: "온라인 앱과 오프라인 버전 양쪽이 공유하는 정적 표시 자료 기반" — KaTeX 0.16.27 CSS/글꼴의 로컬 번들화, Tilt Prism·Yellowtail의 바이트 동일 로컬 서빙, CDN 링크 제거. 공급된 diff·자료 안에서 CSS 캐스케이드, 글꼴 경로, 패키징 필터, 라이선스 동봉, 문서의 범위 서술 모두 확정 결함 없음.
- 수락이 **의미하지 않는 것**: 오프라인 앱 완성, Android WebView/런타임 서버에서의 동작, 새 APK, 오프라인 AI. 문서도 동일하게 선을 긋고 있으므로 그대로 유지할 것.
- 유지 사항: 온라인 앱 정상 동작, 사용자 데이터·모델 설정 불변, 설치 보류, 릴리즈·신규 APK 없음 — 이번 diff는 이들 중 어느 것도 건드리지 않았다.
- 다음 단계(재패키징·APK 작업) 진입 전 권고 조건: R1(59/60 원인 기록 또는 정확 개수 단언), R2(서브셋 매핑 교차 단언), R3(KaTeX 글꼴 고지 확인), R4(잔존 외부 참조·버전 정적 단언). 이들은 이번 수락을 막는 결함이 아니라 다음 범위의 선행 검사다.
- 모델 실행 위치(기기 내 / LAN PC / 생성 없음) 질문은 이번 변경과 독립적이며, 답변 전까지 임의 대체하지 않는다는 문서 입장이 적절하다.