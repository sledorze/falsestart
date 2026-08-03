---
'@sledorze/falsestart': patch
---

Upgrades cairn to 0.7.0 and drops two workarounds it makes unnecessary.

Four of the six issues this repo filed upstream are fixed in 0.7.0, and two of them existed here as
workarounds:

- **Root-relative `ignore` patterns now match.** Every entry in `.cairnrc.json` carried a `**/`
  prefix — `**/.changeset/**` rather than `.changeset/**` — because the plain form silently matched
  nothing and cairn then demanded a `_SUMMARY.md` in directories that were supposed to be excluded.
  Verified before and after: without the exclusion, 12 problems; with the root-relative form, none.
- **A link to a child directory's own `_SUMMARY.md` satisfies link-completeness.** The root summary
  had to carry both `[docs/](./docs)` and a separate index link, because the bare directory link was
  the only one that counted — which pushed authors toward the worse destination, since GitHub
  renders `./docs` as a file listing and `./docs/_SUMMARY.md` as the curated index. Now just the
  index.

`pnpm check` also gains `--report-deletions`, which is new in 0.7.0 and exists because of the issue
this repo filed: a lossy dedup here deleted the only description of `--refs`, `--prose-refs` and
`checks.coverage`, and every check stayed green because everything remaining was internally
consistent. It is informational and never affects the exit code.

`--prose-refs` is also no longer labelled a migration aid in cairn's help — it was the only check
covering bare-backtick file citations, and this repo had been relying on it permanently.
