/**
 * Renders a verdict into what the process should actually emit.
 *
 * The exit codes are not arbitrary — they are the hook contract's own vocabulary, and getting them
 * wrong silently changes the behaviour:
 *
 * - exit 0 with JSON on stdout — the decision. This is how a block is expressed.
 * - exit 0 with nothing — no decision; the normal permission flow applies.
 * - exit 1 — a non-blocking error notice. The user sees it and the tool call proceeds.
 *
 * Notably a block is NOT exit 2. Exit 2 does block, but the runtime discards stdout and reads
 * stderr as the reason, which throws away the structured decision.
 */
import { Effect, Path, Schema } from 'effect'
import type { FileSystem } from 'effect'
import { applyScopeOverrides, loadConfigFile, loadDefaultConfig } from '../config/index.ts'
import { loadRules } from '../checking/index.ts'
import type { Frozen, FreezeOutcome } from '../freezing/index.ts'
import { decide, judgesPayload } from './decide.ts'

export interface HookResponse {
  readonly exitCode: number
  readonly stderr: string | undefined
  readonly stdout: string | undefined
}

const silent = (): HookResponse => ({ exitCode: 0, stderr: undefined, stdout: undefined })

/** A visible complaint that deliberately does not block. */
const problem = (message: string): HookResponse => ({
  exitCode: 1,
  stderr: `falsestart: ${message}`,
  stdout: undefined,
})

/**
 * Shown to the author without deciding anything: no `permissionDecision`, so the normal permission
 * flow still applies. A `warning` rule that produced no output at all would be a rule that does
 * nothing, which is the wrong way to express "worth knowing, not worth blocking".
 */
const advice = (note: string): HookResponse => ({
  exitCode: 0,
  stderr: undefined,
  stdout: JSON.stringify({ systemMessage: `falsestart:\n${note}` }),
})

const denial = (reason: string): HookResponse => ({
  exitCode: 0,
  stderr: undefined,
  stdout: JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }),
})

/**
 * How to get the previous behaviour back, carried on every refusal.
 *
 * The reason a refusal names its own escape hatch is that the alternative is what falsestart does
 * today: a line on a stderr the agent runtime discards, and the write proceeding.
 */
const FREEZE_ESCAPE = 're-run the hook with --freeze=off to use the working tree'

const withEscape = (reason: string): string => `${reason}\n${FREEZE_ESCAPE}`

/** The reasons a source that git established as freezable could not be read. */
const frozenFailures = (outcome: FreezeOutcome | undefined): readonly string[] =>
  outcome === undefined
    ? []
    : [outcome.rules, outcome.config].flatMap((source) => (source._tag === 'Broken' ? [source.reason] : []))

const documentsOf = (source: Frozen | undefined): ReadonlyMap<string, string> | undefined =>
  source?._tag === 'Frozen' ? source.documents : undefined

/**
 * A frozen source that will not load denies rather than reporting.
 *
 * That is a deliberate amendment to "a broken guard must not become an outage", not a contradiction
 * of it. Under a freeze a WORKING-TREE typo never reaches the loader at all, so the case the old
 * policy protected is strictly better off. What denies is a COMMITTED rule set that does not load —
 * a repository-wide problem a commit introduced, and the thing `scan` in CI already fails closed on.
 */
const refuse = (frozen: boolean, message: string): HookResponse =>
  frozen ? denial(withEscape(message)) : problem(message)

/**
 * Decides what to emit for one hook invocation.
 *
 * Rules are loaded only once the payload is known to be judgeable, so the common case — a tool
 * call that writes no source — costs a JSON parse and nothing more.
 */
export interface RespondOptions {
  /** Path to a config file. Absent means look for the default names in `projectDirectory`. */
  readonly configPath?: string | undefined
  /** The raw hook payload. */
  readonly input: string
  /**
   * Where an unnamed config is looked for.
   *
   * The PROJECT, never the rules directory. With `--preset` the rules live inside
   * `node_modules`, and looking beside them there meant a repo's own config was silently
   * ignored — the rule then applied as though no config existed, which is precisely the quiet
   * wrong answer this tool exists to prevent.
   */
  readonly projectDirectory: string
  readonly rulesDirectory: string
  /**
   * What a git ref committed, resolved on demand.
   *
   * A THUNK rather than a value, and that is a cost decision. The freeze spawns four git processes;
   * building it before `judgesPayload` has looked at the payload would move that cost onto every
   * tool call an agent makes, and most tool calls write nothing. Invoked once, only on the judged
   * path.
   *
   * Absent means unfrozen — the 0.2.0 behaviour — so a library call that predates this is unchanged.
   */
  readonly freeze?: (() => FreezeOutcome) | undefined
  /** Report judged writes that land where no rule is scoped. See `DecideOptions`. */
  readonly warnUnscoped?: boolean | undefined
}

export const respond = (
  options: RespondOptions,
): Effect.Effect<HookResponse, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const { configPath, input, projectDirectory, rulesDirectory, warnUnscoped } = options
    // The payload arrives from another process, so a malformed one is an ordinary outcome rather
    // than an exception to catch. `UnknownFromJsonString` keeps it in the error channel and hands
    // back `unknown`, which is what it is until `judgesPayload` has looked at it.
    const parsed = yield* Effect.result(Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(input))

    if (parsed._tag === 'Failure') {
      return problem(`could not read the hook payload as JSON (${parsed.failure})`)
    }

    if (!judgesPayload(parsed.success)) {
      return silent()
    }

    // Invoked here and nowhere earlier: everything above this line runs on every tool call.
    const outcome = options.freeze?.()

    // A source that was established as freezable and then could not be read is refused before any
    // content is looked at. Falling back to the working tree here would make breaking git the
    // cheapest disarm available, which is the whole reason this exists.
    const [refused] = frozenFailures(outcome)
    if (refused !== undefined) {
      return denial(withEscape(refused))
    }

    const frozenRules = documentsOf(outcome?.rules)
    const frozenConfig = documentsOf(outcome?.config)
    // A failure on EITHER frozen source has to deny, and the overrides step reads both.
    const eitherFrozen = [frozenRules, frozenConfig].some((documents) => documents !== undefined)

    const loaded = yield* Effect.result(loadRules(rulesDirectory, frozenRules))
    if (loaded._tag === 'Failure') {
      return refuse(
        frozenRules !== undefined,
        `could not load rules from ${rulesDirectory}\n${loaded.failure.reasons.join('\n')}`,
      )
    }

    // An explicit --config must exist; without one, the default names are looked for in
    // `projectDirectory` — never beside the rules, which `--preset` and `pkg:` both put inside
    // node_modules — and their absence simply means no overrides.
    const configured = yield* Effect.result(
      configPath === undefined
        ? loadDefaultConfig(projectDirectory, frozenConfig)
        : loadConfigFile(configPath, frozenConfig?.get(path.basename(configPath))),
    )

    if (configured._tag === 'Failure') {
      return refuse(frozenConfig !== undefined, configured.failure.reasons.join('\n'))
    }

    const scoped = yield* Effect.result(applyScopeOverrides(loaded.success, configured.success))
    if (scoped._tag === 'Failure') {
      // No path prefix: overrides only exist when a config file supplied them, so a `configPath ??`
      // fallback here would be a branch no input can reach. The reasons name the rule themselves.
      return refuse(eitherFrozen, scoped.failure.reasons.join('\n'))
    }

    const decision = yield* decide(scoped.success, parsed.success, { warnUnscoped })

    switch (decision._tag) {
      case 'Advise': {
        return advice(decision.note)
      }
      case 'Deny': {
        return denial(decision.reason)
      }
      case 'Report': {
        return problem(decision.problem)
      }
      default: {
        return silent()
      }
    }
  })
