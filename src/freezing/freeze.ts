/**
 * What a git ref committed, and what that licenses.
 *
 * "The freeze did not happen" is two situations, separated structurally — by what git said about the
 * ROLE of a path — before any content is read, and never by what any file contains:
 *
 * - `Unfrozen` — there was nothing to freeze. No work tree, no commit yet, a rules tree outside the
 *   repository or untracked inside it, a submodule. There is no committed version of these bytes, so
 *   "read the committed version" is not weaker than the alternative; it is undefined. Reading the
 *   working tree here is the only defined answer, and it is a stated policy that `--doctor` names.
 * - `Broken` — a freeze that was established as possible did not complete. Reaching it takes positive
 *   prior evidence: a work tree, a ref that resolves (or demonstrably does not, in a repository that
 *   has refs), a tracked tree with at least one document. `Broken` never reads the working tree,
 *   because a freeze that falls back on a git failure is one an agent defeats by breaking git — and
 *   breaking the load is already the cheapest disarm there is.
 *
 * Nothing here spawns: the four `git` invocations arrive as callbacks, which is what lets every arm
 * of the decision be reached from a unit test rather than only from the coverage-excluded `cli.ts`.
 * They are callbacks rather than collected values so that a step nobody needs is never run at all —
 * `--freeze=off` asks git nothing, and a rules tree the ref does not track never reads a blob.
 */
import { Effect } from 'effect'
import type { RulesPath } from './anchor.ts'
import type { Absent, TreeEntry } from './listing.ts'
import { isAbsent, parseBatchObjects, parseTreeListing } from './listing.ts'

/**
 * Whether the repository this freeze read can itself be repointed by writing one file.
 *
 * `'unverified'` is not a failure and never blocks under `auto` — a linked worktree is a supported
 * git workflow. It travels with the outcome so `--doctor` can state the one thing about a setup that
 * weakens the guarantee, instead of the guarantee being narrower than it reads for a minority of
 * users who are never told.
 */
export type Anchor = 'unverified' | 'verified'

export const FREEZE_MODES = ['auto', 'off', 'require'] as const
export type FreezeMode = (typeof FREEZE_MODES)[number]

/** What git answered, already collected. Supplied by `cli.ts`, the only file that may spawn. */
export interface GitAnswer {
  readonly failed: boolean
  readonly stderr: string
  readonly stdout: Uint8Array
}

export type Frozen =
  | {
      readonly _tag: 'Frozen'
      readonly anchor: Anchor
      readonly documents: ReadonlyMap<string, string>
      readonly ref: string
    }
  | { readonly _tag: 'Unfrozen'; readonly reason: string }
  | { readonly _tag: 'Broken'; readonly reason: string }

export interface FreezeOutcome {
  readonly config: Frozen
  readonly rules: Frozen
}

/** Which config the ref is asked about: the default names, or the one `--config` gave. */
export type ConfigSource =
  | { readonly _tag: 'Candidates'; readonly names: readonly string[]; readonly relative: string }
  | {
      readonly _tag: 'Explicit'
      readonly name: string
      readonly origin: string
      /** `undefined` when the path the command line named is outside the project repository. */
      readonly relative: string | undefined
    }

/** What the shared preamble established, and both classifiers then rely on. */
export interface FreezeEvidence {
  readonly anchor: Anchor
  readonly mode: FreezeMode
  readonly projectDirectory: string
  readonly ref: string
  readonly toplevel: string
}

export interface FreezeInput {
  readonly anchor: Anchor
  readonly config: ConfigSource
  /** Whether `git rev-parse --show-toplevel` answered for the project directory. */
  readonly inWorkTree: boolean
  readonly isDocument: (name: string) => boolean
  readonly listTree: (relative: string) => GitAnswer
  readonly mode: FreezeMode
  readonly namedRefs: () => GitAnswer
  readonly probe: (requests: readonly string[]) => GitAnswer
  readonly projectDirectory: string
  readonly readBlobs: (oids: readonly string[]) => GitAnswer
  readonly ref: string
  /** Set when `--freeze-ref` named it. Naming a ref is a statement that it exists. */
  readonly refExplicit: boolean
  /** The path the command line named, as written — it is what a reader recognises. */
  readonly rulesDirectory: string
  readonly rulesPath: RulesPath
  readonly toplevel: string
}

export interface Divergence {
  readonly kind: 'added' | 'changed' | 'removed'
  readonly path: string
}

/**
 * A path's location relative to a repository toplevel, or `undefined` when it is outside.
 *
 * Both sides are `realpath`ed by the caller before this is asked. Segment containment, never
 * `startsWith`: a sibling `rulesx/` shares a prefix with `rules/` and is a different directory.
 */
export const containedPath = (toplevelReal: string, targetReal: string): string | undefined => {
  if (toplevelReal === targetReal) {
    return ''
  }
  const prefix = `${toplevelReal}/`
  return targetReal.startsWith(prefix) ? targetReal.slice(prefix.length) : undefined
}

/** What the working tree has that the ref does not, and the reverse. Sorted, and pure. */
export const divergence = (
  frozen: ReadonlyMap<string, string>,
  working: ReadonlyMap<string, string>,
): readonly Divergence[] => {
  const found: Divergence[] = []

  for (const [path, contents] of working) {
    const committed = frozen.get(path)
    if (committed === undefined) {
      found.push({ kind: 'added', path })
    } else if (committed !== contents) {
      found.push({ kind: 'changed', path })
    }
  }
  for (const path of frozen.keys()) {
    if (!working.has(path)) {
      found.push({ kind: 'removed', path })
    }
  }

  return found.toSorted((left, right) => (left.path < right.path ? -1 : 1))
}

const unfrozen = (reason: string): Frozen => ({ _tag: 'Unfrozen', reason })
const broken = (reason: string): Frozen => ({ _tag: 'Broken', reason })

/**
 * `require` extends `Broken` to every row `auto` merely reports.
 *
 * It is for a repository that knows it is a repository and wants `rm -rf .git` to stop writes rather
 * than silently resume reading the working tree. Opt-in, because it genuinely can become an outage.
 */
const byMode = (mode: FreezeMode, reason: string): Frozen =>
  mode === 'require' ? broken(reason) : unfrozen(reason)

const both = (verdict: Frozen): FreezeOutcome => ({ config: verdict, rules: verdict })

const anchorRefusal = (evidence: FreezeEvidence): string =>
  `no verified anchor between ${evidence.projectDirectory} and the filesystem root: ` +
  `${evidence.toplevel}/.git is not a directory, so this repository can be repointed by replacing ` +
  `one file. Expected in a linked worktree outside its main repository, or with --separate-git-dir. ` +
  `Use --freeze=auto to freeze anyway.`

const prefixed = (relative: string, name: string): string => (relative === '' ? name : `${relative}/${name}`)

/** What P2 is asked after the ref probe. Empty when `--config` named a path outside the repository. */
const configRequests = (ref: string, source: ConfigSource): readonly string[] =>
  source._tag === 'Explicit'
    ? source.relative === undefined
      ? []
      : [`${ref}:${source.relative}`]
    : source.names.map((name) => `${ref}:${prefixed(source.relative, name)}`)

export interface ClassifyConfigOptions {
  readonly evidence: FreezeEvidence
  /** P2's answers for the config requests, in request order. */
  readonly objects: readonly (string | Absent)[]
  readonly source: ConfigSource
}

/**
 * The config the ref holds — including the fact of WHICH config it holds.
 *
 * Discovery is frozen as well as content, because adding a second config file beside a committed one
 * breaks the load, and a broken load is already an allowed write with a stderr line the agent
 * runtime discards. An absent candidate is the answer "the repository committed no such config",
 * never a failure.
 */
export const classifyConfig = (options: ClassifyConfigOptions): Frozen => {
  const { evidence, objects, source } = options

  if (source._tag === 'Explicit' && source.relative === undefined) {
    return byMode(evidence.mode, `${source.origin} is outside the project repository`)
  }

  const names = source._tag === 'Explicit' ? [source.name] : source.names
  // A path the command line NAMED and the ref does not hold is a source that was established as
  // freezable and cannot be honoured, so it refuses. An absent candidate is different: nobody named
  // it, and "the repository committed no such config" is the answer rather than a failure.
  if (source._tag === 'Explicit' && typeof objects[0] !== 'string') {
    return broken(`${source.origin} is not committed at ${evidence.ref}`)
  }

  const documents = new Map<string, string>()
  for (const [index, name] of names.entries()) {
    const object = objects[index]
    if (typeof object === 'string') {
      documents.set(name, object)
    }
  }

  return { _tag: 'Frozen', anchor: evidence.anchor, documents, ref: evidence.ref }
}

export interface ClassifyRulesOptions {
  readonly directory: string
  readonly evidence: FreezeEvidence
  readonly isDocument: (name: string) => boolean
  readonly listTree: (relative: string) => GitAnswer
  readonly path: RulesPath
  readonly readBlobs: (oids: readonly string[]) => GitAnswer
}

/** `100644` and `100755`. Anything else at a rule document's path is a policy question, not a read. */
const isRegularFile = (entry: TreeEntry): boolean => entry.mode === '100644' || entry.mode === '100755'

export const classifyRules = (options: ClassifyRulesOptions): Effect.Effect<Frozen> =>
  Effect.gen(function* () {
    const { directory, evidence, isDocument, listTree, path, readBlobs } = options
    const { mode, ref } = evidence

    if (path._tag === 'Outside') {
      return byMode(mode, `${directory} is outside the project repository at ${evidence.toplevel}`)
    }
    if (path._tag === 'Diverged') {
      // The only thing a swapped symlink can produce, and the one place the disk gets a say — by
      // being refused rather than followed.
      return broken(
        `${directory} resolves to ${path.real}, which is not the path the command line named; ` +
          `falsestart freezes the path it was given`,
      )
    }

    const listed = listTree(path.relative)
    if (listed.failed) {
      // P1 proved a work tree and P2 proved the ref resolves, so this is a broken object store.
      return broken(`could not list ${directory} at ${ref}: ${listed.stderr}`)
    }

    const prefix = path.relative === '' ? '' : `${path.relative}/`
    const entries = parseTreeListing(new TextDecoder().decode(listed.stdout))
    const inside = entries.flatMap((entry) =>
      entry.path.startsWith(prefix) ? [{ entry, name: entry.path.slice(prefix.length) }] : [],
    )

    // Refused before the count is taken: a rule document the working tree follows and enforces must
    // not vanish from the frozen tree that replaces it.
    const irregular = inside.find(({ entry, name }) => isDocument(name) && !isRegularFile(entry))
    if (irregular !== undefined) {
      return broken(
        `${irregular.entry.path} is committed as a symlink/submodule entry; ` +
          `a rule document must be a regular file`,
      )
    }

    const documents = inside.filter(({ entry, name }) => isDocument(name) && isRegularFile(entry))
    if (documents.length === 0) {
      // An empty listing must classify as "not tracked", never as a frozen tree of zero rules, or a
      // `--preset` run would load nothing and report health. WHICH kind of nothing it is comes from
      // the project's own committed tree — a structure a human reviewed, and one no write produces.
      const atRoot = entries.find((entry) => entry.path === path.relative)
      if (atRoot?.mode === '160000') {
        return byMode(mode, `${directory} is a submodule; its contents are not in ${ref} of the project repository`)
      }
      if (atRoot?.mode === '120000') {
        return byMode(
          mode,
          `${directory} is committed as a symlink; falsestart freezes the path the command line named, ` +
            `not where it points`,
        )
      }
      return byMode(mode, `${directory} is not tracked at ${ref}`)
    }

    const oids = documents.map(({ entry }) => entry.oid)
    const read = readBlobs(oids)
    if (read.failed) {
      return broken(`could not read ${documents.length} rule document(s) at ${ref}: ${read.stderr}`)
    }

    const objects = yield* Effect.result(parseBatchObjects(read.stdout, oids))
    if (objects._tag === 'Failure') {
      return broken(`could not read ${documents.length} rule document(s) at ${ref}: ${objects.failure}`)
    }

    const contents = new Map<string, string>()
    for (const [index, document] of documents.entries()) {
      const object = objects.success[index]
      if (typeof object !== 'string') {
        return broken(`${ref} no longer holds ${document.entry.path}`)
      }
      contents.set(document.name, object)
    }

    return { _tag: 'Frozen', anchor: evidence.anchor, documents: contents, ref }
  })

/**
 * Classifies the rule tree and the config, independently.
 *
 * Independently because `--preset` puts rules in `node_modules`, where freezing is meaningless, while
 * the project's own config is perfectly freezable — coupling them would leave the setup the
 * documentation recommends fully exposed to a scope override nobody committed.
 */
export const freeze = (input: FreezeInput): Effect.Effect<FreezeOutcome> =>
  Effect.gen(function* () {
    const evidence = {
      anchor: input.anchor,
      mode: input.mode,
      projectDirectory: input.projectDirectory,
      ref: input.ref,
      toplevel: input.toplevel,
    }

    if (input.mode === 'off') {
      return both(unfrozen('--freeze=off'))
    }

    if (!input.inWorkTree) {
      return both(byMode(input.mode, `${input.projectDirectory} is not inside a git work tree`))
    }

    if (input.anchor === 'unverified' && input.mode === 'require') {
      return both(broken(anchorRefusal(evidence)))
    }

    const requests = [input.ref, ...configRequests(input.ref, input.config)]
    const answered = yield* Effect.result(parseBatchObjects(input.probe(requests).stdout, requests))
    if (answered._tag === 'Failure') {
      return both(broken(`could not read ${input.ref} from ${input.toplevel}: ${answered.failure}`))
    }

    const [probed, ...configObjects] = answered.success
    if (isAbsent(probed)) {
      if (input.refExplicit) {
        return both(broken(`${input.ref} does not resolve`))
      }
      // `for-each-ref` prints a ref in a repository whose HEAD was repointed and prints nothing in a
      // freshly `git init`ed one, both exiting 0 — so the discriminator is output emptiness. It
      // raises the cost of that escape by one command; it does not close it, because no probe inside
      // a git directory survives an agent that can write inside that git directory.
      return input.namedRefs().stdout.length === 0
        ? both(byMode(input.mode, `${input.toplevel} has no commit yet`))
        : both(broken('HEAD does not resolve in a repository that has refs'))
    }

    return {
      config: classifyConfig({ evidence, objects: configObjects, source: input.config }),
      rules: yield* classifyRules({
        directory: input.rulesDirectory,
        evidence,
        isDocument: input.isDocument,
        listTree: input.listTree,
        path: input.rulesPath,
        readBlobs: input.readBlobs,
      }),
    }
  })
