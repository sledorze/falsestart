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
import { Data, Effect, Layer, Stdio, Stream } from 'effect'
import { packageRulesDirectory, parseArguments, presetDirectory } from './cli/index.ts'
import type { HookResponse } from './hook/index.ts'
import { diagnose, respond } from './hook/index.ts'

/**
 * Carries a non-zero exit out of the program. A typed error rather than a bare failure, so the
 * intent is legible where it is raised and where it is handled.
 */
class Exit extends Data.TaggedError('Exit')<{ readonly code: number }> {}

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

const program = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const options = parseArguments(yield* stdio.args)

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
    return yield* new Exit({ code: 1 })
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
    return yield* new Exit({ code: 1 })
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

NodeRuntime.runMain(program.pipe(Effect.provide(platform)), { disableErrorReporting: true })
