---
'@sledorze/falsestart': minor
---

A repo can now decide where each rule applies, without editing the rule.

`falsestart.config.json` (or `--config <file>`) re-scopes any loaded rule:

```json
{ "rules": { "prefer-smart-constructor": { "files": ["src/domain/**/*.ts"] } } }
```

Previously a rule's `files`/`ignores` were fixed by whoever wrote it, and the only way to change
them was to edit a vendored file under `node_modules`, which the next install destroys. That made
the documented advice — "narrow the globs rather than soften the severity" — impossible to follow,
and left dropping the rule entirely as the only real option.

An override changes **only the keys it names**, so setting `files` keeps the rule's own `ignores`:
re-scoping where a rule looks must not quietly discard the test-file exemption its author wrote.
An override naming a rule that is not loaded is an error rather than a no-op, since a typo'd id
would otherwise be a scope change that silently never happens.

The config file is optional and an absent one means no overrides. A file that exists but cannot be
read or parsed is reported, because its author expected it to apply.
