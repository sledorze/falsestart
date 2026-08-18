/**
 * `--report-deletions` in CI, and the cairn behaviour the wiring depends on.
 *
 * `pnpm check` passes the flag with cairn default `--deletions-since HEAD`, comparing the WORKING
 * TREE against HEAD. A CI checkout has nothing uncommitted, so the check inspected nothing on every
 * pull request and said so on every run, in a line that read as boilerplate. The fix is a second,
 * pull-request-only step comparing against the base.
 *
 * The first two assertions are about CAIRN rather than about this repository, deliberately: the day
 * its default starts catching a committed deletion, they are what says the extra step became
 * redundant.
 */
import { NodeServices } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { Effect } from 'effect'
import { run } from '../testSupport/process.ts'
import { aBranchThatDeletedADocument } from '../testSupport/repository.ts'
import { workflowSteps } from '../testSupport/workflow.ts'

const CAIRN = `${process.cwd()}/node_modules/.bin/cairn`

layer(NodeServices.layer)('the deletions report', (it) => {
  /**
   * The claim the CI step rests on, pinned against the real tool rather than restated in prose:
   * with the deletion committed and the tree clean, the default ref sees nothing at all.
   *
   * This is a claim about cairn, not about falsestart, and it is worth a test for that exact
   * reason — the day cairn's default starts catching a committed deletion, the step below becomes
   * redundant and this test is what says so.
   */
  it.effect('sees nothing against the default ref, because the deletion is committed', () =>
    Effect.gen(function* () {
      const root = yield* aBranchThatDeletedADocument
      const ran = yield* run(CAIRN, ['check', '--report-deletions'], root)

      expect(ran.output).toContain('Nothing deleted since the compared ref')
      expect(ran.output).not.toContain('Tuning knobs')
    }).pipe(Effect.scoped),
  )

  it.effect('names what the deletion took when compared against the base', () =>
    Effect.gen(function* () {
      const root = yield* aBranchThatDeletedADocument
      const ran = yield* run(CAIRN, ['check', '--report-deletions', '--deletions-since', 'main'], root)

      expect(ran.output).toContain('deleted doc(s) took content with them')
      expect(ran.output).toContain('guide.md')
      // The heading is the CONTENT the deletion carried off, which is the information the report
      // exists to surface; naming the file alone would be satisfied by `git log`.
      expect(ran.output).toContain('# Tuning knobs')
    }).pipe(Effect.scoped),
  )

  it.effect('is wired into CI against the pull request base, with the history to resolve it', () =>
    Effect.gen(function* () {
      const steps = yield* workflowSteps
      const reporting = steps.filter(({ step }) => (step.run ?? '').includes('--deletions-since'))

      expect(reporting).toHaveLength(1)
      const [only] = reporting

      // Against the branch being merged into, never a hard-coded `main`.
      expect(only?.step.run).toContain('github.base_ref')
      // On pull requests only: `github.base_ref` is empty on a push, and the step would compare
      // against `origin/` and report nothing while looking like it ran.
      expect(only?.step.if?.replaceAll(/\s+/g, ' ').trim()).toBe("github.event_name == 'pull_request'")
      expect(only?.step['continue-on-error']).toBeUndefined()

      // The two things that would turn it back into the no-op it was written to remove: no history
      // to resolve the base against, and no fetch of the base branch itself.
      const checkout = only?.job.steps?.find((step) => (step.uses ?? '').startsWith('actions/checkout'))
      expect(checkout?.with?.['fetch-depth']).toBe(0)
      expect(
        only?.job.steps?.some(
          (step) => (step.run ?? '').startsWith('git fetch') && step.run?.includes('github.base_ref'),
        ),
      ).toBeTruthy()
    }),
  )
})
