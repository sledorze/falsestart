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
import { toScopingPath } from '../core/scope.ts'
import type { Rule } from '../core/rule.ts'

export type Decision =
  | { readonly _tag: 'Defer' }
  | { readonly _tag: 'Deny'; readonly findings: readonly Finding[]; readonly reason: string }
  | { readonly _tag: 'Report'; readonly problem: string }

const DEFER: Decision = { _tag: 'Defer' }

/**
 * The tools that introduce source text, and where each keeps its content and its path.
 *
 * The path key is per-tool rather than assumed: `NotebookEdit` calls it `notebook_path`, and
 * reading `file_path` there would leave the rule effectively unscoped instead of correctly scoped
 * — a rule would then run against a file its globs never admitted.
 *
 * `Edit`/`NotebookEdit` are judged by the text they would introduce, rather than by the whole
 * resulting file, which the hook never sees. An edit is therefore checked for what it ADDS; it
 * cannot be checked for what it leaves behind elsewhere in the file.
 */
const WRITE_TOOLS: Readonly<Record<string, { readonly content: string; readonly path: string }>> = {
  Edit: { content: 'new_string', path: 'file_path' },
  NotebookEdit: { content: 'new_source', path: 'notebook_path' },
  Write: { content: 'content', path: 'file_path' },
}

/**
 * The payload is validated by hand rather than with `Schema`, unlike rule documents.
 *
 * The shapes differ in what a good error has to say. A rule document is authored by a person who
 * needs to know which field of which file is wrong, which is exactly what `Schema` reports. A hook
 * payload is machine-generated, and the useful message names the TOOL and the field that tool was
 * expected to carry (`NotebookEdit carried no new_source/notebook_path`) — per-tool knowledge that
 * lives here, not in a schema. Validating against a union of tool shapes would report a union
 * mismatch, which is strictly less informative.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Whether this payload is even a candidate for judgement.
 *
 * Cheap and deliberately separate from `decide`, because the hook fires on EVERY tool call. A
 * caller can skip loading a rule tree entirely for the `Bash`/`Read`/`Grep` calls that make up
 * most of an agent's traffic — which keeps the guard off the hot path, and keeps a broken rule
 * tree from raising errors on tool calls it was never going to have an opinion about.
 *
 * A malformed payload counts as a candidate: deciding it is a problem is `decide`'s job, and
 * skipping it here would silently swallow exactly the case worth reporting.
 */
export const judgesPayload = (payload: unknown): boolean =>
  !isRecord(payload) || typeof payload['tool_name'] !== 'string' || payload['tool_name'] in WRITE_TOOLS

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

    const fields = WRITE_TOOLS[toolName]
    if (fields === undefined) {
      // Not a tool that writes source. Nothing this tool knows how to judge.
      return DEFER
    }

    if (!isRecord(toolInput)) {
      return { _tag: 'Report', problem: `${toolName} carried no tool_input` } as const
    }

    const content = toolInput[fields.content]
    const path = toolInput[fields.path]
    if (typeof content !== 'string' || typeof path !== 'string') {
      return {
        _tag: 'Report',
        problem: `${toolName} carried no ${fields.content}/${fields.path} to judge`,
      } as const
    }

    // The payload reports an absolute path; rules are written relative to the project. Scoping on
    // the raw absolute path makes every repo-relative glob silently never match.
    const cwd = payload['cwd']
    const scopingPath = toScopingPath(path, typeof cwd === 'string' ? cwd : undefined)

    const outcome = yield* Effect.result(checkFile(rules, { content, path: scopingPath }))
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
