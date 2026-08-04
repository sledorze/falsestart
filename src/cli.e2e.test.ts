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
import { expect, layer } from '@effect/vitest'
import { Effect, FileSystem, Layer, Path, Stream } from 'effect'
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

const runCliRaw = (args: readonly string[], payload: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const stdin = Stream.make(new TextEncoder().encode(payload))
    const handle = yield* spawner.spawn(ChildProcess.make('node', [CLI, ...args], { stdin }))

    const stdout = yield* collect(handle.stdout)
    const stderr = yield* collect(handle.stderr)
    const exitCode = yield* handle.exitCode

    return { exitCode: exitCode as number, stderr, stdout } satisfies CliResult
  }).pipe(Effect.scoped, Effect.orDie)

/**
 * Every run passes an explicit empty `--config`, so the executable is judged on the rule set the
 * test gave it and nothing else.
 *
 * Without this the spawned process inherits the repo's own `falsestart.config.ts` from `cwd`, whose
 * overrides name rules these temp directories do not contain — and an override for an unloaded rule
 * is a deliberate hard error, so three of these tests started exiting 1 the moment this repo grew a
 * config. A developer's config must not be able to change what the e2e suite measures.
 */
const withEmptyConfig = (directory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const configPath = path.join(directory, 'empty.config.json')
    yield* fs.writeFileString(configPath, JSON.stringify({ rules: {} }))
    return configPath
  })

const runCli = (rulesDirectory: string, payload: string) =>
  Effect.gen(function* () {
    const configPath = yield* withEmptyConfig(rulesDirectory)
    return yield* runCliRaw(['--rules', rulesDirectory, '--config', configPath], payload)
  })

/**
 * Build once, so the tests judge the artifact that actually ships rather than the sources.
 *
 * A Layer rather than `beforeAll`: setup that a test depends on belongs in the test's environment,
 * where the dependency is visible, instead of in a hook that mutates shared state out of band.
 * falsestart's own `no-test-lifecycle-hooks` rule says so, and it applies to this file.
 */
const Built = Layer.effectDiscard(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    yield* spawner.exitCode(ChildProcess.make('pnpm', ['run', 'build']))
  }).pipe(Effect.orDie),
).pipe(Layer.provide(spawnerLayer))

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
  }).pipe(Effect.scoped)

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

layer(Layer.mergeAll(spawnerLayer, Built), { timeout: 120_000 })('falsestart executable', (it) => {
  it.effect('blocks a violating write with exit 0 and a deny decision on stdout', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const result = yield* runCli(rules, payloadFor({ content: 'const x = v as any', file_path: '/r/a.ts' }))

        expect(result.exitCode).toBe(0)
        expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
      }),
    ),
  )

  it.effect('stays completely silent on a clean write', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const result = yield* runCli(rules, payloadFor({ content: 'const x = v as W', file_path: '/r/a.ts' }))

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe('')
      }),
    ),
  )

  it.effect('leaves an out-of-scope path alone despite identical violating content', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const result = yield* runCli(rules, payloadFor({ content: 'const x = v as any', file_path: '/r/notes.md' }))

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe('')
      }),
    ),
  )

  it.effect('refuses an unrecognised flag instead of running a different rule set', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        // Previously this fell back to the default directory and looked like a working guard.
        const result = yield* runCliRaw(['--rulez', rules], payloadFor({ content: 'x', file_path: '/r/a.ts' }))

        expect(result.exitCode).toBe(1)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain('--rulez')
      }),
    ),
  )

  it.effect('--doctor reports and exits without ever reading stdin', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        // Deliberately no payload. The unit tests cannot observe this: a hang is a property of the
        // process, and the flag that caused one parsed into a perfectly well-formed `Run`.
        // The explicit config is the same isolation `runCli` uses — spawned in this repo, the
        // process would otherwise pick up its `falsestart.config.ts` and reject overrides for rules
        // this temp directory does not contain.
        const configPath = yield* withEmptyConfig(rules)
        const result = yield* runCliRaw(['--doctor', '--rules', rules, '--config', configPath], '')

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('rule(s) apply to')
      }),
    ),
  )

  it.effect('refuses a flag where a value belongs, rather than waiting on a payload', () =>
    Effect.gen(function* () {
      // `--rules -x` consumed the flag as the directory and blocked on stdin forever, with no
      // output to explain itself. Single dash counts: `-h` is a documented flag.
      const result = yield* runCliRaw(['--rules', '-x'], '')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('--rules needs a value')
    }),
  )

  it.effect('prints the version, and refuses it when a value was forgotten', () =>
    Effect.gen(function* () {
      const printed = yield* runCliRaw(['--version'], '')
      expect(printed.exitCode).toBe(0)
      expect(printed.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)

      // `--version` must not short-circuit validation: this is a forgotten `--rules` value.
      const refused = yield* runCliRaw(['--rules', '--version'], '')
      expect(refused.exitCode).toBe(1)
    }),
  )

  it.effect('refuses --rules with no directory', () =>
    withRules({}, () =>
      Effect.gen(function* () {
        const result = yield* runCliRaw(['--rules'], payloadFor({ content: 'x', file_path: '/r/a.ts' }))

        expect(result.exitCode).toBe(1)
        expect(result.stderr).toContain('--rules')
      }),
    ),
  )

  it.effect('prints usage for --help without waiting on stdin', () =>
    withRules({}, () =>
      Effect.gen(function* () {
        const result = yield* runCliRaw(['--help'], '')

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('--rules')
      }),
    ),
  )

  it.effect('reports a broken rule tree without blocking, on exit 1', () =>
    withRules({ 'broken.yml': 'id: 7\nlanguage: tsx' }, (rules) =>
      Effect.gen(function* () {
        const result = yield* runCli(rules, payloadFor({ content: 'const x = v as any', file_path: '/r/a.ts' }))

        expect(result.exitCode).toBe(1)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain('falsestart')
      }),
    ),
  )

  // `scan` had no process-level test at all, and that is exactly how a silent failure shipped:
  // `writeBaseline` was called unwrapped, so a write error propagated to `runMain` and exited 1
  // with no output — the code meaning "your code has violations" rather than "this could not run".
  // Its unit tests passed throughout, because the defect was in the WIRING, and `cli.ts` is
  // excluded from both the coverage ratchet and mutation testing. Only a real process can see it.
  it.effect('scan reports findings and stops the commit', () =>
    withRules({ 'a.ts': 'const x = v as any', 'no-as-any.yml': noAsAny }, (root) =>
      Effect.gen(function* () {
        const configPath = yield* withEmptyConfig(root)
        const result = yield* runCliRaw(['scan', '--rules', root, '--config', configPath, `${root}/a.ts`], '')

        expect(result.exitCode).toBe(1)
        expect(result.stdout).toContain('no-as-any')
        expect(result.stdout).toContain('1 in scope')
      }),
    ),
  )

  it.effect('scan accepts what a baseline already carries, and says so', () =>
    withRules({ 'a.ts': 'const x = v as any', 'no-as-any.yml': noAsAny }, (root) =>
      Effect.gen(function* () {
        const configPath = yield* withEmptyConfig(root)
        const baseline = `${root}/baseline.json`
        const scan = (extra: readonly string[]) =>
          runCliRaw(
            ['scan', '--rules', root, '--config', configPath, '--baseline', baseline, ...extra, `${root}/a.ts`],
            '',
          )

        const wrote = yield* scan(['--update-baseline'])
        expect(wrote.exitCode).toBe(0)
        expect(wrote.stdout).toContain('accepted finding(s)')

        const after = yield* scan([])
        expect(after.exitCode).toBe(0)
        expect(after.stdout).toContain('accepted by baseline')
      }),
    ),
  )

  it.effect('scan says why it could not write a baseline, rather than failing silently', () =>
    withRules({ 'a.ts': 'const x = v as any', 'no-as-any.yml': noAsAny }, (root) =>
      Effect.gen(function* () {
        const configPath = yield* withEmptyConfig(root)
        const result = yield* runCliRaw(
          [
            'scan',
            '--rules',
            root,
            '--config',
            configPath,
            '--baseline',
            `${root}/no-such-directory/baseline.json`,
            '--update-baseline',
            `${root}/a.ts`,
          ],
          '',
        )

        // 2, not 1: a gate that cannot tell "your code has violations" from "the gate is broken"
        // is one people learn to bypass.
        expect(result.exitCode).toBe(2)
        expect(result.stderr).toContain('baseline.json')
      }),
    ),
  )

  it.effect('scan never judges a dependency, and counts what it left alone', () =>
    withRules({ 'a.ts': 'const x = v as any', 'no-as-any.yml': noAsAny }, (root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* fs.makeDirectory(path.join(root, 'node_modules', 'pkg'), { recursive: true })
        yield* fs.writeFileString(path.join(root, 'node_modules', 'pkg', 'i.ts'), 'const y = v as any')

        const configPath = yield* withEmptyConfig(root)
        const result = yield* runCliRaw(
          ['scan', '--rules', root, '--config', configPath, `${root}/a.ts`, `${root}/node_modules/pkg/i.ts`],
          '',
        )

        expect(result.stdout).toContain('1 excluded')
        expect(result.stdout).not.toContain('node_modules')
      }),
    ),
  )

  // `--preset` is how the documentation tells everyone to start, and it appeared nowhere in this
  // suite — the packaged-rules path was never once run as a process. It is also the path that
  // depends on `import.meta.url` pointing at the bundled `dist/cli.js`, which no in-process test
  // can observe: resolve `../rules` from the wrong artifact and the guard loads nothing at all.
  it.effect('loads the packaged rules through --preset and blocks with them', () =>
    withRules({}, (directory) =>
      Effect.gen(function* () {
        const configPath = yield* withEmptyConfig(directory)
        const result = yield* runCliRaw(
          ['--preset', 'clean-code', '--config', configPath],
          payloadFor({ content: 'const x = v as any', file_path: `${directory}/src/a.ts` }),
        )

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('"permissionDecision":"deny"')
        expect(result.stdout).toContain('no-as-any')
      }),
    ),
  )

  it.effect('takes only the named subset of the packaged rules', () =>
    withRules({}, (directory) =>
      Effect.gen(function* () {
        const configPath = yield* withEmptyConfig(directory)
        // `no-await` is an Effect rule. Under `--preset clean-code` it must not be loaded, so this
        // write is allowed — the proof that a preset selects a subdirectory rather than everything.
        const result = yield* runCliRaw(
          ['--preset', 'clean-code', '--config', configPath],
          payloadFor({ content: 'const go = async () => await x', file_path: `${directory}/src/a.ts` }),
        )

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe('')
      }),
    ),
  )

  // The other half of `packageRulesDirectory`'s contract, which cannot honestly be tested in
  // process: under vitest the loader resolves through its own module graph, so a package that does
  // not exist on disk still resolves. Only a real node process does the filesystem walk.
  it.effect('reports an unresolvable rules package without blocking the write', () =>
    withRules({}, (directory) =>
      Effect.gen(function* () {
        const configPath = yield* withEmptyConfig(directory)
        const result = yield* runCliRaw(
          ['--rules', 'pkg:@acme/definitely-not-installed', '--config', configPath],
          payloadFor({ content: 'const x = v as any', file_path: `${directory}/src/a.ts` }),
        )

        // Visible, and NOT blocking: a missing dependency must not stop every write in the repo.
        expect(result.exitCode).toBe(1)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain('could not resolve rules package')
      }),
    ),
  )
})
