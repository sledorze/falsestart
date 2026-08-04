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
import { appliesTo, grammarFor, samplePath, SOURCE_EXTENSIONS } from './scope.ts'

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
  Effect.forEach(
    byLanguage(
      rules.filter((rule) => appliesTo(rule, file.path)),
      file.path,
    ),
    (group) => {
      const [language, applicable] = group

      return parseSource(language, file.content).pipe(Effect.flatMap((root) => allFindingsFor(root, applicable, file)))
    },
  ).pipe(Effect.map((perLanguage) => onePerRulePerPosition(perLanguage.flat())))

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
const byLanguage = (rules: readonly Rule[], filePath: string): readonly (readonly [Language, readonly Rule[]])[] => {
  const grouped = new Map<Language, Rule[]>()

  for (const rule of rules) {
    // The FILE decides, not the rule, whenever it can — see `grammarFor`. Grouping on the resolved
    // grammar rather than the declared one is what keeps this to one parse per grammar per file.
    const language = grammarFor(rule.language, filePath)
    const existing = grouped.get(language)
    if (existing === undefined) {
      grouped.set(language, [rule])
    } else {
      existing.push(rule)
    }
  }

  return [...grouped]
}

/** Every applicable rule of one language, run against the tree that language was parsed into. */
const allFindingsFor = (
  root: ParsedSource,
  rules: readonly Rule[],
  file: FileUnderCheck,
): Effect.Effect<Finding[], MatchError> =>
  Effect.all(rules.map((rule) => findingsFor(root, rule, file))).pipe(Effect.map((perRule) => perRule.flat()))

const asFindings = (rule: Rule) => (violations: readonly { column: number; line: number; text: string }[]) =>
  violations.map((violation): Finding => ({
    column: violation.column,
    line: violation.line,
    message: explain(rule),
    ruleId: rule.id,
    severity: rule.severity ?? 'error',
    text: violation.text,
  }))

/**
 * One rule against the file, falling back to the grammar the rule DECLARES when it cannot run
 * under the file's.
 *
 * Choosing the grammar by extension made this reachable through ordinary configuration: widen a
 * TypeScript-syntax rule to `.js` with a `files` override and `$X as any` no longer compiles. The
 * whole check for that file then failed, and because the hook treats "a rule could not run" as
 * non-blocking, a real `process.exit(1)` in the same file was ALLOWED. One misconfigured rule
 * turned the guard off for everything else.
 *
 * The declared grammar is the one its author wrote the pattern against, so it is the right second
 * choice. A rule that runs under neither still fails, and is still reported — the fallback must not
 * become a way of swallowing a genuinely broken rule.
 */
const findingsFor = (root: ParsedSource, rule: Rule, file: FileUnderCheck): Effect.Effect<Finding[], MatchError> =>
  findViolationsIn(root, rule).pipe(
    Effect.map(asFindings(rule)),
    Effect.catch(() =>
      parseSource(rule.language, file.content).pipe(
        Effect.flatMap((declared) => findViolationsIn(declared, rule)),
        Effect.map(asFindings(rule)),
      ),
    ),
  )

export interface GrammarFallback {
  /** The grammar the rule declares, which it will fall back to. */
  readonly declared: Language
  /** An extension the rule is scoped to whose grammar cannot compile it. */
  readonly extension: string
  readonly ruleId: string
}

/**
 * Rules that cannot run under the grammar their own scope implies, and so will fall back.
 *
 * The fallback in `findingsFor` is what stops one misconfigured rule from disabling every other
 * rule for a file — but a rule quietly running under a different grammar than its files imply is
 * exactly the sort of fact that stays true for months and then surprises somebody.
 *
 * It is a property of the RULE SET rather than of any one write, so it is answered once, here,
 * for `--doctor` to report, instead of being emitted on every tool call where it would become
 * noise and then be ignored.
 *
 * Compiled against empty source: a pattern that is invalid for a grammar is invalid regardless of
 * what it is pointed at, so no file is needed to find out.
 */
const compiles = (language: Language, rule: Rule): Effect.Effect<boolean> =>
  parseSource(language, '').pipe(
    Effect.flatMap((root) => findViolationsIn(root, rule)),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  )

export const fallbacks = (rules: readonly Rule[]): Effect.Effect<readonly GrammarFallback[]> =>
  Effect.all(rules.map((rule) => fallbacksFor(rule))).pipe(Effect.map((perRule) => perRule.flat()))

/**
 * The extensions this rule is scoped to, each with a path its own globs actually admit.
 *
 * Probing with a bare `probe.js` skipped every directory-anchored rule — `files:
 * ['src/domain/**\/*.ts']` is the shape the help text documents — so the fallback went unreported
 * while happening in production. `samplePath` exists for exactly this: hold the directory constant
 * and vary only the extension.
 */
const scopedPaths = (rule: Rule): readonly (readonly [string, string])[] => {
  // No `files` means every path, so this glob stands in for wherever the rule lands.
  const globs = rule.files === undefined ? ['**/*'] : rule.files

  return SOURCE_EXTENSIONS.flatMap((extension) => {
    const path = globs.map((glob) => samplePath(glob, extension)).find((probe) => appliesTo(rule, probe))

    return path === undefined ? [] : [[extension, path] as const]
  })
}

const fallbacksFor = (rule: Rule): Effect.Effect<readonly GrammarFallback[]> =>
  Effect.all(
    scopedPaths(rule).map(([extension, path]) =>
      Effect.all([compiles(grammarFor(rule.language, path), rule), compiles(rule.language, rule)]).pipe(
        Effect.map(([underFile, underDeclared]): readonly GrammarFallback[] =>
          // Only a rule that fails under the file's grammar AND runs under its own has a fallback.
          // One that runs under neither has no recovery to report, and is reported as broken
          // elsewhere; claiming both is worse than claiming one.
          underFile || !underDeclared ? [] : [{ declared: rule.language, extension, ruleId: rule.id }],
        ),
      ),
    ),
  ).pipe(Effect.map((perExtension) => perExtension.flat()))

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
