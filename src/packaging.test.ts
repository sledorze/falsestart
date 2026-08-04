/**
 * What the published tarball actually contains, judged by packing one and listing it.
 *
 * A consumer upgrading 0.1.0 → 0.2.0 reported having to `npm pack` both versions and `diff -rq` the
 * `rules/` trees by hand to find out what had changed, because no `CHANGELOG.md` was in the package.
 * For a devDependency that gates every future edit, "what is newly going to block me" is exactly
 * what you need BEFORE upgrading — and 0.2.0 added two `error`-severity rules to `clean-code`, so a
 * minor bump made a previously-passing repo red with nothing in the package to say so.
 *
 * Asserted against a real archive rather than against the `files` array, because the array is only
 * the input to a question npm answers: `.npmignore`, `publishConfig` and npm's always-included names
 * all get a vote, and the thing the consumer receives is the tarball.
 *
 * It is also listed with `tar` rather than read from `npm pack --json`. npm runs the `prepare`
 * lifecycle script during a pack and that script's output lands on the same stdout as the JSON —
 * `--ignore-scripts` does not suppress it — so parsing that stream couples this test to the console
 * formatting of whatever `prepare` happens to run. `release.yml` runs `pnpm verify` before
 * publishing, which would make a lefthook release that prints a bracket a failed falsestart release.
 */
import { NodeServices } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { Effect, FileSystem, Path, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

/**
 * Runs a command for its stdout, and DIES on a non-zero exit rather than returning it.
 *
 * A pack or a listing that failed has nothing to say about what the tarball contains, so carrying
 * the code back to be asserted would only give the caller a chance to check the wrong thing. This
 * fails the test with the command that broke, which is the only useful outcome either way.
 */
const stdoutOf = (command: string, args: readonly string[]) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make(command, [...args]))
    const stdout = yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString) as Effect.Effect<string>
    const exitCode = yield* handle.exitCode

    return exitCode === 0 ? stdout : yield* Effect.die(`${command} ${args.join(' ')} exited ${exitCode}`)
  }).pipe(Effect.scoped, Effect.orDie)

/** Every path inside a freshly packed tarball, as `package/…` entries. */
const packedFiles = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const destination = yield* fs.makeTempDirectoryScoped()

  yield* stdoutOf('npm', ['pack', '--pack-destination', destination])

  const entries = yield* fs.readDirectory(destination)
  const tarball = entries.find((entry) => entry.endsWith('.tgz')) ?? 'no-tarball-was-written'
  const listed = yield* stdoutOf('tar', ['-tzf', path.join(destination, tarball)])

  return listed.split('\n').map((line) => line.trim())
}).pipe(Effect.scoped)

layer(NodeServices.layer)('the published package', (it) => {
  it.effect('ships the changelog, so an upgrade does not have to be reverse-engineered', () =>
    Effect.gen(function* () {
      const files = yield* packedFiles

      expect(files).toContain('package/CHANGELOG.md')
    }),
  )

  it.effect('ships a changelog that covers the version being published', () =>
    Effect.gen(function* () {
      // A changelog that stops one release short is the same archaeology with extra steps.
      // `changeset version` writes both files in one commit, so this only fails if something else
      // edited one of them.
      const fs = yield* FileSystem.FileSystem
      const manifest = JSON.parse(yield* fs.readFileString('package.json')) as { readonly version: string }
      const changelog = yield* fs.readFileString('CHANGELOG.md')

      expect(changelog).toContain(`## ${manifest.version}`)
    }),
  )
})
