---
'@sledorze/falsestart': minor
---

Fifteen of the twenty shipped rules now cover JavaScript as well as TypeScript.

**This can turn a previously-passing repo red, and that is the point of the change.** Any repo
using `--preset effect` or `--preset all` that writes `.js`, `.jsx`, `.mjs` or `.cjs` files was
being told nothing about them. Those files are now judged, so writes that always broke a rule will
start being blocked — not because the rules changed, but because they finally reach the files. A
JavaScript repo that installed falsestart got a guard that was registered, healthy and completely
inert; that is what this fixes.

The widened rules match runtime constructs that exist identically in both languages: `no-await`,
`no-json-global`, `no-manual-effect-run-in-tests`, `no-new-promise`, `no-process-env`,
`no-process-exit`, `no-raw-coercion`, `no-raw-error`, `no-raw-fetch`, `no-test-lifecycle-hooks`,
`no-then-catch`, `no-throwing-decode`, `no-try-catch`, `no-unsafe-api` and `no-vi-mocking`. Each is
tested against real JavaScript rather than assumed to work there.

Five rules stay TypeScript-only — `no-as-any`, `no-as-never`, `no-double-cast`,
`no-type-assertion`, `prefer-smart-constructor` — because valid JavaScript cannot contain an `as`
expression or a `const x: T = {…}` annotation for them to find. Worth knowing if you were relying
on the opposite: they are not incapable of firing on a `.js` file, since the parser follows a
rule's `language: tsx` rather than the file's extension. Scoping them there would claim coverage a
JavaScript file can never trip.

To keep the old behaviour, re-scope the rules you want narrowed in `falsestart.config.ts`:

```ts
export default {
  rules: { 'no-try-catch': { files: ['src/**/*.{ts,tsx,mts,cts}'] } },
} satisfies FalsestartConfig
```

JavaScript's own type assertion, a JSDoc cast like `/** @type {any} */ (value)`, is still caught by
no shipped rule.
