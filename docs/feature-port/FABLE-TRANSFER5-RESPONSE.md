# Fable transfer R5 response — internal work only

Physical installation remains on HOLD. No release approval is claimed.

- D-R4-1 reproduced: wide-only origin export, receive on B, narrower return to A appended a third chat. `tmp/transfer5-repro.log` records the failing assertion. The legacy fingerprint now projects gallery selection through the incoming manifest and the historical ID map. The same test passes, preserving both original chats and their galleries. The prior narrow-first then fuller-receipt policy test is unchanged and passes.
- Structural asset URL risk reproduced with image, additionalAssets and module assets containing `/assets/`. All structural asset fields now treat a URL as a whole external reference, without requesting a guessed local path. Embedded data stays verbatim. Source data is unchanged; no external URL fetch occurs.
- Hydration remains a documented host precondition. D-R4-2 is a design consideration, not a new host API in this patch.
- v2 receiver/host prepare integration remains unimplemented. The existing planner rejection remains. No v2 import success is claimed.

Evidence: shared tests 111 pass (`tmp/transfer5-fixed.log`), archive/memory 25 pass (`tmp/transfer5-memory.log`), strict TypeScript exit 0 with timestamp and input hashes (`tmp/transfer5-types.log`). Supplied logs describe internal synthetic tests, not actual device transfer. Existing integration gates in the field inventory still apply.
