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

/**
 * A repository with a `main` to diff against, and a branch that changed only `src/a.test.ts`.
 *
 * The shape of a pull request that weakens a test and touches nothing else — which is the defect
 * this whole gate exists to catch, and the one shape a filter on "source files, tests excluded"
 * sees as an empty change set.
 */
const branchThatOnlyWeakensATest = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: 'falsestart-mutation-' }))

  yield* fs.makeDirectory(`${root}/src`, { recursive: true })
  yield* fs.writeFileString(`${root}/src/a.ts`, 'export const a = (n: number): boolean => n > 0\n')
  yield* fs.writeFileString(`${root}/src/a.test.ts`, 'it("holds", () => expect(a(1)).toBe(true))\n')
  // A near-miss neighbour: `b.e2e.test.ts` is not the sibling test of `b.ts`, and must not be
  // treated as one.
  yield* fs.writeFileString(`${root}/src/b.ts`, 'export const b = (n: number): boolean => n < 0\n')
  yield* fs.writeFileString(`${root}/src/b.e2e.test.ts`, 'it("holds", () => expect(b(-1)).toBe(true))\n')
  yield* run('git', ['init', '-q', '-b', 'main', '.'], root)
  yield* run('git', ['config', 'user.email', 'test@example.com'], root)
  yield* run('git', ['config', 'user.name', 'test'], root)
  yield* run('git', ['add', '-A'], root)
  yield* run('git', ['commit', '-qm', 'first'], root)
  yield* run('git', ['checkout', '-q', '-b', 'weaken'], root)
  yield* fs.writeFileString(`${root}/src/a.test.ts`, 'it("holds", () => expect(1).toBe(1))\n')
  yield* run('git', ['commit', '-qam', 'weaken the test'], root)

  return root
})

/** The same repository, but the branch changed a test whose name has no sibling implementation. */
const branchThatWeakensATestWithNoSubject = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const root = yield* branchThatOnlyWeakensATest

  yield* run('git', ['checkout', '-q', 'main'], root)
  yield* run('git', ['checkout', '-q', '-b', 'weaken-e2e'], root)
  yield* fs.writeFileString(`${root}/src/b.e2e.test.ts`, 'it("holds", () => expect(1).toBe(1))\n')
  yield* run('git', ['commit', '-qam', 'weaken the e2e test'], root)

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
  readonly env?: Readonly<Record<string, string>> | undefined
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

  /**
   * The hole this closes was reproduced on the real repository before it was closed: a branch that
   * deleted every assertion constraining `appliesTo` from `src/checking/scope.test.ts`, touching no
   * source file, left the suite green and the guard silent — `mutation: no mutatable source changed
   * on this branch, skipping`, exit 0. "The test stopped constraining the code" is the defect, and
   * the guard was looking only at the code.
   *
   * The mapping is structural — `x.test.ts` beside `x.ts` — not a search for which tests happen to
   * touch which file. It follows the repository's own file-role convention, so a test whose subject
   * is not its sibling (`cli.e2e.test.ts`, `corpus.test.ts`) still pulls nothing in.
   */
  it.effect('scores the implementation when only its test changed', () =>
    Effect.gen(function* () {
      const root = yield* branchThatOnlyWeakensATest

      const ran = yield* run('bash', [SCRIPT], root)

      expect(ran.output).toContain('src/a.ts')
      expect(ran.output).not.toContain('skipping')
    }).pipe(Effect.scoped),
  )

  // The negative half, which is what stops the mapping from being a content guess: a test file whose
  // name does not name an implementation drags nothing in, even when a plausible-looking neighbour
  // (`src/b.ts` beside `src/b.e2e.test.ts`) is sitting right there.
  it.effect('pulls in nothing for a test that is not the sibling of any implementation', () =>
    Effect.gen(function* () {
      const root = yield* branchThatWeakensATestWithNoSubject

      const ran = yield* run('bash', [SCRIPT], root)

      expect(ran.output).toContain('no mutatable source changed')
      expect(ran.output).not.toContain('src/b.ts')
    }).pipe(Effect.scoped),
  )

  it.effect('is run by CI with that requirement turned on, against a fully fetched history', () =>
    Effect.gen(function* () {
      const steps = yield* workflowSteps
      const mutation = steps.filter(({ step }) => (step.run ?? '').includes('mutation:changed'))

      expect(mutation).toHaveLength(1)
      const [only] = mutation
      // Without this the job diffs against a base it could not resolve, prints `skipping`, and
      // exits 0 on every pull request — green, and having mutated nothing. Read from the step or
      // the job, because setting it at either level is the same thing to the runner and pinning one
      // spelling would fail a refactor that changed nothing.
      expect(only?.step.env?.['MUTATION_REQUIRE_BASE'] ?? only?.job.env?.['MUTATION_REQUIRE_BASE']).toBe('1')

      const checkout = only?.job.steps.find((step) => (step.uses ?? '').startsWith('actions/checkout'))
      // `fetch-depth: 1`, the default, is what makes `origin/main` absent in the first place.
      expect(checkout?.with?.['fetch-depth']).toBe(0)
    }),
  )
})
