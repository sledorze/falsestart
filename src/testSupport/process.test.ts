/**
 * The spawn helper, against the two things that make a child process helper wrong in production.
 *
 * Both were found by review rather than by use: the three commands this helper runs today are small
 * and local, so neither case fires yet. That is exactly when to pin them — a helper that works for
 * every input anyone has tried is not the same as one that works.
 */
import { NodeServices } from '@effect/platform-node'
import { describe, expect, layer } from '@effect/vitest'
import { Effect, FileSystem } from 'effect'
import { run } from './process.ts'

/** Writes past any plausible pipe buffer on BOTH streams, interleaved, then exits cleanly. */
const FLOODS_BOTH_STREAMS = `
const chunk = 'x'.repeat(1024)
for (let i = 0; i < 400; i++) {
  process.stderr.write(chunk)
  process.stdout.write('line' + i + '\\n')
}
`

layer(NodeServices.layer)('run', (it) => {
  /**
   * Reading stdout to completion and only THEN reading stderr deadlocks: the child blocks writing
   * stderr once the buffer fills, so it never finishes stdout, so the read never completes. It
   * surfaces as a test timeout naming nothing about the cause.
   */
  it.effect(
    'captures a child that floods both streams instead of deadlocking on one',
    () =>
      Effect.gen(function* () {
        const ran = yield* run('node', ['-e', FLOODS_BOTH_STREAMS], process.cwd())

        expect(ran.exitCode).toBe(0)
        expect(ran.output).toContain('line399')
        expect(ran.output.length).toBeGreaterThan(400_000)
      }),
    20_000,
  )

  /**
   * The corruption class this repository has already been bitten by: git reads `GIT_DIR` before it
   * looks at any path, so a fixture that spawns `git init` in its own directory writes into
   * whatever repository the environment names instead. `cwd` is no defence, and neither is
   * blanking — `GIT_DIR=''` is a fatal path, not an unset variable.
   */
  it.effect('runs a child with no inherited git location variables', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const victim = yield* fs.makeTempDirectoryScoped({ prefix: 'falsestart-victim-' })
      const fixture = yield* fs.makeTempDirectoryScoped({ prefix: 'falsestart-fixture-' })

      yield* run('git', ['init', '-q', '-b', 'main', '.'], victim)
      const before = yield* run('git', ['rev-list', '--count', '--all'], victim)

      // The ambient environment names the victim; the child is told to work in `fixture`.
      const ran = yield* run('git', ['init', '-q', '-b', 'main', '.'], fixture, { GIT_DIR: `${victim}/.git` })

      expect(ran.exitCode).toBe(0)
      expect(yield* fs.exists(`${fixture}/.git`)).toBeTruthy()
      const after = yield* run('git', ['rev-list', '--count', '--all'], victim)
      expect(after.output).toBe(before.output)
    }).pipe(Effect.scoped),
  )

  /** Prints the named variable as the child sees it, or `unset`. */
  const REPORTS_A_VARIABLE = "process.stdout.write(process.env[process.argv[1]] ?? 'unset')"

  describe.each([
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CEILING_DIRECTORIES',
    'GIT_COMMON_DIR',
    'GIT_DIR',
    'GIT_INDEX_FILE',
    'GIT_NAMESPACE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_WORK_TREE',
  ])('%s', (name) => {
    it.effect('never reaches a child, however it is asked for', () =>
      Effect.gen(function* () {
        const ran = yield* run('node', ['-e', REPORTS_A_VARIABLE, name], process.cwd(), { [name]: '/somewhere/else' })

        expect(ran.output).toBe('unset')
      }),
    )
  })

  it.effect('gives a child only what it declares, not the parent environment', () =>
    Effect.gen(function* () {
      // `VITEST` is set in this process by the runner. A child that can see it is one inheriting the
      // ambient environment — the mechanism the list above exists to defeat, and what
      // `extendEnv: false` is actually doing.
      const ran = yield* run('node', ['-e', REPORTS_A_VARIABLE, 'VITEST'], process.cwd())

      expect(ran.output).toBe('unset')
    }),
  )

  it.effect('gives a child the PATH and HOME it does need', () =>
    Effect.gen(function* () {
      const path = yield* run('node', ['-e', REPORTS_A_VARIABLE, 'PATH'], process.cwd())
      const home = yield* run('node', ['-e', REPORTS_A_VARIABLE, 'HOME'], process.cwd())

      expect(path.output).not.toBe('unset')
      expect(path.output.length).toBeGreaterThan(0)
      expect(home.output).not.toBe('unset')
    }),
  )
})
