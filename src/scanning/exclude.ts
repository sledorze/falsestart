/**
 * Deciding which of the paths handed to a scan are the repository's own to answer for.
 *
 * A gate that judges a dependency is worse than useless: nobody can act on the finding, and the
 * noise is what gets the gate switched off. Handed one file from `node_modules`, an unfiltered scan
 * reported 34 findings in somebody else's library — and 424 files of one dependency produced almost
 * four thousand.
 *
 * Exclusion is decided STRUCTURALLY, by where a path is, never by what it contains. That is the
 * same rule the rest of this codebase applies to anything that acts on a file, and it is why the
 * defaults below are the two directories that are never a repository's own source rather than a
 * guess at what looks generated. `dist/`, `build/` and `vendor/` are deliberately NOT defaults:
 * plenty of repositories keep real, authored source in directories with those names, and silently
 * declining to judge them would be the inert-guard failure this tool exists to remove.
 *
 * Everything else is opt-in and explicit — `--exclude` globs, and whatever the caller's own
 * `.gitignore` already covers. Nothing is dropped quietly: every exclusion is counted and reported,
 * because "scanned nothing" and "scanned everything and it was clean" must never look alike.
 */
import { matchesAny, toScopingPath } from '../checking/index.ts'

/**
 * Never a repository's own source, under any layout.
 *
 * Kept deliberately short. Each entry has to be somewhere it is impossible to author the code you
 * are being asked to answer for — not merely somewhere code is often generated.
 */
export const DEFAULT_EXCLUSIONS: readonly string[] = ['**/node_modules/**', '**/.git/**']

export type ExclusionReason = 'default' | 'excluded' | 'gitignored'

export interface Exclusion {
  readonly path: string
  readonly reason: ExclusionReason
}

export interface Partitioned {
  readonly excluded: readonly Exclusion[]
  /** Paths the scan should actually read. */
  readonly judged: readonly string[]
}

export interface PartitionOptions {
  /** Extra globs from `--exclude`, matched against the project-relative path. */
  readonly exclude?: readonly string[] | undefined
  /**
   * Paths the caller's own tooling already considers ignored.
   *
   * Supplied rather than computed, because `.gitignore` semantics are git's — nested files,
   * negation, anchoring, precedence — and a re-implementation that is subtly wrong would exclude
   * files nobody asked it to, silently. The caller asks git; this decides what to do with the
   * answer.
   */
  readonly gitignored?: ReadonlySet<string> | undefined
  readonly paths: readonly string[]
  readonly projectDirectory: string
}

/**
 * The paths `git check-ignore -z` reported as ignored.
 *
 * Separated from the call that produces it so it can be tested: the spawn belongs to the
 * executable, the one place allowed to know a process exists, but deciding what its output MEANS
 * is a decision like any other.
 *
 * NUL-delimited, because git quotes any non-ASCII path when asked for newlines — the same trap the
 * documented `-z`/`-0` recipe avoids, one layer down.
 */
export const parseIgnoredPaths = (stdout: string): ReadonlySet<string> =>
  new Set(stdout.split('\u0000').filter((line) => line.length > 0))

/**
 * Splits the given paths into the ones to judge and the ones to account for.
 *
 * Order matters only for the REASON reported: a path inside `node_modules` that is also gitignored
 * is reported as a default exclusion, because that is the one the reader cannot change.
 */
export const partitionPaths = (options: PartitionOptions): Partitioned => {
  const { exclude, gitignored, paths, projectDirectory } = options

  const excluded: Exclusion[] = []
  const judged: string[] = []

  for (const path of paths) {
    const relative = toScopingPath(path, projectDirectory)

    // Both spellings are checked: a caller may hand over absolute paths while `--exclude` globs and
    // git's own answers are written relative to the project.
    const reason: ExclusionReason | undefined = matchesAny(DEFAULT_EXCLUSIONS, relative)
      ? 'default'
      : gitignored?.has(relative) === true || gitignored?.has(path) === true
        ? 'gitignored'
        : exclude !== undefined && matchesAny(exclude, relative)
          ? 'excluded'
          : undefined

    if (reason === undefined) {
      judged.push(path)
    } else {
      excluded.push({ path, reason })
    }
  }

  return { excluded, judged }
}
