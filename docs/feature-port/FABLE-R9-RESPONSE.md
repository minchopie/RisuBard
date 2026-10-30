# Fable runtime R9 response — 2026-10-17

## Confirmed defects and fixes

1. Cold-cache chat acknowledgement followed by `/api/patch` reproduced loss of the newly acknowledged chat. Never-loaded external accept/keep cases also reproduced (three failures in `tmp/runtime9-cold-repro.log`). `ensureChatStore` now primes the stripped database baseline from the same hydrated source before accepting chat changes, and the patch load does not replace an existing fullChatStore. The focused suite61 passed (`tmp/runtime9-cold-fixed.log`).
2. The persistent publication fault test now asserts a journal remains immediately after the failed write. The blocked-observer unit case also asserts the journal remains, addressing the nondiscriminating evidence concern.
3. Startup recovery previously rotated an external edit through a single `.bak`. Recovery now records source/destination/checksum and syncs a separate immutable revision under `trash/transaction-recovery/<journal>/<path-content hash>/original` before replacing an existing target. It preserves all replaced recovery revisions, so no inference about whether an edit refreshed its sidecar is needed. The normal commit path is unchanged. A failed archive copy leaves the target and journal in place. Two regression cases reproduced the previous absence of durable protection; both now pass.
4. Compatibility-cache rebuild now uses a recovery handler registered by the server. A pending save replays with its original observer instead of bypassing it. The unit case uses an existing tracked character file; the initial new untracked preset fixture did not exercise this guard and was corrected without weakening the assertion.
5. Added an HTTP double-fault case: failed partial publish + blocked recovery + external edit of an unpublished target → external review and flush both fail with the affected path, target remains unchanged, graceful shutdown retains the complete attempted app snapshot, a new Node process completes the journal and retains the external bytes in the durable copy. All13 full-write failure cases pass (`tmp/runtime9-recovery-http-final.log`). This is synthetic PC HTTP/service verification, not physical Android evidence.

## Current internal verification

- Client4713 pass/6 skip; type0 errors/8 existing CSS warnings; web build pass (`tmp/client-suite-ports4.log`, `tmp/typecheck-ports4.log`, `tmp/web-build-ports4.log`).
- Server1165 pass/3 skip with maxWorkers4 (`tmp/server-suite-runtime10-recheck.log`). The preceding concurrent run timed out one painter persistence case at30s (1164 pass/1 fail/3 skip); no product or timeout change was made before the lower-concurrency full rerun. The older Windows log rename EPERM failure remains recorded; neither failure is hidden or claimed to have a confirmed environmental root cause.
- Archive/memory25 pass (`tmp/transfer4-memory.log`). Shared109 and strict TS0 are separate evidence.
- APK13 built from this tree, strict dual-ABI16KiB packaging verified, zipalign and debug signature verified. Emulator instrumentation in progress at this response's creation. New ARM64 ELF is statically verified but has not executed on a physical device. Physical devices remain HOLD.

## Explicit remaining boundaries

- The double-fault case stays blocked in-process; no new nonqueued status UI or desktop recovery-copy browser was implemented. After restart the prepared transaction completes, with both versions durably retained. UI recovery guidance remains a pre-release integration gate.
- R9's direct-lane fallback variant (recovery itself throws CANONICAL_FILES_CHANGED before pendingCanonicalRecovery is assigned) is not claimed fixed by the compatibility-cache setter; it still requires its own reproduction/assessment.
- Large real databases, native ARM64 execution, physical two-way transfer, system SAF picker interaction, formal release signing and all remaining transfer/UI integration are not verified.
- This response is not a whole-product or release approval.
