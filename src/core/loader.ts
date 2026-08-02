/**
 * Loads a directory of rule documents into a rule set.
 *
 * Loading is all-or-nothing. A tree containing one unreadable rule fails the whole load rather
 * than quietly returning the rules that happened to parse — a guard silently running with a
 * smaller rule set than its author believes is exactly the failure this tool exists to prevent,
 * and it is invisible from the outside. For the same reason every problem in the tree is reported
 * together: fixing rules one failure per run is how the last few stop getting fixed.
 *
 * Filesystem access goes through Effect's `FileSystem`/`Path` services rather than `node:fs`, so
 * the caller decides what "the filesystem" means and tests can supply a real temp tree.
 */
import { Data, Effect, FileSystem, Path } from 'effect'
import { parse as parseYaml } from 'yaml'
import type { Rule } from './rule.ts'
import { parseRule } from './rule.ts'

export class RuleLoadError extends Data.TaggedError('RuleLoadError')<{
  /** Every problem found in the tree, not merely the first. */
  readonly reasons: readonly string[]
}> {}

const RULE_EXTENSIONS = ['.yml', '.yaml']

/**
 * Documents here define named matchers that every rule in the tree may reference by `matches:`,
 * rather than rules of their own. Without somewhere to put them, a matcher needed by several rules
 * has to be copy-pasted into each one's local `utils:`, and the copies drift.
 */
const SHARED_UTILS_DIRECTORY = '_utils'

const isRuleDocument = (name: string): boolean => RULE_EXTENSIONS.some((extension) => name.endsWith(extension))

const isSharedUtil = (entry: string): boolean => entry.split('/')[0] === SHARED_UTILS_DIRECTORY

/**
 * A shared util is deliberately NOT a `Rule`: it has no `language`, `message`, or `files`, because
 * it never matches on its own — it is a fragment named for reuse. Validating it as a rule would
 * demand fields that make no sense for one.
 */
const parseSharedUtil = (source: string, origin: string): Effect.Effect<{ id: string; rule: unknown }, string> =>
  Effect.try({
    catch: (cause) => `${origin}: invalid YAML (${String(cause)})`,
    try: () => parseYaml(source) as unknown,
  }).pipe(
    Effect.flatMap((document) => {
      if (typeof document !== 'object' || document === null || Array.isArray(document)) {
        return Effect.fail(`${origin}: shared util must be a YAML mapping`)
      }

      const { id, rule } = document as Record<string, unknown>
      if (typeof id !== 'string' || id.length === 0) {
        return Effect.fail(`${origin}: shared util needs a non-empty id`)
      }
      if (rule === undefined || rule === null) {
        return Effect.fail(`${origin}: shared util needs a rule`)
      }

      return Effect.succeed({ id, rule })
    }),
  )

/**
 * Two rules sharing an id make findings ambiguous and let one rule mask the other depending on
 * load order, so the tree is refused outright rather than resolved by some arbitrary precedence.
 */
const findDuplicateIds = (rules: readonly Rule[]): readonly string[] => {
  const seen = new Set<string>()
  const duplicated = new Set<string>()

  for (const rule of rules) {
    if (seen.has(rule.id)) {
      duplicated.add(rule.id)
    }
    seen.add(rule.id)
  }

  return [...duplicated].map((id) => `duplicate rule id: ${id}`)
}

/**
 * Reads every `.yml`/`.yaml` document under `directory`, recursively.
 *
 * Results are sorted by path. The directory walk's own order is NOT dependable — measured against
 * a real temp tree it returned sibling directories in reverse — so the sort is what actually makes
 * findings come out the same way run to run.
 */
export const loadRules = (
  directory: string,
): Effect.Effect<readonly Rule[], RuleLoadError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const entries = yield* fs
      .readDirectory(directory, { recursive: true })
      .pipe(Effect.mapError((cause) => new RuleLoadError({ reasons: [`cannot read ${directory}: ${cause}`] })))

    const documents = entries.filter((entry) => isRuleDocument(entry)).toSorted()

    const read = (entry: string) =>
      fs.readFileString(path.join(directory, entry)).pipe(Effect.mapError((cause) => `cannot read ${entry}: ${cause}`))

    // `Effect.all` over a mapped list rather than `Effect.forEach(documents, ...)`: a lint rule
    // keyed on the name `forEach` reads the second argument as an array `thisArg`.
    const utilOutcomes = yield* Effect.all(
      documents
        .filter((entry) => isSharedUtil(entry))
        .map((entry) =>
          read(entry).pipe(
            Effect.flatMap((contents) => parseSharedUtil(contents, entry)),
            Effect.result,
          ),
        ),
    )

    const outcomes = yield* Effect.all(
      documents
        .filter((entry) => !isSharedUtil(entry))
        .map((entry) =>
          read(entry).pipe(
            Effect.flatMap((contents) =>
              // The origin is folded into the text here: a bare reason like "Missing key at [id]"
              // is useless when the whole point is to say WHICH of forty rule files is broken.
              parseRule(contents, entry).pipe(Effect.mapError((error) => `${error.origin}: ${error.reason}`)),
            ),
            // Each document is reduced to a Result so one bad rule does not short-circuit the walk;
            // the failures are collected and reported together below.
            Effect.result,
          ),
        ),
    )

    const sharedUtils: Record<string, unknown> = {}
    for (const outcome of utilOutcomes) {
      if (outcome._tag === 'Success') {
        sharedUtils[outcome.success.id] = outcome.success.rule
      }
    }
    const hasSharedUtils = Object.keys(sharedUtils).length > 0

    const failures = [
      ...utilOutcomes.flatMap((outcome) => (outcome._tag === 'Failure' ? [outcome.failure] : [])),
      ...outcomes.flatMap((outcome) => (outcome._tag === 'Failure' ? [outcome.failure] : [])),
    ]
    // A rule's own `utils:` wins a name collision: the shared set is a default, not an override.
    const withSharedUtils = (rule: Rule): Rule =>
      hasSharedUtils ? { ...rule, utils: { ...sharedUtils, ...rule.utils } } : rule

    const rules = outcomes.flatMap((outcome) => (outcome._tag === 'Success' ? [withSharedUtils(outcome.success)] : []))
    const reasons = [...failures, ...findDuplicateIds(rules)]

    return yield* reasons.length > 0 ? Effect.fail(new RuleLoadError({ reasons })) : Effect.succeed(rules)
  })
