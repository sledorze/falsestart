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
import { Config, Effect, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

/** What a finished command left behind: both streams joined, because guards assert across the pair. */
export interface Ran {
  readonly exitCode: number
  readonly output: string
}

/**
 * Every variable git consults BEFORE it looks at a path, refused on the way in.
 *
 * `cwd` is not protection. A fixture that runs `git init` in its own temporary directory writes into
 * whatever repository these name instead — which is how a session of this project ended up with
 * fixture commits on `main` and on two feature branches. They arrive honestly, too: git sets
 * `GIT_DIR` for a `pre-push` hook when the push comes from a linked worktree, and `GIT_INDEX_FILE`
 * for `pre-commit`, so a suite run from a hook inherits them without anyone asking.
 *
 * Refused rather than blanked: `GIT_DIR=''` is a fatal path, not an unset variable
 * (`fatal: The empty string is not a valid path`), so no env map can express the removal.
 *
 * The same list, for the same reason, is in `src/cli.ts`. Duplicated deliberately — test support
 * must not import the executable, and a shared module would couple them for eight constants.
 */
const GIT_LOCATION_VARIABLES = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_WORK_TREE',
])

/**
 * What a child is given, as an ALLOWLIST rather than a denylist.
 *
 * Read through `Config` rather than `process.env` — this project's own `no-process-env` rule refuses
 * the latter, and is right for the reason it states: naming what is needed puts the requirement in
 * the code instead of inheriting an unbounded global. `PATH` finds `git` and `node`; `HOME` is where
 * git looks for `.gitconfig`, without which `commit` fails on identity. Nothing else has been
 * needed — extend this list rather than widening it back to everything.
 *
 * An allowlist also makes the denylist above belt-and-braces rather than load-bearing, which is the
 * right way round for a guard against silent corruption.
 */
const childEnvironment = Effect.gen(function* () {
  const path = yield* Config.string('PATH').pipe(Config.withDefault(''))
  const home = yield* Config.string('HOME').pipe(Config.withDefault(''))

  return { HOME: home, PATH: path }
})

const withoutGitLocation = (source: Readonly<Record<string, string>>): Record<string, string> =>
  Object.fromEntries(Object.entries(source).filter(([name]) => !GIT_LOCATION_VARIABLES.has(name)))

export const run = (
  command: string,
  args: readonly string[],
  cwd: string,
  env?: Readonly<Record<string, string>>,
): Effect.Effect<Ran, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const base = yield* childEnvironment
    const requested = withoutGitLocation(env ?? {})
    const handle = yield* spawner.spawn(
      ChildProcess.make(command, [...args], { cwd, env: { ...base, ...requested }, extendEnv: false }),
    )
    // CONCURRENTLY, and not as an optimisation. Draining stdout to completion and only then reading
    // stderr deadlocks any child that fills the stderr buffer meanwhile: it blocks writing stderr,
    // so it never finishes stdout, so the read never returns. It surfaces as a test timeout that
    // names nothing about the cause.
    const [stdout, stderr] = yield* Effect.all(
      [
        handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        handle.stderr.pipe(Stream.decodeText(), Stream.mkString),
      ],
      { concurrency: 2 },
    )
    const exitCode = yield* handle.exitCode

    return { exitCode, output: `${stdout}${stderr}` }
  }).pipe(Effect.scoped, Effect.orDie)
