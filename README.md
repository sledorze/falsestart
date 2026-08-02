# falsestart

Blocks risky code patterns the instant an AI writes them — before the file lands, not
just at CI. Can also be used to enforce structure/architecture conventions.

Status: early scaffold. No functionality yet — this repo currently carries only the
tooling/quality baseline (TypeScript, vitest, oxlint, prettier, lefthook, stryker,
changesets, cairn docs enforcement), matching the conventions used in
[cairn](https://github.com/sledorze/cairn).

## Development

```bash
pnpm install
pnpm verify   # lint + typecheck + test + build + check
```

See [AGENTS.md](./AGENTS.md) for the documentation, release, and shipping conventions
this repo follows.
