# Contributing

`pnpm install`, then `pnpm verify` — lint, format, typecheck, tests, build, docs. It must be green
before you push; the git hooks run it for you but are skippable, so treat them as the backstop.

The conventions this repo holds you to are in [AGENTS.md](./AGENTS.md), and they are unusual enough
to be worth reading before your first change: documentation summaries are content-hashed and
checked, every user-facing change needs a changeset, and a rule that edits or blocks code must be
scoped structurally rather than by a content match.

## Adding a rule

Rules are [ast-grep](https://ast-grep.github.io) documents under `rules/`. Three gates apply, and
each exists because a rule once failed it:

- **Worked examples.** `src/corpus.test.ts` needs an entry with both `catches` and `allows`. A rule
  with only positive examples looks correct right up until it fires on code nobody meant to forbid.
- **Blast radius.** It must not fire on the conforming fixture, and the extension test asserts it
  reaches every TypeScript extension — plus every JavaScript one, unless the rule matches syntax
  valid JavaScript cannot contain, in which case add it to `TYPESCRIPT_ONLY` and give it a
  JavaScript counter-example. A third test asserts the rule's globs are built from the one
  extension list in `scope.ts` rather than retyped.
- **Real remedies.** Every API a message names is checked against the installed package, because
  four messages once recommended APIs that did not exist.

Run the built binary against the scenario before calling it done — `pnpm build`, then pipe a hook
payload in. Unit tests passing is necessary, not sufficient.

## Before you push

Get an adversarial review from one subagent prompted to refute, given the diff rather than your
reasoning, and verify its findings yourself before acting. AGENTS.md explains why, and what it has
caught.
