#!/usr/bin/env node
/**
 * The executable. Reads a PreToolUse hook payload on stdin and emits a decision.
 *
 * Everything interesting happens in `respond` and `parseArguments`; this file exists to connect
 * them to the process, and is deliberately the only place that names a runtime or a process.
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { NodeFileSystem, NodePath, NodeRuntime, NodeStdio } from '@effect/platform-node'
import { Data, Effect, FileSystem, Layer, Schema, Stdio, Stream } from 'effect'
import { packageRulesDirectory, parseArguments, presetDirectory } from './cli/index.ts'
import type { HookResponse } from './hook/index.ts'
import { diagnose, respond } from './hook/index.ts'
import { fingerprint, render, scan, ScanExit } from './scanning/index.ts'
import { applyScopeOverrides, loadConfigFile, loadDefaultConfig } from './config/index.ts'
import { loadRules } from './checking/index.ts'

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
 * The accepted-findings file: a flat JSON array of fingerprints.
 *
 * Deliberately not a rich record. A baseline is a second source of truth, and the way that stops
 * being a liability is by holding as little as possible and only ever shrinking — a fingerprint is
 * present or it is not. An absent file is an empty baseline rather than an error, so
 * `--baseline` can be wired into a hook before the file exists.
 */
const readBaseline = (
  baselinePath: string | undefined,
): Effect.Effect<ReadonlySet<string> | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (baselinePath === undefined) {
      return undefined
    }

    const fs = yield* FileSystem.FileSystem
    const text = yield* Effect.orElseSucceed(fs.readFileString(baselinePath), () => '[]')
    const parsed = yield* Effect.result(Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(text))

    return parsed._tag === 'Failure' || !Array.isArray(parsed.success)
      ? new Set<string>()
      : new Set(parsed.success.filter((entry): entry is string => typeof entry === 'string'))
  })

const writeBaselineFile = (
  baselinePath: string,
  fingerprints: readonly string[],
): Effect.Effect<void, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    // Sorted, so re-running produces the same bytes and a diff shows only what actually changed.
    const body = `${JSON.stringify([...fingerprints].toSorted(), undefined, 2)}\n`
    yield* Effect.orElseSucceed(fs.writeFileString(baselinePath, body), () => undefined)
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
  const brokenCode = args[0] === 'scan' ? ScanExit.Broken : 1

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

  const projectDirectory = process.cwd()

  const located = yield* Effect.result(
    Effect.try({
      catch: String,
      try: (): string => {
        if (options.preset !== undefined) {
          return presetDirectory(options.preset, PACKAGED_RULES_ROOT)
        }
        return options.rulesPackage === undefined
          ? options.rulesDirectory
          : packageRulesDirectory(options.rulesPackage, projectDirectory)
      },
    }),
  )

  // A rules package that will not resolve is reported like any other misconfiguration: visible,
  // and non-blocking, so a missing dependency cannot stop every write in the repo.
  if (located._tag === 'Failure') {
    yield* write(`falsestart: could not resolve rules package (${located.failure})\n`, stdio.stderr())
    return yield* new Exit({ code: brokenCode })
  }

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

    const prepared = yield* Effect.result(
      Effect.gen(function* () {
        const loaded = yield* loadRules(located.success)
        const configured =
          options.configPath === undefined
            ? yield* loadDefaultConfig(projectDirectory)
            : yield* loadConfigFile(options.configPath)
        return yield* applyScopeOverrides(loaded, configured)
      }),
    )

    if (prepared._tag === 'Failure') {
      yield* write(`falsestart: ${prepared.failure.reasons.join('\n')}\n`, stdio.stderr())
      return yield* new Exit({ code: ScanExit.Broken })
    }

    const accepted = yield* readBaseline(options.baselinePath)
    const report = yield* Effect.result(scan({ baseline: accepted, paths, projectDirectory, rules: prepared.success }))

    if (report._tag === 'Failure') {
      yield* write(`falsestart: ${report.failure.path}: ${report.failure.reason}\n`, stdio.stderr())
      return yield* new Exit({ code: ScanExit.Broken })
    }

    if (options.writeBaseline && options.baselinePath !== undefined) {
      const all = report.success.scanned.flatMap((file) =>
        file.findings.map((finding) => fingerprint(file.path, finding)),
      )
      yield* writeBaselineFile(options.baselinePath, all)
      yield* write(`falsestart: wrote ${all.length} accepted finding(s) to ${options.baselinePath}\n`, stdio.stdout())
      return
    }

    const outcome = render(report.success)
    yield* write(`${outcome.text}\n`, stdio.stdout())
    return yield* outcome.exitCode === ScanExit.Clean ? Effect.void : new Exit({ code: outcome.exitCode })
  }

  // `--doctor` answers a question about the installation, so it must not wait on a payload that
  // will never arrive. Reading stdin below happens only on the judging path.
  if (options._tag === 'Doctor') {
    const diagnosis = yield* diagnose({
      configPath: options.configPath,
      projectDirectory,
      rulesDirectory: located.success,
      version: VERSION,
    })

    yield* write(`${diagnosis.lines.join('\n')}\n`, stdio.stdout())
    return yield* diagnosis.healthy ? Effect.void : new Exit({ code: 1 })
  }

  // Read stdin only once there is something to do with it.
  const input = yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)

  const response = yield* respond({
    configPath: options.configPath,
    input,
    // The process runs in the project, which is where a repo's own config lives — not beside the
    // rules, which `--preset` and `pkg:` both put inside node_modules.
    projectDirectory,
    rulesDirectory: located.success,
    warnUnscoped: options.warnUnscoped,
  })

  yield* emit(response)

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
