import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { Effect, FileSystem, Layer, Path } from 'effect'
import { loadConfigFile, loadDefaultConfig } from './config-file.ts'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

const withFiles = <A, E>(
  files: Readonly<Record<string, string>>,
  use: (directory: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'falsestart-config-' })

    for (const [name, contents] of Object.entries(files)) {
      const target = path.join(root, name)
      yield* fs.makeDirectory(path.dirname(target), { recursive: true })
      yield* fs.writeFileString(target, contents)
    }

    return yield* use(root)
  }).pipe(Effect.scoped)

const unstattable = Layer.mergeAll(
  NodePath.layer,
  FileSystem.layerNoop({ exists: () => Effect.fail(new Error('cannot stat') as never) }),
)

layer(platform)('loading a config file', (it) => {
  it.effect('reports a JSON config that exists but cannot be read', () =>
    withFiles({ 'falsestart.config.json/inner.txt': 'x' }, (directory) =>
      Effect.gen(function* () {
        // A DIRECTORY with the config's name: it exists, but is not a document.
        const path = yield* Path.Path
        const error = yield* Effect.flip(loadConfigFile(path.join(directory, 'falsestart.config.json')))

        expect(error.reasons.join(', ')).toContain('cannot be read')
      }),
    ),
  )

  it.effect('treats a filesystem it cannot even question as no config at all', () =>
    Effect.gen(function* () {
      // Forced rather than contrived: the point is that an unstattable path and an absent one lead
      // the caller to the same next step, so they get the same answer.
      const error = yield* Effect.flip(loadConfigFile('anywhere.json'))

      expect(error.reasons.join(', ')).toContain('no such config file')
    }).pipe(Effect.provide(unstattable)),
  )

  it.effect('finds nothing when a directory holds no config', () =>
    withFiles({ 'unrelated.txt': 'x' }, (directory) =>
      Effect.gen(function* () {
        expect((yield* loadDefaultConfig(directory)).rules).toEqual({})
      }),
    ),
  )
})
