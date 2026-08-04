# Contributing — summary

`pnpm install`, then `pnpm verify` (lint, format, typecheck, coverage, build, docs) must be green
before you push. The git hooks run it for you but are skippable, so they are the backstop rather
than the practice. The conventions themselves live in [AGENTS.md](./AGENTS.md) and are unusual
enough to read first: content-hashed documentation summaries, a changeset for every user-facing
change, and structural rather than content-pattern scoping for anything that edits or blocks code.

**Adding a rule** — an ast-grep document under `rules/`, past three gates, each of which exists
because a rule once failed it. _Worked examples_: an entry in `src/corpus.test.ts` carrying both
`catches` and `allows`, since a rule with only positive examples looks correct until it fires on
code nobody meant to forbid. _Blast radius_: it must leave the conforming fixture alone, reach every
TypeScript and JavaScript extension unless it matches syntax valid JavaScript cannot contain (then
it goes in `TYPESCRIPT_ONLY` with a JavaScript counter-example), and build its globs from the single
extension list in `scope.ts` rather than retyping them. _Real remedies_: every API a message names
is checked against the installed package, after four messages recommended APIs that did not exist.

Then run the built binary against the real scenario — `pnpm build`, pipe a hook payload in. Unit
tests passing is necessary, not sufficient.

**Before you push**, get an adversarial review from one subagent prompted to refute, given the diff
rather than your reasoning, and verify its findings yourself before acting on them.
