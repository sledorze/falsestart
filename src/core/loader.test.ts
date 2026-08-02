import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { describe, effect, expect } from '@effect/vitest'
import { Effect, FileSystem, Layer, Path } from 'effect'
import { loadRules } from './loader.ts'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

/** A rule tree written to a real temp directory — the thing under test is filesystem behaviour. */
const withTree = <A, E>(
  files: Readonly<Record<string, string>>,
  use: (directory: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'falsestart-rules-' })

    for (const [name, contents] of Object.entries(files)) {
      const target = path.join(root, name)
      yield* fs.makeDirectory(path.dirname(target), { recursive: true })
      yield* fs.writeFileString(target, contents)
    }

    return yield* use(root)
  }).pipe(Effect.scoped, Effect.provide(platform))

const rule = (id: string) => `
id: ${id}
language: tsx
rule:
  pattern: $X as any
`

describe('rule tree loading', () => {
  effect('loads every rule in a flat directory', () =>
    withTree({ 'a.yml': rule('alpha'), 'b.yaml': rule('beta') }, (directory) =>
      Effect.gen(function* () {
        const loaded = yield* loadRules(directory)

        expect(loaded.map((entry) => entry.id)).toEqual(['alpha', 'beta'])
      }),
    ),
  )

  effect('descends into subdirectories', () =>
    withTree({ 'promise/b.yml': rule('beta'), 'type/a.yml': rule('alpha') }, (directory) =>
      Effect.gen(function* () {
        const loaded = yield* loadRules(directory)

        expect(loaded.map((entry) => entry.id)).toEqual(['beta', 'alpha'])
      }),
    ),
  )

  effect('ignores files that are not rule documents', () =>
    withTree({ 'README.md': '# not a rule', 'a.yml': rule('alpha'), 'notes.txt': 'hello' }, (directory) =>
      Effect.gen(function* () {
        const loaded = yield* loadRules(directory)

        expect(loaded.map((entry) => entry.id)).toEqual(['alpha'])
      }),
    ),
  )

  effect('orders rules by path so output is stable across runs', () =>
    withTree({ 'a/one.yml': rule('one'), 'b/two.yml': rule('two'), 'c/three.yml': rule('three') }, (directory) =>
      Effect.gen(function* () {
        const loaded = yield* loadRules(directory)

        expect(loaded.map((entry) => entry.id)).toEqual(['one', 'two', 'three'])
      }),
    ),
  )

  effect('returns an empty set for an empty directory', () =>
    withTree({}, (directory) =>
      Effect.gen(function* () {
        expect(yield* loadRules(directory)).toEqual([])
      }),
    ),
  )

  effect('reports every malformed rule, not just the first', () =>
    withTree(
      { 'bad1.yml': 'id: 7\nlanguage: tsx', 'bad2.yml': 'language: nope', 'ok.yml': rule('fine') },
      (directory) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(loadRules(directory))

          expect(error._tag).toBe('RuleLoadError')
          expect(error.reasons).toHaveLength(2)
          expect(error.reasons.join('\n')).toContain('bad1.yml')
          expect(error.reasons.join('\n')).toContain('bad2.yml')
        }),
    ),
  )

  effect('refuses a tree where two rules share an id', () =>
    withTree({ 'one.yml': rule('duplicated'), 'two.yml': rule('duplicated') }, (directory) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(loadRules(directory))

        expect(error.reasons.join('\n')).toContain('duplicated')
      }),
    ),
  )

  effect('reports a rule-shaped entry it cannot read as a document', () =>
    // A DIRECTORY named `*.yml` is listed by the walk and passes the extension test, but reading
    // it as a file fails. The walk yielding a name is not proof that a document is behind it.
    withTree({ 'looks-like.yml/inner.txt': 'not a rule' }, (directory) =>
      Effect.gen(function* () {
        const error = yield* Effect.flip(loadRules(directory))

        expect(error.reasons.join('\n')).toContain('looks-like.yml')
      }),
    ),
  )

  effect('fails when the rule directory does not exist', () =>
    withTree({}, (directory) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const error = yield* Effect.flip(loadRules(path.join(directory, 'absent')))

        expect(error._tag).toBe('RuleLoadError')
      }),
    ),
  )
})
