---
'@sledorze/falsestart': minor
---

The CLI refuses misconfiguration instead of quietly working around it, and gains `--help`.

`falsestart --rulez foo`, a bare positional argument, and `--rules` with no directory previously
all fell back to the default rule directory and ran normally. **That is a guard enforcing a
different rule set than the one asked for, while looking healthy.** All three are now refused with
exit 1 and a message on stderr; as with every other falsestart error, the write still proceeds.

`--help` / `-h` prints usage and exits 0 without reading stdin.

Also removes the placeholder `version` export from the library surface — it duplicated
`package.json` and had to be hand-synced. Consumers wanting the version should read it from
`package.json`.
