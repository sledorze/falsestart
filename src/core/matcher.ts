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
