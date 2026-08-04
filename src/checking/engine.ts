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
import type { MatchError, ParsedSource } from './matcher.ts'
import { findViolationsIn, parseSource } from './matcher.ts'
import type { Language, Rule, Severity } from './rule.ts'
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
 *
 * One finding per rule per position. A rule written as `any:` of several patterns can match more
 * than one of them at the same node — `load().then(d).catch(e)` tripped `no-then-catch` twice at
 * identical coordinates — and the reader of a `permissionDecisionReason` sees a duplicated line with
 * nothing to distinguish it.
 */
export const checkFile = (
  rules: readonly Rule[],
  file: FileUnderCheck,
): Effect.Effect<readonly Finding[], MatchError> =>
  Effect.forEach(byLanguage(rules.filter((rule) => appliesTo(rule, file.path))), (group) => {
    const [language, applicable] = group

    return parseSource(language, file.content).pipe(Effect.flatMap((root) => allFindingsFor(root, applicable)))
  }).pipe(Effect.map((perLanguage) => onePerRulePerPosition(perLanguage.flat())))

/**
 * The applicable rules, grouped by the language their matcher is written against.
 *
 * Each group is parsed ONCE. Parsing used to happen per rule, and it is where essentially all the
 * time goes: measured on a 762 KB source file, one parse costs 94ms while one match against the
 * parsed tree costs 3ms, so twenty-two rules spent 2046ms parsing to do 60ms of matching.
 * Ninety-seven per cent of the work was re-reading the same source into the same tree.
 *
 * A `Map` rather than sorting, so rules keep the order they were loaded in within each group and
 * the report stays stable.
 */
const byLanguage = (rules: readonly Rule[]): readonly (readonly [Language, readonly Rule[]])[] => {
  const grouped = new Map<Language, Rule[]>()

  for (const rule of rules) {
    const existing = grouped.get(rule.language)
    if (existing === undefined) {
      grouped.set(rule.language, [rule])
    } else {
      existing.push(rule)
    }
  }

  return [...grouped]
}

/** Every applicable rule of one language, run against the tree that language was parsed into. */
const allFindingsFor = (root: ParsedSource, rules: readonly Rule[]): Effect.Effect<Finding[], MatchError> =>
  Effect.all(rules.map((rule) => findingsFor(root, rule))).pipe(Effect.map((perRule) => perRule.flat()))

const findingsFor = (root: ParsedSource, rule: Rule): Effect.Effect<Finding[], MatchError> =>
  findViolationsIn(root, rule).pipe(
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
  )

/**
 * One finding per rule per position.
 *
 * A rule written as `any:` of several patterns can match more than one of them at the same node —
 * `load().then(d).catch(e)` tripped `no-then-catch` twice at identical coordinates — and the reader
 * of a `permissionDecisionReason` sees a duplicated line with nothing to distinguish it.
 */
const onePerRulePerPosition = (findings: readonly Finding[]): readonly Finding[] => {
  const seen = new Set<string>()

  return findings.filter((finding) => {
    const at = `${finding.ruleId}:${finding.line}:${finding.column}`
    if (seen.has(at)) {
      return false
    }
    seen.add(at)
    return true
  })
}
