#!/usr/bin/env node
/**
 * The executable. Reads a PreToolUse hook payload on stdin and emits a decision.
 *
 * Everything interesting happens in `respond` and `parseArguments`; this file exists to connect
 * them to the process, and is deliberately the only place that names a runtime or a process.
 */
import { NodeFileSystem, NodePath, NodeRuntime, NodeStdio } from '@effect/platform-node'
import { Data, Effect, Layer, Stdio, Stream } from 'effect'
import { parseArguments } from './hook/options.ts'
import type { HookResponse } from './hook/respond.ts'
import { respond } from './hook/respond.ts'

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

const program = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const options = parseArguments(yield* stdio.args)

  if (options._tag === 'Help') {
    return yield* write(`${options.text}\n`, stdio.stdout())
  }

  if (options._tag === 'Invalid') {
    // Refusing the run is itself the non-blocking error notice: the write proceeds, but the
    // misconfiguration is visible rather than silently running some other rule set.
    yield* write(`falsestart: ${options.problem}\n`, stdio.stderr())
    return yield* new Exit({ code: 1 })
  }

  // Read stdin only once there is something to do with it.
  const input = yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)
  const response = yield* respond(options.rulesDirectory, input, options.configPath)

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

  process.emitWarning = (warning, ...rest: readonly never[]): void => {
    // The identifying code can arrive in any of the trailing arguments, including inside an
    // options object, so every one is folded into the text before matching. Checking only the
    // first silently let MODULE_TYPELESS_PACKAGE_JSON through.
    const described = (rest as readonly unknown[]).map((argument) =>
      typeof argument === 'string' ? argument : JSON.stringify(argument),
    )
    const text = [String(warning), ...described].join(' ')

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
