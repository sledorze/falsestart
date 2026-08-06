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
import { Effect, Schema } from 'effect'
import type { FileSystem, Path } from 'effect'
import { applyScopeOverrides, loadConfigFile, loadDefaultConfig } from '../config/index.ts'
import { loadRules } from '../checking/index.ts'
import type { FreezeOutcome } from '../freezing/index.ts'
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
  /** Stub: slice 4's tests need the option to exist before anything consumes it. */
  readonly freeze?: (() => FreezeOutcome) | undefined
  /** Report judged writes that land where no rule is scoped. See `DecideOptions`. */
  readonly warnUnscoped?: boolean | undefined
}

export const respond = (
  options: RespondOptions,
): Effect.Effect<HookResponse, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
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

    const loaded = yield* Effect.result(loadRules(rulesDirectory))
    if (loaded._tag === 'Failure') {
      return problem(`could not load rules from ${rulesDirectory}\n${loaded.failure.reasons.join('\n')}`)
    }

    // An explicit --config must exist; without one, the default names are looked for in
    // `projectDirectory` — never beside the rules, which `--preset` and `pkg:` both put inside
    // node_modules — and their absence simply means no overrides.
    const configured = yield* Effect.result(
      configPath === undefined ? loadDefaultConfig(projectDirectory) : loadConfigFile(configPath),
    )

    if (configured._tag === 'Failure') {
      return problem(configured.failure.reasons.join('\n'))
    }

    const scoped = yield* Effect.result(applyScopeOverrides(loaded.success, configured.success))
    if (scoped._tag === 'Failure') {
      // No path prefix: overrides only exist when a config file supplied them, so a `configPath ??`
      // fallback here would be a branch no input can reach. The reasons name the rule themselves.
      return problem(scoped.failure.reasons.join('\n'))
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
