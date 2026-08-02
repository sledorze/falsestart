#!/usr/bin/env node
/**
 * The executable. Reads a PreToolUse hook payload on stdin and emits a decision.
 *
 * Everything interesting happens in `respond`; this file exists to connect it to the process, and
 * is deliberately the only place that knows a process exists at all.
 */
import { NodeFileSystem, NodePath, NodeRuntime, NodeStdio } from '@effect/platform-node'
import { Effect, Layer, Stdio, Stream } from 'effect'
import { respond } from './hook/respond.ts'

/** Where rules live, relative to wherever the hook is run from. */
const DEFAULT_RULES_DIRECTORY = '.falsestart/rules'

const rulesDirectoryFrom = (args: readonly string[]): string => {
  const flag = args.indexOf('--rules')
  return flag === -1 ? DEFAULT_RULES_DIRECTORY : (args[flag + 1] ?? DEFAULT_RULES_DIRECTORY)
}

const program = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio
  const args = yield* stdio.args
  const input = yield* stdio.stdin.pipe(Stream.decodeText(), Stream.mkString)

  const response = yield* respond(rulesDirectoryFrom(args), input)

  if (response.stdout !== undefined) {
    yield* Stream.make(response.stdout).pipe(Stream.run(stdio.stdout()))
  }
  if (response.stderr !== undefined) {
    yield* Stream.make(`${response.stderr}\n`).pipe(Stream.run(stdio.stderr()))
  }

  // A non-zero exit is the contract's "non-blocking error notice". Failing the effect is how that
  // reaches the process; the message has already been written, so reporting it again would double
  // up the output the user sees.
  return yield* response.exitCode === 0 ? Effect.void : Effect.fail(undefined)
})

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeStdio.layer)

NodeRuntime.runMain(program.pipe(Effect.provide(platform)), { disableErrorReporting: true })
