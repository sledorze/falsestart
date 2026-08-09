---
'@sledorze/falsestart': minor
---

Two inputs that made the guard go silent are now refused or handled, and a defect can no longer exit
with nothing on either stream.

**An empty glob in `files`/`ignores` is refused at load.** `files: ['']` loaded clean and then killed
every judged write: `picomatch.isMatch` throws on an empty pattern, and a throw is a _defect_ — it
escapes every error boundary in the program. Measured in every mode: **exit 1, stdout 0 bytes, stderr
0 bytes**, `--doctor` included. `--fail closed` could not deny it, so the strictest setting failed
open; under `--agent copilot` a non-zero exit denies every tool call in the session, with nothing
anywhere saying why. One character, in a file this tool asks people to write by hand. Refused in
config scope overrides too.

**A `..` segment in a reported path is now collapsed.** `sub/../src/a.ts` matched no repo-relative
glob, so the hook allowed it in silence — while `scan`, which resolves the path first, denied the
same file. Two enforcement points disagreeing, and the quiet one guards the writes. The collapse is
purely lexical: `a/b/../c` is `a/c` on every filesystem, so the rule that scoping must never depend
on the disk is untouched. A leading `..` that cannot be collapsed is kept rather than invented away.

**This can turn a previously-passing repo red**, twice over: a rule set carrying an empty glob now
fails to load instead of crashing, and rules that silently skipped `..`-spelled paths now fire on
them.

**And a defect now says so.** `runMain` runs with error reporting off, which is right for every
failure — each is already written in the hook contract's shape — and was wrong for a throw, which
had written nothing. Any defect now prints that it is a bug in falsestart rather than a problem with
your rules, that the write was **not** checked, and the underlying text. It exits 1 under Claude
Code, 0 under `--agent copilot` where any non-zero denies, and 2 under `scan` where a shell reads 1
as findings.
