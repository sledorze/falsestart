/**
 * Turns one agent tool-call into a verdict.
 *
 * The three outcomes map onto what a PreToolUse hook is actually able to say, and the distinction
 * between them is the whole policy:
 *
 * - `Deny` — the code being written breaks a rule. This is the only outcome that stops anything.
 * - `Defer` — nothing to say; the normal permission flow applies.
 * - `Report` — the guard could not do its job. Surfaced to the user, but the write proceeds.
 *
 * `Report` is the interesting one. The engine deliberately refuses to treat a rule it could not
 * run as "found nothing", but that is about never SILENTLY under-reporting — it does not follow
 * that a typo in a rule file should hold every write in the repo hostage. Reporting keeps the
 * failure loud, which was the actual point, without turning a misconfiguration into an outage.
 *
 * Only `error`-severity findings deny. Anything softer is advice, and advice that blocks is
 * indistinguishable from an error.
 */
import { Effect } from 'effect'
import type { Finding } from '../core/engine.ts'
import { checkFile } from '../core/engine.ts'
import type { Rule } from '../core/rule.ts'

export type Decision =
  | { readonly _tag: 'Defer' }
  | { readonly _tag: 'Deny'; readonly findings: readonly Finding[]; readonly reason: string }
  | { readonly _tag: 'Report'; readonly problem: string }

const DEFER: Decision = { _tag: 'Defer' }

/**
 * The tools that introduce source text, and where each keeps it.
 *
 * `Edit` is judged by `new_string` — the text it would introduce — rather than by the whole
 * resulting file, which the hook never sees. That means an edit is checked for what it ADDS; it
 * cannot be checked for what it leaves behind elsewhere in the file.
 */
const CONTENT_FIELD: Readonly<Record<string, string>> = {
  Edit: 'new_string',
  Write: 'content',
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const describe = (finding: Finding): string =>
  `${finding.ruleId} (${finding.line}:${finding.column}): ${finding.message}`

/**
 * Judges the tool call described by `payload`.
 *
 * Never fails: every way this can go wrong is itself one of the three outcomes, because a guard
 * that throws inside a hook is a guard whose behaviour the agent runtime decides, not this code.
 */
export const decide = (rules: readonly Rule[], payload: unknown): Effect.Effect<Decision> =>
  Effect.gen(function* () {
    if (!isRecord(payload)) {
      return { _tag: 'Report', problem: 'hook payload was not an object' } as const
    }

    const { tool_input: toolInput, tool_name: toolName } = payload
    if (typeof toolName !== 'string') {
      return { _tag: 'Report', problem: 'hook payload carried no tool_name' } as const
    }

    const field = CONTENT_FIELD[toolName]
    if (field === undefined) {
      // Not a tool that writes source. Nothing this tool knows how to judge.
      return DEFER
    }

    if (!isRecord(toolInput)) {
      return { _tag: 'Report', problem: `${toolName} carried no tool_input` } as const
    }

    const content = toolInput[field]
    const path = toolInput['file_path']
    if (typeof content !== 'string' || typeof path !== 'string') {
      return { _tag: 'Report', problem: `${toolName} carried no ${field}/file_path to judge` } as const
    }

    const outcome = yield* Effect.result(checkFile(rules, { content, path }))
    if (outcome._tag === 'Failure') {
      return {
        _tag: 'Report',
        problem: `rule ${outcome.failure.ruleId} could not run: ${outcome.failure.reason}`,
      } as const
    }

    const blocking = outcome.success.filter((finding) => finding.severity === 'error')
    if (blocking.length === 0) {
      return DEFER
    }

    return {
      _tag: 'Deny',
      findings: blocking,
      reason: blocking.map((finding) => describe(finding)).join('\n'),
    } as const
  })
