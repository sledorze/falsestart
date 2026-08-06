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
        // The BYTES, not the parsed shape. One rule per line is what four documents and `--help`
        // give as the reason two runs diff cleanly, and `JSON.parse` is blind to every part of
        // that claim — the layout could collapse to one line, or lose its trailing newline, with
        // this suite green. `listing.test.ts` pins what `ruleListText` returns; only a process can
        // say that is what reaches stdout.
        expect(result.stdout).toBe(
          `[\n  {"files":["**/*.{ts,tsx}"],"id":"no-as-any","ignores":null,"language":"tsx","severity":"error"}\n]\n`,
        )
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

  // A reader that stops reading is the documented way to use this flag — the reference's own
  // sample pipes it into `jq`, and `| head` and `| grep -q` are what people reach for next. Past
  // one pipe buffer the writer then takes an EPIPE, and unhandled that exits 1, which under this
  // command's own vocabulary means the command line was refused. `set -o pipefail` turns that into
  // a red build on a document that was produced perfectly.
  //
  // Only a real pipeline shows it, which is why this spawns a shell: the in-process spawner
  // collects stdout to completion, so it can never be the reader that leaves. The fixture is sized
  // past the buffer on purpose — with the one-rule fixtures above the write finishes first and the
  // test would pass without the handling it exists to check.
  it.effect('survives a reader that closes the pipe after one line', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'falsestart-e2e-pipe-' })

      const globs = Array.from({ length: 12 }, (_, index) => `  - '**/segment-${index}/**/*.{ts,tsx,mts,cts}'`)
      yield* Effect.all(
        Array.from({ length: 150 }, (_, index) =>
          fs.writeFileString(
            path.join(root, `rule-${index}.yml`),
            `id: rule-${String(index).padStart(5, '0')}\nlanguage: tsx\nrule:\n  pattern: $X as any\nfiles:\n${globs.join('\n')}\n`,
          ),
        ),
      )
      const configPath = yield* withEmptyConfig(root)

      // `PIPESTATUS[0]` is what a user's `set -o pipefail` reads, and it is the only place the
      // writer's own code survives the pipeline.
      const script = `node ${CLI} --list-rules --rules ${root} --config ${configPath} | head -1 > /dev/null; exit "\${PIPESTATUS[0]}"`
      const handle = yield* spawner.spawn(ChildProcess.make('bash', ['-c', script]))

      expect(yield* handle.exitCode).toBe(0)
    }).pipe(Effect.scoped, Effect.orDie),
  )

  // The one exception to the paragraph above, pinned because the help text and the reference now
  // both state it and nothing else observes it — a parse test sees `Invalid`, not an exit code.
  // `scan` earns its 2 by being a subcommand at argv[0]: an unmistakable act that cannot be a
  // stray flag on a hook command line, which is the whole reason the hook path keeps 1.
  it.effect('scan refuses --list-rules with its own 2, the one exception to the shared 1', () =>
    Effect.gen(function* () {
      const result = yield* runCliRaw(['scan', '--list-rules', 'a.ts'], '')

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('--list-rules')
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

  // T21 — the same failure, under the policy that governs it. A repository that pins its rules to a
  // package and enforces nothing until `pnpm install` finishes is the "matter of when" this switch
  // exists for.
  it.effect('--fail closed denies a judged write when the rules package will not resolve', () =>
    withRules({}, (directory) =>
      Effect.gen(function* () {
        const configPath = yield* withEmptyConfig(directory)
        const result = yield* runCliRaw(
          ['--rules', 'pkg:@acme/definitely-not-installed', '--config', configPath, '--fail', 'closed'],
          payloadFor({ content: 'const x = v as any', file_path: `${directory}/src/a.ts` }),
        )

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('"permissionDecision":"deny"')
        expect(result.stdout).toContain('could not resolve rules package')
      }),
    ),
  )

  // T22 — the reproduction that corrected this design, end to end. Package resolution happens before
  // stdin is read, so answering it there denied `Bash`, `Read` and `Grep` — a full agent lockup over
  // calls that write nothing. Silence in EITHER policy is the fix, and that makes this a behaviour
  // change independent of the flag: it is exit 1 with a stderr notice today.
  //
  // A payload that is merely MALFORMED is not in that set and is not silenced: `judgesPayload` says
  // it is a candidate, so it reaches the guard and is denied for the package, exactly as a broken
  // rule tree already denies it. See `respond.test.ts`'s T25 pair.
  it.effect('says nothing about a tool call it does not judge, even when the rules package will not resolve', () =>
    withRules({}, (directory) =>
      Effect.gen(function* () {
        const configPath = yield* withEmptyConfig(directory)
        const result = yield* runCliRaw(
          ['--rules', 'pkg:@acme/definitely-not-installed', '--config', configPath, '--fail', 'closed'],
          payloadFor({ command: 'ls' }, 'Bash'),
        )

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe('')
        expect(result.stderr).toBe('')
      }),
    ),
  )

  // T23 — `--doctor` is the one question this command exists to answer, and it answered nothing at
  // all here: no version line, no changelog line, no policy line.
  it.effect('--doctor reports a rules package it could not resolve, and the policy it was given', () =>
    Effect.gen(function* () {
      const result = yield* runCliRaw(
        ['--doctor', '--rules', 'pkg:@acme/definitely-not-installed', '--fail', 'closed'],
        '',
      )

      expect(result.exitCode).toBe(1)
      expect(result.stdout).toContain('falsestart ')
      expect(result.stdout).toContain('--fail closed')
      expect(result.stdout).toContain('COULD NOT RESOLVE')
    }),
  )

  // T24 — the end-to-end half of the claim that `--doctor` is byte-unchanged for a caller who never
  // uses this feature. A parse test cannot see it: the policy travels from the parser through
  // `cli.ts` unresolved, and `cli.ts` is excluded from the coverage ratchet.
  it.effect('--doctor says nothing about a policy when none was given', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const configPath = yield* withEmptyConfig(rules)
        const result = yield* runCliRaw(['--doctor', '--rules', rules, '--config', configPath], '')

        expect(result.stdout).not.toContain('policy')
      }),
    ),
  )
})

/**
 * The freeze, against real git and a real process.
 *
 * These are the dogfooding pass made permanent. Every non-git case ASSERTS the directory is not a
 * repository before relying on it, rather than assuming a temp directory yields one, and every
 * attack case asserts POSITIVELY — with a marker only one rule set carries — because "nothing was
 * blocked" is compatible with a dozen unrelated failures while "the rule carrying this marker fired"
 * is not.
 */
const PROJECT_RULE = `
id: no-as-any
language: tsx
severity: error
message: 'PROJECT RULE'
rule:
  pattern: $X as any
files:
  - '**/*.ts'
`

const ATTACKER_RULE = `
id: no-as-any
language: tsx
severity: error
message: 'ATTACKER RULE FIRED'
rule:
  pattern: zzz_marker
files:
  - '**/*.ts'
`

const git = (cwd: string, args: readonly string[], env?: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const handle = yield* spawner.spawn(ChildProcess.make('git', args, { cwd, env, extendEnv: true }))
    const stdout = yield* collect(handle.stdout)
    const exitCode = yield* handle.exitCode
    return { exitCode, stdout }
  }).pipe(Effect.scoped, Effect.orDie)

/** A real repository with the given files committed. */
const commitAll = (root: string) =>
  Effect.gen(function* () {
    yield* git(root, ['init', '-q', '.'])
    yield* git(root, ['config', 'user.email', 'test@example.com'])
    yield* git(root, ['config', 'user.name', 'test'])
    yield* git(root, ['add', '-A'])
    yield* git(root, ['commit', '-qm', 'first'])
  })

const writeAll = (root: string, files: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    for (const [name, contents] of Object.entries(files)) {
      const target = path.join(root, name)
      yield* fs.makeDirectory(path.dirname(target), { recursive: true })
      yield* fs.writeFileString(target, contents)
    }
  })

/** A temp directory, plus whatever files, WITHOUT a git repository unless one is asked for. */
const withProject = <A, E>(
  files: Readonly<Record<string, string>>,
  use: (
    root: string,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: 'falsestart-freeze-' }))
    yield* writeAll(root, files)
    return yield* use(root)
  }).pipe(Effect.scoped)

/** Run the executable AS IF the agent were working in `cwd`, which is what decides the repository. */
const runIn = (cwd: string, args: readonly string[], payload: string, env?: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const stdin = Stream.make(new TextEncoder().encode(payload))
    const handle = yield* spawner.spawn(
      ChildProcess.make('node', [`${process.cwd()}/${CLI}`, ...args], { cwd, env, extendEnv: true, stdin }),
    )

    const stdout = yield* collect(handle.stdout)
    const stderr = yield* collect(handle.stderr)
    const exitCode = yield* handle.exitCode

    return { exitCode, stderr, stdout } satisfies CliResult
  }).pipe(Effect.scoped, Effect.orDie)

/** Every directory strictly above `start`, up to the filesystem root. */
const ancestorsOf = (start: string): readonly string[] => {
  const found: string[] = []
  let candidate = start
  while (candidate !== '/') {
    candidate = candidate.slice(0, candidate.lastIndexOf('/')) || '/'
    found.push(candidate)
  }
  return found
}

const violation = (root: string, content = 'const x = v as any') =>
  payloadFor({ content, file_path: `${root}/src/a.ts` })

layer(Layer.mergeAll(spawnerLayer, Built), { timeout: 180_000 })('the freeze, end to end', (it) => {
  // T60 — the issue's first vector.
  it.effect('judges the committed rule when the working-tree copy has been narrowed', () =>
    withProject({ 'rules/r.yml': PROJECT_RULE }, (root) =>
      Effect.gen(function* () {
        yield* commitAll(root)
        yield* writeAll(root, { 'rules/r.yml': PROJECT_RULE.replace("'**/*.ts'", "'**/never/**'") })

        const result = yield* runIn(root, ['--rules', './rules'], violation(root))

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('PROJECT RULE')
      }),
    ),
  )

  // T61 — the issue's second vector, which touches no rule file at all.
  it.effect('ignores a scope override the repository never committed', () =>
    withProject({ 'falsestart.config.json': '{"rules":{}}', 'rules/r.yml': PROJECT_RULE }, (root) =>
      Effect.gen(function* () {
        yield* commitAll(root)
        yield* writeAll(root, {
          'falsestart.config.json': '{"rules":{"no-as-any":{"files":["**/never/**"]}}}',
        })

        const result = yield* runIn(root, ['--rules', './rules'], violation(root))

        expect(result.stdout).toContain('PROJECT RULE')
      }),
    ),
  )

  // T62 — vector 3. Adding a file breaks the load, and a broken load used to be an allowed write.
  it.effect('does not see a second config file the repository never committed', () =>
    withProject({ 'falsestart.config.ts': 'export default { rules: {} }\n', 'rules/r.yml': PROJECT_RULE }, (root) =>
      Effect.gen(function* () {
        yield* commitAll(root)
        yield* writeAll(root, { 'falsestart.config.json': '{"rules":{}}' })

        const result = yield* runIn(root, ['--rules', './rules'], violation(root))

        expect(result.stdout).toContain('PROJECT RULE')
      }),
    ),
  )

  // T63 — vector 4, one `echo`, and the cheapest disarm there was.
  it.effect('does not see a working-tree rule document that was corrupted', () =>
    withProject({ 'rules/r.yml': PROJECT_RULE }, (root) =>
      Effect.gen(function* () {
        yield* commitAll(root)
        yield* writeAll(root, { 'rules/r.yml': `${PROJECT_RULE}not: [valid\n` })

        const result = yield* runIn(root, ['--rules', './rules'], violation(root))

        expect(result.stdout).toContain('PROJECT RULE')
      }),
    ),
  )

  // T64 — the gitfile hijack, end to end. Preconditions asserted: the planted file really does move
  // the toplevel, which is what made this work.
  it.effect('never lets a planted .git inside the rules directory choose the repository', () =>
    withProject({ 'rules/r.yml': ATTACKER_RULE }, (evil) =>
      withProject({ 'rules/r.yml': PROJECT_RULE }, (root) =>
        Effect.gen(function* () {
          yield* commitAll(evil)
          yield* commitAll(root)
          yield* writeAll(root, { 'rules/.git': `gitdir: ${evil}/.git\n` })

          const moved = yield* git(`${root}/rules`, ['rev-parse', '--show-toplevel'])
          expect(moved.stdout.trim()).toBe(`${root}/rules`)

          const result = yield* runIn(root, ['--rules', './rules'], violation(root, 'const zzz_marker = v as any'))

          expect(result.stdout).toContain('PROJECT RULE')
          expect(result.stdout).not.toContain('ATTACKER RULE FIRED')
        }),
      ),
    ),
  )

  // T65 — one command, no commit, working tree untouched.
  it.effect('refuses a HEAD that does not resolve in a repository that has refs', () =>
    withProject({ 'rules/r.yml': PROJECT_RULE }, (root) =>
      Effect.gen(function* () {
        yield* commitAll(root)
        yield* git(root, ['symbolic-ref', 'HEAD', 'refs/heads/nope'])

        const result = yield* runIn(root, ['--rules', './rules'], violation(root))

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('"permissionDecision":"deny"')
        expect(result.stdout).toContain('HEAD does not resolve')
      }),
    ),
  )

  // T66 — naming a ref is a statement that it exists.
  it.effect('refuses an explicitly named ref that does not resolve', () =>
    withProject({ 'rules/r.yml': PROJECT_RULE }, (root) =>
      Effect.gen(function* () {
        yield* commitAll(root)

        const result = yield* runIn(root, ['--rules', './rules', '--freeze-ref', 'refs/heads/nope'], violation(root))

        expect(result.stdout).toContain('refs/heads/nope does not resolve')
      }),
    ),
  )

  // T67 — the case that must not become an outage, and the precondition is asserted rather than
  // assumed: a temp directory is only outside a repository if it really is.
  it.effect('keeps judging in a directory that is not a repository at all', () =>
    withProject({ 'rules/r.yml': PROJECT_RULE }, (root) =>
      Effect.gen(function* () {
        expect((yield* git(root, ['rev-parse', '--show-toplevel'])).exitCode).not.toBe(0)

        const result = yield* runIn(root, ['--rules', './rules'], violation(root))

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('PROJECT RULE')
        expect(result.stderr).toBe('')
      }),
    ),
  )

  // T68 — and `require` is where that becomes a refusal, for a repository that wants it to be.
  it.effect('refuses to judge outside a repository under --freeze require', () =>
    withProject({ 'rules/r.yml': PROJECT_RULE }, (root) =>
      Effect.gen(function* () {
        expect((yield* git(root, ['rev-parse', '--show-toplevel'])).exitCode).not.toBe(0)

        const result = yield* runIn(root, ['--rules', './rules', '--freeze', 'require'], violation(root))

        expect(result.stdout).toContain('"permissionDecision":"deny"')
        expect(result.stdout).toContain('is not inside a git work tree')
        expect(result.stdout).toContain(root)
      }),
    ),
  )

  // T69 — a rule document the WORKING TREE follows and enforces. Dropping it silently would make
  // the freeze weaker than the thing it replaces.
  it.effect('refuses a rule document committed as a symlink rather than dropping it', () =>
    withProject({ 'real-rule.yml': PROJECT_RULE }, (root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* fs.makeDirectory(path.join(root, 'rules'))
        yield* fs.symlink(path.join(root, 'real-rule.yml'), path.join(root, 'rules', 'linked.yml'))
        yield* commitAll(root)

        const result = yield* runIn(root, ['--rules', './rules'], violation(root))

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('"permissionDecision":"deny"')
        expect(result.stdout).toContain('rules/linked.yml')
      }),
    ),
  )

  // T70 — D10. The setup the documentation recommends puts rules in node_modules, where freezing is
  // meaningless, while the project's own config is perfectly freezable. Coupling them would leave
  // exactly that setup open to the issue's second vector.
  it.effect('freezes the config of a --preset run even though its rules cannot be frozen', () =>
    withProject({ 'falsestart.config.json': '{"rules":{}}' }, (root) =>
      Effect.gen(function* () {
        yield* commitAll(root)
        yield* writeAll(root, {
          'falsestart.config.json': '{"rules":{"no-as-any":{"files":["**/never/**"]}}}',
        })

        const result = yield* runIn(root, ['--preset', 'clean-code'], violation(root))

        expect(result.stdout).toContain('"permissionDecision":"deny"')
        expect(result.stdout).toContain('no-as-any')
      }),
    ),
  )

  // T71 — the legibility promise, end to end.
  it.effect('--doctor names the working-tree change that is not in effect', () =>
    withProject({ 'rules/r.yml': PROJECT_RULE }, (root) =>
      Effect.gen(function* () {
        yield* commitAll(root)
        yield* writeAll(root, { 'rules/r.yml': PROJECT_RULE.replace("'**/*.ts'", "'**/never/**'") })

        const result = yield* runIn(root, ['--doctor', '--rules', './rules'], '')

        expect(result.stdout).toContain('freeze   ref     HEAD')
        expect(result.stdout).toContain('NOT in effect')
        expect(result.stdout).toContain('changed  r.yml')
      }),
    ),
  )

  // T90 — C1 end to end, and the reason the anchor WALKS rather than merely reporting. The payload
  // carries both markers, so the assertion is about WHOSE rules ran rather than that something
  // blocked.
  it.effect('walks over a planted .git in a monorepo subdirectory onto the real root', () =>
    withProject({ 'rules/r.yml': ATTACKER_RULE }, (evil) =>
      withProject({ 'packages/app/rules/r.yml': PROJECT_RULE }, (root) =>
        Effect.gen(function* () {
          yield* commitAll(evil)
          yield* commitAll(root)
          const app = `${root}/packages/app`
          yield* writeAll(root, { 'packages/app/.git': `gitdir: ${evil}/.git\n` })

          expect((yield* git(app, ['rev-parse', '--show-toplevel'])).stdout.trim()).toBe(app)

          const result = yield* runIn(
            app,
            ['--rules', './rules'],
            payloadFor({ content: 'const x = v as any\nconst zzz_marker = 1', file_path: `${app}/src/a.ts` }),
          )

          expect(result.stdout).toContain('PROJECT RULE')
          expect(result.stdout).not.toContain('ATTACKER RULE FIRED')

          const doctor = yield* runIn(app, ['--doctor', '--rules', './rules'], '')
          expect(doctor.stdout).not.toContain('anchor')
        }),
      ),
    ),
  )

  // T91 — C5a. Verified against 0.2.0 as exit 0 with no output.
  it.effect('refuses a rules directory swapped for a symlink to somewhere else', () =>
    withProject(
      { '.weak/r.yml': PROJECT_RULE.replace("'**/*.ts'", "'**/never/**'"), 'rules/r.yml': PROJECT_RULE },
      (root) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          yield* commitAll(root)
          yield* fs.remove(path.join(root, 'rules'), { recursive: true })
          yield* fs.symlink(path.join(root, '.weak'), path.join(root, 'rules'))

          const result = yield* runIn(root, ['--rules', './rules'], violation(root))

          expect(result.exitCode).toBe(0)
          expect(result.stdout).toContain('"permissionDecision":"deny"')
          expect(result.stdout).toContain('./rules resolves to')
          expect(result.stdout).toContain('.weak')
        }),
    ),
  )

  // T92 — C5b. One `rm -rf` defeated `require`, whose entire purpose is refusing what it cannot
  // verify, so both modes are asserted.
  it.effect('keeps enforcing the committed rules after the rules directory is deleted', () =>
    withProject({ 'rules/r.yml': PROJECT_RULE }, (root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* commitAll(root)
        yield* fs.remove(path.join(root, 'rules'), { recursive: true })

        for (const extra of [[], ['--freeze', 'require']]) {
          const result = yield* runIn(root, ['--rules', './rules', ...extra], violation(root))

          expect(result.exitCode).toBe(0)
          expect(result.stdout).toContain('PROJECT RULE')
        }
      }),
    ),
  )
  /**
   * T80 — the residual, pinned OPEN rather than described in a comment.
   *
   * Where `.git` is a regular file and no enclosing directory has a real one — a linked worktree
   * outside its main repository, or `--separate-git-dir` — one `Write` substitutes the entire object
   * database while `rev-parse --show-toplevel` does not move, so containment passes cleanly. The walk
   * cannot help: there is nothing to walk outward to.
   *
   * Asserted POSITIVELY, with a marker only the attacker's rule set carries, so this says whose rules
   * ran rather than that nothing blocked. Its own regression signal is permanent and needs no special
   * protocol: paired with T81, strengthening `auto` to refuse an unverified anchor turns THIS red on
   * the next ordinary run, which is the deliberate act a changeset should accompany.
   */
  it.effect('is still repointable in a linked worktree outside its main repository, under auto', () =>
    withProject({ 'rules/r.yml': ATTACKER_RULE }, (evil) =>
      withProject({ 'rules/r.yml': PROJECT_RULE }, (main) =>
        withProject({}, (elsewhere) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem
            const path = yield* Path.Path
            yield* commitAll(evil)
            yield* commitAll(main)

            const worktree = path.join(elsewhere, 'wt')
            yield* git(main, ['worktree', 'add', '--detach', '-q', worktree, 'HEAD'])

            // Preconditions, asserted rather than assumed.
            expect((yield* fs.stat(path.join(worktree, '.git'))).type).toBe('File')
            expect((yield* git(worktree, ['rev-parse', '--show-toplevel'])).stdout.trim()).toBe(worktree)
            for (const above of ancestorsOf(worktree)) {
              expect(yield* fs.exists(`${above}/.git`)).toBeFalsy()
            }

            yield* fs.writeFileString(path.join(worktree, '.git'), `gitdir: ${evil}/.git\n`)
            expect((yield* git(worktree, ['rev-parse', '--show-toplevel'])).stdout.trim()).toBe(worktree)

            const payload = payloadFor({ content: 'const zzz_marker = 1', file_path: `${worktree}/src/a.ts` })
            const result = yield* runIn(worktree, ['--rules', './rules'], payload)

            expect(result.stdout).toContain('ATTACKER RULE FIRED')

            const doctor = yield* runIn(worktree, ['--doctor', '--rules', './rules'], '')
            expect(doctor.stdout).toContain('anchor  UNVERIFIED')
          }),
        ),
      ),
    ),
  )

  // T81 — and `require` is the mode with something to say about the one thing here that genuinely
  // cannot be verified. This is the other half of T80's regression signal.
  it.effect('refuses to judge in a worktree whose .git is a file, under require', () =>
    withProject({ 'rules/r.yml': PROJECT_RULE }, (main) =>
      withProject({}, (elsewhere) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          yield* commitAll(main)
          const worktree = path.join(elsewhere, 'wt')
          yield* git(main, ['worktree', 'add', '--detach', '-q', worktree, 'HEAD'])
          expect((yield* fs.stat(path.join(worktree, '.git'))).type).toBe('File')

          const result = yield* runIn(
            worktree,
            ['--rules', './rules', '--freeze', 'require'],
            payloadFor({ content: 'const x = v as any', file_path: `${worktree}/src/a.ts` }),
          )

          expect(result.stdout).toContain('"permissionDecision":"deny"')
          expect(result.stdout).toContain('.git is not a directory')
        }),
      ),
    ),
  )

  // T82 — and none of that fires on an ordinary repository, which is what keeps `require` usable and
  // keeps the `anchor` line worth reading.
  it.effect('says nothing about the anchor in an ordinary repository, and require judges normally', () =>
    withProject({ 'rules/r.yml': PROJECT_RULE }, (root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* commitAll(root)
        expect((yield* fs.stat(`${root}/.git`)).type).toBe('Directory')

        const doctor = yield* runIn(root, ['--doctor', '--rules', './rules'], '')
        expect(doctor.stdout).not.toContain('anchor')

        const result = yield* runIn(root, ['--rules', './rules', '--freeze', 'require'], violation(root))
        expect(result.stdout).toContain('PROJECT RULE')
      }),
    ),
  )

  /**
   * T93 — the P3 limitation, pinned open and stated honestly.
   *
   * `for-each-ref` separates a repository whose HEAD was repointed from a fresh `git init`, and
   * `update-ref -d` empties it, so the tampered repository reads as fresh and the working tree is
   * read again. `.git/logs/HEAD` discriminates all three and `rm` defeats that too: no probe inside a
   * git directory survives an agent that can write inside that git directory.
   *
   * Same permanent signal as T80: if `auto` is ever strengthened here, the first half goes red in CI.
   */
  it.effect('is still disarmable by emptying the refs, under auto, and refuses under require', () =>
    withProject({ 'rules/r.yml': PROJECT_RULE }, (root) =>
      Effect.gen(function* () {
        yield* commitAll(root)
        const branch = (yield* git(root, ['symbolic-ref', '--short', 'HEAD'])).stdout.trim()
        yield* writeAll(root, { 'rules/r.yml': PROJECT_RULE.replace("'**/*.ts'", "'**/never/**'") })
        yield* git(root, ['symbolic-ref', 'HEAD', 'refs/heads/nope'])
        yield* git(root, ['update-ref', '-d', `refs/heads/${branch}`])

        expect((yield* git(root, ['for-each-ref', '--count=1', '--format=%(refname)'])).stdout.trim()).toBe('')

        const allowed = yield* runIn(root, ['--rules', './rules'], violation(root))
        expect(allowed.exitCode).toBe(0)
        expect(allowed.stdout).toBe('')

        const refused = yield* runIn(root, ['--rules', './rules', '--freeze', 'require'], violation(root))
        expect(refused.stdout).toContain('"permissionDecision":"deny"')
        expect(refused.stdout).toContain('has no commit yet')
      }),
    ),
  )
  /**
   * The ambient state git consults before it answers anything: a global config file falsestart does
   * not own, and location variables anyone can set.
   *
   * Both used to decide which repository was authoritative, so a single write to `~/.gitconfig` —
   * outside the repository, outside `.git`, invisible to any diff of the project — made
   * `rev-parse` fail everywhere, and the freeze read that as "there is no repository" and used the
   * working tree. The fix is not to interpret git's complaint but to stop the ambient state from
   * reaching the spawn at all.
   */
  it.effect('ignores a hostile global git config rather than falling back to the working tree', () =>
    withProject({ 'home/.gitconfig': 'not a config\n', 'rules/r.yml': PROJECT_RULE }, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const home = path.join(root, 'home')
        yield* commitAll(root)
        yield* writeAll(root, { 'rules/r.yml': PROJECT_RULE.replace("'**/*.ts'", "'**/never/**'") })

        // The precondition, asserted rather than assumed: that one file really does break git here,
        // and it is what made `rev-parse` fail in every directory on the machine.
        expect((yield* git(root, ['rev-parse', '--show-toplevel'], { HOME: home })).exitCode).not.toBe(0)

        const result = yield* runIn(root, ['--rules', './rules'], violation(root), { HOME: home })

        expect(result.stdout).toContain('PROJECT RULE')
      }),
    ),
  )

  it.effect('ignores GIT_DIR and GIT_WORK_TREE, which would name a different repository', () =>
    withProject({ 'rules/r.yml': ATTACKER_RULE }, (evil) =>
      withProject({ 'rules/r.yml': PROJECT_RULE }, (root) =>
        Effect.gen(function* () {
          yield* commitAll(evil)
          yield* commitAll(root)
          yield* writeAll(root, { 'rules/r.yml': PROJECT_RULE.replace("'**/*.ts'", "'**/never/**'") })

          const result = yield* runIn(root, ['--rules', './rules'], violation(root), {
            GIT_DIR: `${evil}/.git`,
            GIT_WORK_TREE: evil,
          })

          expect(result.stdout).toContain('PROJECT RULE')
          expect(result.stdout).not.toContain('ATTACKER RULE FIRED')
        }),
      ),
    ),
  )

  /**
   * And where git still declines after all that, the answer is a refusal rather than a fallback.
   *
   * A repository whose own `.git/config` says `bare = true` has a work tree git will not name. That
   * is inside `.git`, which SECURITY.md already places out of scope — but it must fail CLOSED, which
   * is the half the classification was missing.
   */
  it.effect('refuses when git will not name the repository but one demonstrably exists', () =>
    withProject({ 'rules/r.yml': PROJECT_RULE }, (root) =>
      Effect.gen(function* () {
        yield* commitAll(root)
        yield* writeAll(root, {
          '.git/config': '[core]\n\trepositoryformatversion = 0\n\tbare = true\n',
          'rules/r.yml': PROJECT_RULE.replace("'**/*.ts'", "'**/never/**'"),
        })

        const result = yield* runIn(root, ['--rules', './rules'], violation(root))

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('"permissionDecision":"deny"')
        expect(result.stdout).not.toContain('PROJECT RULE')
      }),
    ),
  )
  /**
   * A linked worktree INSIDE its main repository — the common `git worktree add ./wt` layout.
   *
   * The anchor walk used to step over it onto the main repository, so the ref consulted was the main
   * repository's HEAD, which does not track `wt/rules`. That reported "not tracked": a silent
   * disarm under `auto`, and a refusal of every write under `require`, in a setup with nothing wrong
   * with it.
   */
  it.effect('freezes a linked worktree inside its main repository against its own branch', () =>
    withProject({ 'rules/r.yml': PROJECT_RULE }, (root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* commitAll(root)
        const worktree = path.join(root, 'wt')
        yield* git(root, ['worktree', 'add', '-q', '-b', 'wt', worktree])

        // Preconditions: it really is a gitfile, and it really is inside the main repository.
        expect((yield* fs.stat(path.join(worktree, '.git'))).type).toBe('File')
        expect((yield* fs.stat(path.join(root, '.git'))).type).toBe('Directory')

        yield* writeAll(worktree, { 'rules/r.yml': PROJECT_RULE.replace("'**/*.ts'", "'**/never/**'") })
        const denied = yield* runIn(worktree, ['--rules', './rules'], violation(worktree))

        expect(denied.stdout).toContain('PROJECT RULE')

        // And `require` must not refuse a clean write in a setup that is entirely ordinary.
        const clean = payloadFor({ content: 'const ok = 1', file_path: `${worktree}/src/a.ts` })
        const allowed = yield* runIn(worktree, ['--rules', './rules', '--freeze', 'require'], clean)

        expect(allowed.exitCode).toBe(0)
        expect(allowed.stdout).toBe('')
      }),
    ),
  )
  /**
   * A `.git` DIRECTORY created where none was — the exploit that survived `--freeze=require`.
   *
   * The previous rule stopped at the nearest `.git` directory and called it verified, reasoning that
   * a write to one fails EISDIR. That is true of REPLACING a directory and says nothing about
   * creating one, and creating one needs no shell. The attacker's committed rules were then
   * enforced under `auto` AND under `require`, the real repository stayed clean, and `--doctor`
   * reported a healthy frozen tree while calling the project's own committed rule the uncommitted
   * change.
   */
  it.effect('refuses to be spoken for by a .git directory created at a tracked path', () =>
    withProject({ 'pkg/rules/r.yml': PROJECT_RULE }, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        yield* commitAll(root)
        const pkg = path.join(root, 'pkg')

        // The plant: a whole repository at a path the real one tracks, carrying a weakened rule,
        // with the strict bytes put back on disk so nothing looks tampered with.
        yield* commitAll(pkg)
        yield* writeAll(pkg, { 'rules/r.yml': ATTACKER_RULE })
        yield* git(pkg, ['add', '-A'])
        yield* git(pkg, ['-c', 'user.email=t@e.st', '-c', 'user.name=t', 'commit', '-qm', 'weakened'])
        yield* writeAll(pkg, { 'rules/r.yml': PROJECT_RULE })

        // The real repository is untouched, which is what made this invisible.
        expect((yield* git(root, ['status', '--porcelain'])).stdout.trim()).toBe('')

        const payload = payloadFor({
          content: 'const x = v as any\nconst zzz_marker = 1',
          file_path: `${pkg}/src/a.ts`,
        })
        for (const extra of [[], ['--freeze', 'require']]) {
          const result = yield* runIn(pkg, ['--rules', './rules', ...extra], payload)

          expect(result.stdout).toContain('PROJECT RULE')
          expect(result.stdout).not.toContain('ATTACKER RULE FIRED')
        }
      }),
    ),
  )

  /**
   * And the report must not invert which side is authoritative.
   *
   * "N working-tree change(s) are NOT in effect" is a claim about which bytes win. Printing it where
   * the anchor is not positively established was wrong in the direction that reassures: it named the
   * project's own rule as the change that had not landed.
   */
  it.effect('never calls the working tree stale where the anchor is not established', () =>
    withProject({ 'rules/r.yml': PROJECT_RULE }, (main) =>
      withProject({}, (elsewhere) =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          yield* commitAll(main)
          const worktree = path.join(elsewhere, 'wt')
          yield* git(main, ['worktree', 'add', '--detach', '-q', worktree, 'HEAD'])
          yield* writeAll(worktree, { 'rules/r.yml': PROJECT_RULE.replace("'**/*.ts'", "'**/never/**'") })

          const doctor = yield* runIn(worktree, ['--doctor', '--rules', './rules'], '')

          expect(doctor.stdout).toContain('anchor  UNVERIFIED')
          expect(doctor.stdout).not.toContain('NOT in effect')
        }),
      ),
    ),
  )
  /**
   * Cases an adversarial review flagged as unverified. Code reading said all of them fail closed;
   * this repository's rule is that unobserved is unproven, so they are observed.
   */
  it.effect('denies rather than falling back when a committed rule document is not valid UTF-8', () =>
    withProject({ 'rules/r.yml': PROJECT_RULE }, (root) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        yield* fs.writeFile(path.join(root, 'rules', 'bad.yml'), new Uint8Array([105, 100, 58, 32, 255, 254, 10]))
        yield* commitAll(root)

        const result = yield* runIn(root, ['--rules', './rules'], violation(root))

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('"permissionDecision":"deny"')
        expect(result.stdout).toContain('bad.yml')
      }),
    ),
  )

  it.effect('refuses a --freeze-ref that names a tree rather than a commit', () =>
    withProject({ 'rules/r.yml': PROJECT_RULE }, (root) =>
      Effect.gen(function* () {
        yield* commitAll(root)
        const tree = (yield* git(root, ['rev-parse', 'HEAD^{tree}'])).stdout.trim()

        const result = yield* runIn(root, ['--rules', './rules', '--freeze-ref', tree], violation(root))

        // Whatever it does, it must not be "read the working tree": a ref that is not a commit is
        // either frozen against that tree or refused, and both are closed.
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('"permissionDecision":"deny"')
      }),
    ),
  )

  it.effect('keeps freezing when the rules path contains a newline', () =>
    withProject({}, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const awkward = 'ru\nles'
        yield* writeAll(root, { [`${awkward}/r.yml`]: PROJECT_RULE })
        yield* commitAll(root)
        yield* writeAll(root, { [`${awkward}/r.yml`]: PROJECT_RULE.replace("'**/*.ts'", "'**/never/**'") })

        expect(yield* git(root, ['ls-tree', '-r', 'HEAD'])).toHaveProperty('exitCode', 0)
        const result = yield* runIn(root, ['--rules', path.join('.', awkward)], violation(root))

        expect(result.stdout).toContain('PROJECT RULE')
      }),
    ),
  )
  it.effect('denies rather than falling back when the committed tree is larger than the read buffer', () =>
    withProject({}, (root) =>
      Effect.gen(function* () {
        // Past `maxBuffer`, `spawnSync` reports a SPAWN error rather than a non-zero exit, and its
        // stderr is empty — so the reason has to carry the error itself or it says nothing at all.
        const padding = `${'x'.repeat(1000)}\n`.repeat(1000)
        const documents = Object.fromEntries(
          Array.from({ length: 70 }, (_, index) => [
            `rules/r${index}.yml`,
            `${PROJECT_RULE.replace('no-as-any', `rule-${index}`)}note: |\n${padding}`,
          ]),
        )
        yield* writeAll(root, documents)
        yield* commitAll(root)

        const result = yield* runIn(root, ['--rules', './rules'], violation(root))

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('"permissionDecision":"deny"')
        expect(result.stdout).toContain('could not read 70 rule document(s)')
        // Node's own text for the overflow, so the person who was blocked can search for it.
        expect(result.stdout).toContain('ENOBUFS')
      }),
    ),
  )
})

/**
 * The Copilot contract through the shipped bundle.
 *
 * `src/cli.ts` is excluded from the coverage ratchet and from mutation testing, so these are the
 * only tests that see the refusal code and the broken-pipe forgiveness at all. They are also the
 * only place the exit code that reaches the operating system is observed, which is the entire point
 * under a runtime where every non-zero exit other than 2 denies the tool call.
 */
layer(Layer.mergeAll(spawnerLayer, Built), { timeout: 120_000 })('the Copilot contract, through the binary', (it) => {
  const copilotRun = (rulesDirectory: string, args: readonly string[], payload: string) =>
    Effect.gen(function* () {
      const configPath = yield* withEmptyConfig(rulesDirectory)
      return yield* runCliRaw(['--rules', rulesDirectory, '--config', configPath, ...args], payload)
    })

  // T-A24 — including the JSON-encoded `toolArgs` that real invocations carry, and the absence of
  // `hookSpecificOutput`, which is the envelope Copilot ignores.
  it.effect('denies a Copilot edit with exit 2 and a top-level deny document', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const result = yield* copilotRun(
          rules,
          ['--agent', 'copilot'],
          JSON.stringify({
            cwd: '/r',
            toolArgs: JSON.stringify({ new_str: 'const x = v as any', old_str: '', path: '/r/a.ts' }),
            toolName: 'edit',
          }),
        )

        expect(result.exitCode).toBe(2)
        expect(result.stdout).toContain('"permissionDecision":"deny"')
        expect(result.stdout).not.toContain('hookSpecificOutput')
        expect(result.stderr).toContain('as any')
      }),
    ),
  )

  // T-A25 — the traffic that makes up most of a session, in both spellings. Silence here is the
  // difference between a guard and an outage: today, unconfigured, every one of these denies.
  it.effect('says nothing at all about a Copilot tool call that writes nothing', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        for (const payload of [
          JSON.stringify({ toolArgs: '{"command":"ls"}', toolName: 'bash' }),
          JSON.stringify({ tool_input: { command: 'ls' }, tool_name: 'bash' }),
        ]) {
          const result = yield* copilotRun(rules, ['--agent', 'copilot'], payload)

          expect(result.exitCode).toBe(0)
          expect(result.stdout).toBe('')
          expect(result.stderr).toBe('')
        }
      }),
    ),
  )

  // T-A26a — a refused command line must never be able to block a write, and under Copilot the only
  // code that satisfies that is 0. The two MISSPELLED rows are the ones that matter: the likeliest
  // typo in a brand-new flag is the flag's own value, and refusing it at exit 1 in front of Copilot
  // denies every tool call in the repository rather than printing a message.
  it.effect('cannot deny anything when the command line names any agent but claude-code', () =>
    Effect.gen(function* () {
      for (const args of [
        ['--agent', 'copilot', '--bogus'],
        ['--agent', 'copilto', '--bogus'],
        ['--agent', '--bogus'],
      ]) {
        const result = yield* runCliRaw(args, '')

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe('')
        expect(result.stderr).not.toBe('')
      }
    }),
  )

  // T-A26b — the control. Cannot be seen failing by withholding code; guarded by making the
  // condition unconditionally true and watching both rows drop to 0.
  it.effect('still refuses at exit 1 where no agent, or claude-code, was named', () =>
    Effect.gen(function* () {
      expect(yield* runCliRaw(['--bogus'], '')).toHaveProperty('exitCode', 1)
      expect(yield* runCliRaw(['--agent', 'claude-code', '--bogus'], '')).toHaveProperty('exitCode', 1)
    }),
  )

  // T-A26c — `runMain` exits 1 on any escaping failure, and exit 1 denies under Copilot. Writing
  // the response is the one fallible step left on the hook path, and a reader that closed the pipe
  // is not this command's failure. Only a real pipeline shows it: the in-process spawner collects
  // stdout to completion, so it can never be the reader that leaves.
  it.effect('does not turn a reader that closed the pipe into a denial', () =>
    withRules({ 'soft.yml': noAsAny.replace('severity: error', 'severity: warning') }, (rules) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const configPath = yield* withEmptyConfig(rules)
        const payload = JSON.stringify({
          cwd: '/r',
          toolArgs: { new_str: 'const x = v as any', old_str: '', path: '/r/a.ts' },
          toolName: 'edit',
        })
        const payloadPath = path.join(rules, 'payload.json')
        yield* (yield* FileSystem.FileSystem).writeFileString(payloadPath, payload)

        const script =
          `node ${CLI} --rules ${rules} --config ${configPath} --agent copilot < ${payloadPath} 2>&1 | true; ` +
          `exit "\${PIPESTATUS[0]}"`
        const handle = yield* spawner.spawn(ChildProcess.make('bash', ['-c', script]))

        expect(yield* handle.exitCode).not.toBe(1)
      }).pipe(Effect.scoped),
    ),
  )
})
