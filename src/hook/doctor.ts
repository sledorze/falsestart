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
import { Effect, FileSystem } from 'effect'
import type { Path } from 'effect'
import {
  applyScopeOverrides,
  findDefaultConfigs,
  findNarrowedScopes,
  loadConfigFile,
  loadDefaultConfig,
} from '../config/index.ts'
import { appliesTo, fallbacks, loadRules } from '../checking/index.ts'
import { decide, WRITE_TOOLS } from './decide.ts'

export interface Diagnosis {
  /** False when any step failed to resolve; the caller turns this into an exit code. */
  readonly healthy: boolean
  readonly lines: readonly string[]
}

export interface DiagnoseOptions {
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
  readonly projectDirectory: string
  readonly rulesDirectory: string
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

export const diagnose = (
  options: DiagnoseOptions,
): Effect.Effect<Diagnosis, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const { changelogPath, configPath, projectDirectory, rulesDirectory, version } = options
    const lines: string[] = [`falsestart ${version}`]

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
    const isReadableFile = (path: string) =>
      fs.stat(path).pipe(
        Effect.map((info) => info.type === 'File'),
        Effect.orElseSucceed(() => false),
      )

    if (changelogPath !== undefined && (yield* isReadableFile(changelogPath))) {
      lines.push(`changes  ${changelogPath} — what this version changed, including any rule that is new`)
    }
    lines.push('')

    const loaded = yield* Effect.result(loadRules(rulesDirectory))
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

    const configured = yield* Effect.result(
      configPath === undefined ? loadDefaultConfig(projectDirectory) : loadConfigFile(configPath),
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
    const found = yield* findDefaultConfigs(projectDirectory)
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

    lines.push(`tools    ${Object.keys(WRITE_TOOLS).toSorted().join(', ')} — any other tool call is ignored`)

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
    const verdict = yield* decide(scoped.success, {
      cwd: projectDirectory,
      tool_input: { content: SAMPLE_SOURCE, file_path: `${projectDirectory}/${SAMPLE_PATH}` },
      tool_name: 'Write',
    })

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
