---
'@sledorze/falsestart': minor
---

Shipped rules now cover `.mts` and `.cts`, not just `.ts` and `.tsx`.

Every rule was scoped to `**/*.{ts,tsx}`, so a repo written in `.mts` or `.cts` installed falsestart
and got **nothing** — no rule matched, no output, exit 0, indistinguishable from a clean write. The
guard was inert and said so nowhere. Both are TypeScript by any definition, and falsestart's own
config loader already accepts `falsestart.config.mts`, so the ecosystem plainly uses them.

`.js`, `.jsx`, `.mjs` and `.cjs` remain excluded, deliberately rather than by omission. The four
assertion rules match syntax that does not exist in JavaScript, and a `.js` file in a TypeScript
repo is usually a build script or generated output — exactly where a guard aimed at application code
produces false positives. A repo that wants them adds a `files` override for the rules it cares
about, which is one line and easier to reach for than undoing having been silently guarded.

**This can flip a previously-passing repo to failing** if it holds `.mts` or `.cts` sources that were
never being checked.

A test asserts both halves — every rule covers all four TypeScript extensions and reaches none of
the JavaScript ones — so a rule added later cannot quietly ship with the narrower glob. Verified by
breaking it in both directions.
