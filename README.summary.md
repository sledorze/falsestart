# falsestart — summary

Blocks risky code patterns the instant an AI writes them, as a Claude Code `PreToolUse` hook: the
tool call arrives on stdin, falsestart answers with a decision, and code breaking a rule never
reaches the file.

Install with `pnpm add -D @sledorze/falsestart` — the whole install for the hook, whose binary
inlines what it needs and never loads yours. The library entry point works straight after it too;
what does not is importing `effect` from your own code, because pnpm's isolated `node_modules`
holds nothing your own `package.json` did not ask for. That is not about `effect` being a peer —
`picomatch`, an ordinary dependency, is absent the same way — so declare what you import.

Register it in `.claude/settings.json` (strict JSON) with an `Edit|Write|NotebookEdit` matcher and
the CLI invoked by path — `node "$CLAUDE_PROJECT_DIR/node_modules/@sledorze/falsestart/dist/cli.js"`.
A bare `falsestart` exits 127 while the hook still shows as registered. Choose the preset
deliberately: `clean-code` assumes no framework and reaches JavaScript as well as TypeScript, `all` includes the Effect set.
Rules are ast-grep documents, so the same file stays readable by the upstream CLI. A rule acts on a
file only when its own `files`/`ignores` globs admit the path — matching content is never on its own
a reason to touch a file. Each rule is evaluated against one file's syntax tree, so a rule cannot ask
a question about the rest of the repository.

Rules come from three places: `--preset all|clean-code|effect` for the shipped corpus, `--rules
<dir>` for your own, and `--rules pkg:<name>` for another package's. Where each rule applies is
re-scopable per repo through a typed `falsestart.config.ts`.

Both are read from `HEAD` rather than from the working tree by default, so a session that can write
files cannot disarm its own guard by editing a rule or adding a config the repository never
committed. `--doctor` prints what is frozen and what is not in effect; `--freeze off` reads the
working tree while you iterate.

Development is `pnpm install` then `pnpm verify` (lint, typecheck, test, build, docs check).

Also linked from the README: [CONTRIBUTING](./CONTRIBUTING.md) (how to run the checks and the three
gates a new rule passes), [SECURITY](./SECURITY.md) (what the tool executes on your behalf — a
TypeScript config is imported, so it runs — and what it cannot see), and the reference doc.

The tarball carries README, LICENSE, CHANGELOG, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT, `docs/`,
`rules/` and `dist/`; a test asserts every relative README link resolves to something in that list,
because a link that works in a checkout can still be dead on npmjs.com. A second test packs a real
tarball and lists it, because the `files` array is only the input to a question npm answers.
