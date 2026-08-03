---
'@sledorze/falsestart': minor
---

Corrects rule validation against the real ast-grep CLI, and adds `no-raw-coercion`.

The validator added in the previous release was written from reasoning rather than measurement,
and was wrong in both directions. It **rejected valid rules** — `all:` of two structured patterns
is accepted by the upstream CLI — and **accepted invalid ones**: a single `regex` clause, an `any:`
of regexes, and any invalid composite nested inside another. Every accept/reject decision is now
modelled on the CLI's actual behaviour, with each shape recorded as a test.

**If a rule of yours started failing after the previous release, this likely fixes it.** If a rule
has been quietly matching far more than intended, this may now report it as a rule error instead.

New `rules/effect/no-raw-coercion.yml` (`error`): flags `String(x)`, `Number(x)`, `Boolean(x)`
and `!!x`. These are total functions — every input yields an output, including inputs that are a
bug, so `String(undefined)` becomes `"undefined"` and `Number("12abc")` becomes `NaN`. It is a
coercion rule rather than a conversion ban: `value.toString()`, `Number.parseInt(raw, 10)`,
`items.filter(Boolean)` and template interpolation are all left alone, each proved by an example.
