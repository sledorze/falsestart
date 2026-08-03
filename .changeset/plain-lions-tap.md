---
'@sledorze/falsestart': patch
---

Documents which tool calls falsestart actually judges.

The most consequential fact about a PreToolUse hook — which tool calls it inspects — was stated
nowhere. A reader could not tell whether their write was covered, and anything outside the set is
allowed in silence, which is indistinguishable from a clean write.

`docs/reference.md` now carries the table: `Write` (`file_path`/`content`), `Edit`
(`file_path`/`new_string`), `NotebookEdit` (`notebook_path`/`new_source`). That is the complete set
of Claude Code built-ins that carry file content — checked against the documentation rather than
assumed, and there is no `MultiEdit`. `WRITE_TOOLS` is now exported so the table is asserted against
the code by a test instead of maintained by hand; it fails from either side, verified by breaking
both.

Also stated plainly: `Bash` is deliberately absent, so a heredoc or shell redirect writes a file
falsestart never sees. That is a real hole rather than an oversight — judging shell commands would
mean predicting what they do — and a reader deciding whether to rely on this should know it.

No behaviour change.
