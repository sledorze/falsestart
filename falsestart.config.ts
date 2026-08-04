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
    // Serialising a literal to satisfy an EXTERNAL wire protocol: the Claude Code hook response on
    // stdout, whose shape is fixed by someone else's contract and has no decode side to keep in
    // step. Encoding it through a schema would turn two pure functions into Effects on the path
    // that runs before every tool call, and buy nothing — an inline object literal cannot be
    // circular, cannot hold a BigInt, and cannot stringify to `undefined`.
    //
    // `cli.ts` renders an arbitrary `unknown` warning argument to text purely to substring-match it
    // for suppression. There is no shape to declare, because the value is whatever Node emitted.
    //
    // Both are the exception the rule's own note names. PARSING is never in this list.
    'no-json-global': {
      files: ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'],
      ignores: [
        '**/*.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
        '**/*.spec.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
        '**/*.bench.{ts,tsx,mts,cts,js,jsx,mjs,cjs}',
        'src/hook/respond.ts',
        'src/cli.ts',
        // Encoding a flat array of strings to a file this tool owns and re-reads. The DECODE side
        // in the same module goes through `Schema.UnknownFromJsonString` and validates every
        // entry, which is the half the rule's own note says is never exempt.
        'src/scanning/baseline.ts',
      ],
    },
    'no-type-assertion': {
      files: ['**/*.{ts,tsx,mts,cts}'],
      // An override REPLACES the rule's scope rather than merging with it, so the rule's own
      // globs have to be restated here in full. That cuts BOTH ways, and this file had only ever
      // worried about one of them.
      //
      // Forgetting an `ignores` entry widens the rule to files it never covered — which is how
      // this file first turned three test-file violations green-to-red.
      //
      // Forgetting an extension in `files` NARROWS it, and that direction is silent. Both of these
      // overrides said `{ts,tsx}` and had quietly stopped covering `.mts` and `.cts` since the
      // release that added them, plus every JavaScript extension once `no-json-global` grew them.
      // Nothing failed; there simply were no `.mts` files here yet for anyone to notice. `--doctor`
      // now names the extensions an override drops, which is how this was finally caught.
      ignores: [
        '**/*.test.{ts,tsx,mts,cts}',
        '**/*.spec.{ts,tsx,mts,cts}',
        '**/*.bench.{ts,tsx,mts,cts}',
        'src/checking/matcher.ts',
      ],
    },
  },
} satisfies FalsestartConfig
