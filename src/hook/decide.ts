/**
 * Turns one agent tool-call into a verdict.
 *
 * The outcomes map onto what a PreToolUse hook is actually able to say, and the distinction
 * between them is the whole policy:
 *
 * - `Deny` — the code being written breaks a rule. This is the only outcome that stops anything.
 * - `Advise` — softer findings worth showing; the write proceeds.
 * - `Defer` — nothing to say; the normal permission flow applies.
 * - `Report` — the guard could not do its job. Surfaced to the user, but the write proceeds.
 *
 * `Report` is the interesting one. The engine deliberately refuses to treat a rule it could not
 * run as "found nothing", but that is about never SILENTLY under-reporting — it does not follow
 * that a typo in a rule file should hold every write in the repo hostage. Reporting keeps the
 * failure loud, which was the actual point, without turning a misconfiguration into an outage.
 *
 * That argument is about the DEFAULT, and it is narrower than it was when it was written. Under a
 * freeze a working-tree typo never reaches the loader at all, so what it now protects is mostly the
 * repository with nothing to freeze — where the typo really is somebody's work in progress. For a
 * repository where an edit that cannot be verified must not land, `--fail closed` turns this same
 * `Report` into a denial.
 *
 * `Report` keeps its meaning either way. Nothing here decides what a guard failure COSTS, because
 * that is a fact about the invocation rather than about the code, and `respond.ts` is where the
 * protocol's price list lives. A fifth outcome would have moved the policy into the judgement, and
 * `--doctor` would then have had to un-pick it again to keep calling a failed sample unhealthy.
 *
 * Only `error`-severity findings deny. Anything softer becomes `Advise`: still shown, but it does
 * not stop the write, because advice that blocks is indistinguishable from an error. Dropping it
 * entirely would be worse — a `warning` rule would then do nothing whatsoever.
 */
import { Effect } from 'effect'
import type { Finding, Rule } from '../checking/index.ts'
import { appliesTo, checkFile, toScopingPath } from '../checking/index.ts'

export type Decision =
  /** Findings that do not block, but that the author should still see. */
  | { readonly _tag: 'Advise'; readonly findings: readonly Finding[]; readonly note: string }
  | { readonly _tag: 'Defer' }
  | { readonly _tag: 'Deny'; readonly findings: readonly Finding[]; readonly reason: string }
  | { readonly _tag: 'Report'; readonly problem: string }

const defer = (): Decision => ({ _tag: 'Defer' })

export interface DecideOptions {
  /**
   * Say so when a judged write lands on a path no rule is scoped to.
   *
   * Off by default, and the default is the interesting part. The honest version of this signal is
   * noisy: measured against the shipped presets, it fires on every `.md`, `.json`, `.yml` and
   * `.js` write, and additionally on every test file under `clean-code`, whose four rules all
   * ignore them. Under `all` or `effect` test files stay quiet, because three Effect rules exist
   * specifically to judge them — so how noisy this is depends on the preset, and it is never
   * quiet in a repo that writes documentation.
   *
   * A warning that appears on most writes is one the reader learns to skip, and a signal that has
   * been trained away is worse than no signal, because it still looks like coverage. So this is a
   * flag to reach for while asking "why was that not blocked?", not something asserted
   * continuously.
   */
  readonly warnUnscoped?: boolean | undefined
}

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
/**
 * The tool calls falsestart judges, and where each one carries its path and its content.
 *
 * Exported so `docs/reference.md` can be checked against it rather than describing it from memory.
 * Anything absent here is allowed in silence — which is right, since most tool calls write nothing,
 * but it also means a write tool that is not listed is one falsestart does not guard and says
 * nothing about. Confirmed complete for Claude Code as of August 2026: `Write`, `Edit` and
 * `NotebookEdit` are the only built-in tools that carry file content. `MultiEdit` does not exist.
 */
export const WRITE_TOOLS: Readonly<Record<string, { readonly content: string; readonly path: string }>> = {
  Edit: { content: 'new_string', path: 'file_path' },
  NotebookEdit: { content: 'new_source', path: 'notebook_path' },
  Write: { content: 'content', path: 'file_path' },
}

/**
 * The agent runtimes falsestart speaks to. DECLARED on the command line, never sniffed.
 *
 * A payload tells you the shape that came in and says nothing whatsoever about how the runtime will
 * read the answer — and the answer is the half where a wrong guess turns a deny into an allow.
 * Copilot expresses a deny as exit 2; Claude Code as exit 0 with a document on stdout. Inferring
 * that from "the payload said `toolName`" would let any normalising shim in front of falsestart
 * decide which contract falsestart emits.
 */
export const AGENTS = ['claude-code', 'copilot'] as const
export type AgentId = (typeof AGENTS)[number]

/** One documented spelling of a runtime's payload envelope. */
export interface Envelope {
  /** The key carrying the tool's arguments. */
  readonly input: string
  /** The key naming the tool. */
  readonly name: string
}

export interface AgentContract {
  /**
   * Every documented spelling of this runtime's envelope, tried in order.
   *
   * Copilot has two, and which one arrives is chosen by the hook AUTHOR: a camelCase event name in
   * the hook config yields camelCase fields, a PascalCase one yields snake_case "to match the VS
   * Code Copilot extension format". Reading both is not sniffing the AGENT — the agent, and with it
   * the whole output contract, is declared. Only the spelling of one envelope is read, and the
   * runtime that sent it documents both as its own.
   */
  readonly envelopes: readonly Envelope[]
  /**
   * Whether this runtime may deliver its tool arguments as a JSON-ENCODED STRING rather than an
   * object. Copilot does (github/copilot-cli#3349). Claude Code does not, and must not be given the
   * benefit of the doubt: a `tool_input` that is a string is genuinely malformed there, and
   * reinterpreting it would accept a shape the contract does not have.
   */
  readonly encodedInput: boolean
  readonly id: AgentId
  /**
   * Prefixed onto every problem this contract reports. EMPTY for `claude-code`, so the default
   * path's diagnostics stay byte-identical; `copilot: ` elsewhere, because
   * `edit carried no new_str/path` is otherwise ambiguous between "Copilot renamed a field" and
   * "you set --agent wrong", which have opposite remedies. A field rather than a conditional, so
   * there is no branch to cover.
   */
  readonly problemPrefix: string
  /** Whether this contract's tool argument names are inferred rather than documented. */
  readonly provisionalTools: boolean
  /**
   * The tool `--doctor`'s sample is written as, with its field names carried DIRECTLY rather than
   * looked up in `tools`. A lookup would need a `?? …` arm no input can reach, and an unreachable
   * arm breaks the 100% branch threshold. A test asserts the two agree, so this cannot drift.
   */
  readonly sample: { readonly content: string; readonly path: string; readonly tool: string }
  readonly tools: Readonly<Record<string, { readonly content: string; readonly path: string }>>
}

// `satisfies` rather than a type annotation, for the reason `EMPTY_CONFIG` gives in
// `src/config/config.ts`: an annotated literal asserts a shape nothing checked.
export const CLAUDE_CODE_CONTRACT = {
  encodedInput: false,
  envelopes: [{ input: 'tool_input', name: 'tool_name' }],
  id: 'claude-code',
  problemPrefix: '',
  provisionalTools: false,
  sample: { content: 'content', path: 'file_path', tool: 'Write' },
  tools: WRITE_TOOLS,
} satisfies AgentContract

/**
 * GitHub Copilot CLI. `view`, `bash`, `grep`, `glob`, `task`, `powershell`, `web_fetch` and
 * `ask_user` introduce no source text and are absent for the reason `Bash` is.
 *
 * NEITHER tool's argument names are documented by GitHub — `docs/reference.md` and `--doctor` both
 * say so to the reader. `edit`'s `path` is corroborated by copilot-cli#3349; `new_str` and `content`
 * are inferences. If one is wrong that tool is unjudged: reported where the report is readable,
 * silent where it is not, and caught by `falsestart scan` either way. `edit`'s `old_str` is
 * deliberately unread — an edit is judged by the text it INTRODUCES.
 */
export const COPILOT_CONTRACT = {
  encodedInput: true,
  envelopes: [
    { input: 'toolArgs', name: 'toolName' },
    { input: 'tool_input', name: 'tool_name' },
  ],
  id: 'copilot',
  problemPrefix: 'copilot: ',
  provisionalTools: true,
  sample: { content: 'content', path: 'path', tool: 'create' },
  tools: {
    create: { content: 'content', path: 'path' },
    edit: { content: 'new_str', path: 'path' },
  },
} satisfies AgentContract

/** Exported for the reason `WRITE_TOOLS` is: so `docs/reference.md` can be checked against it. */
export const AGENT_CONTRACTS: Readonly<Record<AgentId, AgentContract>> = {
  'claude-code': CLAUDE_CODE_CONTRACT,
  copilot: COPILOT_CONTRACT,
}

/** The default lives HERE and nowhere else, for the reason `respond.ts` defaults `--fail` once. */
export const contractFor = (agent: AgentId | undefined): AgentContract => AGENT_CONTRACTS[agent ?? 'claude-code']

/**
 * Every tool name that belongs to some OTHER contract, precomputed once.
 *
 * Membership here is what turns "a tool falsestart has no opinion about" into "the flag names the
 * wrong runtime": `Write` cannot come from Copilot, whose tool table is documented and closed, and
 * `create` cannot come from Claude Code. A structural discriminator — membership in a declared
 * table — rather than a guess about what the name looks like.
 */
const toolsElsewhere = (id: AgentId): ReadonlySet<string> =>
  new Set(AGENTS.filter((other) => other !== id).flatMap((other) => Object.keys(AGENT_CONTRACTS[other].tools)))

const OTHER_TOOLS: Readonly<Record<AgentId, ReadonlySet<string>>> = {
  'claude-code': toolsElsewhere('claude-code'),
  copilot: toolsElsewhere('copilot'),
}

/**
 * The payload is validated by hand rather than with `Schema`, unlike rule documents.
 *
 * The shapes differ in what a good error has to say. A rule document is authored by a person who
 * needs to know which field of which file is wrong, which is exactly what `Schema` reports. A hook
 * payload is machine-generated, and the useful message names the TOOL and the field that tool was
 * expected to carry (`NotebookEdit carried no new_source/notebook_path`) — per-tool knowledge that
 * lives here, not in a schema. Validating against a union of tool shapes would report a union
 * mismatch, and it would now span two agents, two envelope spellings and two-or-three tools, where
 * the useful message is `copilot: create carried no content/path to judge (toolArgs carried:
 * file_text, path)`.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The first documented spelling this payload actually uses, if any. */
const spokenEnvelope = (
  payload: Record<string, unknown>,
  contract: AgentContract,
): { readonly envelope: Envelope; readonly tool: string } | undefined => {
  for (const envelope of contract.envelopes) {
    const tool = payload[envelope.name]
    if (typeof tool === 'string') {
      return { envelope, tool }
    }
  }
  return undefined
}

/**
 * Whether this payload is even a candidate for judgement.
 *
 * Cheap and deliberately separate from `decide`, because the hook fires on EVERY tool call. A
 * caller can skip loading a rule tree entirely for the `Bash`/`Read`/`Grep` calls that make up
 * most of an agent's traffic — which keeps the guard off the hot path, and keeps a broken rule
 * tree from raising errors on tool calls it was never going to have an opinion about.
 *
 * A malformed payload counts as a candidate: deciding it is a problem is `decide`'s job, and
 * skipping it here would silently swallow exactly the case worth reporting. So does a tool name
 * belonging to a DIFFERENT contract than the one declared: that is not a tool falsestart has no
 * opinion about, it is proof the flag is wrong, and deferring it here would make a misdeclared
 * `--agent` silently unguarded — which is the failure mode the flag exists to avoid.
 *
 * It never touches the INPUT key, so a Copilot `bash` call costs the same handful of operations a
 * `Bash` call does today, in either spelling, and the JSON-string decode never runs on the hot path.
 *
 * The second parameter is optional because this is a published export whose arity predates the
 * agent contract; absent means `claude-code`.
 */
export const judgesPayload = (payload: unknown, agent?: AgentId): boolean => {
  if (!isRecord(payload)) {
    return true
  }
  const contract = contractFor(agent)
  const spoken = spokenEnvelope(payload, contract)
  return spoken === undefined || spoken.tool in contract.tools || OTHER_TOOLS[contract.id].has(spoken.tool)
}

const describe = (finding: Finding): string =>
  `${finding.ruleId} (${finding.line}:${finding.column}): ${finding.message}`

/**
 * What a payload is asking to write, if anything.
 *
 * Split out of `decide` rather than duplicated because `respond` needs the DESTINATION too — a
 * judged write into a frozen rules directory is told why nothing happened — and two readings of the
 * same payload would eventually disagree about which tool carries its path where. `NotebookEdit`
 * calls it `notebook_path`, and reading `file_path` there leaves a rule effectively unscoped rather
 * than correctly scoped.
 */
export type JudgedTarget =
  /** Not a tool that writes source. Nothing this tool knows how to judge. */
  | { readonly _tag: 'Deferred' }
  | { readonly _tag: 'Malformed'; readonly problem: string }
  | {
      readonly _tag: 'Write'
      readonly content: string
      /** The agent's working directory, when it named one. Rules are scoped relative to it. */
      readonly cwd: string | undefined
      readonly path: string
    }

export const judgedTarget = (payload: unknown): JudgedTarget => {
  if (!isRecord(payload)) {
    return { _tag: 'Malformed', problem: 'hook payload was not an object' }
  }

  const toolName = payload['tool_name']
  if (typeof toolName !== 'string') {
    return { _tag: 'Malformed', problem: 'hook payload carried no tool_name' }
  }

  const fields = WRITE_TOOLS[toolName]
  if (fields === undefined) {
    return { _tag: 'Deferred' }
  }

  const toolInput = payload['tool_input']
  if (!isRecord(toolInput)) {
    return { _tag: 'Malformed', problem: `${toolName} carried no tool_input` }
  }

  const content = toolInput[fields.content]
  const path = toolInput[fields.path]
  if (typeof content !== 'string' || typeof path !== 'string') {
    return { _tag: 'Malformed', problem: `${toolName} carried no ${fields.content}/${fields.path} to judge` }
  }

  const cwd = payload['cwd']
  return { _tag: 'Write', content, cwd: typeof cwd === 'string' ? cwd : undefined, path }
}

/**
 * Judges the tool call described by `payload`.
 *
 * Never fails: every way this can go wrong is itself one of the three outcomes, because a guard
 * that throws inside a hook is a guard whose behaviour the agent runtime decides, not this code.
 */
export const decide = (
  rules: readonly Rule[],
  payload: unknown,
  options: DecideOptions = {},
): Effect.Effect<Decision> =>
  Effect.gen(function* () {
    const target = judgedTarget(payload)
    if (target._tag === 'Malformed') {
      return { _tag: 'Report', problem: target.problem } as const
    }
    if (target._tag === 'Deferred') {
      return defer()
    }
    // The payload reports an absolute path; rules are written relative to the project. Scoping on
    // the raw absolute path makes every repo-relative glob silently never match.
    const { content, cwd, path } = target
    const scopingPath = toScopingPath(path, cwd)

    // Deliberately before the check rather than after it. A path no rule admits produces no
    // findings, so the two are equivalent in outcome — but reading it here says the condition is
    // about SCOPE, not about a check that came back empty, and `some` costs nothing when the
    // option is off. It cannot pre-empt a `Deny`: a rule that could deny is a rule that applies.
    if (options.warnUnscoped === true && !rules.some((rule) => appliesTo(rule, scopingPath))) {
      return {
        _tag: 'Advise',
        // Empty on purpose. There is no finding — that is the entire report. `Advise` is reused
        // rather than given a sibling tag because the response is identical in kind: shown to the
        // author, decides nothing, write proceeds.
        findings: [],
        note: `no rule is scoped to ${scopingPath}, so this write was not checked`,
      } as const
    }

    const outcome = yield* Effect.result(checkFile(rules, { content, path: scopingPath }))
    if (outcome._tag === 'Failure') {
      return {
        _tag: 'Report',
        problem: `rule ${outcome.failure.ruleId} could not run: ${outcome.failure.reason}`,
      } as const
    }

    const blocking = outcome.success.filter((finding) => finding.severity === 'error')

    if (blocking.length > 0) {
      return {
        _tag: 'Deny',
        findings: blocking,
        reason: blocking.map((finding) => describe(finding)).join('\n'),
      } as const
    }

    const advisory = outcome.success.filter((finding) => finding.severity !== 'error')
    if (advisory.length === 0) {
      return defer()
    }

    return {
      _tag: 'Advise',
      findings: advisory,
      note: advisory.map((finding) => describe(finding)).join('\n'),
    } as const
  })
