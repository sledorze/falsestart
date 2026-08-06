/**
 * Answers "is this thing actually guarding anything?" — which nothing else could.
 *
 * Every misconfiguration falsestart has degrades to the same place: exit 1, a line on stderr the
 * agent runtime swallows, and the write proceeding. A missing rules directory, a misspelled preset,
 * two config files, an override naming a rule the current preset does not load — all of them leave a
 * hook that is registered, silent, and enforcing nothing.
 *
 * The exit codes make that worse rather than better, because they are the hook contract's and not a
 * human's: blocking is exit 0 WITH stdout, allowing is exit 0 WITHOUT, and failure is exit 1. So
 * `falsestart … ; echo $?` cannot distinguish "allowed" from "blocked", and a shell `if` reads a
 * broken guard as success. The only honest check available before this was hand-writing a hook
 * payload, which nothing documented.
 *
 * This reports what falsestart resolved and what it did with it, in that order, and fails loudly
 * when a step did not resolve. It reads no stdin: it is a question about the installation, not about
 * a tool call.
 */
import { Effect, FileSystem, Path } from 'effect'
import {
  applyScopeOverrides,
  findDefaultConfigs,
  findNarrowedScopes,
  loadConfigFile,
  loadDefaultConfig,
} from '../config/index.ts'
import { appliesTo, fallbacks, loadRules, readRuleDocuments } from '../checking/index.ts'
import type { FreezeOutcome, Frozen } from '../freezing/index.ts'
import { divergence } from '../freezing/index.ts'
import type { FailurePolicy } from './respond.ts'
import type { AgentId } from './decide.ts'
import { contractFor, decide } from './decide.ts'

export interface Diagnosis {
  /** False when any step failed to resolve; the caller turns this into an exit code. */
  readonly healthy: boolean
  readonly lines: readonly string[]
}

export interface DiagnoseOptions {
  readonly agent?: AgentId | undefined
  /**
   * Where this installation's release notes are. Verified to be a readable file before being
   * printed, so a wrong or absent path costs a line of the report rather than the whole report.
   *
   * OPTIONAL, and that is a compatibility decision rather than a convenience one: `DiagnoseOptions`
   * is part of the published library surface, so a required field here is a compile error in every
   * caller that predates it — a minor release turning a consumer's `tsc` red, which is exactly the
   * surprise this whole change exists to spare people.
   */
  readonly changelogPath?: string | undefined
  readonly configPath: string | undefined
  /**
   * The `--fail` policy the hook will run under, when the caller named one.
   *
   * `undefined` means nobody named one, and nothing is printed. OPTIONAL for the reason
   * `changelogPath` is.
   */
  readonly failure?: FailurePolicy | undefined
  /**
   * What a git ref committed, when the caller resolved one.
   *
   * OPTIONAL for the reason `changelogPath` is: `DiagnoseOptions` is published, and a required field
   * here is a compile error in every caller that predates it.
   */
  readonly freeze?: FreezeOutcome | undefined
  readonly projectDirectory: string
  readonly rulesDirectory: string
  /**
   * Why the caller could not resolve a rules source at all, when it could not.
   *
   * OPTIONAL for the reason `changelogPath` is. When set, `rulesDirectory` is never loaded from.
   */
  readonly unresolvedRules?: string | undefined
  readonly version: string
}

/**
 * Paths probed for reachability. A NESTED one is the point: `src/**.ts` and `src/**\/*.ts` look alike
 * and behave completely differently, and a report that only probed top-level files showed four rules
 * applying while every nested source file — nearly the whole codebase — was unguarded.
 */
const PROBE_PATHS = ['src/a.ts', 'src/nested/deep/a.ts', 'src/a.mts', 'src/a.test.ts', 'src/a.js'] as const

/**
 * A sample run through the real decision path. Deliberately reported as an OBSERVATION, not a
 * verdict on the installation: `rules/effect` contains nothing that forbids a type assertion, so an
 * earlier version told users of a perfectly working effect guard that nothing was enforcing.
 */
const SAMPLE_PATH = 'src/nested/example.ts'
const SAMPLE_SOURCE = 'const widget = payload as any'

/**
 * A block of `label  text` rows under one heading, in the report's existing shape.
 *
 * The heading is on the first row and the rest are indented under it, which is what makes `rules`,
 * `config` and `scope` read as one report rather than as a list of unrelated lines.
 */
const block = (heading: string, rows: readonly (readonly [string, string])[]): readonly string[] =>
  rows.map(([label, text], index) => `${(index === 0 ? heading : '').padEnd(9)}${label.padEnd(8)}${text}`)

const documentsOf = (source: Frozen | undefined): ReadonlyMap<string, string> | undefined =>
  source?._tag === 'Frozen' ? source.documents : undefined

/** How many documents a frozen source holds; nothing, when it is not frozen. */
const countOf = (source: Frozen): number => (source._tag === 'Frozen' ? source.documents.size : 0)

const describeFrozen = (source: Frozen, held: string): string => {
  switch (source._tag) {
    case 'Frozen': {
      return `frozen — ${held}`
    }
    case 'Unfrozen': {
      // A stated policy rather than a fault: there was no committed version of these bytes.
      return `not frozen — ${source.reason}`
    }
    default: {
      return `COULD NOT BE READ — ${source.reason}`
    }
  }
}

/**
 * The one line a linked-worktree user has to see, because for them it is the difference between what
 * this feature claims and what it delivers.
 *
 * Printed ONLY when the anchor is unverified. A line that appears on every healthy run is one readers
 * stop seeing, and this is precisely the fact that must not be skimmed past.
 */
const anchorWarning = (projectDirectory: string): string =>
  `UNVERIFIED — no directory between ${projectDirectory} and / has a .git DIRECTORY, so replacing ` +
  `one file repoints this repository and everything below would still read as frozen. Expected in a ` +
  `linked worktree outside its main repository, or with --separate-git-dir. --freeze require refuses ` +
  `to judge here instead.`

export const diagnose = (
  options: DiagnoseOptions,
): Effect.Effect<Diagnosis, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const {
      agent,
      changelogPath,
      configPath,
      failure,
      freeze,
      projectDirectory,
      rulesDirectory,
      unresolvedRules,
      version,
    } = options
    const contract = contractFor(agent)
    const lines: string[] = [`falsestart ${version}`]

    // Every step below reads the FROZEN bytes where there are any. A report that resolved the
    // working tree while the hook enforced the ref would describe a rule set nobody is running,
    // which is the failure this whole command exists to prevent, wearing a new hat.
    const frozenRules = documentsOf(freeze?.rules)
    const frozenConfig = documentsOf(freeze?.config)

    // The version alone does not answer the question someone runs `--doctor` after an upgrade to
    // ask, which is "what is newly going to block me". A minor bump can add an `error`-severity rule
    // to a preset and turn a green repo red; 0.2.0 did it twice, and the release notes were not even
    // in the package, so the only way to find out was to pack both versions and diff them by hand.
    //
    // Printed only when a readable FILE is really there. A path offered for an artifact that is
    // absent sends the reader looking for the one thing that would have answered them, which is
    // worse than saying nothing — and it is absent in every installation published before this line
    // existed. `stat` rather than `exists` because "there is a directory of that name" is not the
    // claim being made, and a filesystem that cannot answer at all gets the same answer as "no": the
    // reader's next step is identical, and this is the one report still available when things break.
    const fs = yield* FileSystem.FileSystem
    const paths = yield* Path.Path
    const isReadableFile = (candidate: string) =>
      fs.stat(candidate).pipe(
        Effect.map((info) => info.type === 'File'),
        Effect.orElseSucceed(() => false),
      )

    if (changelogPath !== undefined && (yield* isReadableFile(changelogPath))) {
      lines.push(`changes  ${changelogPath} — what this version changed, including any rule that is new`)
    }

    // Printed on EVERY run, unlike `policy`, and this is the one departure from the `--fail`
    // precedent. The person asking "why did my deny not block?" is by definition the one who did
    // NOT pass `--agent`, so a line printed only when the flag is named is absent from exactly the
    // report that needs it. Above the early returns for the reason the policy line is.
    lines.push(
      contract.id === 'copilot'
        ? 'agent    copilot — a deny is exit 2 with the reason on stderr; a guard failure exits 0'
        : 'agent    claude-code — a deny is exit 0 with a JSON document on stdout; a guard failure exits 1',
    )

    // Printed only when `--fail` was NAMED, and printed here — above everything that can return
    // early. A line on every run would announce the default, which is no news, and would be the
    // thing `anchorWarning`'s comment forbids: a line readers stop seeing. Above the early returns
    // because the person asking "why was that write denied with no finding" is precisely the one
    // whose installation is in one of those states, and a policy line only a healthy run prints is
    // a policy line nobody sees.
    if (failure !== undefined) {
      lines.push(
        failure === 'closed'
          ? 'policy   --fail closed — a write falsestart cannot check is DENIED. A malformed hook payload is never the reason.'
          : 'policy   --fail open — a write falsestart cannot check is reported on stderr and proceeds.',
      )
    }
    lines.push('')

    // Reported rather than left to the caller's stderr: this is the one resolution failure that
    // happens before `diagnose` is reachable at all, so a caller that returned early on it produced
    // no report whatsoever — for the single question this command exists to answer.
    if (unresolvedRules !== undefined) {
      lines.push(`rules    COULD NOT RESOLVE — ${unresolvedRules}`)
      return { healthy: false, lines }
    }

    const loaded = yield* Effect.result(loadRules(rulesDirectory, frozenRules))
    if (loaded._tag === 'Failure') {
      lines.push(`rules    ${rulesDirectory}`, `         COULD NOT LOAD — ${loaded.failure.reasons.join('; ')}`)
      return { healthy: false, lines }
    }
    // How many of them can actually stop a write, which is the question "N loaded" stops one word
    // short of. Both counts print even when one is zero: the reader who needs to learn that advisory
    // rules exist is precisely the one whose set has none, so a clause that appeared only when an
    // advisory rule was already there would be invisible to them. `?? 'error'` is the same
    // defaulting the engine applies, written out here rather than imported so this line reads as
    // what it reports.
    const blocking = loaded.success.filter((rule) => (rule.severity ?? 'error') === 'error').length
    lines.push(
      `rules    ${rulesDirectory} — ${loaded.success.length} loaded (${blocking} block, ${loaded.success.length - blocking} advise)`,
    )

    const namedConfig = configPath === undefined ? undefined : frozenConfig?.get(paths.basename(configPath))
    const configured = yield* Effect.result(
      configPath === undefined
        ? loadDefaultConfig(projectDirectory, frozenConfig)
        : loadConfigFile(configPath, namedConfig),
    )
    if (configured._tag === 'Failure') {
      lines.push(`config   COULD NOT LOAD — ${configured.failure.reasons.join('; ')}`)
      return { healthy: false, lines }
    }

    // Never "none found": absence of overrides is not absence of a config file, and asserting the
    // stronger claim from the weaker fact is the kind of quiet wrong answer this tool exists to stop.
    const overrides = Object.keys(configured.success.rules)
    const named = overrides.length === 0 ? '' : `: ${overrides.join(', ')}`
    // "Did you pick up my config?" is the question this line exists to answer, and reporting only
    // where it LOOKED made a project with a config and one without print the same thing.
    const found = yield* findDefaultConfigs(projectDirectory, frozenConfig)
    const where = configPath ?? (found.length === 0 ? `no config file in ${projectDirectory}` : found.join(', '))
    lines.push(`config   ${where} — ${overrides.length} override(s)${named}`)

    const scoped = yield* Effect.result(applyScopeOverrides(loaded.success, configured.success))
    if (scoped._tag === 'Failure') {
      lines.push(`         OVERRIDES REJECTED — ${scoped.failure.reasons.join('; ')}`)
      return { healthy: false, lines }
    }

    // Printed under `config`, because it is a fact about what the override did rather than about
    // the rules. Informational: narrowing is the feature working, and only the reader knows whether
    // this particular narrowing was meant.
    for (const narrowed of findNarrowedScopes(loaded.success, scoped.success)) {
      const lost = narrowed.lostExtensions.map((extension) => `.${extension}`).join(', ')
      lines.push(`         ${narrowed.ruleId} stops covering ${lost} — the override replaces the rule's own files`)
    }

    // A rule that cannot run under the grammar its own scope implies falls back to the grammar it
    // declares, which keeps one misconfigured rule from disabling every other rule for a file. That
    // recovery must not be silent: it is a fact about the RULE SET, so it is stated once here
    // rather than on every tool call, where it would become noise and then be ignored.
    for (const fallback of yield* fallbacks(scoped.success)) {
      lines.push(
        `         ${fallback.ruleId} falls back to ${fallback.declared} for .${fallback.extension} — its pattern does not compile under that file's grammar`,
      )
    }

    // Between `config` and `tools`, because it is a fact about WHICH bytes the two lines above
    // describe. `healthy` follows the same split the classification does: `Unfrozen` is a stated
    // policy and stays healthy; `Broken` is a guard that could not do its job and does not.
    if (freeze !== undefined) {
      const frozenRef = [freeze.rules, freeze.config].flatMap((source) =>
        source._tag === 'Frozen' ? [source.ref] : [],
      )[0]
      const unverified = [freeze.rules, freeze.config].some(
        (source) => source._tag === 'Frozen' && source.anchor === 'unverified',
      )
      const committedConfig =
        freeze.config._tag === 'Frozen' && freeze.config.documents.size > 0
          ? [...freeze.config.documents.keys()].join(', ')
          : `no falsestart config at ${frozenRef}`

      const rows: (readonly [string, string])[] = [
        ...(frozenRef === undefined ? [] : [['ref', frozenRef] as const]),
        ...(unverified ? [['anchor', anchorWarning(projectDirectory)] as const] : []),
        ['rules', describeFrozen(freeze.rules, `${countOf(freeze.rules)} document(s) from ${rulesDirectory}`)],
        ['config', describeFrozen(freeze.config, committedConfig)],
      ]
      lines.push(...block('freeze', rows))

      // The entire answer to "I edited a rule and nothing happened", and it costs one working-tree
      // read plus a pure comparison — here, in a report someone asked for, and never on a judged
      // write. A rules directory that is not there is not an error: the ref is what is in effect,
      // so every committed document simply reads as removed.
      //
      // Printed only where the anchor is VERIFIED. "N working-tree change(s) are NOT in effect" is a
      // claim about which side is authoritative, and where that cannot be positively established the
      // claim was wrong in the direction that reassures — it named the project's own committed rule
      // as the change that had not landed.
      if (freeze.rules._tag === 'Frozen' && freeze.rules.anchor === 'verified') {
        const working = yield* readRuleDocuments(rulesDirectory).pipe(Effect.orElseSucceed(() => new Map()))
        const drift = divergence(freeze.rules.documents, working)
        if (drift.length > 0) {
          lines.push(
            `         ${drift.length} working-tree change(s) are NOT in effect — commit them, or pass --freeze off:`,
          )
          for (const entry of drift) {
            lines.push(`           ${entry.kind.padEnd(8)} ${entry.path}`)
          }
        }
      }

      if ([freeze.rules, freeze.config].some((source) => source._tag === 'Broken')) {
        return { healthy: false, lines }
      }
    }

    // The FIELD names, not just the tool names. Nothing inside falsestart can verify the Copilot
    // mapping — it has no real Copilot payload — so the strongest honest answer available is to
    // print what it will read and let the reader diff it against one.
    // Rendered first and sorted after, so the ordering needs no comparator of its own: the tool name
    // is the prefix of every rendered entry, and a hand-written comparator here has an arm no
    // contract's table can reach.
    const judged = Object.entries(contract.tools)
      .map(([tool, fields]) => `${tool} (${fields.path}/${fields.content})`)
      .toSorted()
    lines.push(`tools    ${judged.join(', ')} — any other tool call is ignored`)

    // A declared fact about the contract, not a name check on the agent.
    if (contract.provisionalTools) {
      lines.push(
        '         PROVISIONAL — GitHub does not document these argument names. Compare them against one real',
        '         hook payload; if they differ, that tool is not being judged. Please report it.',
      )
    }

    const reach = PROBE_PATHS.map(
      (path) => [path, scoped.success.filter((rule) => appliesTo(rule, path)).length] as const,
    )
    lines.push('scope')
    for (const [path, count] of reach) {
      lines.push(`         ${`${count}`.padStart(3)} rule(s) apply to ${path}`)
    }
    lines.push('')

    // Reported, NOT failed. "Misses five `src/` paths" is not "misses everything": a rule set scoped
    // to `lib/**` or a monorepo's `packages/*/src/**` blocks perfectly well and probes zero here.
    // Exiting 1 on that inference called a working guard broken.
    if (reach.every(([, count]) => count === 0)) {
      lines.push(
        'check    no rule applies to any probed path. Expected if your sources are not under src/;',
        '         otherwise the `files` globs are not matching what you think they are.',
      )
      return { healthy: true, lines }
    }

    // A real payload through the real decision path, reported as what it is: one observation, not a
    // verdict on the installation.
    // Written in the ACTIVE contract's vocabulary, from the contract itself. Hand-written in Claude
    // Code's, a healthy Copilot installation reports `the sample could not be judged` and exits 1 —
    // from the one command whose whole job is saying whether the installation is healthy.
    const verdict = yield* decide(
      scoped.success,
      {
        cwd: projectDirectory,
        [contract.envelopes[0].name]: contract.sample.tool,
        [contract.envelopes[0].input]: {
          [contract.sample.content]: SAMPLE_SOURCE,
          [contract.sample.path]: `${projectDirectory}/${SAMPLE_PATH}`,
        },
      },
      { agent: contract.id },
    )

    // `Report` is the guard failing, not the sample passing. Collapsing every non-`Deny` tag into
    // the reassuring branch reported a rule that cannot run at match time as a clean bill of health,
    // while every real write hit exit 1 and proceeded.
    if (verdict._tag === 'Report') {
      lines.push(`check    the sample could not be judged — ${verdict.problem}`)
      return { healthy: false, lines }
    }

    if (verdict._tag === 'Deny') {
      lines.push(`check    the sample \`${SAMPLE_SOURCE}\` at ${SAMPLE_PATH} was blocked`)
      return { healthy: true, lines }
    }

    // A rule DID forbid the sample and reported it without blocking. Falling through to the line
    // below would offer "expected unless one forbids type assertions" as the explanation, which
    // names the wrong cause for the one rule set the `rules` line has just called advisory.
    if (verdict._tag === 'Advise') {
      lines.push(
        `check    the sample \`${SAMPLE_SOURCE}\` at ${SAMPLE_PATH} was reported, not blocked —` +
          ` the rule(s) that matched it advise`,
      )
      return { healthy: true, lines }
    }

    // "Expected unless a rule forbids type assertions" was wrong whenever one did and the sample
    // path was simply outside its scope — the glob-typo case this feature exists to surface.
    const covering = scoped.success.filter((rule) => appliesTo(rule, SAMPLE_PATH)).length
    lines.push(
      covering === 0
        ? `check    no rule applies to ${SAMPLE_PATH}, so the sample proves nothing — read the scope block above`
        : `check    the sample \`${SAMPLE_SOURCE}\` at ${SAMPLE_PATH} was not blocked by any of the` +
            ` ${covering} rule(s) that apply there — expected unless one forbids type assertions`,
    )

    // Reaching here means every step resolved and at least one rule can fire.
    return { healthy: true, lines }
  })
