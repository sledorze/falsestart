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
import type { Rule } from './rule.ts'
import { parseRule } from './rule.ts'

export class RuleLoadError extends Data.TaggedError('RuleLoadError')<{
  /** Every problem found in the tree, not merely the first. */
  readonly reasons: readonly string[]
}> {}

const RULE_EXTENSIONS = ['.yml', '.yaml']

const isRuleDocument = (name: string): boolean => RULE_EXTENSIONS.some((extension) => name.endsWith(extension))

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

    // `Effect.all` over a mapped list rather than `Effect.forEach(documents, ...)`: a lint rule
    // keyed on the name `forEach` reads the second argument as an array `thisArg`.
    const outcomes = yield* Effect.all(
      documents.map((entry) => {
        const absolute = path.join(directory, entry)

        return fs.readFileString(absolute).pipe(
          Effect.mapError((cause) => `cannot read ${entry}: ${cause}`),
          Effect.flatMap((contents) =>
            // The origin is folded into the text here: a bare reason like "Missing key at [id]"
            // is useless when the whole point is to say WHICH of forty rule files is broken.
            parseRule(contents, entry).pipe(Effect.mapError((error) => `${error.origin}: ${error.reason}`)),
          ),
          // Each document is reduced to a Result so one bad rule does not short-circuit the walk;
          // the failures are collected and reported together below.
          Effect.result,
        )
      }),
    )

    const failures = outcomes.flatMap((outcome) => (outcome._tag === 'Failure' ? [outcome.failure] : []))
    const rules = outcomes.flatMap((outcome) => (outcome._tag === 'Success' ? [outcome.success] : []))
    const reasons = [...failures, ...findDuplicateIds(rules)]

    return yield* reasons.length > 0 ? Effect.fail(new RuleLoadError({ reasons })) : Effect.succeed(rules)
  })
