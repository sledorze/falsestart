/**
 * Entry point for the helpers a consumer uses to test their own rules.
 *
 * Public API despite the directory name — a rule is a program, and this is how you show it does
 * what you think.
 */
export type { CaseResult, Identified, RuleExpectation } from './assess.ts'
export { assessRule, findUntestedRules } from './assess.ts'
