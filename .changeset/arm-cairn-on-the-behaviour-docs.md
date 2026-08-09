---
'@sledorze/falsestart': patch
---

`docs/reference.md` now documents the seven exports it was missing — six of them added the same week,
while the page opened with "Every flag, export and shipped rule".

The two behaviour documents also gained `--refs` links to the code they describe. `cairn --refs` only
protects prose that links to its subject, and those two tracked **zero** source files while the
architecture doc tracked eight — which is why every false sentence found that week was in one of
them, under a green check. A change to the parser, the decision path, the diagnostic, the freeze or
rule scoping now fails the check and forces the prose to be re-read.

A test pins the export enumeration, the way one already pinned the shipped-rule enumeration. The two
enumerations with tests stayed correct; the one without drifted.
