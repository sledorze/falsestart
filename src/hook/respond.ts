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
import { Effect, FileSystem, Path, Schema } from 'effect'
import { applyScopeOverrides, loadConfigFile, loadDefaultConfig } from '../config/index.ts'
import { isRuleDocument, loadRules } from '../checking/index.ts'
import type { Frozen, FreezeOutcome } from '../freezing/index.ts'
import { containedPath } from '../freezing/index.ts'
import { decide, judgedTarget, judgesPayload } from './decide.ts'

/**
 * What a failure of the GUARD costs, as opposed to a finding about the code.
 *
 * `open` is the 0.2.0 behaviour and the default: report on stderr, exit 1, let the write through.
 * `closed` denies instead, for a repository where an edit that cannot be verified must not land.
 *
 * A policy over `Report`, deliberately, and not a fifth `Decision`: what a guard failure COSTS is a
 * fact about the invocation, not about the code, so it belongs where the protocol's price list
 * already lives. A fifth outcome would have moved policy into judgement, and `--doctor` would then
 * have had to un-pick it again to keep reporting a failed sample as unhealthy.
 */
export const FAILURE_POLICIES = ['closed', 'open'] as const
export type FailurePolicy = (typeof FAILURE_POLICIES)[number]

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
const FREEZE_ESCAPE = 're-run the hook with --freeze off to use the working tree'

const withEscape = (reason: string): string => `${reason}\n${FREEZE_ESCAPE}`

/**
 * Said first, and said in the agent's own terms, because whoever reads a deny reason is about to
 * start editing. Nothing about the code was judged, so an agent that treats this like a finding will
 * rewrite correct code to appease a rule that never ran.
 */
const UNCHECKED_LEAD =
  'falsestart could not check this write, and --fail closed denies a write it could not check. ' +
  'Nothing about the code was judged, so do not change it to satisfy this. What failed:'

/**
 * The remedy that works, first — and the trap named, because the obvious remedy is not available.
 *
 * `respond` returns before `decide` on every load-time failure, so while `--fail closed` is on and
 * the rule tree is broken, EVERY judged write denies, including the edit that would repair the rule
 * document. "Fix the problem above" is advice the reader cannot take through the tool they are
 * reading it in. The freeze's own escape does not have this shape — `--freeze off` makes a
 * working-tree repair take effect immediately — so the wording is deliberately not copied from it.
 */
const UNCHECKED_ESCAPE =
  're-run the hook with --fail open to allow writes falsestart cannot check. ' +
  'Repairing the problem above needs that too: while --fail closed is on and the guard is broken, ' +
  'every judged write is denied, including the one that would fix it.'

const unchecked = (reason: string): string => `${UNCHECKED_LEAD}\n${reason}\n${UNCHECKED_ESCAPE}`

/**
 * What a guard failure emits under the policy in force.
 *
 * `undefined` is a real state at this boundary and means the default: `RespondOptions.failure` is
 * optional, so a library caller that predates this flag never names one. Defaulting HERE rather than
 * at each call site is what keeps the default in exactly one place — `??` scattered across three
 * modules is three chances to disagree about it, and one of them is `cli.ts`, which nothing covers.
 */
const guardFailure = (policy: FailurePolicy | undefined, reason: string): HookResponse =>
  policy === 'closed' ? denial(unchecked(reason)) : problem(reason)

/** Both, when there are both. The freeze note never replaces what a rule had to say. */
const join = (text: string, extra: string | undefined): string => (extra === undefined ? text : `${text}\n${extra}`)

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
 *
 * `frozen` is asked FIRST, and where it wins the message keeps exactly the text it always had. The
 * two switches decide different things — the freeze decides which bytes are authoritative, `--fail`
 * decides what a guard failure costs — and where the freeze already denies, `--freeze off` is the
 * remedy that works and `--fail open` is not. A denial naming both would send the reader down the
 * one that cannot help, so the disjunction resolves by precedence rather than growing a "both" arm.
 */
const refuse = (frozen: boolean, policy: FailurePolicy | undefined, message: string): HookResponse =>
  frozen ? denial(withEscape(message)) : guardFailure(policy, message)

/**
 * Why a rule an author just edited did not change anything, said at the moment the confusion happens.
 *
 * Default-on freezing has one real cost, and this is it: a rule author edits a rule and nothing
 * happens. A diagnostic nobody runs mid-iteration does not answer that, so the answer is attached to
 * the write itself.
 *
 * Scoped by two STRUCTURAL tests and never by content: segment containment of the destination
 * directory inside the rules directory, and `isRuleDocument` on the name. Both matter. `startsWith`
 * would claim a sibling `rulesx/`, and containment alone would tell the author of `<rules>/.git` —
 * the payload of the one attack this design is built around — that their write "does not take effect
 * until it is committed", when it took effect the instant it landed.
 *
 * It does NOT cover an author who WIDENS a rule and expects a new block somewhere else; that write
 * stays silent, and only `--doctor` answers it. Reporting divergence on every judged write was
 * considered and rejected for the reason `decide.ts` gives about `--warn-unscoped`: a signal that
 * fires on most writes gets trained away, and a trained-away signal is worse than none because it
 * still looks like coverage.
 */
const frozenRuleNote = (options: {
  readonly ref: string
  readonly rulesDirectory: string
  readonly written: string | undefined
}): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const { ref, rulesDirectory, written } = options

    if (written === undefined) {
      return undefined
    }

    const real = (candidate: string) => fs.realPath(candidate).pipe(Effect.orElseSucceed(() => undefined))

    // Both sides are resolved, so a symlinked rules directory is judged by where it really is. The
    // destination's DIRECTORY, because the document being written need not exist yet — and neither
    // need the rules directory, which under a freeze may have been deleted entirely.
    const rulesReal = yield* real(rulesDirectory)
    if (rulesReal === undefined) {
      return undefined
    }
    const destination = yield* real(path.dirname(written))
    if (destination === undefined) {
      return undefined
    }

    const relative = containedPath(rulesReal, destination)
    if (relative === undefined) {
      return undefined
    }

    return isRuleDocument(path.join(relative, path.basename(written)))
      ? `rules are read from ${ref}, so this document does not take effect until it is committed.\n` +
          '`falsestart --doctor` lists what is not in effect; `--freeze off` reads the working tree.'
      : undefined
  })

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
  readonly freeze?: (() => Effect.Effect<FreezeOutcome, never, FileSystem.FileSystem | Path.Path>) | undefined
  /**
   * What a failure of the guard itself costs. Absent means `open`, the 0.2.0 behaviour, so a library
   * call that predates this is unchanged. Never a `Broken` freeze, which denies in every policy.
   */
  readonly failure?: FailurePolicy | undefined
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
    const outcome = options.freeze === undefined ? undefined : yield* options.freeze()

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
        options.failure,
        `could not load rules from ${rulesDirectory}\n${loaded.failure.reasons.join('\n')}`,
      )
    }

    // An explicit --config must exist; without one, the default names are looked for in
    // `projectDirectory` — never beside the rules, which `--preset` and `pkg:` both put inside
    // node_modules — and their absence simply means no overrides.
    const namedConfig = configPath === undefined ? undefined : frozenConfig?.get(path.basename(configPath))
    const configured = yield* Effect.result(
      configPath === undefined
        ? loadDefaultConfig(projectDirectory, frozenConfig)
        : loadConfigFile(configPath, namedConfig),
    )

    if (configured._tag === 'Failure') {
      return refuse(frozenConfig !== undefined, options.failure, configured.failure.reasons.join('\n'))
    }

    const scoped = yield* Effect.result(applyScopeOverrides(loaded.success, configured.success))
    if (scoped._tag === 'Failure') {
      // No path prefix: overrides only exist when a config file supplied them, so a `configPath ??`
      // fallback here would be a branch no input can reach. The reasons name the rule themselves.
      return refuse(eitherFrozen, options.failure, scoped.failure.reasons.join('\n'))
    }

    const decision = yield* decide(scoped.success, parsed.success, { warnUnscoped })

    const target = judgedTarget(parsed.success)
    const note =
      outcome?.rules._tag === 'Frozen'
        ? yield* frozenRuleNote({
            ref: outcome.rules.ref,
            rulesDirectory,
            written: target._tag === 'Write' ? target.path : undefined,
          })
        : undefined

    switch (decision._tag) {
      case 'Advise': {
        return advice(join(decision.note, note))
      }
      case 'Deny': {
        // The decision wins and the explanation still arrives: a rule document whose own content
        // breaks a rule is both things at once.
        return denial(join(decision.reason, note))
      }
      case 'Report': {
        return problem(decision.problem)
      }
      default: {
        return note === undefined ? silent() : advice(note)
      }
    }
  })
