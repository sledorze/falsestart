import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { expect, layer } from '@effect/vitest'
import { Effect, FileSystem, Layer, Path } from 'effect'
import { respond } from './respond.ts'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

const noAsAny = `
id: no-as-any
language: tsx
message: 'as any erases the type'
rule:
  pattern: $X as any
`

const withRules = <A, E>(
  files: Readonly<Record<string, string>>,
  use: (directory: string) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: 'falsestart-respond-' })

    for (const [name, contents] of Object.entries(files)) {
      const target = path.join(root, name)
      yield* fs.makeDirectory(path.dirname(target), { recursive: true })
      yield* fs.writeFileString(target, contents)
    }

    return yield* use(root)
  }).pipe(Effect.scoped)

const writeOf = (content: string) =>
  JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_input: { content, file_path: '/repo/src/widget.ts' },
    tool_name: 'Write',
  })

layer(platform)('hook response', (it) => {
  it.effect('emits a deny decision in the shape the hook contract defines', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          input: writeOf('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        // Blocking is exit 0 WITH json on stdout. Exit 2 would discard stdout entirely.
        expect(response.exitCode).toBe(0)
        const payload = JSON.parse(response.stdout ?? '{}')
        expect(payload.hookSpecificOutput.hookEventName).toBe('PreToolUse')
        expect(payload.hookSpecificOutput.permissionDecision).toBe('deny')
        expect(payload.hookSpecificOutput.permissionDecisionReason).toContain('as any erases the type')
      }),
    ),
  )

  it.effect('stays silent when the write is clean', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          input: writeOf('const x = value as Widget'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(0)
        expect(response.stdout).toBeUndefined()
        expect(response.stderr).toBeUndefined()
      }),
    ),
  )

  it.effect('emits advisory findings as a system message with no permission decision', () =>
    withRules({ 'soft.yml': `${noAsAny}severity: warning\n` }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          input: writeOf('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(0)
        const payload = JSON.parse(response.stdout ?? '{}')
        expect(payload.systemMessage).toContain('as any erases the type')
        // No permissionDecision: advising must not silently approve the write either.
        expect(payload.hookSpecificOutput).toBeUndefined()
      }),
    ),
  )

  it.effect('honours a per-repo scope override so a rule can be narrowed without editing it', () =>
    withRules(
      { 'no-as-any.yml': noAsAny, 'scope.json': '{"rules":{"no-as-any":{"files":["src/domain/**/*.ts"]}}}' },
      (rules) =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const config = path.join(rules, 'scope.json')

          // The shipped rule has no `files` at all, so without the override this would be denied.
          const response = yield* respond({
            configPath: config,
            input: writeOf('const x = value as any'),
            projectDirectory: rules,
            rulesDirectory: rules,
          })

          expect(response.exitCode).toBe(0)
          expect(response.stdout).toBeUndefined()
        }),
    ),
  )

  it.effect('still applies a rule where the override admits it', () =>
    withRules(
      { 'no-as-any.yml': noAsAny, 'scope.json': '{"rules":{"no-as-any":{"files":["**/widget.ts"]}}}' },
      (rules) =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const response = yield* respond({
            configPath: path.join(rules, 'scope.json'),
            input: writeOf('const x = value as any'),
            projectDirectory: rules,
            rulesDirectory: rules,
          })

          expect(JSON.parse(response.stdout ?? '{}').hookSpecificOutput.permissionDecision).toBe('deny')
        }),
    ),
  )

  it.effect('reports an explicitly-named config that does not exist', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        // Asking for a config that is not there is a misconfiguration, not an absence.
        const path = yield* Path.Path
        const response = yield* respond({
          configPath: path.join(rules, 'absent.json'),
          input: writeOf('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(1)
        expect(response.stderr).toContain('no such config file')
      }),
    ),
  )

  it.effect('proceeds with no overrides when no default config is present', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          input: writeOf('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(JSON.parse(response.stdout ?? '{}').hookSpecificOutput.permissionDecision).toBe('deny')
      }),
    ),
  )

  it.effect('picks up a default falsestart.config.json next to the rules', () =>
    withRules(
      { 'falsestart.config.json': '{"rules":{"no-as-any":{"files":["nowhere/**"]}}}', 'no-as-any.yml': noAsAny },
      (rules) =>
        Effect.gen(function* () {
          const response = yield* respond({
            input: writeOf('const x = value as any'),
            projectDirectory: rules,
            rulesDirectory: rules,
          })

          expect(response.stdout).toBeUndefined()
        }),
    ),
  )

  it.effect('loads a TypeScript config, so rule ids can be checked by the compiler', () =>
    withRules(
      {
        'falsestart.config.ts': [
          "import type { FalsestartConfig } from '@sledorze/falsestart'",
          '',
          'export default {',
          "  rules: { 'no-as-any': { files: ['nowhere/**/*.ts'] } },",
          '} satisfies FalsestartConfig',
          '',
        ].join('\n'),
        'no-as-any.yml': noAsAny,
      },
      (rules) =>
        Effect.gen(function* () {
          const response = yield* respond({
            input: writeOf('const x = value as any'),
            projectDirectory: rules,
            rulesDirectory: rules,
          })

          // Re-scoped away from src/widget.ts by the typed config.
          expect(response.stdout).toBeUndefined()
        }),
    ),
  )

  it.effect('refuses two competing default configs rather than picking one', () =>
    withRules(
      {
        'falsestart.config.json': '{"rules":{}}',
        'falsestart.config.ts': 'export default { rules: {} }\n',
        'no-as-any.yml': noAsAny,
      },
      (rules) =>
        Effect.gen(function* () {
          const response = yield* respond({
            input: writeOf('const x = value as any'),
            projectDirectory: rules,
            rulesDirectory: rules,
          })

          expect(response.exitCode).toBe(1)
          expect(response.stderr).toContain('more than one')
        }),
    ),
  )

  it.effect('loads a JavaScript config from its real path', () =>
    withRules(
      {
        'falsestart.config.js': "export default { rules: { 'no-as-any': { files: ['nowhere/**'] } } }\n",
        'no-as-any.yml': noAsAny,
      },
      (rules) =>
        Effect.gen(function* () {
          const response = yield* respond({
            input: writeOf('const x = value as any'),
            projectDirectory: rules,
            rulesDirectory: rules,
          })

          expect(response.stdout).toBeUndefined()
        }),
    ),
  )

  it.effect('reports a TypeScript config that does not parse', () =>
    withRules({ 'falsestart.config.ts': 'export default { rules: {{{ }\n', 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          input: writeOf('const x = v as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(1)
        expect(response.stderr).toContain('falsestart.config.ts')
      }),
    ),
  )

  it.effect('reports a config directory masquerading as a TypeScript config', () =>
    withRules({ 'falsestart.config.ts/inner.txt': 'x', 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          input: writeOf('const x = v as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(1)
        expect(response.stderr).toContain('cannot be read')
      }),
    ),
  )

  it.effect('reports a JavaScript config that cannot be imported', () =>
    withRules({ 'falsestart.config.js': 'export default {{{\n', 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          input: writeOf('const x = v as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(1)
        expect(response.stderr).toContain('imported')
      }),
    ),
  )

  it.effect('reports a TypeScript config with no default export', () =>
    withRules({ 'falsestart.config.ts': 'export const rules = {}\n', 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          input: writeOf('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(1)
        expect(response.stderr).toContain('default export')
      }),
    ),
  )

  it.effect('reports a config file that exists but cannot be understood', () =>
    withRules({ 'no-as-any.yml': noAsAny, 'scope.json': '{oops' }, (rules) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const response = yield* respond({
          configPath: path.join(rules, 'scope.json'),
          input: writeOf('const x = v as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(1)
        expect(response.stderr).toContain('JSON')
      }),
    ),
  )

  it.effect('reports a config path that is not a readable file', () =>
    withRules({ 'no-as-any.yml': noAsAny, 'scope.json/inner.txt': 'x' }, (rules) =>
      Effect.gen(function* () {
        // A DIRECTORY named like the config file: it exists, but reading it as one fails.
        const path = yield* Path.Path
        const response = yield* respond({
          configPath: path.join(rules, 'scope.json'),
          input: writeOf('const x = v as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(1)
        expect(response.stderr).toContain('cannot be read')
      }),
    ),
  )

  it.effect('reports an override naming a rule that is not loaded', () =>
    withRules({ 'no-as-any.yml': noAsAny, 'scope.json': '{"rules":{"typo":{"files":["x"]}}}' }, (rules) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const response = yield* respond({
          configPath: path.join(rules, 'scope.json'),
          input: writeOf('const x = v as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(1)
        expect(response.stderr).toContain('typo')
      }),
    ),
  )

  it.effect('finds a default config in the project, not beside the rules', () =>
    // Regression: with `--preset` the rules live inside node_modules. Looking for the config
    // beside them meant a repo's own config was silently ignored and rules applied unchanged.
    withRules({ 'no-as-any.yml': noAsAny }, (rulesElsewhere) =>
      withRules({ 'falsestart.config.json': '{"rules":{"no-as-any":{"files":["nowhere/**"]}}}' }, (project) =>
        Effect.gen(function* () {
          const response = yield* respond({
            input: writeOf('const x = value as any'),
            projectDirectory: project,
            rulesDirectory: rulesElsewhere,
          })

          expect(response.stdout).toBeUndefined()
        }),
      ),
    ),
  )

  it.effect('surfaces a problem without blocking when the input is not JSON', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({ input: 'this is not json', projectDirectory: rules, rulesDirectory: rules })

        // Exit 1 is the contract's non-blocking error: the user sees it, the write proceeds.
        expect(response.exitCode).toBe(1)
        expect(response.stderr).toContain('JSON')
        expect(response.stdout).toBeUndefined()
      }),
    ),
  )

  it.effect('surfaces a problem without blocking when the rules cannot be loaded', () =>
    withRules({}, (rules) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const response = yield* respond({
          input: writeOf('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: path.join(rules, 'absent'),
        })

        expect(response.exitCode).toBe(1)
        expect(response.stderr).toBeDefined()
        expect(response.stdout).toBeUndefined()
      }),
    ),
  )

  it.effect('surfaces a problem without blocking when a rule document is malformed', () =>
    withRules({ 'broken.yml': 'id: 7\nlanguage: tsx' }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          input: writeOf('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(1)
        expect(response.stderr).toContain('broken.yml')
      }),
    ),
  )

  it.effect('surfaces a problem without blocking when a judgeable payload is incomplete', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        // A Write with no file_path: judgeable in principle, but there is no path to scope by.
        const response = yield* respond({
          input: JSON.stringify({ tool_input: { content: 'const x = y as any' }, tool_name: 'Write' }),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(1)
        expect(response.stdout).toBeUndefined()
      }),
    ),
  )

  it.effect('has no opinion about a tool that writes no source', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          input: JSON.stringify({ tool_input: { command: 'ls' }, tool_name: 'Bash' }),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(0)
        expect(response.stdout).toBeUndefined()
      }),
    ),
  )

  it.effect('does not load rules for a tool it will not judge', () =>
    // A broken rule tree must not turn an unrelated Bash call into an error notice.
    withRules({ 'broken.yml': 'id: 7\nlanguage: tsx' }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          input: JSON.stringify({ tool_input: {}, tool_name: 'Bash' }),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(0)
        expect(response.stderr).toBeUndefined()
      }),
    ),
  )
})
