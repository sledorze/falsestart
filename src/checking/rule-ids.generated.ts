/**
 * The ids of the rules falsestart ships.
 *
 * Exported so a TypeScript config can be checked by the compiler:

 *     rules: { [id in ShippedRuleId]?: ScopeOverride }
 *
 * `Config.rules` itself stays keyed by plain strings, because a repo may load its own rules
 * alongside these and the type must not stand in their way. A typo is still caught — at load
 * time, by the override-names-a-known-rule check, which works for custom rules too.
 *
 * Kept in step with `rules/` by a test rather than by hand.
 */
export type ShippedRuleId =
  | 'no-as-any'
  | 'no-as-never'
  | 'no-await'
  | 'no-double-cast'
  | 'no-empty-catch'
  | 'no-hardcoded-credential'
  | 'no-json-global'
  | 'no-manual-effect-run-in-tests'
  | 'no-new-promise'
  | 'no-process-env'
  | 'no-process-exit'
  | 'no-raw-coercion'
  | 'no-raw-error'
  | 'no-raw-fetch'
  | 'no-test-lifecycle-hooks'
  | 'no-throwing-decode'
  | 'no-unsafe-api'
  | 'no-then-catch'
  | 'no-try-catch'
  | 'no-type-assertion'
  | 'no-vi-mocking'
  | 'prefer-smart-constructor'

export const SHIPPED_RULE_IDS: readonly ShippedRuleId[] = [
  'no-as-any',
  'no-as-never',
  'no-await',
  'no-double-cast',
  'no-empty-catch',
  'no-hardcoded-credential',
  'no-json-global',
  'no-manual-effect-run-in-tests',
  'no-new-promise',
  'no-process-env',
  'no-process-exit',
  'no-raw-coercion',
  'no-raw-error',
  'no-raw-fetch',
  'no-test-lifecycle-hooks',
  'no-throwing-decode',
  'no-unsafe-api',
  'no-then-catch',
  'no-try-catch',
  'no-type-assertion',
  'no-vi-mocking',
  'prefer-smart-constructor',
]
