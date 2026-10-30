# 사건 초안 필드 계약

- `title`: 사건이나 변화 하나를 식별하는 짧은 제목. Markdown 표식을 넣지 않는다.
- `establishedEvents`: 확정 본문에서 실제로 일어난 사건. 시간 순서대로 최대 12개. 이 배열만 이어 읽어도 이야기 흐름이 자연스러워야 하며 상태 관리, 미완성 플롯 관리, 정본 갱신 제안은 넣지 않는다. 항목 하나는 짧은 사실 하나다. 분위기, 감정, 일상적인 이동보다 나중에 물어볼 만한 구체적 사실(수량, 이름, 물건과 위치, 가격, 시도 결과, 핵심 대사 몇 마디)에 글자를 쓴다.
- `stateChanges`: `subject`, `before`, `after`. `before`가 근거에 없으면 `null`.
- `characterKnowledge`: `character`, `fact`, `stance`. `stance`는 직접 안 사실인 `knows` 또는 사실 여부와 무관한 믿음인 `believes`.
- `persistentFacts`: 이후 장면에도 유지되어야 할 현재 사실.
- `openContinuity`: 아직 해결되지 않았지만 이후 일관성에 필요한 질문·약속·위험.
- `canonicalUpdateCandidates`: 정본 후보의 `type`, `title`, `aliases`, `reason`, `action`, `targetDocumentId`, `confidence`. 자동 반영하지 않는다.

모든 문자열은 한 항목당 500자 이하로 간결하게 쓴다. 같은 사실을 여러 배열에 불필요하게 복제하지 않는다. 기록할 만한 사실이 하나도 없으면 저장 가능한 초안을 꾸미지 말고 빈 의미 배열을 반환한다. 프로그램이 이를 거부하거나 무변화로 처리한다.
