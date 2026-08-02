---
'@sledorze/falsestart': minor
---

Ships a starter rule corpus under `rules/`, covering generic TypeScript hygiene
(`no-as-any`, `no-double-cast`, `no-as-never`) and Effect idioms (`no-await`,
`no-new-promise`, `no-then-catch`, `no-try-catch`, `no-process-env`, `no-process-exit`).

**Adopting these rules can flip a previously-passing repository to blocking.** They are all
`error` severity, so once registered as a PreToolUse hook they deny writes outright. Every rule
exempts `*.test.*` and `*.spec.*`, and applies only to `*.ts`/`*.tsx`. Point the hook at a subset
by copying only the directories you want rather than all of `rules/`.

The Effect rules assume an Effect codebase and will be wrong for one that is not — `no-await` in
particular forbids a construct most TypeScript projects use freely.
