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
import { Effect, Schema } from 'effect'
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
  readonly agent?: AgentId | undefined
  /**
   * The directory to anchor a rule's `files` globs to when the payload names none.
   *
   * Rules are authored project-relative (`src/**\/*.ts`) while a hook reports an absolute path, so
   * something has to say which prefix to strip. The payload's `cwd` says it — except when the
   * payload does not carry one, and then the absolute path was matched raw and every repo-relative
   * glob silently admitted nothing: the rule loads, validates, reports on nothing, and an unguarded
   * file is indistinguishable from a clean one. Claude Code always sends `cwd`; the Copilot envelope
   * is provisional and any other caller may not.
   *
   * The payload still WINS when it names one, deliberately. Both are legitimate anchors and only the
   * rule's author knows which their globs were written against: a hook command that runs in a
   * subdirectory (`cd packages/app && falsestart --rules ../../rules`) while the payload names the
   * repository root is a real, working configuration, and preferring this field silently stopped it
   * blocking — measured, deny to exit 0 with nothing on either stream.
   *
   * OPTIONAL: `DecideOptions` is published, so a caller that predates this keeps the behaviour it
   * was written against.
   */
  readonly projectDirectory?: string | undefined
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
 * The one hook event falsestart implements, and the key both runtimes name the event in.
 *
 * `hook_event_name` is documented by Claude Code on every payload, and by Copilot on the VS Code
 * compatible spelling its PascalCase hook config selects — so ONE key covers both, and reading it
 * is not sniffing the agent for the reason `AGENTS` gives: it says which event arrived, never how
 * the runtime will read the answer. Copilot's camelCase spelling carries no event field at all,
 * which is why absence can never be a refusal (see `judgedTarget`).
 *
 * `IMPLEMENTED_EVENT` is also what `respond` writes into Claude Code's deny document, so the event
 * falsestart claims to implement and the event it names in its answer cannot drift apart — the
 * hardcoded literal there was half of #63.
 */
export const EVENT_KEY = 'hook_event_name'
export const IMPLEMENTED_EVENT = 'PreToolUse'

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
   *
   * Non-empty by type, because the FIRST one is what a payload carrying none of them is told to
   * carry — a contract with no envelope could not say anything useful there.
   */
  readonly envelopes: readonly [Envelope, ...(readonly Envelope[])]
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
 * The contract a payload's tool name really belongs to, when it is not the declared one's.
 *
 * `undefined` covers three different things on purpose — no tool name in a spelling this contract
 * reads, a tool this contract owns, and a tool nobody owns — because every caller asks the same
 * question of it: is there structural evidence that ANOTHER runtime sent this payload. Membership
 * in a declared, closed table is that evidence; the shape of the name is not.
 */
const foreignTool = (payload: Record<string, unknown>, contract: AgentContract): AgentId | undefined => {
  const spoken = spokenEnvelope(payload, contract)
  return spoken === undefined || spoken.tool in contract.tools
    ? undefined
    : AGENTS.find((id) => id !== contract.id && spoken.tool in AGENT_CONTRACTS[id].tools)
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
  /**
   * The payload names a tool from a contract other than the one declared, which is proof the flag
   * is wrong rather than a tool falsestart has no opinion about. `runtime` is the contract the name
   * really belongs to, so the notice can be emitted on the channel that runtime reads — a message
   * about a misdeclared `--agent` is useless on the channel of the agent that is not there.
   */
  | { readonly _tag: 'Misdeclared'; readonly problem: string; readonly runtime: AgentId }
  /**
   * The payload names a hook event falsestart does not implement, so there is nothing here to
   * judge — see `judgedTarget`, which is where the argument for refusing rather than judging is.
   */
  | { readonly _tag: 'Unsupported'; readonly problem: string }
  | {
      readonly _tag: 'Write'
      readonly content: string
      /** The agent's working directory, when it named one. Rules are scoped relative to it, and
       * only when it is absent does `DecideOptions.projectDirectory` stand in. */
      readonly cwd: string | undefined
      readonly path: string
    }

/**
 * A JSON-encoded argument object, kept in a result rather than thrown.
 *
 * `Schema.UnknownFromJsonString` rather than `JSON.parse` for the reason `no-json-global` gives, and
 * because a guard that throws inside a hook is a guard whose behaviour the agent runtime decides.
 */
const decodeArguments = Schema.decodeUnknownResult(Schema.UnknownFromJsonString)

/**
 * The contract is REQUIRED, not defaulted.
 *
 * A default here reads as harmless and is not: it makes every call site that forgets to pass one
 * judge a Copilot payload against Claude Code's table, which resolves to `Malformed` — and
 * `respond` routes `Malformed` to a report rather than to `--fail closed`, so a rule that could not
 * run would stop denying under `--agent copilot`. It would also be an arm no input can reach once
 * both call sites pass a contract, which the 100% branch threshold rejects.
 */
export const judgedTarget = (payload: unknown, contract: AgentContract): JudgedTarget => {
  if (!isRecord(payload)) {
    return { _tag: 'Malformed', problem: `${contract.problemPrefix}hook payload was not an object` }
  }

  // Read FIRST, ahead of the envelope, because most of the events falsestart does not implement
  // carry no tool call whatsoever — `SessionStart`, `Stop` and `UserPromptSubmit` have no
  // `tool_name` to find. Answering those `hook payload carried no tool_name` names neither the
  // cause nor the remedy; it is the dead end #50 opened with, one event further along.
  //
  // A string that is not `PreToolUse` is the only refusal. ABSENCE is not: Copilot's camelCase
  // payload carries no event field, plenty of library callers construct a payload without one, and
  // most of this repo's own fixtures omit it — a refusal there would be a guard that stopped
  // guarding on a payload it used to judge. Neither is a non-string value, which is not a claim
  // about an event at all.
  //
  // What this does NOT do is implement the event. #51's design pass is the argument: after the
  // write neither runtime can block, so `Deny` and `Advise` collapse into one emission and the
  // `severity` dimension of every rule stops meaning anything. `falsestart scan` already covers
  // that ground, so the message names it rather than pretending there is a judgement to make here.
  //
  // A misdeclared `--agent` outranks it, and that is a CHANNEL argument rather than a priority
  // call. A tool name is structural proof of which runtime sent this; `hook_event_name` is not,
  // because both runtimes send it. Where the payload carries that proof, the misdeclaration is the
  // only answer that can be emitted where the runtime really there will read it — measured:
  // `--agent copilot` in front of a Claude Code payload at `PostToolUse` says `Set --agent
  // claude-code` at exit 1, which Claude Code shows in the transcript, where the event refusal
  // would go out at exit 0 on Copilot's channel and reach the debug log and nothing else. The
  // event refusal arrives on the next call, once the flag names the runtime that is answering.
  const event = payload[EVENT_KEY]
  if (typeof event === 'string' && event !== IMPLEMENTED_EVENT && foreignTool(payload, contract) === undefined) {
    return {
      _tag: 'Unsupported',
      problem:
        `${contract.problemPrefix}this hook was invoked for \`${event}\`, and falsestart only implements ` +
        `\`${IMPLEMENTED_EVENT}\` — nothing was judged. A decision emitted here would name the wrong event and ` +
        'be ignored. Register falsestart on PreToolUse, or run `falsestart scan` for after-the-write reporting.',
    }
  }

  const spoken = spokenEnvelope(payload, contract)
  if (spoken === undefined) {
    // A payload speaking ANOTHER contract's envelope cannot be a misdeclaration — there is no tool
    // name in a spelling this contract reads, so there is nothing to look up — but the envelope
    // itself is evidence, and it is the only evidence available in this direction. Without this
    // clause the answer is `hook payload carried no tool_name`, which is the exact line issue #50
    // opens with and which names neither the cause nor the remedy.
    const elsewhere = AGENTS.find(
      (id) => id !== contract.id && spokenEnvelope(payload, AGENT_CONTRACTS[id]) !== undefined,
    )
    const hint =
      elsewhere === undefined
        ? ''
        : ` (it carried ${spokenEnvelope(payload, AGENT_CONTRACTS[elsewhere])?.envelope.name}, ` +
          `which belongs to the ${elsewhere} contract — did you mean --agent ${elsewhere}?)`
    return {
      _tag: 'Malformed',
      problem: `${contract.problemPrefix}hook payload carried no ${contract.envelopes[0].name}${hint}`,
    }
  }

  const fields = contract.tools[spoken.tool]
  if (fields === undefined) {
    // The same question the event check asked, asked once more rather than threaded through as a
    // parameter: the answer is two property reads and a two-element `find`, and a parameter would
    // make the two clauses able to disagree about what counts as evidence.
    const elsewhere = foreignTool(payload, contract)
    return elsewhere === undefined
      ? { _tag: 'Deferred' }
      : {
          _tag: 'Misdeclared',
          problem:
            `this payload names the tool \`${spoken.tool}\`, which belongs to the ${elsewhere} ` +
            `contract, but --agent ${contract.id} was given. Set --agent ${elsewhere}, or remove the flag.`,
          runtime: elsewhere,
        }
  }

  const raw = payload[spoken.envelope.input]
  // Guarded on `typeof raw === 'string'`, so an ABSENT key keeps its own message rather than being
  // reported as a string that would not parse — which is both untrue and a change to what the
  // default path has always said.
  let input: unknown = raw
  if (contract.encodedInput && typeof raw === 'string') {
    const decoded = decodeArguments(raw)
    if (decoded._tag === 'Failure') {
      return {
        _tag: 'Malformed',
        problem: `${contract.problemPrefix}${spoken.tool} carried ${spoken.envelope.input} as a string that is not JSON`,
      }
    }
    input = decoded.success
  }

  if (!isRecord(input)) {
    return {
      _tag: 'Malformed',
      problem: `${contract.problemPrefix}${spoken.tool} carried no ${spoken.envelope.input}`,
    }
  }

  const content = input[fields.content]
  const path = input[fields.path]
  if (typeof content !== 'string' || typeof path !== 'string') {
    // The keys that DID arrive are named, because neither Copilot tool's argument names are
    // documented by GitHub. Without them a wrong inference reads as a mysterious silence; with
    // them it is one line of a diagnostic and a one-literal fix.
    const carried = Object.keys(input).toSorted()
    return {
      _tag: 'Malformed',
      problem:
        `${contract.problemPrefix}${spoken.tool} carried no ${fields.content}/${fields.path} to judge ` +
        `(${spoken.envelope.input} carried${carried.length === 0 ? ' nothing' : `: ${carried.join(', ')}`})`,
    }
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
    const target = judgedTarget(payload, contractFor(options.agent))
    // A misdeclared flag reports for the reason a malformed payload does: it is a fact about the
    // invocation rather than about the code, so an agent told "denied" would rewrite something
    // nothing ever judged. A foreign hook event is a third fact of the same kind — about the
    // REGISTRATION — and reusing `Report` rather than growing a fifth outcome is what keeps
    // `respond` the only place that prices it, and `--doctor` free of a tag to un-pick.
    if (target._tag === 'Malformed' || target._tag === 'Misdeclared' || target._tag === 'Unsupported') {
      return { _tag: 'Report', problem: target.problem } as const
    }
    if (target._tag === 'Deferred') {
      return defer()
    }
    // The payload reports an absolute path; rules are written relative to the project. Scoping on
    // the raw absolute path makes every repo-relative glob silently never match.
    //
    // The payload's `cwd` when it carries one, and only then the caller's project directory. See
    // `DecideOptions.projectDirectory` for why that order and not the other.
    const { content, cwd, path } = target
    const scopingPath = toScopingPath(path, cwd ?? options.projectDirectory)

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
