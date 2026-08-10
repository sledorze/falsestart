/**
 * Running a real command and capturing everything it said.
 *
 * Shared because three separate guards need it and none of them is about process handling: the
 * mutation script, the deletions report and the git fixtures all care about an exit code and some
 * output. Duplicating the plumbing in each pushed the interesting assertion further down every file
 * that used it.
 *
 * `Effect.orDie` rather than a typed error: a fixture that cannot spawn `git` is a broken test
 * environment, not a case under test, and surfacing it as a defect keeps every caller's signature
 * free of an error channel none of them handles.
 */
import { Effect, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

/** What a finished command left behind: both streams joined, because guards assert across the pair. */
export interface Ran {
  readonly exitCode: number
  readonly output: string
}

export const run = (
  command: string,
  args: readonly string[],
  cwd: string,
  env?: Readonly<Record<string, string>>,
): Effect.Effect<Ran, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make(command, [...args], { cwd, env, extendEnv: true }))
    const stdout = yield* handle.stdout.pipe(Stream.decodeText(), Stream.mkString)
    const stderr = yield* handle.stderr.pipe(Stream.decodeText(), Stream.mkString)
    const exitCode = yield* handle.exitCode

    return { exitCode, output: `${stdout}${stderr}` }
  }).pipe(Effect.scoped, Effect.orDie)
