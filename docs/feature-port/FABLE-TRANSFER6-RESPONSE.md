# Transfer R6 response

Physical installation remains on HOLD; this is a planner/archive review, not release approval.

- D-R5-1 reproduced with a free-text HTML external URL plus an adjacent real local asset. URL tokens are now excluded from local asset extraction and reported as external references. The original field is untouched; the adjacent local asset is still captured. No download is attempted.
- D-R5-2 reproduced for both an ID-less normal chat and an ID-less stub with an unrelated legacy registry row. Only chats with nonempty string IDs participate in source mapping/fingerprint comparison; every original chat remains unchanged. Both the stored-source shortcut and legacy fallback use that same candidate list.
- Structural data URI schemes remain verbatim, case-insensitively. Local `assets/` keys keep their existing case-sensitive interpretation.
- Added the requested page-path assertion. It exposed that a damaged shared page reported only its storage hash; the capture error now includes both the logical saved-page path and existing storage diagnostics, plus the slot label.
- Documented receiver hydration and incoming-selection gallery projection in the field inventory. v2 still rejects through the shared apply function; the existing nonmutating v2 regression test remains. A second identical rejection was not added merely against a hypothetical refactor. The unimplemented host must enforce prepare admission before any staging.

Current narrow evidence: shared114 pass; archive/memory25 pass with named tests; shared strict TypeScript exit0. The verification ledger includes exact command arrays, UTC times, code/test/config hashes before and after each bounded batch, and log hashes. It covers only the shared strict TS configuration; the CJS server is checked by execution, not claimed strict-TypeScript checked. Independent prose review cannot recompute hashes, so digest binding remains machine-produced evidence rather than an independent cryptographic audit.

Logs: transfer6-repro.log (3 expected failures), transfer6-memory.log (new path assertion failure), transfer6-fixed-final.log and transfer6-memory-final.log. Exact verification runs and input binding are in transfer6-verification.json and transfer6-bound-*.log. No user data was used or modified. API36/APK14 runtime testing predates this final scanner/diagnostic patch; the final artifact must be rebuilt after reviews.
