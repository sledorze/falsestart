---
'@sledorze/falsestart': patch
---

Document how to check that two agent registrations have not drifted apart

A repository serving both Claude Code and GitHub Copilot CLI registers falsestart twice, in
`.claude/settings.json` and in `.github/hooks/*.json`. falsestart reads neither: it is invoked BY
the wiring and never inspects it. `--doctor` cannot close that gap either — it answers "did what I
registered resolve, and does it block", and reads no repository config at all.

**Check both runtimes enforce the same thing** in `docs/using-the-hook.md` is a ~100-line script a
repository owns, built out of the already-exported `AGENTS` and `WRITE_TOOLS` and out of
`--list-rules`, with the real output of every case it reports. It catches a Copilot registration
that forgot `--agent copilot` — worse than a missing one, because that denies every tool call in
the session; a declared runtime whose config holds someone else's guard and not falsestart; a
Claude Code matcher that never reaches a write tool; an unparseable config, which discards every
hook in the file and so throws rather than degrading to "no hooks found"; and the drift a presence
check reports green on — both files registered, `--preset clean-code` in one and `--preset all` in
the other.

Absence of a runtime's config stays not-a-finding: a repository with no `.github/hooks/` has said
nothing about Copilot, and reporting there would be inferring intent. The five answers the check
gets wrong are tabulated in the doc rather than left to be discovered — two silences, and three
findings it raises against a repository that is wired correctly, one of which this same page
recommends the arrangement for.

No behaviour change, and no new flag — this is prose, and the material it uses was already public.
`docs/` ships in the package, so it reaches an installed copy only through a release.
