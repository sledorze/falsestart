---
'@sledorze/falsestart': minor
---

`no-manual-effect-run-in-tests` flags `Effect.runPromise`/`runSync`/`runFork`/`runCallback` inside
test files. Running an Effect by hand there means the test supplies its own runtime and then reports
whatever escapes: requirements vanish from the type, a scope opens and closes around one call, and a
failure arrives as a rejected promise rather than as the test's own result. Use `it.effect` inside
`layer(MyLayer)(...)`, or the standalone `effect(...)`.

**`Effect.provide` inside a test is deliberately not flagged.** Providing a different layer for one
case — a filesystem that fails on demand, a stubbed clock — is what layers are for. This repo has
exactly such a test, and a blanket ban would have fired on it.

Also refactors falsestart's own suites (`loader`, `config-file`, `respond`, `remedies`) from
`Effect.provide(...)` + `orDie` to `layer()`. That was not cosmetic: `orDie` discarded the cause, so
a missing file surfaced as an untyped defect instead of `PlatformError: NotFound`.
