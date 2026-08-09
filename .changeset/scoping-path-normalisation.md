---
'@sledorze/falsestart': minor
---

`toScopingPath` now normalises `./` prefixes, doubled separators and interior `./` segments, so
every spelling of a path scopes identically.

A glob is matched against the literal path string, so `./src/a.ts` matched **nothing** — not even
`**/*.ts`. Zero findings on a file that should be blocked is indistinguishable from a clean file, so
the failure was total and completely silent.

It was latent, because the only caller receives Claude Code's `file_path`, which is always absolute
and already clean. Any caller that forwards paths hits it immediately — lefthook's `root:` setting,
the documented way to scope a hook to one package of a monorepo, emits exactly `./src/a.ts`, and so
does `find . | xargs`. Anyone calling the exported `toScopingPath` from their own tooling was
affected today.

`..` is deliberately still not resolved: doing so would require anchoring the path to a real
directory, and a scoping decision must not depend on the filesystem, or a rule starts behaving
differently in CI than it does locally.
