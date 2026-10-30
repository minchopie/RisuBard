# Review — R7-1 left-boundary fix (Fable 5.1, read-only, scoped)

## 0. Evidence and limits

Traced the current `snapshot.ts` regex line, the new test, `protocol.ts`, and both logs. Nothing executed; no diff supplied, so "one line changed" is checked only by comparing the current line against the R7 review's quoted pre-fix regex (they differ solely by the `(?<![A-Za-z0-9_+.-])` prefix). Memory-page code not supplied, not reviewed.

## 1. Fix traced against code — **closed**

Current pattern: `(?<![A-Za-z0-9_+.-])(?:[a-z][a-z0-9+.-]*:\/\/|\/\/|data:|blob:|file:)[^\s<>"']+` with `gi`.

Trace of the regression input `profile:assets/one.png metadata:assets/two.png my_data:assets/three.png` (`description`, `wholeAsset` false, regex gate passes):
- `profile:` — at `p` the lookbehind passes but alt 1 needs `://`, fails; at `f` of `file:` the preceding `o` is in the class → lookbehind fails. Pre-fix this matched `file:assets/one.png` (exactly the failure in `transfer8-boundary-repro.log`, column 45 = `deepEqual` of the `external` assertion).
- `metadata:` — `d` of `data:` preceded by `a` → blocked.
- `my_data:` — `d` preceded by `_` → blocked **only because `_` was added** to the class (the R7 suggestion lacked it; the response's class is correct for this input).
- `assets/one.png` etc.: `a` after `:` passes lookbehind but `assets` then `/` fails alt 1; `/` after `s` fails lookbehind; `one.png` has no `:`. No match anywhere → `localText === field`, `external` untouched, `matchAll` yields all three paths → `asset()` → `source.asset` → test wrapper records them. `missing` empty; fixture produces no other `external`. All assertions hold by trace; the fixed log passes (4.4 ms, full run).

Pre-fix log demonstrates the misclassification half empirically; the "not collected" half (all three paths replaced by `' '`) is by trace only, since the test fails before the `requested` assertions. Post-fix both halves are empirically covered.

## 2. Regression of the five URI cases — **preserved by trace and log**

Field `<img src="${uri}"> local assets/actual.png`: each URI start is preceded by `"`, which is outside the lookbehind class, so matching proceeds exactly as in R7: `data:`/`DATA:` → alt 3 (not external), `//cdn…` → alt 2, `file:///…` → alt 1, `blob:https://…` → alt 4 with full token as reason. Scan resumes after the consumed token, so no inner re-match. `assets/actual.png` survives (`a` after space). `free-text external` (`"https://…`) and structural tests (never reach this regex) unchanged. Log: 12/12 snapshot tests, 116 total, names/order match the supplied file.

## 3. KEEP

`String.replace` returns a new string; the callback only pushes to `external` and performs no I/O; `asset()` remains the sole loader call and is never handed a URI token; no DB write path touched. Installation HOLD stated and consistent.

## 4. Proved issues

None blocking. One test-coverage gap: the new test omits the `canonical(db)` before/after assertion every neighbouring test carries. The traced path cannot mutate, and the adjacent tests cover the same code, so this is a hygiene gap, not a defect.

## 5. Unverified / behavioural notes (hypotheses, low)

- **Truncated reason on glued URLs.** A URL immediately preceded by a class character (`foo-https://cdn/assets/a.png`, `x.https://…`) now fails at `h`, and the `//` alternative fires at the `//` after the colon, yielding reason `//cdn/assets/a.png` instead of the full URL. Still classified external, never fetched, local path not guessed — so KEEP holds — but a future "will not download" UI would show a truncated string. Realistic inputs (`src=`, `"`, `(`, CJK, `:` before the URL) are unaffected.
- **Glued `//assets/x.png`** remains external (accepted/documented in the response); `// assets/x.png` with a space is still collected because `[^\s<>"']+` needs ≥1 char.
- **R7 §3 performance hypothesis** is structurally addressed: inside any alphanumeric run every position fails the lookbehind in O(1), so alt 1 is attempted only at word starts. Not measured here.
- Line-number/column agreement with the log is consistent; digests not recomputable.

## 6. Scoped verdict

R7-1 is **closed** for the `profile:`/`metadata:`/`my_data:` inputs by deterministic trace and by the before/after logs. The five prior URI cases, adjacent local collection, `data:` inline preservation, no-fetch and no-mutation properties are preserved. Changes verified are the single regex prefix (with the necessary `_`) and one regression test; the only finding is the missing no-mutation assertion in that test, non-blocking. No host/UI/transport or release claim is made; physical installation remains on HOLD.