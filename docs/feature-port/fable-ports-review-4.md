# P4 follow-up review — fetch receiver fix, console sink fix, regression check

Scope: static reading of the supplied sources, the supplied test/emulator artifacts, and the supplied baseline diff. I did not run anything. Where a claim rests on an artifact whose generating harness is not supplied (the WebView probe JSONs), I treat the artifact as a claim checked only for internal consistency.

## Confirmed defects (with trace)

### D1 — Gate default `fetch` lost its receiver (confirmed; fixed in current source)

Trace against the pre-fix code, which the R3 doc quotes and the repro log corroborates:

1. Old constructor stored the native function: `this.fetchImpl = options.fetchImpl ?? fetch`.
2. `request()` invokes it as a member: `await this.fetchImpl(url, { method: 'GET' })` → receiver is the Gate instance.
3. Blink's WebIDL binding rejects a non-Window receiver synchronously: `Failed to execute 'fetch' on 'Window': Illegal invocation` (exactly the string in `emulator-fetch-binding-repro.json`, alongside `direct: "probe"` for the bare call on the same WebView).
4. The Gate's bare `catch` treats it as transport failure: `blockedUntil = now + 30 000`, `return null`.
5. `translateMain`: `!f` → `fallback()` → `onFallback` sets `transientFallback`, throttled toast, original text returned; `runTranslator` returns the source without caching; the HTML batch resolves every node to its original. Clean, silent, permanent failure; "retry" never recovers because every attempt re-throws at step 3.

Before/after evidence is coherent at both tiers. Unit tier: `ports3-fetch-repro.log` fails the new receiver test with `expected undefined to be 200` — `undefined` is precisely `null?.status`, i.e. the catch-and-null path, not some unrelated failure; `ports3-fetch-fixed.log` passes it and the other 18 (5 + 8 + 6 = 19, matches). Device tier: pre-fix Gate source injected into the APK12-era WebView returned `null` for a data URL (`emulator-gate-console-before.json`); the wrapper version returned `gate-probe` (`emulator-gate-binding-fixed.json`); APK13's WebView repeats `gateText: "gate-probe"` with `fetchNative: true`.

Current source is correct: `options.fetchImpl ?? ((input, init) => fetch(input, init))`. Inside the arrow the call is bare, so in strict module code the receiver is `undefined`, which Blink maps to the global. It also resolves `fetch` lazily, so a stub installed after construction is honored — matching the desktop branch's `await fetch(url, …)` semantics. I checked the two sibling member-called defaults for the same hazard: `this.now = Date.now` is receiver-insensitive per spec, and `defaultWait` calls `setTimeout` bare inside its own arrow. No analogous instance remains.

The new test is a genuine detector for this class: its stub throws on any receiver other than `undefined`/`globalThis`, and the repro log proves it fails against the old constructor. One limitation: it does not distinguish lazy from eager resolution (all Android tests stub before import), so a future "optimization" back to `fetch.bind(globalThis)` would pass. Not a defect; a blind spot to be aware of.

To be explicit on the user's point: `gate-probe` is a `data:` URL round-trip. It proves the wrapper invokes native `fetch` without `Illegal invocation` inside the real WebView. It proves nothing about translate.googleapis.com (`providerRequestExecuted: false` in every artifact).

### D2 — WebView console was routed to Android logcat (confirmed privacy-boundary mismatch; fixed)

Trace: `translateHTML` executes `console.log(html)` unconditionally before DOM parsing on the google/deepl/deeplX paths; the stdout blocks in `ports3-fetch-fixed.log` show it firing once per call with the full message HTML. The pre-fix `WebChromeClient` did not override `onConsoleMessage`, so WebView's default sent that text to the system log — `consoleMarkerInLogcat: true` in the before-artifact. Current `MainActivity` overrides `onConsoleMessage(...) = true`, which by Android contract marks the message consumed and suppresses the logcat write. APK13's artifact shows `devToolsConsoleReceived: true` / `systemLogContainsMarker: false`, consistent with DevTools delivery being independent of the `WebChromeClient` callback. The Kotlin override's nullable parameter against the platform's non-null declaration is legal and evidently compiled.

Caveat the response already states and I endorse: this proves the console channel for one synthetic marker on a debug build. It is not an audit of Chromium's non-console logcat output (net errors etc.), the embedded server's file log, or any server-side logging.

### No new confirmed defects from either fix

Regression checks I performed and found clean:

- Desktop path untouched: `await fetch(url, { method: 'GET' })` is a bare call; the `mobileGoogle` guards keep `onFallback` unreachable on desktop. The baseline is now visible in the diff, which closes R3's open item: baseline `if((!res[0]) || res[0].length === 0) return text` and the current `(mobileGoogle && …) || !res[0] || res[0].length === 0` are desktop-equivalent for `[]`, `[[]]`, and `[{}]` (the last throws in `res[0].map` in both), and `f.json()` failure rethrows in both. Desktop session-cache population is unchanged.
- Test interplay: the retry/HTML suites install the stub before `import('./translator')`, so the module-scope `mobileGoogleGate` sees the same function under both the eager and lazy implementations; the 19-pass log confirms no behavioral drift.
- Diagnosability side-effect of D2 (not a defect, but a real trade-off): the Gate's `catch` still records nothing, and release builds now have no console at all (`setWebContentsDebuggingEnabled(BuildConfig.DEBUG)`), so an "always falls back" symptom on a physical release install will surface only as the 30-second-throttled Korean toast. If a future binding-class regression occurs, the only on-device diagnostic is a debug build plus USB DevTools.

## Scoped verdict

What the supplied material proves:

- The diff against 64ebfb23 shows exactly one hunk in `scriptings.ts` — the `LuaFactory(undefined, { _: './risubard' })` constructor — and translator hunks that match the supplied current `translator.ts` line for line. R3's analysis of the Lua change (effective on Node hosts, inert in the WebView) stands; nothing in the diff contradicts it.
- The Gate receiver defect is reproduced before and absent after, at unit and WebView tiers.
- The logcat sink is reproduced before and absent after on APK13.
- APK13 (`f29626b0…`, matching across `emulator13-fetch-console.json` and `apk13-file-verification.json`) passed instrumentation: `INSTRUMENTATION_CODE: -1` is `Activity.RESULT_OK`, no `failure` key, all five report keys present, runtime probe JSON all-true on `x64`. Both ABIs show three 16 KiB-aligned loads.

Current vs. earlier, kept distinct: APK12 ran the same instrumentation and the app-UID operations but predates both fixes; the three pre-fix WebView artifacts were taken on that generation. The `VERSION_NAME` was not bumped (both UAs read `0.9.72-dev-debug`), so the APK SHA is the only identifier separating them — `emulator16k-apk13-instrumentation.log` carries no SHA and is tied to APK13 by filename only. Minor traceability gap, not a correctness issue.

What the material does not cover, and I did not infer: the diff is scoped to two TS paths, so it does not prove the Gate file or `MainActivity.kt` changed only where the response says; I reviewed their current contents, not their deltas. The full-suite counts (client 4713, server 1165) are asserted, not evidenced here. The probe harness that transpiled and injected the Gate is not supplied, so I cannot say whether the shipped bundle's module-scope instance was exercised or source was re-injected; the wording suggests the latter.

## Remaining integration / real-provider boundaries

Unchanged from R3 unless noted: no request to translate.googleapis.com has been made from any WebView, so CORS behavior from a `http://127.0.0.1:<port>` origin, 429-as-TypeError, `■` preservation by Google, GET URL length for ~5000-char CJK batches, the `useExperimentalGoogleTranslator` bypass of the Gate, and whether the UI "retry" re-enters `translateHTML` remain unverified. No end-to-end translation was driven through the shipped bundle via ChatBody. Release-build console suppression is asserted by code, tested only on debug. The ARM64 executable has never run on hardware; `arch: "x64"` throughout. The emulator carried prior state (`persistedRuns: 7`), so APK13 was exercised as an over-install, not a fresh install. Pre-existing Lua API items (duplicate `declareAPI`, `setDescription` closure check, `ensureLuaFactory` waiter path) are untouched and remain unverified against upstream.

Verdict within scope: the two P3 findings are correctly fixed with no regression visible in source, tests, or diff; the Gate path now has a real regression test for the receiver class. This is not a release approval. Physical installation HOLD stands — the first real Google round-trip from a device, and the ARM64 binary itself, are still untested.