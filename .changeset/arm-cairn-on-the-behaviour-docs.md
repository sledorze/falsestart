---
'@sledorze/falsestart': patch
---

`docs/reference.md` now documents the seven exports it was missing, six of which were added last
week while the page opened with "Every flag, export and shipped rule".

Internal tooling changes make that class of drift detectable rather than reviewer-dependent, and are
described in `AGENTS.md`: the two behaviour documents now carry `--refs` links to the code they
describe (they tracked zero source files while the architecture doc tracked eight), a test pins the
export enumeration the way one already pinned the rule enumeration, and `pre-commit` refuses a commit
that re-stamps a summary's hash without rewriting the summary.
