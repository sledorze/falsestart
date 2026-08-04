# Reference — summary

The lists: command line, rule document format, configuration, shipped rules, library exports.

**Judged tool calls:** `Write` (`file_path`/`content`), `Edit` (`file_path`/`new_string`),
`NotebookEdit` (`notebook_path`/`new_source`) — the complete set of Claude Code built-ins carrying
file content. Anything else is allowed in silence. `Bash` is deliberately absent, so a shell
redirect writes a file falsestart never sees.

**Command line:** `--preset all|clean-code|effect`, `--rules <dir>`, `--rules pkg:<name>`,
`--config <file>`, `--doctor`, `--warn-unscoped`, `--version`, `--help`. `--doctor` reports what was
resolved, probes five paths for reachability, and names any rule whose override covers fewer
extensions than it ships with — an override REPLACES `files` rather than merging, so a restated
glob that omits an extension silently unguards it. It also names the changelog shipped inside the
installation it reports on, so an upgrade's new rules are readable where the upgrade is verified.
Reads no stdin. `--warn-unscoped` reports a
judged write no rule is scoped to rather than passing it in silence; non-blocking, off by default. Exit 0 with JSON blocks, exit 0 with no output defers, exit 1 reports a
problem without blocking. Blocking is deliberately not exit 2, which discards stdout.

**`scan [paths…]`:** judges files on disk for a git hook or CI. Paths from the caller, `-`/`-0` for
stdin, `--baseline`/`--update-baseline` to absorb pre-existing findings, `--warn-unscoped` refused.
Its own exit codes — 0 clean, 1 findings, 2 could-not-run — and it fails closed where the hook fails
open.

**Rule document:** `id`, `language` and `rule` required; `message`, `note`, `severity`, `files`,
`ignores`, `constraints`, `utils` optional. Severity defaults to `error`. Documents under `_utils/`
are fragments needing only `id` and `rule`.

Seventeen of twenty-three shipped rules match `**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}` — the constructs they catch
exist in both languages. Six (`no-as-any`, `no-as-never`, `no-double-cast`, `no-effect-assertion`, `no-type-assertion`,
`prefer-smart-constructor`) stay TypeScript-only: they do fire on TS syntax at a `.js` path, since
the parser follows `language: tsx` rather than the extension, but valid JavaScript cannot contain
an `as` expression or a typed `const` to find. A JSDoc cast is caught by nothing.

`no-effect-assertion` is the one rule with NO test-file exemption, deliberately: the blanket every
other assertion rule carries exists for a fixture cast a mock needs (`as never`), which this rule
leaves alone, but it was also waving through `x as Effect.Effect<A>` — a claim that a stream which
can fail cannot. Found by falsestart allowing three of them into this repo's own tests while wired
and running.

**Configuration:** per-rule `files` (required) and `ignores` (optional, omission keeps the rule's
own), plus a top-level `exclude` glob list for `scan` — the repository's standing policy, which
`--exclude` adds to rather than replaces. A malformed `exclude` is an error, not ignored. An override for a rule that is not loaded is an error. A `.ts` config must use a type-only
import.

**Shipped rules:** twenty-two, all `error` severity; `clean-code` assumes no framework and now reaches JavaScript too, `effect`
assumes Effect, and `no-vi-mocking`, `no-test-lifecycle-hooks` and `no-manual-effect-run-in-tests` apply only to test files. `Schema.Class` constructors throw but are deliberately not ruled — that would contradict `prefer-smart-constructor`.

**Library:** the exported functions, error classes and constants, with the area each belongs to,
plus the exported types. `effect` is a required peer; `@effect/platform-node` is optional.
