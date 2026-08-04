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
 * A metavariable standing alone: `$X`, `$$$ARGS`. As a whole pattern it matches any node, so it
 * narrows nothing — which is why `pattern: $X` behaves like a bare `regex` for the purposes below,
 * and `pattern: $X as any` does not.
 */
const BARE_METAVARIABLE = /^\$(\$\$)?[A-Z_][\dA-Z_]*$/

/**
 * Whether a matcher can determine the set of AST kinds it might match.
 *
 * This is the property the real `ast-grep` CLI requires and the napi binding does not check. It is
 * modelled here rather than guessed: the rules below reproduce the CLI's accept/reject decision on
 * every shape in `matcher.test.ts`'s validation suite, each of which was run against the actual
 * `ast-grep` binary rather than reasoned about.
 *
 * `all` needs only ONE clause to narrow, since every clause must hold simultaneously. `any` needs
 * EVERY branch to narrow, since any one of them may be the branch that matches. That also gives
 * the right answers for the empty cases without special-casing them — an empty `all` narrows
 * nothing and is refused, an empty `any` matches nothing and is accepted.
 *
 * Relational clauses (`has`, `inside`, `follows`, `precedes`) and `not` describe a node's
 * surroundings rather than the node, so they never narrow on their own. A `matches:` reference is
 * treated as narrowing: resolving it would mean resolving utils here, and assuming it does not
 * narrow would reject rules the CLI accepts.
 */
const isClause = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

const narrowsKind = (matcher: unknown): boolean => {
  // A non-mapping matcher (including the bare-string shorthand some tools allow) narrows nothing
  // here, which is also what ast-grep decides: it rejects `rule: $X as any` outright.
  if (!isClause(matcher)) {
    return false
  }

  const clause = matcher

  if ('kind' in clause || 'matches' in clause) {
    return true
  }
  if ('pattern' in clause) {
    return typeof clause['pattern'] === 'string' ? !BARE_METAVARIABLE.test(clause['pattern']) : true
  }
  if (Array.isArray(clause['all'])) {
    return clause['all'].some((inner: unknown) => narrowsKind(inner))
  }
  if (Array.isArray(clause['any'])) {
    return clause['any'].every((inner: unknown) => narrowsKind(inner))
  }

  return false
}

/**
 * Rejects matcher shapes the real `ast-grep` CLI refuses but the napi binding accepts.
 *
 * The gap is dangerous in one direction: napi accepts a matcher that pins no AST kind and then
 * matches essentially every node, so a rule the upstream engine considers broken fires on almost
 * any input. A rule authored against the CLI would fail loudly there and misfire silently here.
 */
const validateMatcher = (matcher: unknown): string | undefined =>
  narrowsKind(matcher) ? undefined : 'rule matches no particular AST kind — add a `kind`, or a `pattern` with structure'

/**
 * The rule format is validated structurally at parse time, but the matcher body itself is only
 * meaningful to ast-grep, so it stays `unknown` until here and is handed over as-is.
 *
 * The three assertions below are the only place falsestart does not satisfy its own
 * `no-type-assertion` rule, and the exception is inherent rather than lazy: this is the seam
 * between a validated-but-untyped document and a third-party type, and there is nothing further
 * to narrow with. They are confined to this one function so the rest of the codebase stays clean,
 * and a repo adopting the rule can exempt its own adapter the same way.
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
  Effect.suspend(() => parseSource(rule.language, source).pipe(Effect.flatMap((root) => findViolationsIn(root, rule))))

/**
 * A parsed tree, ready for any number of rules of the same language to be run against it.
 *
 * Separated from matching because parsing is where essentially all the time goes, and it was
 * happening once per RULE. Measured on a 762 KB source file: one parse costs 94ms and one match
 * against the parsed tree costs 3ms, so running twenty-two rules cost 2046ms of parsing to do 60ms
 * of matching. Ninety-seven per cent of the work was re-reading the same file into the same tree.
 *
 * The type is deliberately opaque to everything outside this module — it is `@ast-grep/napi`'s, and
 * this file exists to be the only place that knows that.
 */
export type ParsedSource = ReturnType<ReturnType<typeof parse>['root']>

/**
 * Parsing does not fail. tree-sitter answers malformed input with error NODES rather than an
 * exception, which is what lets a rule match the well-formed parts of a half-written file — the
 * normal state of a file an agent is editing.
 *
 * Checked rather than assumed, against a lone surrogate, an embedded NUL, twenty thousand levels of
 * nesting and a two-megabyte source: none throws. So there is no error channel here to thread, and
 * inventing one would mean a branch no input can reach and no test can cover.
 */
export const parseSource = (language: Language, source: string): Effect.Effect<ParsedSource> =>
  Effect.sync(() => parse(LANGUAGES[language], source).root())

export const findViolationsIn = (root: ParsedSource, rule: Rule): Effect.Effect<Violation[], MatchError> =>
  Effect.suspend(() => {
    const invalid = validateMatcher(rule.rule)
    return invalid === undefined
      ? runMatcher(root, rule)
      : Effect.fail(new MatchError({ reason: invalid, ruleId: rule.id }))
  })

const runMatcher = (root: ParsedSource, rule: Rule): Effect.Effect<Violation[], MatchError> =>
  Effect.try({
    catch: (cause) => new MatchError({ reason: String(cause), ruleId: rule.id }),
    try: () =>
      root.findAll(toNapiConfig(rule)).map((node) => {
        const { start } = node.range()
        return { column: start.column + 1, line: start.line + 1, text: node.text() }
      }),
  })
