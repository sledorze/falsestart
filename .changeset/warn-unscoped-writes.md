---
'@sledorze/falsestart': minor
---

Add `--warn-unscoped`, which reports a judged write that no rule is scoped to instead of passing it
in silence.

Without it, "no rule looked at this file" and "every rule looked and found nothing" are the same
observable outcome: nothing. A repo can wire the hook up correctly, see it registered and healthy,
and have it check none of the files being written — the shipped rules match only
`**/*.{ts,tsx,mts,cts}`, so a JavaScript repo gets a guard that is installed and inert. That is how
this was found: a probe file carrying a hardcoded credential was written to a `.js` path, went
through untouched, and was reported as "falsestart does not block".

The flag is non-blocking and cannot pre-empt a denial — a rule that could block is by definition a
rule that applies. It does not change any existing decision, so no previously-passing repo can
start failing because of it.

It is refused with `--doctor` rather than accepted and ignored: `--doctor` reads no payload to
report on, and its scope block already prints a rule count per probed path, where a `0` is the same
fact this flag reports at write time.

It is off by default because the signal is noisy, and that is worth knowing before turning it on.
Measured against the shipped presets, it fires on every `.md`, `.json`, `.yml` and `.js` write
under all three, and on test files under `clean-code` only — whose four rules all ignore them,
while `effect` carries three rules that exist to judge them.
