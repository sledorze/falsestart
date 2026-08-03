---
'@sledorze/falsestart': minor
---

Reorganises the source tree around a stated taxonomy, and the docs around reader need.

`core/` is renamed `checking/` — "core" meant "everything we did not classify". Two files were
filed by habit rather than by rule: `options.ts` parsed CLI flags from under `hook/` despite having
nothing to do with the PreToolUse protocol, and `config-file.ts` reached for `node:module` from
under `core/`. They now live in `cli/` and `config/`.

Each area presents an `index.ts` entry point, and cross-area imports go through it. This is the
piece that was missing entirely: with no stable surface to cite, `architecture.md` had to name
fourteen implementation files, so its reference-drift check fired on every implementation edit and
said nothing. It now cites six entry points, and drift means the area's offering changed.

**Public API shape is unchanged** — `src/index.ts` still re-exports the same names, now via the
entry points rather than the leaves.

Adds `docs/reference.md`: the flags, exit codes, rule document format, configuration, all fifteen
shipped rules, and the library exports. There was no reference documentation at all despite a
thirty-export API. The docs index is now organised by what a reader is trying to do, and names the
absence of a tutorial as a known gap.

The taxonomy is stated once, in `docs/architecture.md`, rather than restated in module docstrings
that would drift apart from it.

Also drops `src/testSupport/**` and `scripts/**` from the coverage excludes — neither directory has
ever existed in this project.
