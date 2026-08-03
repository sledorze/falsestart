# falsestart — summary

Blocks risky code patterns the instant an AI writes them, as a Claude Code `PreToolUse` hook: the
tool call arrives on stdin, falsestart answers with a decision, and code breaking a rule never
reaches the file.

Register it in `.claude/settings.json` with an `Edit|Write` matcher and `falsestart --preset all`.
Rules are ast-grep documents, so the same file stays readable by the upstream CLI. A rule acts on a
file only when its own `files`/`ignores` globs admit the path — matching content is never on its own
a reason to touch a file.

Rules come from three places: `--preset all|clean-code|effect` for the shipped corpus, `--rules
<dir>` for your own, and `--rules pkg:<name>` for another package's. Where each rule applies is
re-scopable per repo through a typed `falsestart.config.ts`.

Development is `pnpm install` then `pnpm verify` (lint, typecheck, test, build, docs check).
