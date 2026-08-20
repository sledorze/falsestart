---
'@sledorze/falsestart': patch
---

Correct five documented claims that were false, one of which was also printed by `--help`.

**`--rules` given twice is REFUSED, not ranked.** `docs/reference.md`, `docs/using-the-hook.md` and
the `--help` text all said that a `pkg:` specifier given alongside the directory form "wins, in
either order" or "replaces the first". It does neither — `falsestart: --rules can be given once;
name one directory or one pkg: specifier, not two`, exit 1. A reader following the old text expected
the last flag to take effect and got a hard failure of the whole invocation. The reference table
contradicted itself in adjacent rows, and `--help` carried the same dead sentence.

Also corrected, all verified against the shipped corpus and the manifest rather than re-read:

- `docs/reference.md` said "all five" TypeScript-only rules immediately after naming six.
- `README.md` said an example trips "six" rules and then listed five.
- `README.md`'s `pnpm verify` comment named `lint + typecheck + test + build + check`; it runs
  `lint + format:check + typecheck + coverage:ci + build + check + mutation:changed`. The `test` vs
  `coverage:ci` distinction is the one this project records as learned the hard way.
- `AGENTS.md` said `LEFTHOOK_EXCLUDE` takes one command at a time; it takes a comma-separated list.

No behaviour change. The binary already did the right thing in every case; only the descriptions of
it were wrong.
