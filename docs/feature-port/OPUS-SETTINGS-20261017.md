# Opus 5.5 Extra 최종 설정 이전 검수 — 2026-10-17

실제 Claude Code `claude-opus-5-5 --effort xhigh` 호출의 최종 응답이다. 입력은 비밀정보를 제외한 작업 코드·검증 결과·관련 모델 선택 코드였다. 실제 DB/키/채팅은 전달하지 않았다. 첫 출력 한도 오류는 승인으로 세지 않았고, 이후 초기화·적용 후·최종의 유효 검수 3건을 완료했다.

이하 최종 응답은 원문 그대로다. 원문의 “imported and reset keys are empty”는 대상 필드가 없다는 뜻이 아니라 두 **불일치 배열**이 비어 있다는 문맥이다. 이 응답 이후 사용자가 추가 캐릭터는 본인 작업이라고 확인했다. 기존 재시작 검증 시점 이후 자료는 보존했고 재초기화하지 않았다.

---
**Verdict: no confirmed blocker.** The evidence supports the claim that settings were configured and saved, and that they persisted across a cold restart on all four apps. That claim is limited to the plan-listed keys at each restart-verification point.

**Why it is supported:** Each app went through force-stop, start, reload, then flush and read. `verifySettings` asserts four things:
- protected keys are unchanged,
- original plugin storage and the organizer subset are unchanged,
- theme defaults match,
- imported and reset keys are empty.

The wrapper re-asserts the empty mismatch and reset arrays and 134 asset SHAs against origin bytes. Offline local-AI SHA and 4096/512 limits are asserted. Independent adb file SHAs match, and `settings.json` is byte-identical.

**Reporting boundaries:**
1. **Coverage:** Only `protectedKeys`, `importedKeys` and `resetKeys` were checked. The `modelProfileRegistry*` caches were not checked. Describe them as caches, not as verified data.
2. **Phone Offline:** The verified snapshot predates the user-added character, and the live state was not re-verified afterward. Do not rerun the unchanged `verifySettings` as a "final" check. It may fail on character data, which is user work, not a migration fault. Keep the character and wait for the user's answer.
3. **Plugin:** Say "imported, stored enabled=true." Startup execution was observed only on phone Offline (DOM). `FINAL-EVIDENCE` drops the restart-proof `pluginRuntimeLoaded` and `permissionPrompts` values. Either quote them per target or make no runtime or permission claim.
4. **API:** `apiConfigured` only means `proxyKey` and `forceReplaceUrl` are present. It does not show API success.
5. **Offline apps:** `resolveChatModelBinding` returns the local preset first whenever local AI is available and enabled. This overrides chat and module bindings. So the imported API settings are stored but not used for replies there.
6. **Normal apps:** Unbound chats use the imported global `maxContext`/`maxResponse`. Generation was not tested, so make no usability claim.
7. **Also disclose:**
   - the phone's optional module icon is absent;
   - tablet asset aliases differ in name only (bytes match);
   - colliding preset names got the USB suffix;
   - the active theme was reset to default;
   - preset counts and IDs differ per device by source (4 vs 3);
   - the three metadata differences existed before the patch and are not attributed to the migration.
