/**
 * The per-file floor, against the report shape that merged green while a file sat below it.
 *
 * The first case is not synthetic: those are PR #85's own numbers, from the run that passed.
 */
import { effect, expect } from '@effect/vitest'
import { Effect } from 'effect'
import { belowFloor, decodeReport, score } from './mutationFloor.ts'

const FLOOR = 70

/** `n` mutants of one status, which is all the scorer reads. */
const mutants = (status: string, count: number) => Array.from({ length: count }, () => ({ status }))

const report = (files: Readonly<Record<string, { readonly killed: number; readonly survived: number }>>) =>
  JSON.stringify({
    files: Object.fromEntries(
      Object.entries(files).map(([path, counts]) => [
        path,
        { mutants: [...mutants('Killed', counts.killed), ...mutants('Survived', counts.survived)] },
      ]),
    ),
  })

effect('fails a changed file below the floor even when the run average clears it', () =>
  Effect.gen(function* () {
    // PR #85 as it actually ran: 71.89 overall, workflow.ts at 66.67, merged green.
    const decoded = yield* decodeReport(
      report({
        'src/testSupport/process.ts': { killed: 18, survived: 3 },
        'src/testSupport/repository.ts': { killed: 129, survived: 51 },
        'src/testSupport/workflow.ts': { killed: 6, survived: 3 },
      }),
    )

    const failing = belowFloor(score(decoded), FLOOR)

    expect(failing.map((file) => file.path)).toEqual(['src/testSupport/workflow.ts'])
  }),
)

effect('passes when every changed file clears the floor on its own', () =>
  Effect.gen(function* () {
    const decoded = yield* decodeReport(
      report({ 'src/a.ts': { killed: 8, survived: 2 }, 'src/b.ts': { killed: 9, survived: 1 } }),
    )

    expect(belowFloor(score(decoded), FLOOR)).toEqual([])
  }),
)

effect('fails a module whose every mutant survived, however healthy its neighbour', () =>
  Effect.gen(function* () {
    const decoded = yield* decodeReport(
      report({ 'src/healthy.ts': { killed: 100, survived: 0 }, 'src/quota.ts': { killed: 0, survived: 11 } }),
    )

    const failing = belowFloor(score(decoded), FLOOR)

    expect(failing.map((file) => file.path)).toEqual(['src/quota.ts'])
    expect(failing[0]?.score).toBe(0)
  }),
)

effect('reports a file with no covered mutants rather than failing or excusing it', () =>
  Effect.gen(function* () {
    const decoded = yield* decodeReport(report({ 'src/unreached.ts': { killed: 0, survived: 0 } }))
    const scored = score(decoded)

    expect(scored[0]?.score).toBeNull()
    expect(belowFloor(scored, FLOOR)).toEqual([])
  }),
)

effect('counts a timeout as killed, the way the report beside it does', () =>
  Effect.gen(function* () {
    const decoded = yield* decodeReport(
      JSON.stringify({ files: { 'src/a.ts': { mutants: [...mutants('Timeout', 7), ...mutants('Survived', 3)] } } }),
    )

    expect(score(decoded)[0]?.score).toBe(70)
    expect(belowFloor(score(decoded), FLOOR)).toEqual([])
  }),
)
