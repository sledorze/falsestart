import type { FalsestartConfig } from './src/config/index.ts'

/**
 * falsestart's own scope overrides — the first real use of this feature in this repo.
 *
 * One exemption, and it is inherent rather than lazy. `toNapiConfig` in `src/checking/matcher.ts`
 * is the seam between a rule document validated as YAML but untyped beyond that, and
 * `@ast-grep/napi`'s own types. There is nothing further to narrow with: re-deriving ast-grep's
 * whole rule grammar in TypeScript is precisely what that file argues against, since every gap
 * between the copy and the original becomes a rule that silently under-matches.
 *
 * Scoping it here rather than deleting the rule is the point. The exemption is one file wide, it
 * sits where someone reviews it, and a repo adopting `no-type-assertion` can exempt its own adapter
 * the same way instead of dropping the rule.
 *
 * A **type-only** import, because a `.ts` config is type-stripped and imported without a filesystem
 * location, so a value import cannot resolve — `satisfies` gives the same checking. Use `.mjs` if
 * you want `makeConfigUnsafe` instead. Both limits are documented in `docs/reference.md`; this file
 * exists partly to prove the documented path actually works.
 */
export default {
  rules: {
    'no-type-assertion': {
      files: ['**/*.{ts,tsx}'],
      // An override REPLACES the rule's scope rather than merging with it, so the rule's own
      // exclusions have to be restated here. Adding one exemption and forgetting them silently
      // widens the rule to files it never covered — which is how this file first turned three
      // test-file violations green-to-red.
      ignores: ['**/*.test.{ts,tsx}', '**/*.spec.{ts,tsx}', '**/*.bench.{ts,tsx}', 'src/checking/matcher.ts'],
    },
  },
} satisfies FalsestartConfig
