/**
 * Decides which files a rule is allowed to act on.
 *
 * This is the structural half of falsestart's safety story. A rule fires on a file only when
 * that file's PATH puts it in scope — never merely because its CONTENT happened to match. Getting
 * this wrong is silent in both directions: too broad and a rule flags files it was never meant to
 * see, too narrow and a rule quietly stops protecting anything at all. Neither failure announces
 * itself, which is why scoping lives in its own module with its own negative tests.
 *
 * Matching is delegated to `picomatch` rather than a bespoke glob-to-RegExp translation. Hand-
 * rolled translations tend to be subtly wrong at exactly the edges that matter here — brace
 * alternation, `*` versus `**` at a directory boundary, a literal segment that must not match as
 * a substring — and a scoping bug is indistinguishable from "the rule is off".
 */
import picomatch from 'picomatch'

export interface FileScope {
  /** Globs the path must match. Absent means "every path". */
  readonly files?: readonly string[] | undefined
  /** Globs carving exclusions out of `files`. Applied after it, and independently of it. */
  readonly ignores?: readonly string[] | undefined
}

/**
 * Globs are authored with `/`, but a path can arrive with `\` on Windows. Normalising here keeps
 * a rule's scope identical across platforms instead of silently matching nothing on one of them.
 */
const toPosixPath = (filePath: string): string => filePath.replaceAll('\\', '/')

const matchesAny = (globs: readonly string[], filePath: string): boolean =>
  picomatch.isMatch(filePath, [...globs], { dot: true })

/**
 * Re-expresses a path the way rule globs are written.
 *
 * Rules are authored relative to a project (`src/**\/*.ts`), but a write-time hook reports an
 * absolute path (`/repo/src/a.ts`), and matching one against the other never fires. That failure
 * is completely silent — the rule loads, validates, and reports nothing, which is indistinguishable
 * from a clean file. Normalising the path before it reaches `appliesTo` is what closes it.
 *
 * A path outside `root`, or a path with no known root, is returned unchanged: a rule can still
 * reach it with a leading `**\/`, and inventing a relative path for something that is not actually
 * inside the project would be worse than leaving it alone.
 */
export const toScopingPath = (filePath: string, root: string | undefined): string => {
  const path = toPosixPath(filePath)
  if (root === undefined) {
    return path
  }

  const base = toPosixPath(root).replace(/\/+$/, '')
  // The separator is required: without it `/repo` would swallow `/repo-other`.
  const prefix = `${base}/`

  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/**
 * `true` when `filePath` is in scope for a rule carrying this `files`/`ignores` pair.
 *
 * `ignores` is honoured even when `files` is absent, so a rule can say "everywhere except here"
 * without having to first enumerate everywhere.
 */
export const appliesTo = (scope: FileScope, filePath: string): boolean => {
  const path = toPosixPath(filePath)

  if (scope.files !== undefined && !matchesAny(scope.files, path)) {
    return false
  }

  return !(scope.ignores !== undefined && matchesAny(scope.ignores, path))
}
