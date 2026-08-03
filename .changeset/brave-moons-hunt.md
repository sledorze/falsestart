---
'@sledorze/falsestart': patch
---

Wires mutation testing into CI and the pre-push gate, and puts the coverage threshold in CI.

Stryker was configured and wired to nothing — two devDependencies, a config file, and a `mutation`
script no workflow or hook invoked. Its first run did not even reach a mutant: `inPlace` mode
rewrites the real source files and `src/self.test.ts` reads them from disk, so falsestart judged
Stryker's own instrumentation, found 13 violations, and failed the dry run. That suite now skips
under mutation testing — the property it asserts is about committed source, not an instrumented copy.

**The first real pass scored 89.94% at 100% line coverage**, which is the point of the exercise.
Among the survivors: every conjunct of `isRecord` in `decide.ts`. Nothing had ever fed
`judgesPayload` a `null`, an array, or a non-object, so `typeof value === 'object'`,
`value !== null` and `!Array.isArray(value)` could each be deleted with the whole suite green — it
had no direct test at all, only indirect exercise through `respond`, which always hands it a
well-formed object. Adding one took `decide.ts` from 82% to 91% and the repo to 90.89%.

**Two gates, because they answer different questions.** CI runs the full `pnpm mutation` against the
repo-wide ratchet, now raised from 77 to 88. The pre-push hook runs `pnpm mutation:changed` — only
the files the branch touched, in ~5 seconds rather than ~52, free on docs-only pushes — against a
deliberate floor of 70 rather than 88. `--mutate <file>` scores the _whole file_, not your change,
and three files sit below 88 today, so a break of 88 there would have rejected a comment-only edit
to any of them.

**The hook cannot touch your working tree.** `inPlace` is forced — sandbox mode crashes before it
starts, because its tsconfig preprocessor calls `ts.parseConfigFileTextToJson`, which TypeScript 7
removed — and pointing that at someone's checkout is not acceptable: interrupt it and their source
is left mutated. `mutation:changed` runs Stryker inside a disposable `git worktree` of HEAD and
discards it. Verified by interrupting it at three points mid-run: source intact, no leaked worktree,
no leaked temp directory.

`pnpm coverage:ci` now runs in CI. The thresholds in `vitest.config.ts` were enforced only by the
pre-push hook, which `git push --no-verify` skips, so a coverage regression could reach `main`.
`autoUpdate` is off for the CI variant — it exists so the ratchet self-raises locally, and CI must
measure against the committed numbers rather than rewrite them.
