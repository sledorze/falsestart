/**
 * git's plumbing output formats, read as data.
 *
 * Nothing here spawns anything: `cli.ts` is the only file allowed to know a process exists, and
 * reading git's answer lives here precisely so it can be tested against the bytes git really writes.
 */
import { Effect } from 'effect'

/** One entry of `git ls-tree -r -z`, with its mode kept rather than filtered on. */
export interface TreeEntry {
  readonly mode: string
  readonly oid: string
  readonly path: string
  readonly type: string
}

/**
 * `-z` separates records with a NUL. Named rather than inlined: a literal NUL in source is invisible
 * in every diff and every review.
 */
const RECORD_SEPARATOR = '\u0000'

/**
 * Every entry a ref's tree carries under the requested path, INCLUDING symlinks and gitlinks.
 *
 * Nothing is dropped here. Filtering non-regular entries out at this level would make a rule
 * document committed as a symlink silently vanish from a frozen tree that the working-tree loader
 * follows and enforces — a freeze weaker than the thing it replaces, with no diagnostic. Deciding
 * what a non-regular entry MEANS is a policy question, so it belongs to the classifier, where it can
 * refuse.
 */
export const parseTreeListing = (stdout: string): readonly TreeEntry[] =>
  stdout
    .split(RECORD_SEPARATOR)
    .filter((entry) => entry.length > 0)
    .flatMap((entry) => {
      // `indexOf`/`slice` rather than destructuring `split('\t')`: a path may contain a tab and `-z`
      // does not quote it, so only the FIRST tab separates the metadata from the path.
      const tab = entry.indexOf('\t')
      const [mode, type, oid] = entry.slice(0, tab).split(' ')
      if (mode === undefined || type === undefined || oid === undefined) {
        return []
      }
      return [{ mode, oid, path: entry.slice(tab + 1), type }]
    })

/** An object the ref does not hold. A value rather than a gap, because git reports it with exit 0. */
export interface Absent {
  readonly _tag: 'Absent'
}

const ABSENT = { _tag: 'Absent' } as const

/** An answer that is not content. `undefined` cannot arise once the frame count has been checked. */
export const isAbsent = (object: string | Absent | undefined): boolean => typeof object !== 'string'

/** What a request that does not resolve is answered with: `<request> missing`, and exit 0. */
const MISSING_SUFFIX = ' missing'

/** The byte a frame header ends on. Decimal, because prettier and oxlint disagree about hex case. */
const NEWLINE = 10

const decoder = new TextDecoder()

/**
 * The objects `git cat-file --batch` wrote, in request order.
 *
 * Takes bytes, not a string: the header's size is a BYTE count, so slicing a decoded string by it
 * corrupts any document with a non-ASCII character — every shipped rule message has a typographic
 * quote and several have an em dash.
 *
 * Frames are read by DECLARED SIZE, never by scanning for a line shape. A blob's own content can
 * contain a line reading `deadbeef missing`, and a committed rule whose `message:` ends in the word
 * "missing" produces one; a scanner would then refuse the whole tree because of one rule's prose.
 * Only the header AT A FRAME BOUNDARY is inspected.
 *
 * Absence is a value rather than a shorter list, because `<request> missing` comes with exit 0 —
 * invisible to the exit code. The caller decides whether an absent object is an answer (a config
 * candidate the ref does not hold) or a failure (a blob OID `ls-tree` has just reported).
 */
export const parseBatchObjects = (
  stdout: Uint8Array,
  requests: readonly string[],
): Effect.Effect<readonly (string | Absent)[], string> =>
  Effect.gen(function* () {
    const objects: (string | Absent)[] = []
    let offset = 0

    while (offset < stdout.length) {
      const newline = stdout.indexOf(NEWLINE, offset)
      if (newline === -1) {
        return yield* Effect.fail(`git cat-file stopped mid-header after ${objects.length} object(s)`)
      }

      const header = decoder.decode(stdout.subarray(offset, newline))
      if (header.endsWith(MISSING_SUFFIX)) {
        objects.push(ABSENT)
        offset = newline + 1
        continue
      }

      // `Number.parseInt` rather than `Number(…)`: oxlint's `prefer-number-coercion` asks for the
      // latter and falsestart's own `no-raw-coercion` forbids it, on the grounds that a coercion
      // cannot fail and so turns a wrong value into a plausible one. A named parse wins that tie.
      // oxlint-disable-next-line prefer-number-coercion
      const size = Number.parseInt(header.slice(header.lastIndexOf(' ') + 1), 10)
      const start = newline + 1
      const end = start + size
      if (end > stdout.length) {
        return yield* Effect.fail(`git cat-file declared ${size} bytes and wrote ${stdout.length - start}`)
      }

      objects.push(decoder.decode(stdout.subarray(start, end)))
      // The frame's own trailing newline, which is not part of the object.
      offset = end + 1
    }

    return objects.length === requests.length
      ? objects
      : yield* Effect.fail(`git cat-file answered ${objects.length} of ${requests.length} request(s)`)
  })
