/**
 * Apply the floor to EVERY changed file, which Stryker's `thresholds.break` cannot.
 *
 * `break` is compared against one number for the whole run — `systemUnderTestMetrics.metrics
 * .mutationScore` in Stryker's `mutation-test-report-helper.js` — so a well-tested file in the same
 * pull request pays for an untested one.
 *
 * Not theoretical. It happened here: a pull request merged green at `All files 71.89` carrying
 * `workflow.ts` at 66.67, below the floor of 70. And a module scoring 0.00 with every one of its
 * eleven mutants surviving passes whenever it arrives beside one healthy file — which is precisely
 * the defect the gate exists to catch. The `demo/test-that-cannot-fail` demonstration only ever went
 * red because that branch touched nothing else.
 *
 * The per-file numbers were in the JSON report the whole time. Nothing read them.
 */
import { Effect, Schema } from 'effect'

const MutantSchema = Schema.Struct({ status: Schema.String })

const FileSchema = Schema.Struct({ mutants: Schema.Array(MutantSchema) })

export const ReportSchema = Schema.Struct({ files: Schema.Record(Schema.String, FileSchema) })

export type Report = typeof ReportSchema.Type

export interface Scored {
  readonly covered: number
  readonly path: string
  /** `null` when the file produced no covered mutants at all — see `allowEmpty` in the script. */
  readonly score: number | null
}

/**
 * Stryker's own definition of the score: killed and timed-out over what was actually covered.
 *
 * `Ignored` and `NoCoverage` are excluded rather than counted as failures, so this number is the one
 * the text reporter prints — a gate that disagreed with the report beside it would be argued with
 * rather than fixed.
 */
export const score = (report: Report): readonly Scored[] =>
  Object.entries(report.files).map(([path, file]) => {
    const counts = new Map<string, number>()
    for (const mutant of file.mutants) {
      counts.set(mutant.status, (counts.get(mutant.status) ?? 0) + 1)
    }

    const killed = (counts.get('Killed') ?? 0) + (counts.get('Timeout') ?? 0)
    const covered = killed + (counts.get('Survived') ?? 0)

    return { covered, path, score: covered === 0 ? null : (killed / covered) * 100 }
  })

/**
 * The files that fail the gate.
 *
 * A file with no covered mutants is NOT one of them: `allowEmpty` exists so a module reachable only
 * through `cli.ts` or the e2e suite does not error the run, and `coverage:ci`'s 100% thresholds are
 * what catch a file no test reaches. Reported separately by the caller rather than hidden.
 */
export const belowFloor = (scored: readonly Scored[], floor: number): readonly Scored[] =>
  scored.filter((file): file is Scored & { readonly score: number } => file.score !== null && file.score < floor)

export const decodeReport = (document: string): Effect.Effect<Report> =>
  Effect.orDie(Schema.decodeUnknownEffect(Schema.fromJsonString(ReportSchema))(document))
