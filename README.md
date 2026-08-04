# falsestart

[![CI](https://github.com/sledorze/falsestart/actions/workflows/ci.yml/badge.svg)](https://github.com/sledorze/falsestart/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

Blocks risky code patterns the instant an AI writes them — before the file lands, not
just at CI. Can also be used to enforce structure/architecture conventions.

falsestart runs as a Claude Code `PreToolUse` hook. The tool call arrives on stdin, falsestart
answers with a decision, and code that breaks a rule never reaches the file.

## Install

```bash
pnpm add -D @sledorze/falsestart
```

That is the whole install for the hook: the binary inlines what it needs and never loads yours.

Importing falsestart as a **library** works too, straight after that command. What does not work is
importing `effect` — its peer — from your own code: under pnpm's default isolated `node_modules`,
`import 'effect'` fails. So declare it yourself if you use it, with `pnpm add effect`.

Being a peer is not the reason. pnpm puts nothing in your project that your own `package.json` did
not ask for, so `picomatch` — an ordinary dependency of falsestart, not a peer — is equally absent.
npm's flat layout leaves both importable, and `node-linker=hoisted` makes pnpm do the same, but
neither is a guarantee to build on: depend on what you import.

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

**Pick the preset deliberately.** `clean-code` is six rules and assumes nothing else.
`effect` is seventeen rules that assume an Effect codebase — they forbid `await`, `try/catch`,
`new Promise`, `.then`, `JSON.parse`, `fetch` and `process.env`. An eight-line function that
awaits a `fetch`, `JSON.parse`s the body inside `try`/`catch` and throws an `Error` trips **six**
of them:

```
no-await, no-json-global, no-raw-error, no-raw-fetch, no-try-catch
```

That is intended in an Effect repo and wrong everywhere else. `--rules
<dir>` points at your own directory, and `--rules pkg:@acme/falsestart-rules` at another package's.

Seventeen of the twenty-three rules match JavaScript as well as TypeScript — `try`, `await`, `process.env`,
`fetch` and the rest are the same construct in both. The six that key on TypeScript syntax
(`no-as-any`, `no-as-never`, `no-double-cast`, `no-effect-assertion`, `no-type-assertion`,
`prefer-smart-constructor`) stay `**/*.{ts,tsx,mts,cts}`, because valid JavaScript has nothing for
them to find.

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
