---
'@sledorze/falsestart': patch
---

Corrects claims that had gone false, and stops one rule reporting the same finding twice.

An adversarial audit of the repo's own prose found statements that were true when written and were
falsified by later changes — the kind that is worse than no documentation, because a reader acts on
them:

- **The README said shipped rules match `**/*.{ts,tsx}` only** and told `.mts`/`.cts` users to write
  their own globs. They have matched `**/*.{ts,tsx,mts,cts}` since the extension change, and
  `docs/reference.md` said so — the two docs contradicted each other, and following the README meant
  replacing a correct scope with a narrower hand-rolled one.
- **`README.summary.md` told you to register `Edit|Write` and a bare `falsestart --preset all`** —
  the two things the README itself now warns produce a hook that shows as registered and enforces
  nothing.
- **The README said `effect` was only needed for the library.** It is a required peer dependency, so
  installing this installs it either way.
- **`docs/using-the-hook.md` said `--doctor` exits 1 when no rule reaches any probed path.** It
  reports and exits 0, deliberately — and the sample transcript in that doc showed output the code
  has never produced.
- **`docs/reference.md` listed `Options` and `Preset` as exported types.** They are not: a consumer
  following that list got `TS2305`. `Diagnosis` and `DiagnoseOptions`, which are exported, were
  missing. A type-level pin now fails `pnpm typecheck` if an exported type disappears.
- **`config-file.ts` claimed to hold the codebase's only direct `node:` import.** There are five,
  two of them in that file.
- Rule counts in the README and two changesets, and a test named for a config lookup this codebase
  deliberately does not have.

**Behaviour change:** a rule written as `any:` of several patterns could match more than one at the
same node, and each match became its own finding. `load().then(d).catch(e)` reported `no-then-catch`
twice at identical coordinates in the message a blocked author reads. Findings are now one per rule
per position.

`pnpm format:check` also now runs in CI. It existed only in a `lefthook.yml` block that nothing
invoked, so formatting was enforced by a skippable local hook and nothing that could block a merge.
