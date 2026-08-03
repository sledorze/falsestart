---
'@sledorze/falsestart': patch
---

falsestart now passes its own rules, and enforces them on itself.

Five violations in its own source were removed rather than exempted: a preset check that widened a
const tuple by assertion (`PRESETS.some(...)` needs no widening), a dynamic import asserting
`Promise<{ default?: unknown }>` for a shape nothing had checked (now `unknown` plus a type guard),
an annotated config literal (now `satisfies`), and two in the warning shim — a `never[]` spread
widened by assignment instead of assertion, and `String(warning)` on a `string | Error` replaced by
naming both cases.

One exemption remains and is now a reviewed override in `falsestart.config.ts` rather than an
unspoken failure: `toNapiConfig` in `src/checking/matcher.ts` is the seam between a
validated-but-untyped rule document and `@ast-grep/napi`'s types, and re-deriving ast-grep's rule
grammar in TypeScript is exactly what that module argues against. This is the first use of scope
overrides in this repo, so the feature is now dogfooded by its own author.

`src/self.test.ts` keeps the count at zero, and asserts the exemption is still load-bearing — if
`matcher.ts` ever stops needing it, the test fails and the override should be deleted rather than
left as a hole nobody re-examines.

No behaviour change for consumers. The internals are equivalent; what changed is that the tool no
longer fails itself.
