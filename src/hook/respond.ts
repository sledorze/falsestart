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
import { Effect } from 'effect'
import type { FileSystem, Path } from 'effect'
import { loadRules } from '../core/loader.ts'
import { decide, judgesPayload } from './decide.ts'

export interface HookResponse {
  readonly exitCode: number
  readonly stderr: string | undefined
  readonly stdout: string | undefined
}

const SILENT: HookResponse = { exitCode: 0, stderr: undefined, stdout: undefined }

/** A visible complaint that deliberately does not block. */
const problem = (message: string): HookResponse => ({
  exitCode: 1,
  stderr: `falsestart: ${message}`,
  stdout: undefined,
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
export const respond = (
  rulesDirectory: string,
  input: string,
): Effect.Effect<HookResponse, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.result(
      Effect.try({
        catch: String,
        try: () => JSON.parse(input) as unknown,
      }),
    )

    if (parsed._tag === 'Failure') {
      return problem(`could not read the hook payload as JSON (${parsed.failure})`)
    }

    if (!judgesPayload(parsed.success)) {
      return SILENT
    }

    const loaded = yield* Effect.result(loadRules(rulesDirectory))
    if (loaded._tag === 'Failure') {
      return problem(`could not load rules from ${rulesDirectory}\n${loaded.failure.reasons.join('\n')}`)
    }

    const decision = yield* decide(loaded.success, parsed.success)

    switch (decision._tag) {
      case 'Deny': {
        return denial(decision.reason)
      }
      case 'Report': {
        return problem(decision.problem)
      }
      default: {
        return SILENT
      }
    }
  })
