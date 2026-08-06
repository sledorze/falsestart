import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { Effect, FileSystem, Layer, Path } from 'effect'
import { findDefaultConfigs, loadConfigFile, loadDefaultConfig } from './config-file.ts'

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

/**
 * The frozen path: discovery and content both come from the ref, and the working tree is never
 * stat'ed.
 *
 * Every case here writes a DIFFERENT config to disk at the same path, because "the frozen bytes were
 * used" and "the frozen bytes were used after also reading the file" are different claims and only
 * the first is worth having. A disagreement is the only thing that can tell them apart.
 */
layer(platform)('loading a config the ref committed', (it) => {
  // T36 — the issue's second vector: a scope override nobody committed.
  it.effect('parses the committed JSON while the working tree says something else', () =>
    withFiles({ 'falsestart.config.json': '{"rules":{"x":{"files":["never/**"]}}}' }, (directory) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const config = yield* loadConfigFile(path.join(directory, 'falsestart.config.json'), '{"rules":{}}')

        expect(config.rules).toEqual({})
      }),
    ),
  )

  // T37 — the same, for the typed format, which is the one the documentation recommends.
  it.effect('type-strips and imports the committed TypeScript, not the file on disk', () =>
    withFiles({ 'falsestart.config.ts': "export default { rules: { x: { files: ['never/**'] } } }\n" }, (directory) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const config = yield* loadConfigFile(
          path.join(directory, 'falsestart.config.ts'),
          "const files: string[] = ['committed/**']\nexport default { rules: { y: { files } } }\n",
        )

        expect(config.rules).toEqual({ y: { files: ['committed/**'] } })
      }),
    ),
  )

  // T38 — the discriminating one. Under the old verify-then-import shape a `.js`/`.mjs` config was
  // imported from its real path, so this fixture would fail by THROWING rather than by asserting.
  it.effect('imports committed JavaScript from the bytes, never from the path', () =>
    withFiles({ 'falsestart.config.mjs': "throw new Error('IMPORTED')\n" }, (directory) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const config = yield* loadConfigFile(
          path.join(directory, 'falsestart.config.mjs'),
          "export default { rules: { z: { files: ['committed/**'] } } }\n",
        )

        expect(config.rules).toEqual({ z: { files: ['committed/**'] } })
      }),
    ),
  )

  // T39 — the cost of D7, made loud. A `.js`/`.mjs` config could import anything before; frozen, it
  // is imported from a `data:` URL with no location to resolve a specifier against.
  it.effect('says why a committed JavaScript config cannot import a package', () =>
    withFiles({}, (directory) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const error = yield* Effect.flip(
          loadConfigFile(
            path.join(directory, 'falsestart.config.mjs'),
            "import picomatch from 'picomatch'\nexport default { rules: {}, x: picomatch }\n",
          ),
        )

        expect(error.reasons.join('\n')).toContain('data:')
        expect(error.reasons.join('\n')).toContain('--freeze off')
      }),
    ),
  )

  // T40 — `rm falsestart.config.json` would otherwise be a one-command disarm, because the explicit
  // path's existence gate runs before anything else.
  it.effect('loads a committed config when no file exists on disk at all', () =>
    withFiles({}, (directory) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const config = yield* loadConfigFile(
          path.join(directory, 'falsestart.config.json'),
          '{"rules":{"a":{"files":["src/**"]}}}',
        )

        expect(config.rules).toEqual({ a: { files: ['src/**'] } })
      }),
    ),
  )

  // T41 — the issue's third vector: adding a second config file breaks the load, and a broken load
  // is an allowed write. Discovery has to come from the ref too.
  it.effect('discovers only the config the ref holds, whatever is on disk', () =>
    withFiles(
      { 'falsestart.config.json': '{"rules":{}}', 'falsestart.config.ts': 'export default { rules: {} }\n' },
      (directory) =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const found = yield* findDefaultConfigs(directory, new Map([['falsestart.config.ts', 'export default {}\n']]))

          expect(found).toEqual([path.join(directory, 'falsestart.config.ts')])
        }),
    ),
  )

  // T42 — and a config the repository never committed is not picked up at all.
  it.effect('discovers nothing when the ref committed no config', () =>
    withFiles({ 'falsestart.config.json': '{"rules":{"x":{"files":["never/**"]}}}' }, (directory) =>
      Effect.gen(function* () {
        expect(yield* findDefaultConfigs(directory, new Map())).toEqual([])
        expect((yield* loadDefaultConfig(directory, new Map())).rules).toEqual({})
      }),
    ),
  )
})
