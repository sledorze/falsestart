/**
 * Exercises the shipped executable as a process.
 *
 * The unit tests cover the decision logic; what only a real process can prove is the part that
 * lives outside them — that the bundle actually loads (the ast-grep native module has to stay
 * external, and a bundling regression is invisible to every in-process test), that stdin is read
 * to completion, and that the exit codes the hook contract depends on are the ones that reach the
 * operating system.
 */
import { NodeServices } from '@effect/platform-node'
import { beforeAll, describe, effect, expect } from '@effect/vitest'
import { Effect, FileSystem, Path, Stream } from 'effect'
import { ChildProcess, ChildProcessSpawner } from 'effect/unstable/process'

const CLI = 'dist/cli.js'

const spawnerLayer = NodeServices.layer

interface CliResult {
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
}

const collect = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString) as Effect.Effect<string, never, never>

const runCli = (rulesDirectory: string, payload: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const stdin = Stream.make(new TextEncoder().encode(payload))
    const handle = yield* spawner.spawn(ChildProcess.make('node', [CLI, '--rules', rulesDirectory], { stdin }))

    const stdout = yield* collect(handle.stdout)
    const stderr = yield* collect(handle.stderr)
    const exitCode = yield* handle.exitCode

    return { exitCode: exitCode as number, stderr, stdout } satisfies CliResult
  }).pipe(Effect.scoped, Effect.orDie)

/** Build once, so the test judges the artifact that actually ships rather than the sources. */
const build = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  yield* spawner.exitCode(ChildProcess.make('pnpm', ['run', 'build']))
}).pipe(Effect.orDie)

const withRules = <A, E>(
  files: Readonly<Record<string, string>>,
  use: (
    directory: string,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'falsestart-e2e-' })

    for (const [name, contents] of Object.entries(files)) {
      yield* fs.writeFileString(path.join(root, name), contents)
    }

    return yield* use(root)
  }).pipe(Effect.scoped, Effect.provide(spawnerLayer))

const noAsAny = `
id: no-as-any
language: tsx
severity: error
message: 'as any erases the type'
rule:
  pattern: $X as any
files:
  - '**/*.{ts,tsx}'
`

const payloadFor = (toolInput: Record<string, unknown>, toolName = 'Write') =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: toolInput, tool_name: toolName })

beforeAll(async () => {
  await Effect.runPromise(build.pipe(Effect.provide(spawnerLayer)))
}, 120_000)

describe('falsestart executable', () => {
  effect('blocks a violating write with exit 0 and a deny decision on stdout', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const result = yield* runCli(rules, payloadFor({ content: 'const x = v as any', file_path: '/r/a.ts' }))

        expect(result.exitCode).toBe(0)
        expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
      }),
    ),
  )

  effect('stays completely silent on a clean write', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const result = yield* runCli(rules, payloadFor({ content: 'const x = v as W', file_path: '/r/a.ts' }))

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe('')
      }),
    ),
  )

  effect('leaves an out-of-scope path alone despite identical violating content', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const result = yield* runCli(rules, payloadFor({ content: 'const x = v as any', file_path: '/r/notes.md' }))

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe('')
      }),
    ),
  )

  effect('reports a broken rule tree without blocking, on exit 1', () =>
    withRules({ 'broken.yml': 'id: 7\nlanguage: tsx' }, (rules) =>
      Effect.gen(function* () {
        const result = yield* runCli(rules, payloadFor({ content: 'const x = v as any', file_path: '/r/a.ts' }))

        expect(result.exitCode).toBe(1)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain('falsestart')
      }),
    ),
  )
})
