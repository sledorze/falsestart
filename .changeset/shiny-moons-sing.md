---
'@sledorze/falsestart': minor
---

Rules can now come from another package: `--rules pkg:@acme/falsestart-rules`.

There were only ever two sources — falsestart's own (`--preset`) and a local directory
(`--rules <dir>`). A third-party rule set was unusable except by hand-writing
`--rules node_modules/@acme/falsestart-rules/rules`, which is undocumented and does not exist under
pnpm's layout.

A specifier may name a subdirectory (`pkg:@acme/falsestart-rules/strict`) to take part of a set. The
package is expected to keep its rules in `rules/`, as falsestart does, and is resolved from **your
project**, so it is found wherever your package manager actually put it.

The `pkg:` prefix is required rather than inferred from the shape of the value: `--rules rules` has
always meant the `rules/` directory, and reinterpreting bare names as packages would silently change
which rule set an existing setup loads. A package that will not resolve is reported without
blocking, like every other misconfiguration.
