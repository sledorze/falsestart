---
'@sledorze/falsestart': minor
---

Exposes a real smart constructor for config, replacing `defineConfig`.

`defineConfig` was a typed identity function: it annotated a literal and checked nothing. That is
precisely the shape falsestart's own `prefer-smart-constructor` rule objects to, so the tool was
shipping advice its own helper ignored.

```js
// falsestart.config.mjs
import { makeConfigUnsafe } from '@sledorze/falsestart'

export default makeConfigUnsafe({
  rules: { 'prefer-smart-constructor': { files: ['src/domain/**/*.ts'] } },
})
```

`makeConfig(input: unknown)` validates and returns an `Effect`; `makeConfigUnsafe` is the same
check, throwing at import, which is the clearest failure for a config module. Both take `unknown`
deliberately — a constructor that only accepts an already-correct `Config` has nothing left to
verify, and a config assembled from an environment variable or another tool's output is exactly
the case worth checking.

**Breaking:** `defineConfig` is removed. In a `.ts` config keep using `satisfies FalsestartConfig`
(a type-stripped config cannot resolve a value import); in `.mjs`/`.js` use `makeConfigUnsafe`.

Prefer `.mjs` over `.js` for a JavaScript config: a `.js` config in a package without
`"type": "module"` makes Node reparse it. falsestart now suppresses that warning and the
type-stripping experimental warning, both of which fired once per judged tool call on the same
stream it reports real problems on.
