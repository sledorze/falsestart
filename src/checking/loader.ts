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

const isMapping = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Exported because the freeze needs the same authority.
 *
 * A frozen tree is judged by this before it is read — a `120000` entry that is a rule document is
 * refused where a `120000` README is ignored — and the write-time note about editing a rule under a
 * freeze is scoped by it too. Two copies of "what counts as a rule document" would eventually
 * disagree, and the disagreement would be silent in both directions.
 */
export const isRuleDocument = (name: string): boolean =>
  RULE_EXTENSIONS.some((extension) => name.endsWith(extension))

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
      if (!isMapping(document)) {
        return Effect.fail(`${origin}: shared util must be a YAML mapping`)
      }

      const { id, rule } = document
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
 * Every `.yml`/`.yaml` document under `directory`, recursively, keyed by its path relative to it.
 *
 * Extracted from `loadRules` rather than inlined so the freeze can hand the loader committed bytes,
 * and so `--doctor` can compare what the working tree holds against what the ref committed. The key
 * shape is the one `readDirectory` produces and nothing else: a frozen tree's keys are matched
 * against it.
 *
 * Results are sorted by path. The directory walk's own order is NOT dependable — measured against a
 * real temp tree it returned sibling directories in reverse — so the sort is what actually makes
 * findings come out the same way run to run.
 */
export const readRuleDocuments = (
  directory: string,
): Effect.Effect<ReadonlyMap<string, string>, RuleLoadError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const entries = yield* fs
      .readDirectory(directory, { recursive: true })
      .pipe(Effect.mapError((cause) => new RuleLoadError({ reasons: [`cannot read ${directory}: ${cause}`] })))

    const names = entries.filter((entry) => isRuleDocument(entry)).toSorted()

    // Reading a rule tree is I/O bound and the documents are independent, so they are read
    // concurrently. The results are still assembled in list order, which is what keeps findings
    // deterministic regardless of which read finishes first.
    const documents = yield* Effect.all(
      names.map((name) =>
        fs.readFileString(path.join(directory, name)).pipe(
          Effect.map((contents) => [name, contents] as const),
          Effect.mapError((cause) => new RuleLoadError({ reasons: [`cannot read ${name}: ${cause}`] })),
        ),
      ),
      { concurrency: 'unbounded' },
    )

    return new Map(documents)
  })

/**
 * Loads a rule set, from the working tree or from bytes the caller already has.
 *
 * With `documents`, the working tree is not touched at all and `directory` is used only for error
 * origins — that is what lets the freeze substitute what a git ref committed without the loader
 * knowing a ref exists. Validation is identical on both paths, because a committed tree is no more
 * trustworthy than an uncommitted one; what changes is only which bytes it is.
 */
export const loadRules = (
  directory: string,
  documents?: ReadonlyMap<string, string> | undefined,
): Effect.Effect<readonly Rule[], RuleLoadError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    // `FileSystem | Path` stays in the requirement type on the frozen path too, so there is one
    // return type rather than two — a caller that switches between the two paths keeps one signature.
    const held = documents ?? (yield* readRuleDocuments(directory))

    // The same filter runs on both paths: a frozen map holds whatever the REF committed under the
    // rules directory, which is as likely to include a README as the working tree is.
    const entries = [...held]
      .filter(([name]) => isRuleDocument(name))
      .toSorted(([left], [right]) => (left < right ? -1 : 1))

    const concurrently = { concurrency: 'unbounded' } as const

    const utilOutcomes = yield* Effect.all(
      entries
        .filter(([name]) => isSharedUtil(name))
        // Each document is reduced to a Result so one bad rule does not short-circuit the walk;
        // the failures are collected and reported together below.
        .map(([name, contents]) => parseSharedUtil(contents, name).pipe(Effect.result)),
      concurrently,
    )

    const outcomes = yield* Effect.all(
      entries
        .filter(([name]) => !isSharedUtil(name))
        .map(([name, contents]) =>
          // The origin is folded into the text here: a bare reason like "Missing key at [id]" is
          // useless when the whole point is to say WHICH of forty rule files is broken.
          parseRule(contents, name).pipe(
            Effect.mapError((error) => `${error.origin}: ${error.reason}`),
            Effect.result,
          ),
        ),
      concurrently,
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
