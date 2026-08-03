---
'@sledorze/falsestart': minor
---

Config can be TypeScript, and `files` is now required in an override.

`falsestart.config.ts` is type-checked against the exported `FalsestartConfig`, so a malformed
override or a mistyped rule id is a compile error in your editor rather than a runtime report:

```ts
import type { FalsestartConfig } from '@sledorze/falsestart'

export default {
  rules: { 'prefer-smart-constructor': { files: ['src/domain/**/*.ts'] } },
} satisfies FalsestartConfig
```

Use a **type-only** import: a `.ts` config has its types stripped and is imported without a
filesystem location, so it cannot resolve a value import. `.js`/`.mjs` configs are imported from
their real path and may import anything, including the new `defineConfig` helper. `.json` still
works. `ShippedRuleId` and `SHIPPED_RULE_IDS` are exported for typing rule ids.

**Breaking, if you already wrote a config:** `files` is now required in a scope override. An
override exists to say where a rule applies in _this_ repo, and one that adjusts only `ignores`
leaves that inherited from an author who never saw your layout. `ignores` stays optional and, when
omitted, the rule keeps its own.

Without `--config`, falsestart now looks for `falsestart.config.{ts,mts,js,mjs,json}` beside the
rules directory — _superseded by a later change: the lookup is in the project directory, since
`--preset` and `pkg:` both put the rules inside `node_modules`_ — previously it looked only for `falsestart.config.json`. Two present is an error
rather than a precedence rule. A config named explicitly with `--config` must now exist, where
before a missing one was silently ignored.
