/**
 * Runs a rule's matcher against a piece of source code and reports what it found.
 *
 * The engine matches against a STRING, never a path on disk. That is not an incidental choice: a
 * write-time guard has to judge content that does not exist as a file yet — the text an agent is
 * about to write. Anything that could only work by reading the file back would be unable to block
 * anything before the fact.
 *
 * `constraints` and `utils` are handed to ast-grep verbatim rather than being re-implemented in
 * TypeScript. Re-implementing them means re-deriving the whole semantics of the upstream matcher
 * — negated constraints, and regexes written in the Rust `regex` dialect (whose inline `(?i)`
 * flag JavaScript's own RegExp cannot even parse) — and every gap between the copy and the
 * original shows up as a rule that silently under-matches.
 */
import { Lang, parse } from '@ast-grep/napi'
import type { NapiConfig, Rule as NapiRule } from '@ast-grep/napi'
import { Data, Effect } from 'effect'
import type { Language, Rule } from './rule.ts'

export interface Violation {
  /** One-based, to line up with how editors and error messages count. */
  readonly column: number
  readonly line: number
  /** The source text that matched. */
  readonly text: string
}

export class MatchError extends Data.TaggedError('MatchError')<{
  readonly reason: string
  readonly ruleId: string
}> {}

const LANGUAGES: Readonly<Record<Language, Lang>> = {
  css: Lang.Css,
  html: Lang.Html,
  javascript: Lang.JavaScript,
  tsx: Lang.Tsx,
  typescript: Lang.TypeScript,
}

/**
 * Rejects matcher shapes the real `ast-grep` CLI refuses but the napi binding accepts.
 *
 * The two are not equivalent validators, and the gap is dangerous in one specific direction: napi
 * accepts `all: [pattern, regex]` with no `kind` and then matches essentially every node, so a
 * rule the upstream engine considers broken reports a violation on almost any input. A rule
 * authored and checked against the CLI would fail loudly there and fire indiscriminately here.
 *
 * This is deliberately a small, targeted check rather than a reimplementation of ast-grep's rule
 * schema. It covers the divergence that actually misfires; everything else is left to napi, whose
 * errors are already surfaced as `MatchError`.
 */
const validateMatcher = (matcher: unknown): string | undefined => {
  if (typeof matcher !== 'object' || matcher === null || !('all' in matcher)) {
    return undefined
  }

  const all = (matcher as { all: unknown }).all
  if (!Array.isArray(all) || all.length === 0) {
    return 'rule with `all` must be a non-empty array'
  }

  // A single clause is unambiguous however it is written; it is the multi-clause form with nothing
  // pinning an AST kind that the CLI rejects.
  const unpinned = all.every(
    (clause: unknown) =>
      typeof clause === 'object' &&
      clause !== null &&
      ('pattern' in clause || 'regex' in clause) &&
      !('kind' in clause),
  )

  return unpinned && all.length > 1
    ? 'rule must specify a set of AST kinds — add a `kind` to the `all` clauses'
    : undefined
}

/**
 * The rule format is validated structurally at parse time, but the matcher body itself is only
 * meaningful to ast-grep, so it stays `unknown` until here and is handed over as-is.
 */
const toNapiConfig = (rule: Rule): NapiConfig => ({
  ...(rule.constraints === undefined ? {} : { constraints: rule.constraints as Record<string, NapiRule> }),
  rule: rule.rule as NapiRule,
  ...(rule.utils === undefined ? {} : { utils: rule.utils as Record<string, NapiRule> }),
})

/**
 * Finds every place in `source` where `rule` matches.
 *
 * An empty result means the code is clean; a failure means the rule itself could not be run, which
 * is a different thing entirely and must never be reported as "no violations".
 */
export const findViolations = (rule: Rule, source: string): Effect.Effect<Violation[], MatchError> =>
  Effect.suspend(() => {
    const invalid = validateMatcher(rule.rule)
    return invalid === undefined
      ? runMatcher(rule, source)
      : Effect.fail(new MatchError({ reason: invalid, ruleId: rule.id }))
  })

const runMatcher = (rule: Rule, source: string): Effect.Effect<Violation[], MatchError> =>
  Effect.try({
    catch: (cause) => new MatchError({ reason: String(cause), ruleId: rule.id }),
    try: () =>
      parse(LANGUAGES[rule.language], source)
        .root()
        .findAll(toNapiConfig(rule))
        .map((node) => {
          const { start } = node.range()
          return { column: start.column + 1, line: start.line + 1, text: node.text() }
        }),
  })
