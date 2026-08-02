/**
 * Applies a set of rules to one file's content.
 *
 * This is where scoping and matching meet, in that order: a rule is only ever run against a file
 * its own `files`/`ignores` globs admit. Order matters for more than efficiency — it is the
 * guarantee that a rule cannot act on a file merely because the content looked right.
 *
 * The file is described by a path AND its content, supplied separately, because at write time the
 * content is not yet what is on disk — it is what is about to be. The path is used only to decide
 * scope; nothing here reads the filesystem.
 */
import { Effect } from 'effect'
import type { MatchError } from './matcher.ts'
import { findViolations } from './matcher.ts'
import type { Rule, Severity } from './rule.ts'
import { appliesTo } from './scope.ts'

export interface Finding {
  readonly column: number
  readonly line: number
  /** What to tell the author. Falls back through `note` to the rule id. */
  readonly message: string
  readonly ruleId: string
  readonly severity: Severity
  /** The source text that matched. */
  readonly text: string
}

/** The content under judgement, and the path it is destined for. */
export interface FileUnderCheck {
  readonly content: string
  readonly path: string
}

/**
 * A rule always has *something* to say, but `message` is optional in the format — a rule may carry
 * only a longer `note` instead. Naming the rule is the last resort, so a finding is never blank.
 */
const explain = (rule: Rule): string => rule.message ?? rule.note ?? `matched rule ${rule.id}`

/**
 * Runs every applicable rule over `file` and returns what they found.
 *
 * Failure to RUN a rule is propagated rather than swallowed. Treating a broken rule as "found
 * nothing" would silently downgrade the guard to permissive at exactly the moment it is least
 * trustworthy, so the caller is forced to decide what to do about it.
 */
export const checkFile = (
  rules: readonly Rule[],
  file: FileUnderCheck,
): Effect.Effect<readonly Finding[], MatchError> =>
  Effect.forEach(
    rules.filter((rule) => appliesTo(rule, file.path)),
    (rule) =>
      findViolations(rule, file.content).pipe(
        Effect.map((violations) =>
          violations.map((violation): Finding => ({
            column: violation.column,
            line: violation.line,
            message: explain(rule),
            ruleId: rule.id,
            severity: rule.severity ?? 'error',
            text: violation.text,
          })),
        ),
      ),
  ).pipe(Effect.map((perRule) => perRule.flat()))
