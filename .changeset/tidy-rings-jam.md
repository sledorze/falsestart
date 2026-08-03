---
'@sledorze/falsestart': patch
---

`pnpm verify` now runs `format:check`, so it covers every gate CI applies.

CI gained `pnpm format:check` in an earlier change; `pnpm verify` did not. That made "local verify
green, merge red" a structural possibility rather than a mistake — and it happened immediately: a
config file written by a script, formatted by nothing, passed verify and failed CI. A verify that
omits a gate CI applies is a verify you cannot trust.
