/**
 * Fail the run when any CHANGED FILE is below the floor, which Stryker's `thresholds.break` cannot.
 *
 * Invoked by `mutate-changed.sh` after Stryker has written its JSON report, with `break` set to null
 * so Stryker itself no longer decides. The reasoning, and the pull request this was found on, are in
 * `src/testSupport/mutationFloor.ts`.
 *
 * `NodeRuntime.runMain` rather than `process.exit`: this project's own `no-process-exit` rule names
 * that alternative, and it is the right one — a failed Effect exits non-zero after finalizers run.
 */
import { NodeFileSystem, NodeRuntime } from '@effect/platform-node'
import { Effect, FileSystem, Schema } from 'effect'
import { belowFloor, decodeReport, score } from '../src/testSupport/mutationFloor.ts'

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const [reportPath, rawFloor] = process.argv.slice(2)

  if (reportPath === undefined || rawFloor === undefined) {
    return yield* Effect.fail('usage: mutation-floor.ts <mutation.json> <floor>')
  }

  // Decoded rather than coerced: `Number(x)` is what `no-raw-coercion` refuses, and it would turn a
  // mistyped floor into NaN — which compares false against everything and passes every file.
  const floor = yield* Schema.decodeUnknownEffect(Schema.FiniteFromString)(rawFloor).pipe(
    Effect.mapError(() => `mutation-floor: "${rawFloor}" is not a floor`),
  )

  const scored = score(yield* decodeReport(yield* fs.readFileString(reportPath)))

  if (scored.length === 0) {
    return yield* Effect.fail('mutation-floor: the report names no files, so nothing was scored')
  }

  const failing = belowFloor(scored, floor)

  for (const file of scored) {
    const mark = failing.includes(file) ? '✗' : '·'
    const reading = file.score === null ? 'no covered mutants' : `${file.score.toFixed(2)}%`
    yield* Effect.log(`  ${mark} ${file.path} ${reading}`)
  }

  for (const file of scored.filter((entry) => entry.score === null)) {
    // `allowEmpty` lets this through on purpose; `coverage:ci`'s thresholds are what score it.
    yield* Effect.log(`mutation-floor: ${file.path} produced no covered mutants — coverage:ci scores that file`)
  }

  if (failing.length > 0) {
    const detail = failing.map((file) => `${file.path} ${file.score?.toFixed(2)}%`).join(', ')

    return yield* Effect.fail(`mutation-floor: below the floor of ${floor}% — ${detail}`)
  }

  yield* Effect.log(`mutation-floor: every changed file is at or above ${floor}%`)
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeFileSystem.layer)))
