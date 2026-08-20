/**
 * The CI workflow, read as data rather than as text.
 *
 * Separated because "what does `ci.yml` declare" is a different question from "is that the right
 * thing to declare", and only the second belongs in a guard. Parsing once, into types, is also what
 * stops an assertion from being written as a substring search over YAML — which passes for a step
 * that is commented out, and for a job whose `if:` never fires.
 *
 * DECODED rather than cast. The same shape lived in a test file as a `parse(...) as { jobs: … }`,
 * where this project's `no-type-assertion` rule does not reach; moving it here made falsestart
 * refuse the file, which is the rule working on its own codebase.
 *
 * MODELLED ON GITHUB'S SCHEMA, not on this repository's workflow — a distinction the first version
 * got wrong, and expensively, because the decode fails by `orDie`. A reusable-workflow job (`uses:`
 * and no `steps:`), an unquoted numeric `env` value, and `continue-on-error: ${{ … }}` are all valid
 * Actions, and each collapsed three guard suites with `SchemaError: Missing key` and nothing naming
 * the workflow. The optionality below is not defensive; it is what the file format says.
 */
import { Effect, FileSystem, Schema } from 'effect'
import { parse } from 'yaml'

const WORKFLOW = `${process.cwd()}/.github/workflows/ci.yml`

/**
 * YAML gives `CI: true` as a boolean and `RETRIES: 1` as a number, and Actions accepts both.
 *
 * Kept as the union rather than coerced to string. Coercing would be convenient — every caller
 * compares these as strings — but a silent `String(value)` is what this project's own
 * `no-raw-coercion` rule refuses, and it would turn "someone unquoted a value in the workflow" into
 * an assertion that quietly keeps passing. The union makes that edit visible at the call site.
 */
const EnvValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean])

const Environment = Schema.Record(Schema.String, EnvValue)

/** A literal here, an expression (`${{ … }}`) in a great many workflows on GitHub. */
const Flag = Schema.Union([Schema.Boolean, Schema.String])

const StepSchema = Schema.Struct({
  'continue-on-error': Schema.optional(Flag),
  env: Schema.optional(Environment),
  if: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
  uses: Schema.optional(Schema.String),
  with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

const JobSchema = Schema.Struct({
  'continue-on-error': Schema.optional(Flag),
  env: Schema.optional(Environment),
  if: Schema.optional(Schema.String),
  // Absent on a job that calls a reusable workflow: it has `uses:` and nothing to step through.
  steps: Schema.optional(Schema.Array(StepSchema)),
  uses: Schema.optional(Schema.String),
})

const WorkflowSchema = Schema.Struct({
  jobs: Schema.Record(Schema.String, JobSchema),
})

export type Step = typeof StepSchema.Type
export type Job = typeof JobSchema.Type

/**
 * Decode a workflow document into its steps, each paired with the job carrying it.
 *
 * Takes the TEXT rather than reading the file, so the decoder can be exercised against workflows
 * this repository does not contain. Not a convenience: every shape it used to reject was one no
 * assertion here could reach while the only input was our own `ci.yml`.
 *
 * `orDie` on a decode failure: a file that does not parse as a workflow is a broken repository, not
 * a case under test, and every caller would otherwise carry an error channel it cannot handle.
 */
export const parseWorkflow = (
  document: string,
): Effect.Effect<readonly { readonly job: Job & { readonly name: string }; readonly step: Step }[]> =>
  Effect.gen(function* () {
    const parsed: unknown = parse(document)
    const workflow = yield* Effect.orDie(Schema.decodeUnknownEffect(WorkflowSchema)(parsed))

    return Object.entries(workflow.jobs).flatMap(([name, job]) =>
      (job.steps ?? []).map((step) => ({ job: { ...job, name }, step })),
    )
  })

/**
 * Every step in this repository's own workflow, paired with the job carrying it.
 *
 * Flattened deliberately: a guard asks "is this command run, and under what conditions", and the
 * condition can sit on the step or on the job. Handing back both lets an assertion read whichever
 * the file happens to use, instead of pinning one spelling and failing a refactor that changed
 * nothing.
 */
export const workflowSteps = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem

  return yield* parseWorkflow(yield* fs.readFileString(WORKFLOW))
})
