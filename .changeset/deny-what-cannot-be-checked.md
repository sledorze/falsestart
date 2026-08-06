---
'@sledorze/falsestart': minor
---

`--fail closed`: deny a write falsestart could not check

`--fail closed` makes a failure of falsestart **itself** deny the write instead of reporting it on
stderr and letting the write through. `falsestart --preset all --fail closed` in your hook command
is the whole setup.

**No judged write changes verdict unless you ask.** The default is `--fail open`, which is today's
behaviour byte for byte.

What `--fail closed` covers: a rule tree or a `--rules pkg:` rules package that will not load, a
config that will not load, an override naming a rule the loaded set does not contain, and a rule that
cannot run at match time. What it does not: a **malformed hook payload**, because it is the agent
runtime's shape rather than your repository's and there is nothing in your project to fix; and a
**refused command line**, because `--fail` is on the very line the parser just declined to
understand. It applies to a **judged write** only — a tool call falsestart does not judge is silent
in either policy — and it is a policy about failures, not a claim that any rule covers what you
write. For that, read `--doctor`'s scope block and `--warn-unscoped`.

**`--fail open` is not an off switch for the freeze.** A source the ref established as freezable and
could not be read still denies, and its reason still names `--freeze off`.

Know the repair trap before turning it on: falsestart answers a load-time failure before it judges
anything, so while `--fail closed` is on and the rule tree is broken, every judged write is denied —
including the edit that would fix the rule document. The denial says so and names `--fail open` as
the way through.

**Two behaviour changes ship regardless of the flag.** Both are non-blocking, and both are named here
because a changelog reader is the only person who will see them:

1. With `--rules pkg:` naming a package that will not resolve, a tool call falsestart does **not
   judge** (`Bash`, `Read`, and anything outside `Write`/`Edit`/`NotebookEdit`) is now **silent**
   instead of exit 1 with a stderr notice — the same as every other rules-source failure. A judged
   write is unaffected.
2. `falsestart --doctor --rules pkg:<missing>` now prints a report ending in a
   `COULD NOT RESOLVE` line and exits 1, where it previously printed one stderr line and no report
   at all.

`scan` and `--list-rules` **refuse** the flag: both already exit 2 when they cannot run, so `closed`
would be a no-op and `open` would weaken a shipped guarantee. No existing command line contains
`--fail`, so nothing that parsed yesterday is refused today.

`--doctor` prints a `policy` line **only when `--fail` was given**, before anything is resolved — so
it is still there when nothing resolved, and `--doctor`'s output is unchanged for anyone who does not
use the flag.

New exports: `FAILURE_POLICIES`, type `FailurePolicy`. New **optional** fields
`RespondOptions.failure`, `RespondOptions.unresolvedRules`, `DiagnoseOptions.failure` and
`DiagnoseOptions.unresolvedRules` — all optional, so no consumer's `tsc` turns red.
