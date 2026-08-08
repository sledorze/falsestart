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
export const isRuleDocument = (name: string): boolean => RULE_EXTENSIONS.some((extension) => name.endsWith(extension))

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

/** One directory's worth of loaded rules, kept with the directory that produced it. */
export interface RuleGroup {
  readonly directory: string
  readonly rules: readonly Rule[]
}

/**
 * Several directories' rules as one set.
 *
 * `--preset clean-code --rules ./.falsestart/rules` is two sources in one invocation, and the two
 * are loaded independently — a preset lives in `node_modules` and is read from the working tree,
 * while the caller's own directory may be read from a git ref. What they cannot do is disagree
 * about an id.
 *
 * A clash is REFUSED rather than resolved by precedence, exactly as `findDuplicateIds` refuses one
 * inside a single tree, and for a sharper version of the same reason: whichever rule lost would
 * carry a `files` glob nobody is enforcing, and its author would have no way to find out. "The
 * later source wins" would also make the answer depend on flag order, so `--preset all --rules ./r`
 * and the reverse would enforce different things.
 *
 * The directories are named in the message because with more than one source the id alone does not
 * say where to go and delete something.
 */
export const mergeRuleSets = (groups: readonly RuleGroup[]): Effect.Effect<readonly Rule[], RuleLoadError> =>
  Effect.suspend(() => {
    const origins = new Map<string, string[]>()
    for (const group of groups) {
      for (const rule of group.rules) {
        origins.set(rule.id, [...(origins.get(rule.id) ?? []), group.directory])
      }
    }

    const reasons = [...origins]
      .filter(([, directories]) => directories.length > 1)
      .map(([id, directories]) => `duplicate rule id: ${id} — defined in ${directories.join(' and ')}`)

    return reasons.length > 0
      ? Effect.fail(new RuleLoadError({ reasons }))
      : Effect.succeed(groups.flatMap((group) => group.rules))
  })

/** A directory to load rules from, and the committed bytes to read instead of the working tree. */
export interface RuleSource {
  readonly directory: string
  /** Committed bytes, when this source is frozen. Absent means read the working tree. */
  readonly documents?: ReadonlyMap<string, string> | undefined
}

/**
 * The sources an invocation loads, with the committed bytes attached to the only one that can have
 * any.
 *
 * One function rather than the same three lines in `cli.ts`, `respond.ts` and `doctor.ts`, because
 * two of those three are excluded from the coverage ratchet and from mutation testing — `cli.ts`
 * entirely. Written out three times, the invariant below was asserted nowhere: handing the shipped
 * sources the project's frozen documents left the whole suite green at 698 tests while
 * `--list-rules` and `scan` failed outright against any repository with a live freeze.
 *
 * The invariant: each source carries its OWN documents, never another's. A preset that a repository
 * vendors is committed and comes from the ref like anything else; one in `node_modules` is not
 * tracked and reads the working tree. Handing the caller's frozen map to a shipped source loads that
 * preset as an EMPTY rule set the moment a freeze is in effect — silent in exactly the way this
 * codebase exists to prevent, and green across the whole suite when it happened.
 */
export const ruleSourcesOf = (options: {
  readonly frozenRules?: ReadonlyMap<string, string> | undefined
  readonly rulesDirectory: string
  readonly shipped?: readonly RuleSource[] | undefined
}): readonly RuleSource[] => [
  ...(options.shipped ?? []),
  { directory: options.rulesDirectory, documents: options.frozenRules },
]

/**
 * Loads every source and merges the result.
 *
 * Per SOURCE rather than per directory-with-shared-bytes, because the two sources an invocation can
 * name are not read the same way: `--preset` lives in `node_modules` and is always the working tree,
 * while the caller's own directory may be frozen to a git ref. One `documents` map covering both
 * would hand a preset the committed bytes of somebody else's directory.
 *
 * Every source's failures are collected before any of them is reported, the same all-at-once
 * discipline `loadRules` applies inside one tree — fixing a broken rule set one message per run is
 * how the last few stop getting fixed.
 */
export const loadRuleSources = (
  sources: readonly RuleSource[],
): Effect.Effect<readonly Rule[], RuleLoadError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const outcomes = yield* Effect.all(
      sources.map((source) =>
        loadRules(source.directory, source.documents).pipe(
          Effect.map((rules): RuleGroup => ({ directory: source.directory, rules })),
          Effect.result,
        ),
      ),
      { concurrency: 'unbounded' },
    )

    // Sorted in ONE pass rather than filtered twice. Two passes read as two independent questions,
    // but the second one's "this was a failure" arm is unreachable — the early return above has
    // already left — so it is a branch no input can cover and no test can defend.
    const groups: RuleGroup[] = []
    const reasons: string[] = []
    for (const outcome of outcomes) {
      if (outcome._tag === 'Failure') {
        reasons.push(...outcome.failure.reasons)
      } else {
        groups.push(outcome.success)
      }
    }

    if (reasons.length > 0) {
      return yield* Effect.fail(new RuleLoadError({ reasons }))
    }

    return yield* mergeRuleSets(groups)
  })
