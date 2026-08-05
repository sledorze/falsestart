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

const collect = (stream: Stream.Stream<Uint8Array, unknown>) => stream.pipe(Stream.decodeText(), Stream.mkString)

const runCliRaw = (args: readonly string[], payload: string) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const stdin = Stream.make(new TextEncoder().encode(payload))
    const handle = yield* spawner.spawn(ChildProcess.make('node', [CLI, ...args], { stdin }))

    const stdout = yield* collect(handle.stdout)
    const stderr = yield* collect(handle.stderr)
    const exitCode = yield* handle.exitCode

    return { exitCode, stderr, stdout } satisfies CliResult
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

/**
 * A rule with BOTH scope keys, for the override test.
 *
 * Its own fixture rather than the shared `noAsAny`, which carries no `ignores` at all — asserting
 * that an unnamed `ignores` survives an override would then be comparing `null` with `null` and
 * proving nothing.
 */
const scopedRule = `
id: scoped-rule
language: tsx
severity: error
message: 'placeholder'
rule:
  pattern: $X as any
files:
  - '**/*.{ts,tsx}'
ignores:
  - '**/*.test.{ts,tsx}'
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

  // Most of an agent's traffic is tool calls falsestart has no opinion about, and the story for
  // running a shell guard beside it rests on this costing nothing and saying nothing. The
  // in-process test asserts exit code and stdout; a hook command that wrote to STDERR would still
  // be a hook command putting a line in front of the user on every `Bash` call, and only a real
  // process can see that stream at all. The rules directory holds a real rule on purpose, so this
  // says "rules were available and still nothing happened".
  it.effect('says nothing on either stream for a tool call it does not judge', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const result = yield* runCli(rules, payloadFor({ command: 'npm install lodash' }, 'Bash'))

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe('')
        expect(result.stderr).toBe('')
      }),
    ),
  )

  // "The last `--rules` wins" is the plausible sentence and it is false across the two FORMS: they
  // write different fields, and `cli.ts` prefers the package whichever order they arrived in. That
  // precedence lives in the wiring, which is excluded from the coverage ratchet and from mutation
  // testing, so nothing but a process observes it — and the reference has to state what is
  // observable rather than what is natural to write.
  it.effect('prefers a rules package over a rules directory whichever came first', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const configPath = yield* withEmptyConfig(rules)
        const payload = payloadFor({ content: 'const x = v as any', file_path: '/r/a.ts' })
        const both = (first: readonly string[], second: readonly string[]) =>
          runCliRaw(['--rules', ...first, '--rules', ...second, '--config', configPath], payload)

        // An unresolvable package is the probe: its failure is loud, specific and non-blocking, so
        // "the package won" and "the directory won" cannot be confused with each other.
        for (const result of [
          yield* both([rules], ['pkg:@nope/definitely-missing']),
          yield* both(['pkg:@nope/definitely-missing'], [rules]),
        ]) {
          expect(result.exitCode).toBe(1)
          expect(result.stdout).toBe('')
          expect(result.stderr).toContain('could not resolve rules package')
        }
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

  it.effect('--doctor names a changelog that is really inside the installation it reports on', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        // Only a process can check this. The path is computed in `cli.ts` from `import.meta.url`,
        // `cli.ts` is excluded from coverage, and every unit test injects the path itself — so the
        // one value that is actually hard to get right is asserted by nothing. It is hard because
        // the tsc emit and the esbuild bundle do not sit at the same depth: re-anchoring it to
        // `../../CHANGELOG.md` leaves all 390 other tests green while the line silently disappears
        // from the shipped binary. Checked by doing it.
        const fs = yield* FileSystem.FileSystem
        const configPath = yield* withEmptyConfig(rules)
        const result = yield* runCliRaw(['--doctor', '--rules', rules, '--config', configPath], '')

        const reported = result.stdout.split('\n').find((line) => line.startsWith('changes')) ?? ''
        expect(reported).toContain('CHANGELOG.md')

        // Naming a path is worth nothing if the path is not there — which is the entire complaint
        // this feature answers, so it must not be reproduced by the feature itself.
        const named = reported.slice('changes'.length).trim().split(' ')[0] ?? ''
        expect(yield* fs.exists(named)).toBeTruthy()
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

  // Note the name. This helper closes stdin immediately, so it cannot observe "never reads stdin":
  // an implementation that read it would not hang, it would take the judging path on an empty
  // payload and exit 1 complaining about the JSON. The existing `--doctor` test's name claims that
  // observation and does not make it either.
  it.effect('--list-rules writes the resolved rule set to stdout and says nothing on stderr', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const configPath = yield* withEmptyConfig(rules)
        const result = yield* runCliRaw(['--list-rules', '--rules', rules, '--config', configPath], '')

        expect(result.exitCode).toBe(0)
        expect(result.stderr).toBe('')
        expect(JSON.parse(result.stdout)).toEqual([
          {
            files: ['**/*.{ts,tsx}'],
            id: 'no-as-any',
            ignores: null,
            language: 'tsx',
            severity: 'error',
          },
        ])
      }),
    ),
  )

  // "Resolved, not raw" is the whole claim of this flag, and it lives only in the wiring: the
  // config is loaded and applied in `cli.ts`, which no in-process test can see. Both halves are
  // asserted, because an override REPLACES `files` while leaving an `ignores` it did not name — so
  // a merge that quietly dropped the rule's own exemption would look like a narrower scope.
  it.effect('--list-rules reports the config globs, and keeps the ignores the override did not name', () =>
    withRules({ 'scoped-rule.yml': scopedRule }, (rules) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const configPath = path.join(rules, 'scoped.config.json')
        yield* fs.writeFileString(
          configPath,
          JSON.stringify({ rules: { 'scoped-rule': { files: ['src/domain/**/*.ts'] } } }),
        )

        const result = yield* runCliRaw(['--list-rules', '--rules', rules, '--config', configPath], '')

        expect(result.exitCode).toBe(0)
        expect(JSON.parse(result.stdout)).toEqual([
          {
            files: ['src/domain/**/*.ts'],
            id: 'scoped-rule',
            ignores: ['**/*.test.{ts,tsx}'],
            language: 'tsx',
            severity: 'error',
          },
        ])
      }),
    ),
  )

  it.effect('--list-rules exits 2 on a rule tree that will not load, with nothing on stdout', () =>
    withRules({ 'broken.yml': 'id: 7\nlanguage: tsx' }, (rules) =>
      Effect.gen(function* () {
        // 2, not the hook's 1: this command answers a script, and a document that could not be
        // produced must not be confused with an empty one.
        const configPath = yield* withEmptyConfig(rules)
        const result = yield* runCliRaw(['--list-rules', '--rules', rules, '--config', configPath], '')

        expect(result.exitCode).toBe(2)
        expect(result.stdout).toBe('')
        expect(result.stderr).toContain('broken.yml')
      }),
    ),
  )

  it.effect('--list-rules exits 2 when the rules package will not resolve', () =>
    withRules({}, (directory) =>
      Effect.gen(function* () {
        // The only test of the failure code on the resolution path, which runs before the mode's
        // own block and would otherwise keep the hook's 1.
        const configPath = yield* withEmptyConfig(directory)
        const result = yield* runCliRaw(
          ['--list-rules', '--rules', 'pkg:@acme/definitely-not-installed', '--config', configPath],
          '',
        )

        expect(result.exitCode).toBe(2)
        expect(result.stderr).toContain('could not resolve rules package')
      }),
    ),
  )

  it.effect('a refused command line keeps the hook non-blocking 1, even when --list-rules was written', () =>
    Effect.gen(function* () {
      // The refusal happens before any mode exists, and the default mode is the hook — where exit
      // 2 BLOCKS the write and the runtime discards stdout (`docs/reference.md`). A mis-typed hook
      // command that happened to name --list-rules must not become an outage, so the shared
      // fail-open 1 stands whatever flags were written.
      const result = yield* runCliRaw(['--list-rules', '--bogus'], '')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('--bogus')
    }),
  )

  it.effect('there is no --json flag; it is refused rather than accepted and ignored', () =>
    Effect.gen(function* () {
      // Settled deliberately: the output is JSON because that is the only thing this command is
      // for, and a flag accepted that changes nothing is what this CLI refuses everywhere else.
      // The human rendering of the same resolution already exists, and it is `--doctor`.
      const result = yield* runCliRaw(['--list-rules', '--json'], '')

      expect(result.exitCode).toBe(1)
      expect(result.stderr).toContain('unrecognised argument: --json')
    }),
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
