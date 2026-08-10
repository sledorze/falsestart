/**
 * The guard that is supposed to catch a test which cannot fail, checked for the same defect.
 *
 * `scripts/mutate-changed.sh` is the only mechanism here that notices a test asserting something the
 * implementation does not control: line coverage says a line ran, never that a test would object if
 * it were wrong. It diffs against `git merge-base HEAD origin/main`, and when no base resolves it
 * prints `skipping` and exits 0 — right for a local pre-push on a branch with no main to compare
 * against, and vacuous in CI, where `actions/checkout` clones with `fetch-depth: 1` and no
 * `origin/main` at all. The obvious CI job therefore passes without mutating a single file: a guard
 * against checks that cannot fail, which is itself a check that cannot fail.
 *
 * So the skip became opt-out. `MUTATION_REQUIRE_BASE=1` says "a base is a precondition here, and its
 * absence is a failure" — and CI sets it, which is the wiring assertion at the end. Without that
 * pairing the first is worth nothing: a strict mode nothing turns on is the same vacuum one layer
 * down.
 */
import { NodeServices } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { Effect } from 'effect'
import { run } from '../testing/process.ts'
import {
  aStackedBranch,
  branchThatOnlyWeakensATest,
  branchThatWeakensATestWithNoSubject,
  repositoryWithNoBase,
} from '../testing/repository.ts'
import { workflowSteps } from '../testing/workflow.ts'

const SCRIPT = `${process.cwd()}/scripts/mutate-changed.sh`

/**
 * The two variables the script reads, explicitly blanked.
 *
 * Not defensive tidiness — without it these tests assert about whatever environment they happen to
 * run in. CI's `mutation` job sets `MUTATION_REQUIRE_BASE=1` and `MUTATION_BASE_REF` on the step,
 * and Stryker runs this whole suite as its dry run from inside that step, so the child `bash` here
 * inherited both: "still skips quietly" got the strict mode it exists to contrast with, exited 1,
 * and took the entire mutation job down with `There were failed tests in the initial test run` —
 * a failure that says nothing about the guard and everything about the environment.
 *
 * Blank rather than absent because the script reads `${VAR:-default}`: an empty value takes the
 * same branch as unset, and an env map cannot express "remove this key".
 */
const NO_AMBIENT: Readonly<Record<string, string>> = { MUTATION_BASE_REF: '', MUTATION_REQUIRE_BASE: '' }

layer(NodeServices.layer)('the mutation guard', (it) => {
  it.effect('refuses to pass when no base resolves and a base was declared to be required', () =>
    Effect.gen(function* () {
      const root = yield* repositoryWithNoBase

      const ran = yield* run('bash', [SCRIPT], root, { ...NO_AMBIENT, MUTATION_REQUIRE_BASE: '1' })

      expect(ran.exitCode).not.toBe(0)
      expect(ran.output).toContain('no merge-base')
    }).pipe(Effect.scoped),
  )

  it.effect('still skips quietly when nothing declared a base to be required', () =>
    Effect.gen(function* () {
      const root = yield* repositoryWithNoBase

      const ran = yield* run('bash', [SCRIPT], root, NO_AMBIENT)

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

      const ran = yield* run('bash', [SCRIPT], root, NO_AMBIENT)

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

      const ran = yield* run('bash', [SCRIPT], root, NO_AMBIENT)

      expect(ran.output).toContain('no mutatable source changed')
      expect(ran.output).not.toContain('src/b.ts')
    }).pipe(Effect.scoped),
  )

  /**
   * A stacked branch diffed against `main` scores its parent's files too. Not a hole — it is
   * stricter, not weaker — but a pull request then waits on a score for work it did not do, at
   * about a minute a file, and a red tick it cannot act on is a tick people learn to ignore.
   */
  it.effect('diffs against the branch it was actually opened against', () =>
    Effect.gen(function* () {
      const root = yield* aStackedBranch

      const stacked = yield* run('bash', [SCRIPT], root, { ...NO_AMBIENT, MUTATION_BASE_REF: 'parent' })
      const wrong = yield* run('bash', [SCRIPT], root, NO_AMBIENT)

      expect(stacked.output).toContain('src/child.ts')
      expect(stacked.output).not.toContain('src/parent.ts')
      // The default is still the default branch, which is what an ordinary pull request wants.
      expect(wrong.output).toContain('src/parent.ts')
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

      // The three edits that turn this job into decoration, all of which a previous version of this
      // test was green on. `|| true` and `continue-on-error` are what a maintainer reaches for when
      // a job is slow or flaky, and both leave the tick green while the guard reports nothing; a
      // narrowed `if:` stops the job running on the event it exists for. Pinned exactly rather than
      // by substring, so a deliberate change has to come here and say so.
      expect(only?.step.run?.trim()).toBe('pnpm mutation:changed')
      expect(only?.step['continue-on-error']).toBeUndefined()
      expect(only?.job['continue-on-error']).toBeUndefined()
      expect(only?.job.if?.replaceAll(/\s+/g, ' ').trim()).toBe("github.event_name == 'pull_request'")

      // And against the branch the pull request is actually merging into, not a hard-coded `main`.
      expect(only?.step.env?.['MUTATION_BASE_REF'] ?? only?.job.env?.['MUTATION_BASE_REF']).toContain('github.base_ref')
      expect(only?.job.steps.some((step) => (step.run ?? '').includes('github.base_ref'))).toBeTruthy()
    }),
  )
})
