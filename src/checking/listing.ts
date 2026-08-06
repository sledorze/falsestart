/**
 * The rule set, as a document another program can read.
 *
 * This exists because the only way to ask falsestart what it loaded was to read its source. An
 * adopting repo needs to assert that the rules blocking writes are the same rules its CI gate
 * checks, and the alternative — regex-parsing falsestart's internals — works until the internals
 * are reformatted.
 *
 * The field set is deliberately smaller than a rule document. Whatever is emitted here becomes a
 * compatibility surface the moment someone writes a test against it, and an assertion that fails
 * when nothing meaningful changed is an assertion people delete. So the matcher, its constraints
 * and its utils are absent — they are ast-grep's shape rather than falsestart's, and every pattern
 * refactor would break a consumer — and so are `message` and `note`, which would make a wording fix
 * a failure. What is left is which rules run, at what severity, and where.
 *
 * Encoded through a schema rather than `JSON.stringify`, for the reason `scanning/baseline.ts`
 * gives where it faced the same choice: `no-json-global`'s only honest exception is a wire format
 * with no decode side to keep in step, and this document is decoded by construction — a consumer
 * parses it and asserts against it. The codec is exported so that decode side is this one rather
 * than a hand-written copy of it, and so the shape is a declared thing rather than a claim in prose.
 */
import { Effect, Schema } from 'effect'
import type { Rule } from './rule.ts'
import { SEVERITIES, SUPPORTED_LANGUAGES } from './rule.ts'

/**
 * One entry of the `--list-rules` document.
 *
 * `files` and `ignores` are nullable rather than optional, and `null` is not `[]`: a rule declaring
 * no `files` matches every path, while `files: []` — a legal document — matches nothing at all. The
 * key is always present, so a rule gaining or losing a scope shows as a changed value rather than a
 * changed shape.
 *
 * `severity` is resolved, not copied: a document that omits it behaves as `error` and reads as it,
 * so two spellings of one rule set cannot diff against each other.
 */
export const RuleDescriptionSchema = Schema.Struct({
  files: Schema.NullOr(Schema.Array(Schema.String)),
  id: Schema.String,
  ignores: Schema.NullOr(Schema.Array(Schema.String)),
  language: Schema.Literals(SUPPORTED_LANGUAGES),
  severity: Schema.Literals(SEVERITIES),
})

/** Derived from the schema, the way `Rule` is: two declarations of one shape are two to keep in step. */
export type RuleDescription = typeof RuleDescriptionSchema.Type

const Line = Schema.fromJsonString(RuleDescriptionSchema)

/**
 * Projects already-loaded, already-scoped rules into the entries the document carries.
 *
 * Takes the rules rather than a directory, so the caller decides what "resolved" means — the CLI
 * hands over the output of `applyScopeOverrides`, and a consumer's own test can hand over whatever
 * it loaded.
 *
 * Sorted by `id`, not by the order the loader produced. The loader's order is the rule documents'
 * PATH order, which leaks the tree's layout into the output: moving a rule between category
 * directories would diff while changing nothing about behaviour, and a diff that fires on a
 * non-change is one people stop reading. Ids are unique within a tree — the loader refuses
 * duplicates outright — so ordering by id is total and needs no tiebreak, which is why the
 * comparator never returns 0.
 *
 * Compared with `<` rather than `localeCompare`, which without an explicit locale varies with the
 * host's ICU data: a determinism bug that would only ever appear on someone else's machine.
 */
export const describeRules = (rules: readonly Rule[]): readonly RuleDescription[] =>
  rules
    .map((rule) => ({
      files: rule.files ?? null,
      id: rule.id,
      ignores: rule.ignores ?? null,
      language: rule.language,
      severity: rule.severity ?? 'error',
    }))
    .toSorted((left, right) => (left.id < right.id ? -1 : 1))

/**
 * The bytes `--list-rules` writes.
 *
 * Assembled a line at a time rather than encoded as one array, for the reason `baselineText` gives:
 * `fromJsonString` takes no `space` option, so encoding the whole array yields a single compact
 * line. One RULE per line is also the right granularity for this document — adding or dropping a
 * rule is a one-line diff, and a re-scope is a one-line diff that names the rule on the same line,
 * which per-field indentation does not. The escaping still goes through the schema, which is what
 * `no-json-global` asks for.
 */
export const ruleListText = (rules: readonly Rule[]): Effect.Effect<string> =>
  Effect.all(describeRules(rules).map((entry) => Schema.encodeEffect(Line)(entry))).pipe(
    Effect.orDie,
    Effect.map((lines) => (lines.length === 0 ? '[]\n' : `[\n${lines.map((line) => `  ${line}`).join(',\n')}\n]\n`)),
  )
