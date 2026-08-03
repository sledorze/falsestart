---
'@sledorze/falsestart': patch
---

Fixes a stale file reference in an earlier changeset — `no-raw-coercion.yml` moved from
`rules/clean-code/` to `rules/effect/` when its message started naming Effect Schema, and the
release note still cited the old path.

It was found by a cairn feature this repo had never switched on, which is the more useful part:
`--prose-refs` checks bare-backtick file citations in prose, the kind that look like documentation
but are invisible to a link checker. Together with widening cairn's root from `docs/` to the
repository, that takes coverage from 8 files to 14 — `README.md` and `AGENTS.md` carry fifteen file
citations between them and were previously checked by nothing at all.
