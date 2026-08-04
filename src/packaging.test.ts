/**
 * What the published tarball actually contains, judged by packing it rather than by reading `files`.
 *
 * A consumer upgrading 0.1.0 → 0.2.0 reported having to `npm pack` both versions and `diff -rq` the
 * `rules/` trees by hand to find out what had changed, because no `CHANGELOG.md` was in the package.
 * For a devDependency that gates every future edit, "what is newly going to block me" is exactly
 * what you need BEFORE upgrading — and 0.2.0 added two `error`-severity rules to `clean-code`, so a
 * minor bump made a previously-passing repo red with nothing in the package to say so.
 *
 * Asserted against a real pack rather than against the `files` array, because the array is only the
 * input to a question npm answers: `.npmignore`, `publishConfig` and npm's always-included names all
 * get a vote, and the thing the consumer receives is the tarball.
 */
import { NodeServices } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { Effect, FileSystem, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

interface PackedFile {
  readonly path: string
}

/**
 * `npm pack` runs the `prepare` lifecycle script, which prints to the same stdout as `--json` —
 * `--ignore-scripts` does not suppress it. So the payload is sliced from the first `[` rather than
 * parsed from the whole stream, which is noise-tolerant in the one direction that matters: a run
 * that emitted no JSON at all has no `[` and fails loudly here instead of silently passing.
 */
const packedFiles = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const handle = yield* spawner.spawn(ChildProcess.make('npm', ['pack', '--dry-run', '--json']))
  const stdout = yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString) as Effect.Effect<string>
  yield* handle.exitCode

  const json = stdout.slice(stdout.indexOf('['))
  const [packed] = JSON.parse(json) as readonly { readonly files: readonly PackedFile[] }[]
  return packed?.files.map((file) => file.path) ?? []
}).pipe(Effect.scoped, Effect.orDie)

layer(NodeServices.layer)('the published package', (it) => {
  it.effect('ships the changelog, so an upgrade does not have to be reverse-engineered', () =>
    Effect.gen(function* () {
      const files = yield* packedFiles

      expect(files).toContain('CHANGELOG.md')
    }),
  )

  it.effect('ships a changelog that covers the version being published', () =>
    Effect.gen(function* () {
      // A changelog that stops one release short is the same archaeology with extra steps.
      // `changeset version` writes both, so this only fails if something else edited one of them.
      const fs = yield* FileSystem.FileSystem
      const manifest = JSON.parse(yield* fs.readFileString('package.json')) as { readonly version: string }
      const changelog = yield* fs.readFileString('CHANGELOG.md')

      expect(changelog).toContain(`## ${manifest.version}`)
    }),
  )
})
