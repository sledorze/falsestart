/**
 * Entry point for checking: rule documents, and applying them to source text.
 *
 * Knows nothing about processes, agent protocols, or configuration files. Why the areas are drawn
 * this way is explained in `docs/architecture.md`.
 */
export type { Finding, FileUnderCheck } from './engine.ts'
export { checkFile } from './engine.ts'
export { loadRules, RuleLoadError } from './loader.ts'
export type { Violation } from './matcher.ts'
export { findViolations, MatchError } from './matcher.ts'
export type { Language, Rule, RuleConstraint, Severity } from './rule.ts'
export { parseRule, RuleParseError, SEVERITIES, SUPPORTED_LANGUAGES } from './rule.ts'
export type { ShippedRuleId } from './rule-ids.generated.ts'
export { SHIPPED_RULE_IDS } from './rule-ids.generated.ts'
export type { FileScope } from './scope.ts'
export { appliesTo, toScopingPath } from './scope.ts'
