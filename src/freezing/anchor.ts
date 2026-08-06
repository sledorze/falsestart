/**
 * Which repository the freeze will trust, and which path it will ask that repository about.
 *
 * Both answers are decided before any content is read, and neither is decided by anything an agent
 * can write in one step. That is the whole of this module, and it exists because getting either one
 * wrong makes every verdict downstream confidently wrong.
 *
 * ## The anchor
 *
 * git honours a `.git` that is an ordinary one-line text file containing `gitdir: <path>`, which a
 * `Write` tool call produces without a shell. Planting one at `packages/app/.git` moves that
 * directory's toplevel to `packages/app` — so a freeze anchored on whatever `rev-parse` answers
 * reads the attacker's object database while every containment check it performs still passes,
 * because the path being checked is the one that moved.
 *
 * So an anchor counts as verified only when `<toplevel>/.git` is a real DIRECTORY, and when it is
 * not, the walk steps outward to the nearest enclosing toplevel that is. The walk is what turns the
 * check from a report into a closure: an attacker's own move creates the condition that triggers it,
 * and it terminates at a repository root whose `.git` a write tool cannot replace — `writeFileSync`
 * on a directory fails EISDIR.
 *
 * `lstat`, not `stat`. A symlinked `.git` stats as a directory, and `unlink` followed by a write
 * replaces the link without touching its target, which puts it squarely inside the escapes this
 * design already assumes. Node's own `lstatSync` is used because Effect's `FileSystem` models only
 * `stat`, which follows links — the same reason `config-file.ts` reaches for `node:module`.
 *
 * ## The path
 *
 * The ref is asked about the path the COMMAND LINE named, resolved lexically. Deriving it by
 * `realpath`ing the working-tree directory hands the choice back to the working tree, which is
 * exactly what the freeze exists to take away: `ln -s .weak rules` then makes falsestart ask the ref
 * about a directory the agent chose, and `rm -rf rules` makes the derivation fail outright. Under a
 * lexical derivation the first is a refusal and the second is simply frozen — the committed tree is
 * a fact about the ref, not about the disk.
 */
import { lstatSync } from 'node:fs'
import { Effect, FileSystem, Path } from 'effect'
import type { Anchor } from './freeze.ts'
import { containedPath } from './freeze.ts'

/**
 * How far outward the walk may look before it reports the anchor unverified.
 *
 * Deeper than any real repository nesting, and present so that a pathological arrangement of
 * gitfiles cannot turn a judged write into an unbounded walk. Hitting it is itself reported as
 * unverified rather than as an error: the answer "this cannot be verified" is already the right one.
 */
export const MAX_ANCHOR_WALK = 16

export interface AnchorResolution {
  readonly anchor: Anchor
  readonly toplevel: string
}

/**
 * Whether this exact path is a directory, without following a link to one.
 *
 * A path that cannot be `lstat`ed at all — no `.git` there, an externally-set `GIT_DIR`, a
 * `core.worktree` arrangement — answers the same "no". The condition is stated positively so that
 * absence lands in the unverified arm rather than in a third branch no fixture can reach.
 */
const isDirectoryEntry = (path: string): boolean =>
  Effect.runSync(
    Effect.try(() => lstatSync(path).isDirectory()).pipe(Effect.orElseSucceed(() => false)),
  )

/**
 * The nearest enclosing repository whose `.git` is a directory, or the caller's own toplevel.
 *
 * `revParse` is supplied rather than performed: only `cli.ts` may spawn, and reading git's answer is
 * this module's job precisely so it can be tested. It answers `undefined` when git declined.
 *
 * On every failure the walk returns the toplevel it started from, never a partial result — an
 * unverified anchor must still freeze against the repository the project is actually in, rather than
 * silently starting to read a different one because the walk gave up.
 */
export const resolveAnchor = (
  toplevel: string,
  revParse: (directory: string) => string | undefined,
): Effect.Effect<AnchorResolution, never, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path

    let candidate = toplevel
    // The bound is on the loop rather than checked inside it, so it also bounds the number of
    // spawns an arrangement of gitfiles can provoke on a judged write.
    for (let walked = 0; walked < MAX_ANCHOR_WALK; walked += 1) {
      if (isDirectoryEntry(path.join(candidate, '.git'))) {
        return { anchor: 'verified', toplevel: candidate }
      }

      const parent = path.dirname(candidate)
      if (parent === candidate) {
        return { anchor: 'unverified', toplevel }
      }

      const next = revParse(parent)
      if (next === undefined) {
        return { anchor: 'unverified', toplevel }
      }
      candidate = next
    }

    return { anchor: 'unverified', toplevel }
  })

export type RulesPath =
  /** Inside the repository, at the path the command line named. `''` means the toplevel itself. */
  | { readonly _tag: 'Contained'; readonly relative: string }
  /** On disk at a different place than the command line named — a swapped symlink, and nothing else. */
  | { readonly _tag: 'Diverged'; readonly real: string }
  | { readonly _tag: 'Outside' }

export interface RulesPathOptions {
  /** The path the command line named, as written. */
  readonly named: string
  /** The process's own working directory, already `realPath`ed: it exists by construction. */
  readonly projectReal: string
  readonly toplevelReal: string
}

/**
 * Where the ref will be asked to look.
 *
 * The real form is computed too, and lexical ≠ real is a refusal rather than a redirection. A
 * directory that is not on disk at all is NOT a refusal: `git ls-tree -r HEAD -- rules` still
 * answers after `rm -rf rules`, and answering is the point.
 */
export const resolveRulesPath = (
  options: RulesPathOptions,
): Effect.Effect<RulesPath, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const lexical = path.resolve(options.projectReal, options.named)
    const relative = containedPath(options.toplevelReal, lexical)
    if (relative === undefined) {
      return { _tag: 'Outside' }
    }

    const real = yield* fs.realPath(lexical).pipe(Effect.orElseSucceed(() => undefined))
    if (real === undefined) {
      return { _tag: 'Contained', relative }
    }

    return containedPath(options.toplevelReal, real) === relative
      ? { _tag: 'Contained', relative }
      : { _tag: 'Diverged', real }
  })
