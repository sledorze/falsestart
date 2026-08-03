# falsestart

[![CI](https://github.com/sledorze/falsestart/actions/workflows/ci.yml/badge.svg)](https://github.com/sledorze/falsestart/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Blocks risky code patterns the instant an AI writes them — before the file lands, not
just at CI. Can also be used to enforce structure/architecture conventions.

falsestart runs as a Claude Code `PreToolUse` hook. The tool call arrives on stdin, falsestart
answers with a decision, and code that breaks a rule never reaches the file.

## Install

Not published yet — the package is `private: true`. Until it is, install from a tarball or a git
reference:

```bash
npm pack                       # in a checkout of this repo
pnpm add -D ./sledorze-falsestart-0.0.1.tgz
```

`effect` is a required peer dependency, so installing this installs it too. The hook binary itself
inlines what it needs and never loads yours — the peer is for the library entry point.

## Wire it up

`.claude/settings.json` — strict JSON, no comments and no trailing commas. An unparseable settings
file discards **every** hook and permission rule in it, not just this one:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write|NotebookEdit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/node_modules/@sledorze/falsestart/dist/cli.js\" --preset clean-code"
          }
        ]
      }
    ]
  }
}
```

Invoke it by path, not as a bare `falsestart`: `node_modules/.bin` is not on `PATH` for a hook
command, so a bare name exits 127 and the hook silently does nothing while still showing as
registered. `npx falsestart --preset clean-code` also works.

**Pick the preset deliberately.** `clean-code` is four TypeScript rules and assumes nothing else.
`effect` is sixteen rules that assume an Effect codebase — they forbid `await`, `try/catch`,
`new Promise`, `.then`, `JSON.parse`, `fetch` and `process.env`, so on an ordinary async function `all` (both
sets) produces seven blocks. That is intended in an Effect repo and wrong everywhere else. `--rules
<dir>` points at your own directory, and `--rules pkg:@acme/falsestart-rules` at another package's.

Shipped rules match `**/*.{ts,tsx,mts,cts}`. `.js`, `.jsx`, `.mjs` and `.cjs` are excluded by
design, so a repo written in those needs its own `files` globs or the guard is installed and inert.

### Check it works

Blocking is exit **0 with JSON on stdout**; allowed is exit 0 and silence; exit **1** means
falsestart could not run and the write proceeded. So `echo $?` alone cannot tell you the difference
between "allowed" and "blocked" — look at stdout:

```bash
echo '{"tool_name":"Write","cwd":"'"$PWD"'","tool_input":{"file_path":"'"$PWD"'/src/a.ts","content":"const x = v as any"}}' \
  | node node_modules/@sledorze/falsestart/dist/cli.js --preset clean-code
```

That must print a `permissionDecision: "deny"` object. Change `as any` to `as Widget` and it must
print nothing.

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

A rule only ever acts on files its own `files`/`ignores` globs admit. Matching content is never on its own a reason to touch a file.

A starter corpus ships in [`rules/`](./rules): `clean-code/` is generic TypeScript, `effect/`
assumes an Effect codebase. Reach them with `--preset`, or copy the ones you want into your own
directory and use `--rules` — what is enforced is a directory listing, not a config file.

Where each rule applies is yours to set, without editing any rule:

```ts
// falsestart.config.ts
import type { FalsestartConfig } from '@sledorze/falsestart'

export default {
  rules: { 'prefer-smart-constructor': { files: ['src/domain/**/*.ts'] } },
} satisfies FalsestartConfig
```

## Docs

- [Overview](./docs/overview.md) — what it does.
- [Using the hook](./docs/using-the-hook.md) — setup, choosing rules, writing one.
- [Architecture](./docs/architecture.md) — how the pieces fit, and why.
- [Reference](./docs/reference.md) — flags, exit codes, rule format, config, exports.
- [Contributing](./CONTRIBUTING.md) — the three gates a new rule has to pass.
- [Security](./SECURITY.md) — what this tool executes, and what it cannot see.

## Development

```bash
pnpm install
pnpm verify   # lint + typecheck + test + build + check
```

See [AGENTS.md](https://github.com/sledorze/falsestart/blob/main/AGENTS.md) for the documentation, release, and shipping conventions
this repo follows.
