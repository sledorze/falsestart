/**
 * Parsing and validation of a single ast-grep rule document.
 *
 * Rules are authored as YAML so the same file stays readable by the upstream `ast-grep` CLI —
 * falsestart deliberately does not invent its own rule format. What this module adds on top of
 * "parse some YAML" is a *fail-closed* validation pass: a rule that cannot be evaluated is
 * rejected loudly at load time rather than silently skipped at match time. A write-time guard
 * that quietly ignores a malformed rule is worse than one that refuses to start, because the
 * rule's author gets no signal that their protection is inert.
 */
import { Data, Effect, Schema } from 'effect'
import { parse as parseYaml } from 'yaml'

/**
 * Languages falsestart can actually evaluate a rule against. Deliberately narrower than the set
 * `ast-grep` itself understands: a rule naming a language we cannot run is a rule whose
 * protection would never fire, so it is rejected rather than accepted-and-ignored.
 */
export const SUPPORTED_LANGUAGES = ['css', 'html', 'javascript', 'tsx', 'typescript'] as const

export const SEVERITIES = ['error', 'warning', 'info', 'hint'] as const

/** A negated constraint. One level of negation is all the rule format defines. */
const NegatedConstraintSchema = Schema.Struct({
  kind: Schema.optional(Schema.String),
  regex: Schema.optional(Schema.String),
})

/** Extra conditions applied to a metavariable captured by the matcher. */
const ConstraintSchema = Schema.Struct({
  kind: Schema.optional(Schema.String),
  not: Schema.optional(NegatedConstraintSchema),
  regex: Schema.optional(Schema.String),
})

const RuleSchema = Schema.Struct({
  constraints: Schema.optional(Schema.Record(Schema.String, ConstraintSchema)),
  /** Globs scoping which files the rule applies to. Absent means "every file". */
  files: Schema.optional(Schema.Array(Schema.String)),
  id: Schema.NonEmptyString,
  /** Globs carving exclusions out of `files`, applied after it. */
  ignores: Schema.optional(Schema.Array(Schema.String)),
  language: Schema.Literals(SUPPORTED_LANGUAGES),
  /** Shown to the author when the rule fires. Optional: a rule may carry only a `note`. */
  message: Schema.optional(Schema.String),
  note: Schema.optional(Schema.String),
  /** The matcher itself. Its internal structure is validated by the match engine, not here. */
  rule: Schema.Unknown,
  severity: Schema.optional(Schema.Literals(SEVERITIES)),
  /** Named sub-rules referenced by `matches:` from within this rule's own matcher. */
  utils: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

export type Language = (typeof SUPPORTED_LANGUAGES)[number]

export type Severity = (typeof SEVERITIES)[number]

export type RuleConstraint = typeof ConstraintSchema.Type

export type Rule = typeof RuleSchema.Type

export class RuleParseError extends Data.TaggedError('RuleParseError')<{
  readonly origin: string
  readonly reason: string
}> {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Parses one rule document.
 *
 * `origin` labels the rule in error messages — a file path when the rule came from disk. The
 * failure is a typed error rather than a throw, so a caller loading a whole tree can collect
 * every bad rule in one pass instead of dying on the first.
 */
export const parseRule = (source: string, origin: string): Effect.Effect<Rule, RuleParseError> =>
  Effect.gen(function* () {
    const fail = (reason: string) => Effect.fail(new RuleParseError({ origin, reason }))

    const document = yield* Effect.try({
      // `String(cause)` rather than `cause.message`: it keeps the error's own type name in the
      // text (`YAMLParseError: ...`), and avoids an `instanceof Error` narrowing whose false
      // branch no call site can actually reach.
      catch: (cause) => new RuleParseError({ origin, reason: `invalid YAML (${String(cause)})` }),
      try: () => parseYaml(source) as unknown,
    })

    // Checked ahead of the schema purely for the error message: Schema reports "Expected object",
    // but the person fixing the file is looking at YAML, where the term is "mapping".
    if (!isRecord(document)) {
      return yield* fail('rule must be a YAML mapping')
    }

    return yield* Schema.decodeUnknownEffect(RuleSchema)(document).pipe(
      Effect.mapError((error) => new RuleParseError({ origin, reason: String(error) })),
    )
  })
