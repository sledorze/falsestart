---
'@sledorze/falsestart': patch
---

`--help` no longer claims `--warn-unscoped` fires on every `.js` write. It does not, and has not
since 0.2.0 gave `clean-code` its first two rules that reach JavaScript — so every shipped preset now
covers a `.js` write and the signal stays quiet on one.

Measured across all three presets rather than re-asserted: it fires on `.md`, `.json` and `.yml`, and
additionally on test files under `clean-code`. A claim about how noisy a signal is rots precisely
when the rule set grows, which is what happened here, in the copy most users read.

A test now pins it — no shipped preset may leave `src/a.js` unscoped, and the help text may not say
otherwise.
