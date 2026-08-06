/**
 * git's plumbing output formats, read as data.
 *
 * Stub. Slice 1 needs the shapes to exist; the parsers themselves arrive with it.
 */
import { Effect } from 'effect'

export interface TreeEntry {
  readonly mode: string
  readonly oid: string
  readonly path: string
  readonly type: string
}

export interface Absent {
  readonly _tag: 'Absent'
}

export const isAbsent = (object: string | Absent | undefined): boolean => typeof object !== 'string'

export const parseTreeListing = (_stdout: string): readonly TreeEntry[] => []

export const parseBatchObjects = (
  _stdout: Uint8Array,
  _requests: readonly string[],
): Effect.Effect<readonly (string | Absent)[], string> => Effect.succeed([])
