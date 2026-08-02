/**
 * falsestart's library surface.
 *
 * The executable is one consumer of this; nothing here knows about processes, argv, or exit
 * codes, so the same pieces can be driven from a test, a script, or a different harness entirely.
 *
 * The layering is deliberately one-directional: a rule is parsed, scoped, matched, and only then
 * judged. Each step is usable on its own.
 */

// Rule documents — parsing and validation.
export type { Language, Rule, RuleConstraint, Severity } from './core/rule.ts'
export { parseRule, RuleParseError, SEVERITIES, SUPPORTED_LANGUAGES } from './core/rule.ts'

// Rule trees — loading a directory of documents.
export { loadRules, RuleLoadError } from './core/loader.ts'

// Scope — which files a rule may act on.
export type { FileScope } from './core/scope.ts'
export { appliesTo } from './core/scope.ts'

// Matching — running one rule against source text.
export type { Violation } from './core/matcher.ts'
export { findViolations, MatchError } from './core/matcher.ts'

// Checking — applying a rule set to a file.
export type { FileUnderCheck, Finding } from './core/engine.ts'
export { checkFile } from './core/engine.ts'

// Verdicts — turning a tool call into a decision, and a decision into process output.
export type { Decision } from './hook/decide.ts'
export { decide, judgesPayload } from './hook/decide.ts'
export type { HookResponse } from './hook/respond.ts'
export { respond } from './hook/respond.ts'

// Testing — proving a rule does what its author thinks.
export type { CaseResult, Identified, RuleExpectation } from './testing/assess.ts'
export { assessRule, findUntestedRules } from './testing/assess.ts'
