---
'@sledorze/falsestart': minor
---

Make four things falsestart already does findable, and report one of them.

`--doctor` now says how many of the loaded rules can block: `rules  rules — 23 loaded (23 block,
0 advise)`. Both counts print even when one is zero, because the reader who needs to know advisory
rules exist is precisely the one whose rule set has none. The `N loaded` text is unchanged.

A rule's `severity` defaults to `error` and only `error` denies a write: a rule declaring `warning`,
`info` or `hint` is shown to the author as `{"systemMessage": …}` with no `permissionDecision`, and
the write proceeds. The how-to now shows that output, and states the cost — severity is a field of
the rule document, so a rule that must block in one tree and advise in another exists twice.

Running your own `Bash` guard beside falsestart is the intended arrangement, not a workaround: two
`PreToolUse` entries, and on a tool call falsestart does not judge it emits nothing on either stream
and exits 0 before its rule tree is read. There is a copyable `settings.json` for it.

Large rule trees: subdirectories load recursively, ids must be unique across the whole tree, and a
`_utils/` directory of shared matchers is recognised only at the top level of the tree `--rules`
names — one nested inside a category is loaded as a rule and fails the whole tree. One invocation
loads one rule source: `--rules` cannot be combined with `--preset` at all, and where both `--rules`
forms are given the `pkg:` one wins whatever the order. Layering trees means one hook entry per tree.
The architecture doc now carries a measured cost model, stamped with the machine and version it was
measured on.

Rules that need repository-wide knowledge are a non-goal, stated outright: a rule is evaluated
against one file's syntax tree, so "flag this unless it is declared somewhere else in the repo" is
not expressible. A config file is executed, so a rule's scope can be computed at load time; its
match cannot.

Corrected in passing: the docs said a `.ts` config cannot resolve a value import. It cannot resolve
a package or relative one — `node:` builtins do work, which is what makes computing a scope by
shelling out possible in the typed config format.
