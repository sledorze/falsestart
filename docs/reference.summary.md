# Reference — summary

The lists: command line, rule document format, configuration, shipped rules, library exports.

**Command line:** `--preset all|clean-code|effect`, `--rules <dir>`, `--rules pkg:<name>`,
`--config <file>`, `--help`. Exit 0 with JSON blocks, exit 0 with no output defers, exit 1 reports a
problem without blocking. Blocking is deliberately not exit 2, which discards stdout.

**Rule document:** `id`, `language` and `rule` required; `message`, `note`, `severity`, `files`,
`ignores`, `constraints`, `utils` optional. Severity defaults to `error`. Documents under `_utils/`
are fragments needing only `id` and `rule`.

Shipped rules match `**/*.{ts,tsx}` only; other extensions need their own globs.

**Configuration:** per-rule `files` (required) and `ignores` (optional, omission keeps the rule's
own). An override for a rule that is not loaded is an error. A `.ts` config must use a type-only
import.

**Shipped rules:** twenty, all `error` severity; `clean-code` assumes only TypeScript, `effect`
assumes Effect, and `no-vi-mocking`, `no-test-lifecycle-hooks` and `no-manual-effect-run-in-tests` apply only to test files. `Schema.Class` constructors throw but are deliberately not ruled — that would contradict `prefer-smart-constructor`.

**Library:** the exported functions, error classes and constants, with the area each belongs to,
plus the exported types. `effect` is a required peer; `@effect/platform-node` is optional.
