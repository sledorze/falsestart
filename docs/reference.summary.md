# Reference — summary

The lists: command line, rule document format, configuration, shipped rules, library exports.

**Judged tool calls:** `Write` (`file_path`/`content`), `Edit` (`file_path`/`new_string`),
`NotebookEdit` (`notebook_path`/`new_source`) — the complete set of Claude Code built-ins carrying
file content. Anything else is allowed in silence. `Bash` is deliberately absent, so a shell
redirect writes a file falsestart never sees.

**Command line:** `--preset all|clean-code|effect`, `--rules <dir>`, `--rules pkg:<name>`,
`--config <file>`, `--doctor`, `--version`, `--help`. `--doctor` reports what was resolved and probes
five paths for reachability, reading no stdin. Exit 0 with JSON blocks, exit 0 with no output defers, exit 1 reports a
problem without blocking. Blocking is deliberately not exit 2, which discards stdout.

**Rule document:** `id`, `language` and `rule` required; `message`, `note`, `severity`, `files`,
`ignores`, `constraints`, `utils` optional. Severity defaults to `error`. Documents under `_utils/`
are fragments needing only `id` and `rule`.

Shipped rules match `**/*.{ts,tsx,mts,cts}`; `.js`/`.jsx`/`.mjs`/`.cjs` are excluded by design
and need an explicit `files` override.

**Configuration:** per-rule `files` (required) and `ignores` (optional, omission keeps the rule's
own). An override for a rule that is not loaded is an error. A `.ts` config must use a type-only
import.

**Shipped rules:** twenty, all `error` severity; `clean-code` assumes only TypeScript, `effect`
assumes Effect, and `no-vi-mocking`, `no-test-lifecycle-hooks` and `no-manual-effect-run-in-tests` apply only to test files. `Schema.Class` constructors throw but are deliberately not ruled — that would contradict `prefer-smart-constructor`.

**Library:** the exported functions, error classes and constants, with the area each belongs to,
plus the exported types. `effect` is a required peer; `@effect/platform-node` is optional.
