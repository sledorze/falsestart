---
'@sledorze/falsestart': patch
---

Fixes a race in the pre-commit hook that let a stale documentation stamp into a commit.

`pre-commit` was `parallel: true`, so `prettier --write` and `oxlint --fix` rewrote files while the
`docs` step was concurrently hashing them. The docs check could read a file prettier was about to
change, pass, and leave a stale `.cairn/` sidecar in the commit — which only surfaced at push, after
the commit already existed.

Reproduced deliberately: hand-edit a markdown table with narrow column padding, run `pnpm stamp`,
then let prettier realign it. The stamp was made against the unformatted text and no longer matches.
That cost two amend cycles in a single session before the cause was found, and both times the
symptom appeared at `git push` with no obvious connection to formatting.

`pre-commit` is now `piped` with explicit priorities, so the docs check always sees post-format
content and a stale stamp is rejected at commit time with the drift named. Verified by
reconstructing the exact scenario: the commit is refused, and `git log` confirms it did not land.

The hook still only **checks**. Stamping is where you assert a doc's claim about a source file is
still true, so a hook that stamped for you would turn the gate into a reflex — precisely the failure
AGENTS.md records against re-stamping without reading the diff.
