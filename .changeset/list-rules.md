---
'@sledorze/falsestart': minor
---

`--list-rules`: print the resolved rule set as JSON, so a repo can assert on it

`falsestart --list-rules` writes the rule set it actually loaded to stdout as JSON, one rule per
line, and exits without reading stdin. Resolved, not raw: `--preset` and `--rules pkg:` are resolved
first and your `falsestart.config.ts` scope overrides are applied, so the globs in the output are
the ones that will really decide what gets judged rather than the ones the rule shipped with.

Each entry carries exactly `files`, `id`, `ignores`, `language` and `severity`. The matcher and the
rule's prose are deliberately absent, so a pattern refactor or a wording fix cannot break an
assertion written against the document. `files: null` means the rule declares no scope and matches
every path, which is the opposite of `files: []`. Entries are sorted by id, so two runs diff cleanly
however the rule tree happens to be laid out on disk. A config's top-level `exclude` is NOT in the
document: it applies to `scan` rather than to any rule, so pin it by reading your config file.

It answers a script rather than the hook protocol, so once it is running it uses `scan`'s exit
codes: 0 with the document on stdout, 2 when the rule set could not be produced. A refused command
line still exits 1, the shared code — exit 2 from a `PreToolUse` hook blocks the write, and an
argument error must never be able to do that.

Also exported for use from your own tests: `describeRules(rules)` returns the same entries,
`ruleListText(rules)` returns the same bytes, and `RuleDescriptionSchema` decodes a document you
read back.

This cannot turn a passing repo red. No existing invocation changes behaviour, and no existing exit
code changes. `--list-rules` is refused alongside `scan`, `--doctor`, `--version` and
`--warn-unscoped` rather than quietly ignored, and there is no `--json` flag — the output is JSON
because that is the only thing this command is for.
