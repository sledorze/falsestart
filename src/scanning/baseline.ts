/**
 * The accepted-findings file.
 *
 * Deliberately not a rich record. A baseline is a second source of truth, and the way that stops
 * being a liability is by holding as little as possible: a flat JSON array with one entry per
 * accepted occurrence, and nothing else.
 *
 * Read as COUNTS rather than a set. Membership alone meant that accepting one
 * `const x = value as any` in a file accepted every identical line in it, forever — so pasting more
 * of an already-baselined pattern was invisible to the gate. The file always listed one entry per
 * occurrence; only the reader was lossy.
 *
 * It lives here rather than in the executable because it is a decision — what counts as a valid
 * baseline, and what a corrupt one means — not plumbing. It was written inline in `cli.ts`, the one
 * file excluded from both the coverage ratchet and mutation testing, where three distinct
 * corruption branches went unexercised by any test at any level.
 */
import { Data, Effect, FileSystem, Schema } from 'effect'

export class BaselineUnreadable extends Data.TaggedError('BaselineUnreadable')<{
  readonly reason: string
}> {}

/**
 * Parses the file's contents into accepted counts.
 *
 * A non-string entry is a corrupt baseline, not a line to skip. Skipping quietly loads a PARTIAL
 * baseline — fewer findings accepted than the file claims, with nothing said about it — which is
 * the silent wrong answer this flag exists to avoid.
 */
const isFingerprint = (entry: unknown): entry is string => typeof entry === 'string'

export const readBaselineText = (
  text: string,
  origin: string,
): Effect.Effect<ReadonlyMap<string, number>, BaselineUnreadable> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.result(Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(text))

    if (parsed._tag === 'Failure' || !Array.isArray(parsed.success)) {
      return yield* new BaselineUnreadable({ reason: `${origin}: not a JSON array of fingerprints` })
    }
    // `every` with a type predicate both validates and narrows, so the loop below needs no second
    // check — one that could never fail, and so could never be tested.
    if (!parsed.success.every(isFingerprint)) {
      return yield* new BaselineUnreadable({ reason: `${origin}: contains entries that are not fingerprints` })
    }

    const counts = new Map<string, number>()
    for (const entry of parsed.success) {
      counts.set(entry, (counts.get(entry) ?? 0) + 1)
    }

    return counts
  })

/**
 * Loads the baseline named by `baselinePath`, or nothing when none was asked for.
 *
 * An ABSENT file is an empty baseline, which is what lets `--baseline` be wired into a hook before
 * the file exists. A file that is present and unreadable is an error instead: silently treating a
 * typo'd path, a directory or malformed JSON as "nothing accepted yet" makes a broken baseline
 * indistinguishable from a real and growing set of new violations.
 */
export const readBaseline = (
  baselinePath: string | undefined,
): Effect.Effect<ReadonlyMap<string, number> | undefined, BaselineUnreadable, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (baselinePath === undefined) {
      return undefined
    }

    const fs = yield* FileSystem.FileSystem
    const read = yield* Effect.result(fs.readFileString(baselinePath))

    if (read._tag === 'Failure') {
      return read.failure.reason._tag === 'NotFound'
        ? new Map<string, number>()
        : yield* new BaselineUnreadable({ reason: `${baselinePath}: ${read.failure.reason._tag}` })
    }

    return yield* readBaselineText(read.success, baselinePath)
  })

/**
 * The bytes to write for a set of accepted fingerprints. Sorted, so a re-run diffs to nothing.
 *
 * Encoded through the same schema the reader decodes with, rather than `JSON.stringify` behind a
 * config exemption. `no-json-global`'s own note says the only honest exception is a wire format
 * with no decode side to keep in step — and this file has one, three functions up.
 */
const JsonString = Schema.fromJsonString(Schema.String)

/**
 * Assembled a line at a time rather than encoded as one array, because the layout is the point.
 *
 * `fromJsonString` takes no `space` option, so encoding the whole array yields a single compact
 * line — and a baseline is a file people read in a review. One fingerprint per line means adding
 * or removing one shows as a one-line diff; compact means every change rewrites the whole file.
 * That regressed once, silently, because the assertion guarding it had been replaced with a
 * whitespace-blind round-trip.
 *
 * The escaping still goes through the schema, which is what `no-json-global` asks for: the quoting
 * of each fingerprint is not hand-rolled.
 */
export const baselineText = (fingerprints: readonly string[]): Effect.Effect<string> =>
  Effect.all([...fingerprints].toSorted().map((entry) => Schema.encodeEffect(JsonString)(entry))).pipe(
    Effect.orDie,
    Effect.map((quoted) =>
      quoted.length === 0 ? '[]\n' : `[\n${quoted.map((entry) => `  ${entry}`).join(',\n')}\n]\n`,
    ),
  )

export const writeBaseline = (
  baselinePath: string,
  fingerprints: readonly string[],
): Effect.Effect<void, BaselineUnreadable, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const written = yield* Effect.result(fs.writeFileString(baselinePath, yield* baselineText(fingerprints)))

    // A baseline that could not be written must not report success. Swallowing it leaves the next
    // run reporting every finding again, with nothing explaining why.
    if (written._tag === 'Failure') {
      return yield* new BaselineUnreadable({ reason: `${baselinePath}: ${written.failure.reason._tag}` })
    }
  })
