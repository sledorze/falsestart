/**
 * The baseline, against a real filesystem.
 *
 * All of this lived inline in `cli.ts` — the one file excluded from both the coverage ratchet and
 * mutation testing — where three distinct corruption branches were exercised by no test at any
 * level. A baseline is the thing standing between a gate and a repository full of pre-existing
 * findings, so "it looked right" is not a standard it can be held to.
 */
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import type { Path } from 'effect'
import { Effect, FileSystem, Layer } from 'effect'
import { baselineText, readBaseline, readBaselineText, writeBaseline } from './baseline.ts'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

const withDirectory = <A, E>(use: (root: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'falsestart-baseline-' })

    return yield* use(root)
  }).pipe(Effect.scoped)

layer(platform)('reading a baseline', (it) => {
  it.effect('counts each occurrence rather than collapsing duplicates', () =>
    Effect.gen(function* () {
      // The bug this shape exists for: as a Set, accepting one `as any` in a file accepted every
      // identical line in it, forever.
      const counts = yield* readBaselineText('["a :: r :: t", "a :: r :: t", "b :: r :: t"]', 'b.json')

      expect(counts.get('a :: r :: t')).toBe(2)
      expect(counts.get('b :: r :: t')).toBe(1)
    }),
  )

  it.effect('accepts an empty array', () =>
    Effect.gen(function* () {
      expect((yield* readBaselineText('[]', 'b.json')).size).toBe(0)
    }),
  )

  it.effect('refuses malformed JSON rather than treating it as empty', () =>
    Effect.gen(function* () {
      // Treating a broken baseline as "nothing accepted yet" makes it indistinguishable from a
      // real and growing set of new violations.
      const error = yield* Effect.flip(readBaselineText('not json at all', 'b.json'))

      expect(error.reason).toContain('not a JSON array')
    }),
  )

  it.effect('refuses a JSON value that is not an array', () =>
    Effect.gen(function* () {
      expect((yield* Effect.flip(readBaselineText('{}', 'b.json'))).reason).toContain('not a JSON array')
    }),
  )

  it.effect('refuses an array carrying anything that is not a fingerprint', () =>
    Effect.gen(function* () {
      // Skipping the non-strings would load a PARTIAL baseline: fewer accepted than the file
      // claims, with nothing said about it.
      const error = yield* Effect.flip(readBaselineText('["ok", 7, {}]', 'b.json'))

      expect(error.reason).toContain('not fingerprints')
    }),
  )

  it.effect('asks for nothing when no baseline was requested', () =>
    Effect.gen(function* () {
      expect(yield* readBaseline(undefined)).toBeUndefined()
    }),
  )

  it.effect('treats an absent file as an empty baseline, so the flag can be wired in first', () =>
    withDirectory((root) =>
      Effect.gen(function* () {
        const counts = yield* readBaseline(`${root}/not-yet.json`)

        expect(counts?.size).toBe(0)
      }),
    ),
  )

  it.effect('refuses a directory where a baseline was named', () =>
    withDirectory((root) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(readBaseline(root))

        expect(error.reason).toContain('BadResource')
      }),
    ),
  )
})

layer(platform)('writing a baseline', (it) => {
  it.effect('sorts, so re-running produces the same bytes', () => {
    // A file that reorders between runs makes every diff unreadable and every review a guess.
    expect(baselineText(['b', 'a'])).toBe(baselineText(['a', 'b']))

    return Effect.void
  })

  it.effect('keeps one entry per occurrence', () => {
    expect(baselineText(['a', 'a'])).toContain('"a",\n  "a"')

    return Effect.void
  })

  it.effect('round-trips through the reader', () =>
    withDirectory((root) =>
      Effect.gen(function* () {
        const path = `${root}/b.json`
        yield* writeBaseline(path, ['x :: r :: t', 'x :: r :: t', 'y :: r :: t'])

        const counts = yield* readBaseline(path)

        expect(counts?.get('x :: r :: t')).toBe(2)
        expect(counts?.get('y :: r :: t')).toBe(1)
      }),
    ),
  )

  it.effect('fails rather than reporting success when it cannot write', () =>
    withDirectory((root) =>
      Effect.gen(function* () {
        // Swallowing this leaves the next run reporting every finding again, with nothing
        // explaining why.
        const error = yield* Effect.flip(writeBaseline(`${root}/missing/b.json`, ['a']))

        expect(error.reason).toContain(`${root}/missing/b.json`)
      }),
    ),
  )
})
