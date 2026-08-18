/**
 * The workflow decoder, against `ci.yml` files GitHub accepts and this once did not.
 *
 * The schema was written from the shape of THIS repository's workflow, which is a narrower thing
 * than the schema it claimed to model — and it fails by `orDie`, so a legitimate edit did not
 * produce a decode error, it produced three guard suites collapsing with `SchemaError: Missing key`
 * and nothing pointing at the workflow.
 */
import { effect, expect } from '@effect/vitest'
import { Effect, Exit } from 'effect'
import { parseWorkflow } from './workflow.ts'

effect('reads the steps of an ordinary job', () =>
  Effect.gen(function* () {
    const steps = yield* parseWorkflow('jobs:\n  build:\n    steps:\n      - run: pnpm lint\n')

    expect(steps.map(({ step }) => step.run)).toEqual(['pnpm lint'])
    expect(steps[0]?.job.name).toBe('build')
  }),
)

effect('accepts a reusable-workflow job, which has no steps at all', () =>
  Effect.gen(function* () {
    const steps = yield* parseWorkflow('jobs:\n  security:\n    uses: ./.github/workflows/codeql.yml\n')

    expect(steps).toEqual([])
  }),
)

effect('accepts env values YAML gives as numbers and booleans', () =>
  Effect.gen(function* () {
    const steps = yield* parseWorkflow(
      'jobs:\n  build:\n    steps:\n      - run: pnpm x\n        env:\n          RETRIES: 1\n          CI: true\n',
    )

    // Accepted as YAML gives them, not coerced — see the note on EnvValue.
    expect(steps[0]?.step.env).toEqual({ CI: true, RETRIES: 1 })
  }),
)

effect('accepts continue-on-error given as an expression rather than a literal', () =>
  Effect.gen(function* () {
    // Built as a template literal with an escaped `$` so the placeholder is data here, not a
    // half-written interpolation — which is what `no-template-curly-in-string` is watching for.
    const expression = `\${{ matrix.experimental }}`
    const steps = yield* parseWorkflow(
      `jobs:\n  build:\n    steps:\n      - run: pnpm x\n        continue-on-error: ${expression}\n`,
    )

    expect(steps[0]?.step['continue-on-error']).toBe(expression)
  }),
)

effect('still refuses a file that is not a workflow at all', () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(parseWorkflow('nope: true\n'))

    expect(Exit.isFailure(exit)).toBeTruthy()
  }),
)
