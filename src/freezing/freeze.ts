/**
 * What a git ref committed, and what that licenses.
 *
 * Stub. The shapes and the entry point exist so slice 1's tests fail on a verdict rather than on a
 * missing module; every classification arm arrives with the implementation.
 */
import { Effect } from 'effect'
import type { RulesPath } from './anchor.ts'

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

export type ConfigSource =
  | { readonly _tag: 'Candidates'; readonly names: readonly string[]; readonly relative: string }
  | {
      readonly _tag: 'Explicit'
      readonly name: string
      readonly origin: string
      readonly relative: string | undefined
    }

export interface FreezeInput {
  readonly anchor: Anchor
  readonly config: ConfigSource
  readonly inWorkTree: boolean
  readonly isDocument: (name: string) => boolean
  readonly listTree: (relative: string) => GitAnswer
  readonly mode: FreezeMode
  readonly namedRefs: () => GitAnswer
  readonly probe: (requests: readonly string[]) => GitAnswer
  readonly projectDirectory: string
  readonly readBlobs: (oids: readonly string[]) => GitAnswer
  readonly ref: string
  readonly refExplicit: boolean
  readonly rulesDirectory: string
  readonly rulesPath: RulesPath
  readonly toplevel: string
}

export interface Divergence {
  readonly kind: 'added' | 'changed' | 'removed'
  readonly path: string
}

/** A path's location relative to a repository toplevel, or `undefined` when it is outside. */
export const containedPath = (toplevelReal: string, targetReal: string): string | undefined => {
  if (toplevelReal === targetReal) {
    return ''
  }
  const prefix = `${toplevelReal}/`
  return targetReal.startsWith(prefix) ? targetReal.slice(prefix.length) : undefined
}

export const divergence = (
  _frozen: ReadonlyMap<string, string>,
  _working: ReadonlyMap<string, string>,
): readonly Divergence[] => []

export const freeze = (_input: FreezeInput): Effect.Effect<FreezeOutcome> =>
  Effect.succeed({
    config: { _tag: 'Unfrozen', reason: 'stub' },
    rules: { _tag: 'Unfrozen', reason: 'stub' },
  })
