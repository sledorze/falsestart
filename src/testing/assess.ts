/**
 * Checking that a rule does what its author thinks it does.
 *
 * A rule is a small program written in a pattern language, and like any program it is wrong until
 * demonstrated otherwise. The two failure modes are not symmetric but they are equally bad: a rule
 * that misses the code it was written to catch protects nothing, and a rule that fires on innocent
 * code trains people to work around the guard. Both are only visible if you write down examples of
 * each and run them.
 *
 * Cases carry a PATH as well as code, because a rule's scope is part of its behaviour. That makes
 * it possible to write the negative test AGENTS.md asks for — evidence that an adjacent,
 * superficially similar file is provably left alone — rather than only testing what gets caught.
 */
import { Effect } from 'effect'
import type { MatchError, Rule } from '../checking/index.ts'
import { checkFile } from '../checking/index.ts'

export interface RuleExpectation {
  readonly code: string
  /** `true`: this code MUST trip the rule. `false`: it must be left alone. */
  readonly expectViolation: boolean
  readonly name: string
  /** The path this code is treated as living at — scoping is under test too. */
  readonly path: string
}

export interface CaseResult {
  /** Why it failed, absent when it passed. */
  readonly detail: string | undefined
  readonly name: string
  readonly passed: boolean
}

/** Anything carrying a rule id — the gate needs nothing else. */
export interface Identified {
  readonly id: string
}

/**
 * Runs every expectation against `rule` and reports each independently, so one wrong case does not
 * hide the others.
 */
export const assessRule = (
  rule: Rule,
  cases: readonly RuleExpectation[],
): Effect.Effect<readonly CaseResult[], MatchError> =>
  Effect.all(
    cases.map((expectation) =>
      checkFile([rule], { content: expectation.code, path: expectation.path }).pipe(
        Effect.map((findings): CaseResult => {
          const found = findings.length

          if (expectation.expectViolation && found === 0) {
            return { detail: `expected a violation, found none`, name: expectation.name, passed: false }
          }
          if (!expectation.expectViolation && found > 0) {
            return {
              detail: `unexpected violation: ${findings.map((finding) => finding.text).join(', ')}`,
              name: expectation.name,
              passed: false,
            }
          }
          return { detail: undefined, name: expectation.name, passed: true }
        }),
      ),
    ),
  )

/**
 * The ids of rules with no test file, given the rule set and the test files that exist.
 *
 * A rule ships with a test named after it. Pairing by NAME rather than by content is deliberate:
 * the question "is this rule tested" has to be answerable without running anything, or the gate
 * cannot run in CI before the tests do.
 */
export const findUntestedRules = (rules: readonly Identified[], testFiles: readonly string[]): readonly string[] => {
  const tested = new Set(
    testFiles.map((file) =>
      file
        .split('/')
        .at(-1)
        ?.replace(/\.test\.ts$/, ''),
    ),
  )

  return rules.filter((rule) => !tested.has(rule.id)).map((rule) => rule.id)
}
