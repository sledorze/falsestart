/**
 * The guard that is supposed to catch a test which cannot fail, checked for the same defect.
 *
 * `scripts/mutate-changed.sh` is the only mechanism in this repo that notices a test asserting
 * something the implementation does not control: line coverage says a line ran, never that a test
 * would object if it were wrong. It diffs against `git merge-base HEAD origin/main`, and when no
 * base resolves it prints `skipping` and exits 0 — right for a local pre-push on a branch with no
 * main to compare against, and vacuous in CI, where `actions/checkout` clones with `fetch-depth: 1`
 * and no `origin/main` at all. The obvious CI job therefore passes without mutating a single file:
 * a guard against checks that cannot fail, which is itself a check that cannot fail.
 *
 * So the skip became opt-out. `MUTATION_REQUIRE_BASE=1` says "a base is a precondition here, and
 * its absence is a failure" — and CI sets it, which is the second assertion below. Without that
 * pairing the first is worth nothing: a strict mode nothing turns on is the same vacuum one layer
 * down.
 */
import { NodeServices } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { Effect, FileSystem, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'
import { parse } from 'yaml'

const SCRIPT = `${process.cwd()}/scripts/mutate-changed.sh`
const WORKFLOW = `${process.cwd()}/.github/workflows/ci.yml`

interface Ran {
  readonly exitCode: number
  readonly output: string
}

const run = (
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

/**
 * A real repository with one commit, on a branch that is not `main` and has no remote — exactly the
 * shape a default `actions/checkout` produces, where `origin/main` does not exist.
 */
const repositoryWithNoBase = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: 'falsestart-mutation-' }))

  yield* fs.makeDirectory(`${root}/src`, { recursive: true })
  yield* fs.writeFileString(`${root}/src/a.ts`, 'export const a = 1\n')
  yield* run('git', ['init', '-q', '-b', 'feature', '.'], root)
  yield* run('git', ['config', 'user.email', 'test@example.com'], root)
  yield* run('git', ['config', 'user.name', 'test'], root)
  yield* run('git', ['add', '-A'], root)
  yield* run('git', ['commit', '-qm', 'first'], root)

  return root
})

/** Every `run:` string in the workflow, paired with the job and step that carries it. */
const workflowSteps = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const document: unknown = parse(yield* fs.readFileString(WORKFLOW))
  const jobs = (document as { readonly jobs: Readonly<Record<string, Job>> }).jobs

  return Object.entries(jobs).flatMap(([name, job]) => job.steps.map((step) => ({ job: { ...job, name }, step })))
})

interface Step {
  readonly run?: string | undefined
  readonly uses?: string | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly with?: Readonly<Record<string, unknown>> | undefined
}

interface Job {
  readonly steps: readonly Step[]
  readonly if?: string | undefined
}

layer(NodeServices.layer)('the mutation guard', (it) => {
  it.effect('refuses to pass when no base resolves and a base was declared to be required', () =>
    Effect.gen(function* () {
      const root = yield* repositoryWithNoBase

      const ran = yield* run('bash', [SCRIPT], root, { MUTATION_REQUIRE_BASE: '1' })

      expect(ran.exitCode).not.toBe(0)
      expect(ran.output).toContain('no merge-base')
    }).pipe(Effect.scoped),
  )

  it.effect('still skips quietly when nothing declared a base to be required', () =>
    Effect.gen(function* () {
      const root = yield* repositoryWithNoBase

      const ran = yield* run('bash', [SCRIPT], root)

      expect(ran.exitCode).toBe(0)
      expect(ran.output).toContain('skipping')
    }).pipe(Effect.scoped),
  )

  it.effect('is run by CI with that requirement turned on, against a fully fetched history', () =>
    Effect.gen(function* () {
      const steps = yield* workflowSteps
      const mutation = steps.filter(({ step }) => (step.run ?? '').includes('mutation:changed'))

      expect(mutation).toHaveLength(1)
      const [only] = mutation
      // Without this the job diffs against a base it could not resolve, prints `skipping`, and
      // exits 0 on every pull request — green, and having mutated nothing.
      expect(only?.step.env?.['MUTATION_REQUIRE_BASE']).toBe('1')

      const checkout = only?.job.steps.find((step) => (step.uses ?? '').startsWith('actions/checkout'))
      // `fetch-depth: 1`, the default, is what makes `origin/main` absent in the first place.
      expect(checkout?.with?.['fetch-depth']).toBe(0)
    }),
  )
})
