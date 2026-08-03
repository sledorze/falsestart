/**
 * Every area is documented, and documentation cites only entry points.
 *
 * No documentation tool checks this. cairn verifies that a doc's links RESOLVE and that their
 * targets have not CHANGED, but nothing notices a source file that no document mentions at all —
 * a new module passes `pnpm check` and `pnpm verify` untouched. `checks.coverage` cannot express
 * it either: its kinds classify scanned markdown, so a `src/**` glob matches nothing.
 *
 * This was checked by hand three times while the architecture doc was being written, and found a
 * real gap each time — `hook/options.ts`, then `config-file.ts` and `rule-ids`, then
 * `testing/assess.ts` and `index.ts`. AGENTS.md says to convert a manual proof into a permanent
 * test rather than trusting it will be repeated. This is that.
 *
 * The second assertion is the one that keeps the first honest. Citing an entry point is what makes
 * a document stable under implementation churn; a doc that reaches past one into an internal file
 * goes stale on every edit to it, and the drift then carries no information.
 */
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { describe, effect, expect } from '@effect/vitest'
import { Effect, FileSystem, Layer } from 'effect'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/** Root modules that are entry points in their own right, alongside every `<area>/index.ts`. */
const ROOT_ENTRY_POINTS = new Set(['src/cli.ts', 'src/index.ts'])

const isEntryPoint = (file: string): boolean => file.endsWith('/index.ts') || ROOT_ENTRY_POINTS.has(file)

const isSource = (file: string): boolean =>
  file.endsWith('.ts') && !file.endsWith('.test.ts') && !file.endsWith('.bench.ts')

const sourceFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const entries = yield* fs.readDirectory('src', { recursive: true })
  return entries.map((entry) => `src/${entry}`).filter((file) => isSource(file))
}).pipe(Effect.provide(platform), Effect.orDie)

const architecture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString('docs/architecture.md')
}).pipe(Effect.provide(platform), Effect.orDie)

/** `[text](../src/x.ts)` — the links the docs check already tracks the content of. */
const citedSourceFiles = (markdown: string): readonly string[] =>
  [...markdown.matchAll(/\]\(\.\.\/(src\/[^)]+\.ts)\)/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]))

describe('documentation covers the source', () => {
  effect('every area entry point is cited by the architecture doc', () =>
    Effect.gen(function* () {
      const cited = new Set(citedSourceFiles(yield* architecture))
      const entryPoints = (yield* sourceFiles).filter((file) => isEntryPoint(file))

      // `src/index.ts` is the library barrel; the doc describes the areas, not the barrel.
      const shouldBeCited = entryPoints.filter((file) => file !== 'src/index.ts')

      expect(shouldBeCited.filter((file) => !cited.has(file))).toEqual([])
    }),
  )

  effect('the architecture doc cites no file below an entry point', () =>
    Effect.gen(function* () {
      // Reaching past an entry point into an implementation file is what made this document go
      // stale on every unrelated edit, back when it named fourteen of them.
      const cited = citedSourceFiles(yield* architecture)

      expect(cited.filter((file) => !isEntryPoint(file))).toEqual([])
    }),
  )

  effect('every area holds an entry point', () =>
    Effect.gen(function* () {
      const files = yield* sourceFiles
      const areas = new Set(
        files.flatMap((file) => {
          const [, area, rest] = file.split('/')
          return area !== undefined && rest !== undefined ? [area] : []
        }),
      )

      const withoutEntryPoint = [...areas].filter((area) => !files.includes(`src/${area}/index.ts`))

      expect(withoutEntryPoint).toEqual([])
    }),
  )
})
