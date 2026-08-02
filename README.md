# falsestart

Blocks risky code patterns the instant an AI writes them — before the file lands, not
just at CI. Can also be used to enforce structure/architecture conventions.

falsestart runs as a Claude Code `PreToolUse` hook. The tool call arrives on stdin, falsestart
answers with a decision, and code that breaks a rule never reaches the file.

```jsonc
// .claude/settings.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "falsestart --rules rules" }],
      },
    ],
  },
}
```

Rules are [ast-grep](https://ast-grep.github.io) documents, so the same file stays readable by the
upstream CLI:

```yaml
id: no-as-any
language: tsx
severity: error
message: '`as any` erases the type rather than establishing it.'
rule:
  pattern: $X as any
files:
  - '**/*.{ts,tsx}'
ignores:
  - '**/*.test.{ts,tsx}'
```

A rule only ever acts on files its own `files`/`ignores` globs admit. Matching content is never on
its own a reason to touch a file.

A starter corpus ships in [`rules/`](./rules): `clean-code/` is generic TypeScript, `effect/`
assumes an Effect codebase. Point `--rules` at a directory holding only the subset you want —
what is enforced is a directory listing, not a config file.

## Docs

- [Overview](./docs/overview.md) — what it does.
- [Using the hook](./docs/using-the-hook.md) — setup, choosing rules, writing one.
- [Architecture](./docs/architecture.md) — how the pieces fit, and why.

## Development

```bash
pnpm install
pnpm verify   # lint + typecheck + test + build + check
```

See [AGENTS.md](./AGENTS.md) for the documentation, release, and shipping conventions
this repo follows.
