/**
 * Renders a verdict into what the process should actually emit.
 *
 * The exit codes are not arbitrary — they are the hook contract's own vocabulary, and getting them
 * wrong silently changes the behaviour. There are now two such vocabularies, one per agent runtime,
 * and which one is in force is DECLARED by the caller rather than inferred from the payload.
 *
 * Claude Code, the default:
 *
 * - exit 0 with JSON on stdout — the decision. This is how a block is expressed.
 * - exit 0 with nothing — no decision; the normal permission flow applies.
 * - exit 1 — a non-blocking error notice. The user sees it and the tool call proceeds.
 *
 * There a block is deliberately NOT exit 2. Exit 2 does block, but the runtime discards stdout and
 * reads stderr as the reason, which throws away the structured decision.
 *
 * Under Copilot exit 2 is the ONLY way to block, and there is no exit 1 at all — every other
 * non-zero exit denies the tool call as "hook errored", so a guard failure reported at exit 1 would
 * be a repository-wide outage rather than a notice. `Emitter` below is where the two price lists
 * sit side by side.
 */
import { Effect, FileSystem, Path, Schema } from 'effect'
import { applyScopeOverrides, loadConfigFile, loadDefaultConfig } from '../config/index.ts'
import { isRuleDocument, loadRules } from '../checking/index.ts'
import type { Frozen, FreezeOutcome } from '../freezing/index.ts'
import { containedPath } from '../freezing/index.ts'
import type { AgentId } from './decide.ts'
import { contractFor, decide, judgedTarget, judgesPayload } from './decide.ts'

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

/**
 * One runtime's price list: the four things falsestart can say, in that runtime's own vocabulary.
 *
 * An interface with two total implementations rather than a branch per call site. A fifth outcome
 * added later is then a type error in whichever emitter forgot it, which is the only structural
 * guarantee available that neither contract becomes the accident the other is patched around.
 */
interface Emitter {
  readonly advice: (note: string) => HookResponse
  readonly denial: (reason: string) => HookResponse
  readonly problem: (message: string) => HookResponse
  readonly silent: () => HookResponse
}

// `satisfies` rather than an annotation, for the reason `EMPTY_CONFIG` gives in `config.ts`.
const CLAUDE_CODE_EMITTER = {
  /**
   * Shown to the author without deciding anything: no `permissionDecision`, so the normal permission
   * flow still applies. A `warning` rule that produced no output at all would be a rule that does
   * nothing, which is the wrong way to express "worth knowing, not worth blocking".
   */
  advice: (note: string): HookResponse => ({
    exitCode: 0,
    stderr: undefined,
    stdout: JSON.stringify({ systemMessage: `falsestart:\n${note}` }),
  }),
  denial: (reason: string): HookResponse => ({
    exitCode: 0,
    stderr: undefined,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    }),
  }),
  /** A visible complaint that deliberately does not block. */
  problem: (message: string): HookResponse => ({
    exitCode: 1,
    stderr: `falsestart: ${message}`,
    stdout: undefined,
  }),
  silent: (): HookResponse => ({ exitCode: 0, stderr: undefined, stdout: undefined }),
} satisfies Emitter

/**
 * GitHub Copilot CLI reads a hook's answer from three places, and a deny is emitted to all three.
 *
 * Not hedging: each is documented, and no reading of the contract makes any of them harmful. exit 2
 * denies; stdout JSON at exit 2 "is merged with the deny decision", which is where the rule's
 * message can reach the model; stderr at exit 2 "is surfaced to the user", which is where it reaches
 * a human. The keys are TOP-LEVEL rather than under `hookSpecificOutput`, which Copilot ignores
 * (github/copilot-cli#2013) — the most likely reason falsestart's deny reads as an allow there.
 *
 * There is no exit 1 in this contract, and that is forced rather than chosen: every non-zero exit
 * other than 2 denies the tool call as "hook errored". Exit 1 on a guard failure would silently
 * convert `--fail open` into fail-closed with a reason nobody can act on.
 *
 * Whether stderr is readable at exit 0 is NOT documented — GitHub's exit-code table says nothing
 * about it — and every non-deny outcome below lands there. `docs/reference.md` says so to the
 * reader rather than implying a measurement nobody took.
 */
const COPILOT_EMITTER = {
  advice: (note: string): HookResponse => ({ exitCode: 0, stderr: `falsestart:\n${note}`, stdout: undefined }),
  denial: (reason: string): HookResponse => ({
    exitCode: 2,
    stderr: `falsestart: ${reason}`,
    stdout: JSON.stringify({ permissionDecision: 'deny', permissionDecisionReason: reason }),
  }),
  problem: (message: string): HookResponse => ({ exitCode: 0, stderr: `falsestart: ${message}`, stdout: undefined }),
  silent: (): HookResponse => ({ exitCode: 0, stderr: undefined, stdout: undefined }),
} satisfies Emitter

const emitterFor = (agent: AgentId | undefined): Emitter =>
  agent === 'copilot' ? COPILOT_EMITTER : CLAUDE_CODE_EMITTER

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
const guardFailure = (emit: Emitter, policy: FailurePolicy | undefined, reason: string): HookResponse =>
  policy === 'closed' ? emit.denial(unchecked(reason)) : emit.problem(reason)

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
const refuse = (emit: Emitter, frozen: boolean, policy: FailurePolicy | undefined, message: string): HookResponse =>
  frozen ? emit.denial(withEscape(message)) : guardFailure(emit, policy, message)

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
  readonly agent?: AgentId | undefined
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
  /**
   * Why the caller could not resolve a rules source at all, when it could not.
   *
   * `--rules pkg:<name>` naming a package that is not installed is discovered by `cli.ts` BEFORE
   * stdin is read, so it cannot be answered there: under `--fail closed` it would deny `Bash`,
   * `Read` and every other tool call an agent makes, over payloads that write nothing — measured,
   * and the exact thing `judgesPayload`'s docstring says must not happen. Handing it here puts it
   * behind `judgesPayload`, where every other guard failure already sits.
   *
   * When set, `rulesDirectory` is never read and `freeze` is never invoked.
   */
  readonly unresolvedRules?: string | undefined
  /** Report judged writes that land where no rule is scoped. See `DecideOptions`. */
  readonly warnUnscoped?: boolean | undefined
}

export const respond = (
  options: RespondOptions,
): Effect.Effect<HookResponse, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const { agent, configPath, input, projectDirectory, rulesDirectory, warnUnscoped } = options
    // Selected first, before the JSON parse: the answer to unparseable stdin runs on every tool
    // call, and an exit 1 there denies every one of them under Copilot.
    const contract = contractFor(agent)
    const emit = emitterFor(agent)
    // The payload arrives from another process, so a malformed one is an ordinary outcome rather
    // than an exception to catch. `UnknownFromJsonString` keeps it in the error channel and hands
    // back `unknown`, which is what it is until `judgesPayload` has looked at it.
    const parsed = yield* Effect.result(Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(input))

    if (parsed._tag === 'Failure') {
      return emit.problem(`could not read the hook payload as JSON (${parsed.failure})`)
    }

    if (!judgesPayload(parsed.success, agent)) {
      return emit.silent()
    }

    const target = judgedTarget(parsed.success, contract)

    // Answered here and nowhere earlier. Everything above this line runs on every tool call; a
    // rules source that could not be resolved is still a guard failure, but it is not a reason to
    // say anything about a `Bash` call. Ahead of `options.freeze()` too: a run that cannot load a
    // rule set has no use for four git spawns.
    if (options.unresolvedRules !== undefined) {
      return guardFailure(emit, options.failure, options.unresolvedRules)
    }

    // Invoked here and nowhere earlier: everything above this line runs on every tool call.
    const outcome = options.freeze === undefined ? undefined : yield* options.freeze()

    // A source that was established as freezable and then could not be read is refused before any
    // content is looked at. Falling back to the working tree here would make breaking git the
    // cheapest disarm available, which is the whole reason this exists.
    const [refused] = frozenFailures(outcome)
    if (refused !== undefined) {
      return emit.denial(withEscape(refused))
    }

    const frozenRules = documentsOf(outcome?.rules)
    const frozenConfig = documentsOf(outcome?.config)
    // A failure on EITHER frozen source has to deny, and the overrides step reads both.
    const eitherFrozen = [frozenRules, frozenConfig].some((documents) => documents !== undefined)

    const loaded = yield* Effect.result(loadRules(rulesDirectory, frozenRules))
    if (loaded._tag === 'Failure') {
      return refuse(
        emit,
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
      return refuse(emit, frozenConfig !== undefined, options.failure, configured.failure.reasons.join('\n'))
    }

    const scoped = yield* Effect.result(applyScopeOverrides(loaded.success, configured.success))
    if (scoped._tag === 'Failure') {
      // No path prefix: overrides only exist when a config file supplied them, so a `configPath ??`
      // fallback here would be a branch no input can reach. The reasons name the rule themselves.
      return refuse(emit, eitherFrozen, options.failure, scoped.failure.reasons.join('\n'))
    }

    const decision = yield* decide(scoped.success, parsed.success, { agent, warnUnscoped })

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
        return emit.advice(join(decision.note, note))
      }
      case 'Deny': {
        // The decision wins and the explanation still arrives: a rule document whose own content
        // breaks a rule is both things at once.
        return emit.denial(join(decision.reason, note))
      }
      case 'Report': {
        // A malformed payload is never the REASON to deny, in any policy: it is the agent runtime's
        // shape, not this repository's, so there is nothing here to fix and an agent told "denied"
        // would rewrite code that was never judged. See docs/architecture.md, "Six failures that
        // must not be confused".
        //
        // The reason, not the outcome. Every guard failure above this line is answered first, so a
        // broken rule tree denies whatever payload arrives — naming the tree, which IS fixable, and
        // never the payload. Answering `Malformed` earlier would repair the wording at the cost of
        // the freeze: a committed tree that will not load would go back to exit 1 on that payload.
        //
        // The discriminator is STRUCTURAL and never the text of the problem: `decide` can only reach
        // `Report` from a malformed target, a misdeclared one, or a rule that could not run, and
        // `judgedTarget` has already said which.
        //
        // A misdeclared `--agent` goes out on the channel of the runtime that ACTUALLY sent the
        // payload, not the one the flag named. Membership of the tool name in a declared table is
        // stronger evidence about who is on the other end than the flag is, and the notice is worth
        // nothing on a channel that runtime does not read — which is exactly what "declared copilot,
        // ran under Claude Code" would otherwise be: exit 0, no output, unguarded indefinitely.
        if (target._tag === 'Misdeclared') {
          return emitterFor(target.runtime).problem(decision.problem)
        }
        return target._tag === 'Malformed'
          ? emit.problem(decision.problem)
          : guardFailure(emit, options.failure, decision.problem)
      }
      default: {
        return note === undefined ? emit.silent() : emit.advice(note)
      }
    }
  })
