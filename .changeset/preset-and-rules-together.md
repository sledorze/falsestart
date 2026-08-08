---
'@sledorze/falsestart': minor
---

`--preset` and `--rules` now combine: one invocation can load a shipped rule set and your own.

`falsestart --preset clean-code --rules ./.falsestart/rules` was refused before, so "the shipped
rules plus mine" meant two hook entries with a duplicated matcher. That is not just verbose — both
entries auto-discover the same `falsestart.config.*`, and an override naming a rule the OTHER entry
loaded is a hard error, so a repo re-scoping rules from both sets could not have a working config at
all. Under `--fail closed` that error denies every write in the repository.

A rule id defined by both sources is **REFUSED**, naming both directories, rather than resolved by
precedence. Whichever rule lost would carry a `files` glob nobody is enforcing, and "the later source
wins" would make `--preset all --rules ./r` and the reverse enforce different things. **This can turn
a previously-passing repo red** in one narrow case: a repo that already vendored a copy of a shipped
rule under its own id, and now names both sources in one invocation, gets a refusal instead of a
silent shadowing. Rename the local rule or drop it.

`--doctor` prints one `rules` row per source rather than one total, because a single number cannot
answer "did my own rules load, or only the preset?".

Two things deliberately did not change. Between the two `--rules` forms the package form still wins
whichever was written first, rather than becoming a third source — the directory in
`--rules pkg:@acme/rules --rules ./local` was named only to be overridden. And `--preset all` alone
still loads exactly the preset: the `.falsestart/rules` default applies only when nothing else names
a source, so a union never quietly adds a directory the caller did not ask for.

Only the `--rules` source can be frozen: a preset resolves inside `node_modules`, which the
project's repository does not track. Under the default `--freeze auto` that is unchanged — the
working tree is read for it, as it always was.

Under `--freeze require` a preset is **refused**, whether or not a `--rules` directory is named
alongside it, and that is a deliberate part of this change rather than a side effect. `require`
means "judge nothing the ref cannot account for". Freezing only the caller's own directory would
have reported `frozen`, exited 0, and judged with an unverified preset the report never named.
A preset was already refused under `require` when it was the only source, so no working setup
changes; what changes is that combining it with `--rules` does not buy an exemption.

`loadRuleSources`, `mergeRuleSets` and the `RuleGroup`/`RuleSource` types are exported, and
`RespondOptions`/`DiagnoseOptions` gain an optional `shippedDirectories`. Optional, so a library
call written before this still compiles unchanged.
