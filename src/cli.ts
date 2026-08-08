#!/usr/bin/env node
/**
 * The executable. Reads a PreToolUse hook payload on stdin and emits a decision.
 *
 * Everything interesting happens in `respond` and `parseArguments`; this file exists to connect
 * them to the process, and is deliberately the only place that names a runtime or a process.
 */
import { spawnSync } from 'node:child_process'
import { basename } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { NodeFileSystem, NodePath, NodeRuntime, NodeStdio } from '@effect/platform-node'
import { Data, Effect, FileSystem, Layer, Path, Stdio, Stream } from 'effect'
import {
  DEFAULT_FREEZE_REF,
  DEFAULT_RULES_DIRECTORY,
  isBrokenPipe,
  packageRulesDirectory,
  parseArguments,
  presetDirectory,
} from './cli/index.ts'
import type { HookResponse } from './hook/index.ts'
import { diagnose, respond } from './hook/index.ts'
import {
  fingerprint,
  parseIgnoredPaths,
  readBaseline,
  render,
  scan,
  ScanExit,
  writeBaseline,
} from './scanning/index.ts'
import { applyScopeOverrides, DEFAULT_CONFIG_CANDIDATES, loadConfigFile, loadDefaultConfig } from './config/index.ts'
import { isRuleDocument, loadRuleSources, ruleListText, ruleSourcesOf } from './checking/index.ts'
import type {
  AnchorResolution,
  ConfigSource,
  FreezeMode,
  FreezeOutcome,
  Frozen,
  GitAnswer,
  WorkTree,
} from './freezing/index.ts'
import {
  containedPath,
  enclosingGitDirectory,
  freeze,
  resolveAnchor,
  resolveRulesPath,
  shippedRuleSources,
} from './freezing/index.ts'

/**
 * Carries a non-zero exit out of the program. A typed error rather than a bare failure, so the
 * intent is legible where it is raised and where it is handled.
 */
class Exit extends Data.TaggedError('Exit')<{ readonly code: number }> {}

/**
 * Applies an `Exit` to the process.
 *
 * `runMain` exits 1 on ANY failure, so failing with an `Exit` carrying a code did not set that
 * code — it set 1. That was invisible while every exit was 1 anyway; it became a silent bug the
 * moment `scan` needed 2 to mean "the gate is broken" rather than "your code has violations", which
 * is the one distinction stopping a git hook from teaching people to use `--no-verify`.
 *
 * Setting `process.exitCode` and completing normally is what actually reaches the shell.
 */
const applyExit = <A, E, R>(effect: Effect.Effect<A, Exit | E, R>): Effect.Effect<A | void, E, R> =>
  Effect.catchIf(
    effect,
    (failure): failure is Exit => failure instanceof Exit,
    (exit) =>
      Effect.sync(() => {
        process.exitCode = exit.code
      }),
  )

const write = (text: string, sink: Sink) => Stream.make(text).pipe(Stream.run(sink))

type Sink = ReturnType<Stdio.Stdio['stdout']>

const emit = (response: HookResponse) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio

    if (response.stdout !== undefined) {
      yield* write(response.stdout, stdio.stdout())
    }
    if (response.stderr !== undefined) {
      yield* write(`${response.stderr}\n`, stdio.stderr())
    }
  })

/**
 * Read from the installed manifest rather than baked in at build time, so it cannot drift from the
 * package a consumer actually has — the same `import.meta.url` anchor `presetDirectory` relies on.
 */
const VERSION: string = createRequire(import.meta.url)('../package.json').version

/**
 * Where the packaged rules live, anchored on this module rather than on the caller's cwd.
 *
 * `import.meta.url` points at the installed `dist/cli.js`, so `../rules` finds them wherever a
 * package manager put the package — including pnpm's content-addressed store, where guessing
 * `node_modules/@sledorze/falsestart/rules` does not work.
 *
 * The anchor is computed HERE and handed to `presetDirectory`, rather than read inside it: the
 * executable is bundled to `dist/cli.js` while the library build also emits `dist/cli/resolve.js`,
 * and a self-anchored `../rules` would mean a different directory in each. Only the shell knows
 * which artifact it is.
 */
const PACKAGED_RULES_ROOT: string = fileURLToPath(new URL('../rules', import.meta.url))

/**
 * This installation's release notes, anchored the same way and for the same reason: a consumer
 * cannot be told to read `node_modules/@sledorze/falsestart/CHANGELOG.md` when a package manager may
 * have put the package somewhere else entirely. `--doctor` checks the file is there before printing
 * it, which is what makes this safe to compute for an installation that predates shipping it.
 */
const CHANGELOG_PATH: string = fileURLToPath(new URL('../CHANGELOG.md', import.meta.url))

/**
 * Which of these paths the caller's own `.gitignore` covers, according to git itself.
 *
 * Asked rather than reimplemented: `.gitignore` semantics are git's — nested files, negation,
 * anchoring, precedence — and an approximation that is subtly wrong would decline to judge files
 * nobody excluded, silently.
 *
 * Best effort by design: no git, no repository, or any other failure yields an empty set and the
 * structural defaults still apply. Only the SPAWN lives here, because this is the one file allowed
 * to know a process exists; reading its output is `parseIgnoredPaths`, where it can be tested.
 */
const gitIgnored = (paths: readonly string[], projectDirectory: string): ReadonlySet<string> => {
  if (paths.length === 0) {
    return new Set()
  }

  const result = spawnSync('git', ['check-ignore', '--stdin', '-z'], {
    cwd: projectDirectory,
    encoding: 'utf8',
    input: paths.join('\u0000'),
  })

  // `check-ignore` exits 1 when nothing matched, which is an answer rather than a failure. Only a
  // spawn error or git's own 128 means we learned nothing.
  return result.error !== undefined || result.status === null || result.status > 1
    ? new Set()
    : parseIgnoredPaths(result.stdout)
}

/**
 * The location variables git honours before it looks at any path.
 *
 * Cleared, because falsestart decides which repository is authoritative by walking the filesystem
 * outward to a `.git` DIRECTORY, and an inherited variable that overrides that decision is the
 * environment disarming the guard. Measured: `GIT_DIR=<other>/.git GIT_WORK_TREE=<other>` made the
 * freeze read a different repository entirely and report the project's own rules as "outside the
 * project repository".
 */
const GIT_LOCATION_VARIABLES = [
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_WORK_TREE',
]

/**
 * The environment every freeze spawn runs in: the caller's, minus everything that could decide for
 * it which repository this is.
 *
 * Global and system configuration are pointed at `/dev/null` as well. Not because config is
 * dangerous, but because git reads it BEFORE it does anything: one malformed line in `~/.gitconfig`
 * makes `rev-parse` exit non-zero in every directory on the machine — a file outside the repository,
 * outside `.git`, and invisible to any diff of the project. Repo-local `.git/config` still applies;
 * that one is inside `.git`, which `SECURITY.md` already places outside what this can defend.
 *
 * The consequence is user-visible and is documented: a global `include`, a custom `core.*`, a
 * commit-signing setting — none of them apply to these four invocations.
 */
const gitEnvironment = (): Record<string, string | undefined> => {
  const inherited: Record<string, string | undefined> = { ...process.env }
  for (const name of GIT_LOCATION_VARIABLES) {
    delete inherited[name]
  }
  inherited['GIT_CONFIG_GLOBAL'] = '/dev/null'
  inherited['GIT_CONFIG_SYSTEM'] = '/dev/null'
  return inherited
}

/**
 * One `git` invocation, with its output kept as BYTES.
 *
 * `encoding` is left unset on purpose: `cat-file --batch` frames objects by a byte count, and
 * decoding before slicing corrupts every document with a non-ASCII character.
 *
 * `--no-optional-locks` rather than `GIT_OPTIONAL_LOCKS=0`, which is what git's own documentation
 * calls the equivalent of: a judged write must not take a repository lock.
 */
const runGit = (args: readonly string[], input?: string): GitAnswer => {
  const result = spawnSync('git', ['--no-optional-locks', ...args], {
    env: gitEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  })

  // A spawn error — `maxBuffer` exceeded, git not on PATH — leaves stderr empty, so it has to be
  // carried explicitly or the refusal says nothing to the person it just blocked.
  return {
    failed: result.error !== undefined || result.status !== 0,
    stderr: result.error === undefined ? (result.stderr?.toString() ?? '') : result.error.message,
    stdout: result.stdout ?? new Uint8Array(),
  }
}

const decoder = new TextDecoder()

/**
 * P1: which repository the project is in, asked from the PROJECT.
 *
 * Never from the rules directory. git honours a `.git` gitfile, so running it with a cwd inside a
 * directory an agent can write hands the agent the choice of repository — one `Write`, no shell.
 */
const toplevelOf = (directory: string): GitAnswer & { readonly toplevel: string | undefined } => {
  const answered = runGit(['-C', directory, 'rev-parse', '--show-toplevel'])
  return { ...answered, toplevel: answered.failed ? undefined : decoder.decode(answered.stdout).trim() }
}

/**
 * Everything the freeze needs, resolved when — and only when — someone asks for it.
 *
 * Four spawns, fixed, independent of the rule count: `rev-parse`, one `cat-file --batch` carrying
 * the ref probe and every config candidate, `ls-tree`, and one `cat-file --batch` carrying the rule
 * blobs. Never `git show` per document, which measured at nearly a whole judged write again at 168
 * rules and grows linearly where this shape does not.
 *
 * Only the SPAWNS live here. Deciding what git's answers MEAN is `src/freezing/`, where it can be
 * tested — this file is excluded from the coverage ratchet and from mutation testing.
 */
const resolveFreeze = (options: {
  readonly configPath: string | undefined
  readonly mode: FreezeMode
  readonly projectDirectory: string
  readonly ref: string
  readonly refExplicit: boolean
  readonly rulesDirectory: string
  readonly shippedDirectories: readonly string[]
}): Effect.Effect<FreezeOutcome, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const { configPath, mode, projectDirectory, ref, refExplicit, rulesDirectory, shippedDirectories } = options

    const real = (candidate: string) => fs.realPath(candidate).pipe(Effect.orElseSucceed(() => candidate))
    const projectReal = yield* real(projectDirectory)

    // `off` asks git nothing at all, including this.
    const asked = mode === 'off' ? undefined : toplevelOf(projectDirectory)
    const located = asked?.toplevel
    const repository: AnchorResolution =
      located === undefined
        ? { _tag: 'Anchored', anchor: 'unverified', toplevel: projectReal }
        : yield* resolveAnchor({
            listTreeAt: (repo, relative) => runGit(['-C', repo, 'ls-tree', ref, '--', relative]),
            projectDirectory,
            refExists: (repo) => runGit(['-C', repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]),
            toplevel: located,
          })
    const anchored =
      repository._tag === 'Anchored' ? repository : { anchor: 'unverified' as const, toplevel: projectReal }

    /**
     * git failing to name the repository is not evidence that there is none.
     *
     * Which of the two it is comes from the filesystem — is there a `.git` DIRECTORY between here
     * and the root — rather than from git's own words, which are another program's prose and would
     * make this a content match.
     */
    const workTree: WorkTree =
      asked === undefined || located !== undefined
        ? { _tag: 'Inside' }
        : (yield* enclosingGitDirectory(projectDirectory)) === undefined
          ? { _tag: 'Absent' }
          : { _tag: 'Unreadable', stderr: asked.stderr }

    const toplevelReal = yield* real(anchored.toplevel)
    const at = (args: readonly string[], input?: string) => runGit(['-C', anchored.toplevel, ...args], input)

    const config: ConfigSource =
      configPath === undefined
        ? {
            _tag: 'Candidates',
            names: DEFAULT_CONFIG_CANDIDATES,
            relative: containedPath(toplevelReal, projectReal) ?? '',
          }
        : {
            _tag: 'Explicit',
            name: path.basename(configPath),
            origin: configPath,
            relative: containedPath(toplevelReal, path.resolve(projectReal, configPath)),
          }

    return yield* freeze({
      config,
      isDocument: isRuleDocument,
      listTree: (relative) => at(['ls-tree', '-r', '-z', ref, '--', relative === '' ? '.' : relative]),
      mode,
      namedRefs: () => at(['for-each-ref', '--count=1', '--format=%(refname)']),
      probe: (requests) => at(['cat-file', '--batch', '--buffer'], `${requests.join('\n')}\n`),
      projectDirectory,
      readBlobs: (oids) => at(['cat-file', '--batch', '--buffer'], `${oids.join('\n')}\n`),
      ref,
      refExplicit,
      repository,
      rulesDirectory,
      rulesPath: yield* resolveRulesPath({ named: rulesDirectory, projectReal, toplevelReal }),
      // Resolved here for the reason `rulesPath` is: only this file may touch the real filesystem,
      // and where a shipped directory actually SITS is what decides whether the ref accounts for it.
      shipped: yield* Effect.all(
        shippedDirectories.map((directory) =>
          resolveRulesPath({ named: directory, projectReal, toplevelReal }).pipe(
            Effect.map((resolved) => ({ directory, path: resolved })),
          ),
        ),
      ),
      workTree,
    })
  })

const program = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  const options = parseArguments(args)

  /**
   * What "falsestart could not do its job" means to the caller, which depends on who is asking.
   *
   * The hook reads exit 1 as a non-blocking error notice and lets the write proceed. A shell
   * running `scan` in a git hook reads 1 as "your code has violations", so a broken installation
   * reported as 1 is indistinguishable from a failing gate — and that is what teaches people to
   * reach for `--no-verify`. Scan says 2 instead.
   *
   * Read from `args` rather than from `options`, because the shared failure paths below run before
   * — and, for `Invalid`, instead of — the mode being known.
   */
  /**
   * Whether a refusal at a non-zero code could BLOCK a write rather than report one.
   *
   * `docs/reference.md` states the law: a refused hook command line must never be able to stop a
   * write. Under Claude Code that is exit 1; under Copilot every non-zero exit denies the tool call
   * — 2 deliberately, anything else as "hook errored" — so 0 is the only non-blocking code left.
   *
   * Anything other than an explicit `claude-code` counts, INCLUDING a misspelled or missing value:
   * the parser is about to refuse those, and refusing them at exit 1 in front of Copilot is an
   * outage rather than a message. Read from `args` rather than `options` for the reason `brokenCode`
   * already is: this runs INSTEAD of the mode being known.
   */
  const mayDenyOnNonZero = args.some((argument, index) => {
    // Both spellings of one declaration. This parser accepts `--agent x` and refuses `--agent=x`,
    // but the REFUSAL has to cover both — `--agent=copilot` is the likeliest typo in the whole
    // flag, and refusing it at exit 1 in front of Copilot is a repository-wide outage rather than
    // a message. A missing value counts too: the parser is about to refuse that as well.
    const named =
      argument === '--agent'
        ? (args[index + 1] ?? '')
        : argument.startsWith('--agent=')
          ? argument.slice('--agent='.length)
          : undefined
    return named !== undefined && named !== 'claude-code'
  })

  /**
   * ... and `--list-rules` is not the hook path either, so it keeps 1.
   *
   * The Copilot exit-code contract governs a command line that answers a TOOL CALL. `--list-rules`
   * reads no stdin, emits no hook decision, and documents exactly two outcomes — 0 with the
   * document, 2 when it could not be produced. Letting the Copilot refusal reach it produced exit 0
   * with an empty stdout, which is the one answer `falsestart --list-rules > rules.json` cannot
   * tell from success, and made two spellings of the same refused combination disagree.
   */
  const brokenCode = args[0] === 'scan' ? ScanExit.Broken : args.includes('--list-rules') ? 1 : mayDenyOnNonZero ? 0 : 1

  if (options._tag === 'Help') {
    return yield* write(`${options.text}\n`, stdio.stdout())
  }

  if (options._tag === 'Version') {
    return yield* write(`${VERSION}\n`, stdio.stdout())
  }

  if (options._tag === 'Invalid') {
    // Refusing the run is itself the non-blocking error notice: the write proceeds, but the
    // misconfiguration is visible rather than silently running some other rule set.
    yield* write(`falsestart: ${options.problem}\n`, stdio.stderr())
    return yield* new Exit({ code: brokenCode })
  }

  /**
   * What a failure costs once the mode IS known, which the two paths above cannot ask.
   *
   * `brokenCode` has to answer before the mode exists: an `Invalid` parse carries none, and the
   * default mode is the hook, where exit 2 BLOCKS the write and the runtime throws stdout away. So
   * an argument error keeps the fail-open 1 even when `--list-rules` was written — a mis-typed hook
   * command must not become an outage. `--list-rules` claims 2 only from here down, where the run
   * is already producing a JSON document rather than a hook decision.
   */
  const failureCode = options._tag === 'ListRules' ? ScanExit.Broken : brokenCode

  const projectDirectory = process.cwd()

  /**
   * Every directory this invocation loads rules from, shipped set first.
   *
   * A list rather than a single directory since `--preset` and `--rules` combine. Order is the
   * order they are REPORTED and merged in, never a precedence: an id two of them define is refused
   * by `mergeRuleSets` rather than resolved, so nothing here can silently substitute one rule for
   * another. Non-empty by construction — the parser leaves `rulesDirectory` at its default whenever
   * nothing else names a source.
   */
  const located = yield* Effect.result(
    Effect.try({
      catch: String,
      try: (): readonly string[] => [
        ...(options.preset === undefined ? [] : [presetDirectory(options.preset, PACKAGED_RULES_ROOT)]),
        ...(options.rulesPackage === undefined
          ? options.rulesDirectory === undefined
            ? []
            : [options.rulesDirectory]
          : [packageRulesDirectory(options.rulesPackage, projectDirectory)]),
      ],
    }),
  )

  const unresolvedRules =
    located._tag === 'Failure' ? `could not resolve rules package (${located.failure})` : undefined

  // `scan` and `--list-rules` answer it right here, as they always have: neither emits a hook
  // decision, and neither has a payload to be silent about. The other two must NOT — this is
  // discovered before stdin is read, so refusing here would deny `Bash`, `Read` and every other tool
  // call an agent makes over a payload that writes nothing. The hook carries it into `respond`,
  // which answers it behind `judgesPayload`; `--doctor` carries it into `diagnose`, which otherwise
  // produces no report at all for the one question it exists to answer.
  if (unresolvedRules !== undefined && options._tag !== 'Run' && options._tag !== 'Doctor') {
    yield* write(`falsestart: ${unresolvedRules}\n`, stdio.stderr())
    return yield* new Exit({ code: failureCode })
  }

  // Inert under `Run`/`Doctor` when the resolution failed: `respond` returns before it reads this,
  // and `diagnose` returns before it loads from it.
  const directories: readonly string[] =
    located._tag === 'Failure' ? [options.rulesDirectory ?? DEFAULT_RULES_DIRECTORY] : located.success

  /**
   * The one directory a freeze can govern, and the one a write into a rule document is judged
   * against: the LAST, which is the caller's own.
   *
   * A preset and a `pkg:` specifier both resolve inside `node_modules`, which git does not track
   * here, so freezing either is already a no-op — `resolveRulesPath` classifies it as outside the
   * project repository and the working tree stays in effect. Pointing the freeze at the caller's
   * own directory when there is one is therefore strictly more coverage than before, never less.
   */
  const rulesDirectory = directories.at(-1) ?? DEFAULT_RULES_DIRECTORY

  /** The sources loaded ahead of `rulesDirectory` — a preset, and never frozen. */
  const shippedDirectories = directories.slice(0, -1)

  const ruleSources = (outcome: FreezeOutcome) =>
    ruleSourcesOf({
      frozenRules: heldBy(outcome.rules),
      rulesDirectory,
      shipped: shippedRuleSources(outcome, shippedDirectories),
    })

  /**
   * The freeze for whichever mode is running, built from the same command line every time.
   *
   * `--doctor`, `--list-rules` and `scan` invoke it immediately, having no payload to gate on; the
   * hook hands it over as a thunk, so a tool call it does not judge never spawns git at all.
   */
  const freezeFor = () =>
    resolveFreeze({
      configPath: options.configPath,
      mode: options.freeze,
      projectDirectory,
      ref: options.freezeRef,
      // A ref the caller NAMED is a statement that it exists, so failing to resolve it is
      // unambiguously broken rather than a fresh-repository special case.
      refExplicit: options.freezeRef !== DEFAULT_FREEZE_REF,
      rulesDirectory,
      shippedDirectories,
    })

  /** The documents a frozen source holds, or nothing when the working tree is what is in effect. */
  const heldBy = (source: Frozen) => (source._tag === 'Frozen' ? source.documents : undefined)

  const brokenFreeze = (outcome: FreezeOutcome): string | undefined =>
    [outcome.rules, outcome.config, ...(outcome.shipped ?? []).map((entry) => entry.source)].flatMap((source) =>
      source._tag === 'Broken' ? [source.reason] : [],
    )[0]

  if (options._tag === 'Scan') {
    // Paths on stdin only when asked for. Reading it unconditionally is how `--rules --doctor`
    // once hung with no output: a mode that waits on input nobody is sending looks identical to a
    // slow one.
    const piped = options.pathSource === 'Argv' ? '' : yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)
    const delimiter = options.pathSource === 'Nul' ? '\u0000' : '\n'
    const paths = [
      ...options.paths,
      ...piped
        .split(delimiter)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ]

    // `scan` already fails closed, so a freeze it cannot honour keeps that policy rather than
    // silently gating against the working tree.
    const frozen = yield* freezeFor()
    const refused = brokenFreeze(frozen)
    if (refused !== undefined) {
      yield* write(`falsestart: ${refused}\n`, stdio.stderr())
      return yield* new Exit({ code: ScanExit.Broken })
    }

    const prepared = yield* Effect.result(
      Effect.gen(function* () {
        const loaded = yield* loadRuleSources(ruleSources(frozen))
        const configured =
          options.configPath === undefined
            ? yield* loadDefaultConfig(projectDirectory, heldBy(frozen.config))
            : yield* loadConfigFile(options.configPath, heldBy(frozen.config)?.get(basename(options.configPath)))
        return { exclude: configured.exclude ?? [], rules: yield* applyScopeOverrides(loaded, configured) }
      }),
    )

    if (prepared._tag === 'Failure') {
      yield* write(`falsestart: ${prepared.failure.reasons.join('\n')}\n`, stdio.stderr())
      return yield* new Exit({ code: ScanExit.Broken })
    }

    const loadedBaseline = yield* Effect.result(readBaseline(options.baselinePath))
    if (loadedBaseline._tag === 'Failure') {
      yield* write(`falsestart: ${loadedBaseline.failure.reason}\n`, stdio.stderr())
      return yield* new Exit({ code: ScanExit.Broken })
    }
    const accepted = loadedBaseline.success
    const report = yield* Effect.result(
      scan({
        baseline: accepted,
        // The config is the repository's standing policy; the flag is this run's addition to it.
        // Neither replaces the other, or one of them silently drops what the other established.
        exclude: [...prepared.success.exclude, ...options.exclude],
        gitignored: gitIgnored(paths, projectDirectory),
        paths,
        projectDirectory,
        rules: prepared.success.rules,
      }),
    )

    if (report._tag === 'Failure') {
      yield* write(`falsestart: ${report.failure.path}: ${report.failure.reason}\n`, stdio.stderr())
      return yield* new Exit({ code: ScanExit.Broken })
    }

    if (options.writeBaseline && options.baselinePath !== undefined) {
      const all = report.success.scanned.flatMap((file) =>
        file.findings.map((finding) => fingerprint(file.path, finding)),
      )
      // Wrapped like every other fallible step here. Left bare, a write failure propagated to
      // `runMain`, which exits 1 with no output at all — silence, and the code that means "your
      // code has violations" rather than "this could not run".
      const wrote = yield* Effect.result(writeBaseline(options.baselinePath, all))
      if (wrote._tag === 'Failure') {
        yield* write(`falsestart: ${wrote.failure.reason}\n`, stdio.stderr())
        return yield* new Exit({ code: ScanExit.Broken })
      }

      yield* write(`falsestart: wrote ${all.length} accepted finding(s) to ${options.baselinePath}\n`, stdio.stdout())
      return
    }

    const outcome = render(report.success)
    yield* write(`${outcome.text}\n`, stdio.stdout())
    return yield* outcome.exitCode === ScanExit.Clean ? Effect.void : new Exit({ code: outcome.exitCode })
  }

  // Like `--doctor`, this answers a question about the installation, so it must not wait on a
  // payload that will never arrive.
  if (options._tag === 'ListRules') {
    const frozen = yield* freezeFor()
    const refused = brokenFreeze(frozen)
    if (refused !== undefined) {
      yield* write(`falsestart: ${refused}\n`, stdio.stderr())
      return yield* new Exit({ code: ScanExit.Broken })
    }

    const resolved = yield* Effect.result(
      Effect.gen(function* () {
        const loaded = yield* loadRuleSources(ruleSources(frozen))
        const configured =
          options.configPath === undefined
            ? yield* loadDefaultConfig(projectDirectory, heldBy(frozen.config))
            : yield* loadConfigFile(options.configPath, heldBy(frozen.config)?.get(basename(options.configPath)))
        return yield* applyScopeOverrides(loaded, configured)
      }),
    )

    if (resolved._tag === 'Failure') {
      yield* write(`falsestart: ${resolved.failure.reasons.join('\n')}\n`, stdio.stderr())
      return yield* new Exit({ code: ScanExit.Broken })
    }

    const wrote = yield* Effect.result(write(yield* ruleListText(resolved.success), stdio.stdout()))

    // A reader that stopped reading is not this command's failure. `| head`, `| grep -q` and the
    // reference's own `| jq` sample all close the pipe once they have what they came for, and the
    // write that lands after that fails with EPIPE — which, propagated, exits 1 and so claims the
    // command line was refused. Only the broken pipe is forgiven; anything else still fails
    // exactly as it did. `--doctor` has the same edge, and changing an existing flag is a
    // different change.
    if (wrote._tag === 'Failure' && !isBrokenPipe(wrote.failure)) {
      return yield* Effect.fail(wrote.failure)
    }
    return
  }

  // `--doctor` answers a question about the installation, so it must not wait on a payload that
  // will never arrive. Reading stdin below happens only on the judging path.
  if (options._tag === 'Doctor') {
    const diagnosis = yield* diagnose({
      agent: options.agent,
      changelogPath: CHANGELOG_PATH,
      configPath: options.configPath,
      failure: options.failure,
      freeze: yield* freezeFor(),
      projectDirectory,
      rulesDirectory,
      shippedDirectories,
      unresolvedRules,
      version: VERSION,
    })

    yield* write(`${diagnosis.lines.join('\n')}\n`, stdio.stdout())
    return yield* diagnosis.healthy ? Effect.void : new Exit({ code: 1 })
  }

  // Read stdin only once there is something to do with it.
  const input = yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)

  const response = yield* respond({
    agent: options.agent,
    configPath: options.configPath,
    failure: options.failure,
    freeze: freezeFor,
    input,
    // The process runs in the project, which is where a repo's own config lives — not beside the
    // rules, which `--preset` and `pkg:` both put inside node_modules.
    projectDirectory,
    rulesDirectory,
    shippedDirectories,
    unresolvedRules,
    warnUnscoped: options.warnUnscoped,
  })

  // A reader that stopped reading is not this command's failure, and `runMain` exits 1 on anything
  // that escapes — which under Copilot denies the tool call. `--list-rules` already forgives this
  // for the same reason; the hook path had no forgiveness at all.
  const wrote = yield* Effect.result(emit(response))
  if (wrote._tag === 'Failure' && !isBrokenPipe(wrote.failure)) {
    return yield* Effect.fail(wrote.failure)
  }

  return yield* response.exitCode === 0 ? Effect.void : new Exit({ code: response.exitCode })
})

/**
 * Warnings Node emits while loading a config, once per judged tool call.
 *
 * `stripTypeScriptTypes` is experimental, and a `.js` config in a package without
 * `"type": "module"` triggers a reparse warning. Both fire on every single write an agent makes,
 * on the same stream falsestart reports real problems on — the first `.ts` config run through the
 * built binary had its actual error buried under one. Neither is actionable from inside a hook.
 *
 * Only these two are dropped, matched by name, and only in the executable: a library has no
 * business editing the host process's output policy.
 */
const SILENCED_WARNINGS = ['stripTypeScriptTypes', 'MODULE_TYPELESS_PACKAGE_JSON']

const silenceConfigLoadingWarnings = (): void => {
  const passThrough = process.emitWarning.bind(process)

  // `never[]` is what makes the spread at the end assignable to every `emitWarning` overload.
  // Reading the arguments needs them widened, and a widening ASSIGNMENT is checked where an
  // assertion is not — `never` is assignable to `unknown`, so nothing is being claimed here.
  process.emitWarning = (warning, ...rest: readonly never[]): void => {
    const args: readonly unknown[] = rest

    // The identifying code can arrive in any of the trailing arguments, including inside an
    // options object, so every one is folded into the text before matching. Checking only the
    // first silently let MODULE_TYPELESS_PACKAGE_JSON through.
    const described = args.map((argument) => (typeof argument === 'string' ? argument : JSON.stringify(argument)))
    // `String(warning)` is a raw coercion of a `string | Error`, which cannot fail and so hides a
    // wrong value. Naming both cases says which text is actually being matched against.
    const text = [warning instanceof Error ? warning.message : warning, ...described].join(' ')

    if (SILENCED_WARNINGS.some((silenced) => text.includes(silenced))) {
      return
    }
    passThrough(warning, ...rest)
  }
}

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeStdio.layer)

// Error reporting is off because every message this program has to give has already been written
// to stderr in the shape the hook contract expects; re-reporting would double it.
silenceConfigLoadingWarnings()

NodeRuntime.runMain(program.pipe(applyExit, Effect.provide(platform)), { disableErrorReporting: true })
