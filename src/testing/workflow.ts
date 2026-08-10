/**
 * The CI workflow, read as data rather than as text.
 *
 * Separated because "what does `ci.yml` declare" is a different question from "is that the right
 * thing to declare", and only the second belongs in a guard. Parsing once, into types, is also what
 * stops an assertion from being written as a substring search over YAML — which passes for a step
 * that is commented out, and for a job whose `if:` never fires.
 *
 * DECODED rather than cast. The same shape lived in a test file as a `parse(...) as { jobs: … }`,
 * where the repo's own `no-type-assertion` rule does not reach; moving it here made falsestart
 * refuse the file, which is the rule doing its job on its own codebase. A cast would have kept a
 * malformed workflow looking well-formed right up to the property access.
 *
 * Every field is optional because it is optional in the schema. Modelling `if` or
 * `continue-on-error` as required would make the type lie about the file, and the guards assert on
 * their ABSENCE as much as on their value.
 */
import { Effect, FileSystem, Schema } from 'effect'
import { parse } from 'yaml'

const WORKFLOW = `${process.cwd()}/.github/workflows/ci.yml`

const StepSchema = Schema.Struct({
  'continue-on-error': Schema.optional(Schema.Boolean),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  if: Schema.optional(Schema.String),
  run: Schema.optional(Schema.String),
  uses: Schema.optional(Schema.String),
  with: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})

const JobSchema = Schema.Struct({
  'continue-on-error': Schema.optional(Schema.Boolean),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  if: Schema.optional(Schema.String),
  steps: Schema.Array(StepSchema),
})

const WorkflowSchema = Schema.Struct({
  jobs: Schema.Record(Schema.String, JobSchema),
})

export type Step = typeof StepSchema.Type
export type Job = typeof JobSchema.Type

/**
 * Every step in the workflow, paired with the job carrying it.
 *
 * Flattened deliberately: a guard asks "is this command run, and under what conditions", and the
 * condition can sit on the step or on the job. Handing back both lets an assertion read whichever
 * the file happens to use, instead of pinning one spelling and failing a refactor that changed
 * nothing.
 *
 * `orDie` on a decode failure: a `ci.yml` this cannot parse is a broken repository, not a case under
 * test, and every caller would otherwise carry an error channel it has no way to handle.
 */
export const workflowSteps = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const parsed: unknown = parse(yield* fs.readFileString(WORKFLOW))
  const document = yield* Effect.orDie(Schema.decodeUnknownEffect(WorkflowSchema)(parsed))

  return Object.entries(document.jobs).flatMap(([name, job]) =>
    job.steps.map((step) => ({ job: { ...job, name }, step })),
  )
})
