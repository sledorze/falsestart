/**
 * Which repository the freeze will trust, and which path it will ask that repository about.
 *
 * Stub. Both answers are deliberately the ones an earlier revision of the design gave — the
 * repository the caller was already standing in, and the path `realpath` resolved to — so the
 * tests fail on a concrete wrong value rather than on a missing module.
 */
import { Effect, FileSystem, Path } from 'effect'
import type { Anchor } from './freeze.ts'
import { containedPath } from './freeze.ts'

/** How far outward the walk may look before it reports the anchor unverified. */
export const MAX_ANCHOR_WALK = 16

export interface AnchorResolution {
  readonly anchor: Anchor
  readonly toplevel: string
}

export const resolveAnchor = (
  toplevel: string,
  _revParse: (directory: string) => string | undefined,
): Effect.Effect<AnchorResolution> => Effect.succeed({ anchor: 'verified', toplevel })

export type RulesPath =
  | { readonly _tag: 'Contained'; readonly relative: string }
  | { readonly _tag: 'Diverged'; readonly real: string }
  | { readonly _tag: 'Outside' }

export interface RulesPathOptions {
  /** The path the command line named, as written. */
  readonly named: string
  readonly projectReal: string
  readonly toplevelReal: string
}

export const resolveRulesPath = (
  options: RulesPathOptions,
): Effect.Effect<RulesPath, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const lexical = path.resolve(options.projectReal, options.named)
    const real = yield* fs.realPath(lexical).pipe(Effect.orElseSucceed(() => undefined))
    const relative = real === undefined ? undefined : containedPath(options.toplevelReal, real)

    return relative === undefined ? { _tag: 'Outside' } : { _tag: 'Contained', relative }
  })
