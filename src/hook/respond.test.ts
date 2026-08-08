import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { describe, effect, expect, layer } from '@effect/vitest'
import { Effect, FileSystem, Layer, Path } from 'effect'
import type { Frozen } from '../freezing/index.ts'
import type { HookResponse } from './respond.ts'
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

  // Named for what it proves: `projectDirectory` and `rulesDirectory` are the same temp directory
  // here, so this exercises the PROJECT lookup. It was called "next to the rules", which is the
  // behaviour this codebase deliberately does not have — see the regression test further down.
  it.effect('picks up a default falsestart.config.json from the project directory', () =>
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

  // What a `.ts` config may import is narrower than "types only" and wider than "nothing": it is
  // imported from a `data:` URL, which has no filesystem location to resolve a specifier against,
  // and `node:` builtins need none. That is the difference between "a rule's scope can be computed
  // at load time" and "a `.ts` config is a static document", which four documents now state.
  it.effect('runs a TypeScript config that computes its scope with a node: builtin', () =>
    withRules(
      {
        'falsestart.config.ts': [
          "import { execSync } from 'node:child_process'",
          '',
          "const elsewhere = execSync('echo nowhere').toString().trim()",
          '',
          'export default {',
          "  rules: { 'no-as-any': { files: [elsewhere + '/**/*.ts'] } },",
          '}',
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

          // The override has to be seen TAKING EFFECT, not merely not erroring: the rule ships with
          // no `files` at all, so a config that loaded and was then ignored would deny this write.
          expect(response.exitCode).toBe(0)
          expect(response.stdout).toBeUndefined()
        }),
    ),
  )

  it.effect('reports a TypeScript config that imports a package, rather than half-loading it', () =>
    withRules(
      {
        'falsestart.config.ts': [
          "import picomatch from 'picomatch'",
          '',
          "const isLegacy = picomatch('legacy/**')",
          '',
          'export default {',
          "  rules: { 'no-as-any': { files: isLegacy('legacy/a.ts') ? ['nowhere/**'] : ['**/*.ts'] } },",
          '}',
          '',
        ].join('\n'),
        'no-as-any.yml': noAsAny,
      },
      (rules) =>
        Effect.gen(function* () {
          // `picomatch` is a real dependency of this package, so the failure is resolution and not
          // absence — the negative that keeps the case above from reading as "imports work".
          const response = yield* respond({
            input: writeOf('const x = value as any'),
            projectDirectory: rules,
            rulesDirectory: rules,
          })

          expect(response.exitCode).toBe(1)
          expect(response.stderr).toContain('falsestart.config.ts')
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

/**
 * The crux: a frozen source that cannot be honoured denies. It does not report and allow.
 *
 * Every assertion here is on the RESPONSE rather than on an error value, because the failure being
 * guarded against is precisely that a `ConfigError` reaches `problem()` — exit 1, non-blocking, and
 * the write proceeds. An assertion on the error would pass either way.
 */
const frozenWith = (documents: Readonly<Record<string, string>>): Frozen => ({
  _tag: 'Frozen',
  anchor: 'verified',
  documents: new Map(Object.entries(documents)),
  ref: 'HEAD',
})

const nothingToFreeze: Frozen = { _tag: 'Unfrozen', reason: 'x is not tracked at HEAD' }

const BLOCKING = `
id: block-any
language: tsx
message: 'FROZEN MESSAGE'
rule:
  pattern: $X as any
files:
  - '**/*.ts'
`

const NARROWED = `
id: block-any
language: tsx
message: 'WORKTREE MESSAGE'
rule:
  pattern: $X as any
files:
  - '**/never-matches/**'
`

const BROKEN_REASONS = [
  { reason: 'could not list ./rules at HEAD: fatal: bad object' },
  { reason: 'HEAD does not resolve in a repository that has refs' },
]

layer(platform)('a freeze the hook cannot honour', (it) => {
  // T43 — the mandatory negative test. The two copies carry DIFFERENT messages, so an
  // implementation that loads the right rule from the wrong bytes is caught: matching on `files`
  // alone would pass against a rule that blocks for an unrelated reason.
  it.effect('judges the committed rule, not the one the working tree was narrowed to', () =>
    withRules({ 'block-any.yml': NARROWED }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          freeze: () => Effect.succeed({ config: frozenWith({}), rules: frozenWith({ 'block-any.yml': BLOCKING }) }),
          input: writeOf('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(0)
        // Asserted before the content: reading the working tree makes this `silent()`, and a
        // `toContain` against `undefined` reports an argument-type complaint rather than the fact.
        expect(response.stdout).toBeDefined()
        expect(response.stdout).toContain('"permissionDecision":"deny"')
        expect(response.stdout).toContain('FROZEN MESSAGE')
        expect(response.stdout).not.toContain('WORKTREE MESSAGE')
      }),
    ),
  )

  // T44 — the control, and what proves T43 measures the freeze rather than a rule that blocks
  // anyway. Same fixture, no freeze: the working tree's narrowing takes effect and nothing happens.
  it.effect('reads the working tree when there is no freeze, and is then disarmed', () =>
    withRules({ 'block-any.yml': NARROWED }, (rules) =>
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

  // T45
  describe.each(BROKEN_REASONS)('when the freeze reports $reason', ({ reason }) => {
    effect('denies the write instead of letting it through with a notice', () =>
      Effect.gen(function* () {
        const response = yield* respond({
          freeze: () => Effect.succeed({ config: { _tag: 'Broken', reason }, rules: { _tag: 'Broken', reason } }),
          input: writeOf('const x = value as any'),
          projectDirectory: '/no/such/place',
          rulesDirectory: '/no/such/place',
        }).pipe(Effect.provide(platform))

        expect(response.exitCode).toBe(0)
        expect(response.stdout).toContain('"permissionDecision":"deny"')
        expect(response.stdout).toContain(reason)
        expect(response.stdout).toContain('--freeze off')
      }),
    )
  })

  // T46 — F3. `respond.ts` turns any ConfigError into a non-blocking notice, so without this a
  // committed config that will not parse is a disarm through the path this change exists to close.
  it.effect('denies when the committed config will not parse', () =>
    withRules({ 'block-any.yml': BLOCKING }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          freeze: () =>
            Effect.succeed({ config: frozenWith({ 'falsestart.config.json': '{oops' }), rules: nothingToFreeze }),
          input: writeOf('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(0)
        expect(response.stdout).toContain('"permissionDecision":"deny"')
        expect(response.stdout).toContain('--freeze off')
      }),
    ),
  )

  // T47 — the same for the rules half. A COMMITTED rule that does not load is a repository-wide
  // problem a commit introduced, which is exactly what `scan` already fails closed on.
  it.effect('denies when the committed rule tree will not load', () =>
    withRules({ 'block-any.yml': BLOCKING }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          freeze: () =>
            Effect.succeed({ config: frozenWith({}), rules: frozenWith({ 'broken.yml': 'id: 7\nlanguage: tsx' }) }),
          input: writeOf('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(0)
        expect(response.stdout).toContain('"permissionDecision":"deny"')
        expect(response.stdout).toContain('broken.yml')
      }),
    ),
  )

  // Not in the design's catalogue. An override naming a rule the frozen tree does not load is a
  // deliberate hard error, and it reaches the same fail-open path as the two above.
  it.effect('denies when a committed override names a rule the committed tree does not load', () =>
    withRules({}, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          freeze: () =>
            Effect.succeed({
              config: frozenWith({ 'falsestart.config.json': '{"rules":{"typo":{"files":["x"]}}}' }),
              rules: frozenWith({ 'block-any.yml': BLOCKING }),
            }),
          input: writeOf('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(0)
        expect(response.stdout).toContain('"permissionDecision":"deny"')
        expect(response.stdout).toContain('typo')
      }),
    ),
  )
})

/** Loads cleanly and cannot run: a matcher that narrows to no AST kind is rejected at match time. */
const UNRUNNABLE = `
id: unrunnable
language: tsx
message: 'never reached'
rule:
  regex: foo
`

/**
 * `--fail closed`: a write falsestart could not check is denied rather than reported.
 *
 * Every case here has NOTHING frozen, which is what makes it measure the policy rather than a denial
 * that would have happened anyway. The controls are already above — `'surfaces a problem without
 * blocking when the rules cannot be loaded'`, `'… when a rule document is malformed'` and
 * `'reports an override naming a rule that is not loaded'` — and they must stay green unchanged.
 */
layer(platform)('a guard failure under --fail closed', (it) => {
  // T5
  it.effect('denies when the rule tree will not load and nothing is frozen', () =>
    withRules({ 'broken.yml': 'id: 7\nlanguage: tsx' }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          failure: 'closed',
          input: writeOf('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(0)
        // Asserted before the content, for the reason T43 gives: a `toContain` against `undefined`
        // reports an argument-type complaint rather than the fact being measured.
        expect(response.stdout).toBeDefined()
        expect(response.stdout).toContain('"permissionDecision":"deny"')
        expect(response.stdout).toContain('broken.yml')
        expect(response.stderr).toBeUndefined()
      }),
    ),
  )

  // T6 — the issue's opening example, with no freeze: an override naming a rule the loaded set does
  // not contain. Under the default freeze this already denies; on the `--freeze off` path it does
  // not, and that path is what this switch is for.
  it.effect('denies when a working-tree override names a rule that is not loaded', () =>
    withRules({ 'falsestart.config.json': '{"rules":{"typo":{"files":["x"]}}}', 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          failure: 'closed',
          input: writeOf('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(0)
        expect(response.stdout).toBeDefined()
        expect(response.stdout).toContain('"permissionDecision":"deny"')
        expect(response.stdout).toContain('no rule named typo is loaded')
      }),
    ),
  )

  // T7 — a different `refuse` call site from T6: the config never loads at all, so the overrides
  // step is never reached.
  it.effect('denies when the config itself will not load', () =>
    withRules({ 'falsestart.config.json': '{oops', 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          failure: 'closed',
          input: writeOf('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(0)
        expect(response.stdout).toBeDefined()
        expect(response.stdout).toContain('"permissionDecision":"deny"')
        expect(response.stdout).toContain('falsestart.config.json')
      }),
    ),
  )

  // T8 — whoever reads a deny reason is about to start editing, and nothing about the code was
  // judged. An agent that reads the loader error before it reads "the code is not what failed" has
  // already started rewriting correct code.
  it.effect('says the guard failed and names what failed, before it says anything else', () =>
    withRules({ 'broken.yml': 'id: 7\nlanguage: tsx' }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          failure: 'closed',
          input: writeOf('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        const decision: unknown = JSON.parse(response.stdout ?? '{}')
        const reason =
          typeof decision === 'object' && decision !== null && 'hookSpecificOutput' in decision
            ? String(JSON.stringify(decision.hookSpecificOutput))
            : ''

        expect(reason).toContain('falsestart could not check this write')
        expect(reason).toContain('do not change it to satisfy this')
        expect(reason).toContain('broken.yml')
        // The lead comes FIRST, not appended. `withEscape` appends, so copying its shape is the
        // natural first draft — and it is the draft that puts the loader error in front of an agent
        // before the sentence telling it not to act on one.
        expect(reason).toMatch(/"permissionDecisionReason":"falsestart could not check this write/)
      }),
    ),
  )

  // T9 — the control, and the fixture's own guard. It asserts today's behaviour, so it cannot be
  // seen red by withholding code; its failure mode is `UNRUNNABLE` rotting into something that
  // runs, which would leave T10 passing against a rule that failed for an unrelated reason.
  it.effect('reports an unrunnable rule without blocking, under the default', () =>
    withRules({ 'unrunnable.yml': UNRUNNABLE }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          input: writeOf('const foo = 1'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(1)
        expect(response.stderr).toContain('rule unrunnable could not run')
        expect(response.stdout).toBeUndefined()
      }),
    ),
  )

  // T10 — the class the switch buys most on, because it is orthogonal to the freeze: a perfectly
  // committed, perfectly loadable rule still fails here, and `--freeze off` cannot repair it.
  it.effect('denies a write it could not check because a rule could not run', () =>
    withRules({ 'unrunnable.yml': UNRUNNABLE }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          failure: 'closed',
          input: writeOf('const foo = 1'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(0)
        expect(response.stdout).toBeDefined()
        expect(response.stdout).toContain('"permissionDecision":"deny"')
        expect(response.stdout).toContain('rule unrunnable could not run')
      }),
    ),
  )

  // T11 — a Write carrying no file_path: judgeable in principle, and the agent runtime's shape
  // rather than this repository's. Nothing in the project is wrong, so a denial leaves an agent one
  // move — rewriting code that was never judged. `WRITE_TOOLS` hard-codes another product's field
  // names, so governing this would make availability depend on their release cadence.
  //
  // The rule tree here LOADS, and that is the whole scope of the claim: the payload is never the
  // REASON. A guard failure hit first denies on its own terms — T25 pins that, and pins why moving
  // this check earlier would be wrong.
  it.effect('never denies a malformed hook payload, even under --fail closed', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          failure: 'closed',
          input: JSON.stringify({ tool_input: { content: 'const x = y as any' }, tool_name: 'Write' }),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(1)
        expect(response.stdout).toBeUndefined()
        expect(response.stderr).toContain('carried no content/file_path')
      }),
    ),
  )

  // T12 — the same argument one step earlier. Denying an unparseable payload for a guard reason is
  // the malformed-payload class wearing a hat.
  it.effect('never denies stdin that is not JSON, even under --fail closed', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          failure: 'closed',
          input: 'this is not json',
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(1)
        expect(response.stdout).toBeUndefined()
        expect(response.stderr).toContain('JSON')
      }),
    ),
  )

  /**
   * T25 — the pair T11 is only half of, and the reason the malformed check is where it is.
   *
   * "A malformed payload is never denied" is too strong, and was already too strong before this flag
   * existed: a COMMITTED rule tree that will not load denies every judged tool call under the freeze
   * alone, and a malformed payload is one of them. Verified against `dist/cli.js` built from
   * `origin/main`, with no `--fail` in existence.
   *
   * What is true is narrower and is what these two assert: the payload is never the REASON. Both
   * denials name the rule tree, which is a fact about the repository and is fixable; neither says
   * anything about the payload, which falsestart never reached.
   *
   * Answering `Malformed` earlier — the obvious repair — is what these forbid. It would turn the
   * first case back into exit 1, which is the fail-open disarm the freeze was built to close.
   */
  it.effect('denies a malformed payload for the FROZEN tree it could not load, not for the payload', () =>
    withRules({}, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          freeze: () =>
            Effect.succeed({ config: frozenWith({}), rules: frozenWith({ 'broken.yml': 'id: 7\nlanguage: tsx' }) }),
          input: JSON.stringify({ tool_input: { content: 'const x = y as any' }, tool_name: 'Write' }),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(0)
        expect(response.stdout).toContain('"permissionDecision":"deny"')
        expect(response.stdout).toContain('broken.yml')
        expect(response.stdout).not.toContain('carried no content/file_path')
      }),
    ),
  )

  it.effect('denies a malformed payload under --fail closed for the guard failure it hit first', () =>
    withRules({ 'broken.yml': 'id: 7\nlanguage: tsx' }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          failure: 'closed',
          input: JSON.stringify({ tool_input: { content: 'const x = y as any' }, tool_name: 'Write' }),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(0)
        expect(response.stdout).toContain('"permissionDecision":"deny"')
        expect(response.stdout).toContain('broken.yml')
        expect(response.stdout).not.toContain('carried no content/file_path')
      }),
    ),
  )
})

/**
 * A rules SOURCE that could not be resolved at all — `--rules pkg:<name>` naming a package that is
 * not installed.
 *
 * The caller discovers this before stdin is read, so it cannot be answered there: under `--fail
 * closed` it would deny `Bash`, `Read` and every other tool call an agent makes, over payloads that
 * write nothing. It is handed to `respond` instead, which answers it behind `judgesPayload` — where
 * every other guard failure already sits.
 */
const UNRESOLVED = "could not resolve rules package (Cannot find module '@acme/nope/package.json')"

layer(platform)('a rules package the caller could not resolve', (it) => {
  // T18
  it.effect('denies a judged write when the rules package could not be resolved', () =>
    withRules({}, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          failure: 'closed',
          input: writeOf('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
          unresolvedRules: UNRESOLVED,
        })

        expect(response.exitCode).toBe(0)
        expect(response.stdout).toBeDefined()
        expect(response.stdout).toContain('"permissionDecision":"deny"')
        expect(response.stdout).toContain('could not resolve rules package')
      }),
    ),
  )

  // T19 — the negative test, and the one an end-to-end `Write` payload cannot give. Denying a
  // `Bash` call with "falsestart could not check this write" is an agent lockup rather than a write
  // guard, and it contradicts `judgesPayload`'s stated invariant.
  it.effect(
    'stays silent on a tool call it will not judge, even with an unresolvable package under --fail closed',
    () =>
      withRules({}, (rules) =>
        Effect.gen(function* () {
          const response = yield* respond({
            failure: 'closed',
            input: JSON.stringify({ tool_input: { command: 'ls' }, tool_name: 'Bash' }),
            projectDirectory: rules,
            rulesDirectory: rules,
            unresolvedRules: UNRESOLVED,
          })

          expect(response.exitCode).toBe(0)
          expect(response.stdout).toBeUndefined()
          expect(response.stderr).toBeUndefined()
        }),
      ),
  )

  // T20 — the other half of the placement, which T18 and T19 cannot see: a run that cannot load a
  // rule set has no use for four git spawns. A counter rather than a service double, matching how
  // this file already supplies `freeze` as a plain thunk.
  it.effect('never spawns the freeze for a run whose rules could not be resolved', () =>
    withRules({}, (rules) =>
      Effect.gen(function* () {
        let spawned = 0
        const response = yield* respond({
          failure: 'closed',
          freeze: () => {
            spawned += 1
            return Effect.succeed({ config: nothingToFreeze, rules: nothingToFreeze })
          },
          input: writeOf('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
          unresolvedRules: UNRESOLVED,
        })

        expect(spawned).toBe(0)
        expect(response.stdout).toContain('"permissionDecision":"deny"')
      }),
    ),
  )
})

/**
 * The moment the confusion happens: a judged write INTO the frozen rules directory.
 *
 * Scoped by two structural tests and never by content — segment containment of the destination
 * directory, and `isRuleDocument` on the name. The negative cases are the point. A note saying "this
 * does not take effect until it is committed" is actively wrong about a file that took effect
 * immediately, and telling someone that about `<rules>/.git` would be telling them it about the one
 * write this whole design exists to defeat.
 */
const noteOf = (response: HookResponse): string => {
  const payload: unknown = JSON.parse(response.stdout ?? '{}')
  return typeof payload === 'object' && payload !== null && 'systemMessage' in payload
    ? String(payload.systemMessage)
    : ''
}

const writeTo = (filePath: string, content = 'name: not a rule\n') =>
  JSON.stringify({ hook_event_name: 'PreToolUse', tool_input: { content, file_path: filePath }, tool_name: 'Write' })

const frozenRules = (documents: Readonly<Record<string, string>>) => () =>
  Effect.succeed({ config: frozenWith({}), rules: frozenWith(documents) })

layer(platform)('editing a rule while the freeze is on', (it) => {
  // T48
  it.effect('says why editing a rule document changed nothing', () =>
    withRules({ 'block-any.yml': BLOCKING }, (rules) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const response = yield* respond({
          freeze: frozenRules({ 'block-any.yml': BLOCKING }),
          input: writeTo(path.join(rules, 'new.yml')),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(0)
        expect(noteOf(response)).toContain('does not take effect until it is committed')
      }),
    ),
  )

  // T49 — nothing to explain when nothing is frozen.
  it.effect('says nothing when the rules are not frozen', () =>
    withRules({ 'block-any.yml': BLOCKING }, (rules) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const response = yield* respond({
          input: writeTo(path.join(rules, 'new.yml')),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.stdout).toBeUndefined()
      }),
    ),
  )

  // T50 — a sibling `rulesx/` shares a prefix with `rules/` and is a different directory.
  it.effect('leaves a sibling directory whose name merely starts the same alone', () =>
    withRules({ 'rules/block-any.yml': BLOCKING, 'rulesx/new.yml': 'id: x\n' }, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const response = yield* respond({
          freeze: frozenRules({ 'block-any.yml': BLOCKING }),
          input: writeTo(path.join(root, 'rulesx', 'new.yml')),
          projectDirectory: root,
          rulesDirectory: path.join(root, 'rules'),
        })

        expect(response.stdout).toBeUndefined()
      }),
    ),
  )

  // T51 — the F1 payload itself. `<rules>/.git` takes effect the instant it is written, and telling
  // its author it will not is the worst possible thing to say about it.
  it.effect('says nothing about a .git gitfile written into the rules directory', () =>
    withRules({ 'block-any.yml': BLOCKING }, (rules) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const response = yield* respond({
          freeze: frozenRules({ 'block-any.yml': BLOCKING }),
          input: writeTo(path.join(rules, '.git'), 'gitdir: /elsewhere/.git\n'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.stdout).toBeUndefined()
      }),
    ),
  )

  // T52 — the adjacent-file negative test. A REAL rule document, correct extension, refused by its
  // LOCATION alone. A `.md` here would be unfalsifiable: no implementation could treat one as a rule.
  it.effect('leaves a real rule document outside the rules directory alone', () =>
    withRules({ 'examples/sample-rule.yml': BLOCKING, 'rules/block-any.yml': BLOCKING }, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const response = yield* respond({
          freeze: frozenRules({ 'block-any.yml': BLOCKING }),
          input: writeTo(path.join(root, 'examples', 'sample-rule.yml'), BLOCKING),
          projectDirectory: root,
          rulesDirectory: path.join(root, 'rules'),
        })

        expect(response.stdout).toBeUndefined()
      }),
    ),
  )

  // T53 — containment alone is not enough; a README in the rules directory is not a rule.
  it.effect('says nothing about a document in the rules directory that is not a rule', () =>
    withRules({ 'block-any.yml': BLOCKING }, (rules) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const response = yield* respond({
          freeze: frozenRules({ 'block-any.yml': BLOCKING }),
          input: writeTo(path.join(rules, 'NOTES.md'), '# how these work\n'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.stdout).toBeUndefined()
      }),
    ),
  )

  // Not in the design's catalogue, and all three are reachable. The rules directory can be gone
  // entirely — that is the case the lexical path derivation exists to keep frozen — the destination
  // directory need not exist yet, and a payload can carry no path at all.
  it.effect('says nothing when there is no rules directory on disk to compare against', () =>
    withRules({}, (root) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const response = yield* respond({
          freeze: frozenRules({ 'block-any.yml': BLOCKING }),
          input: writeTo(path.join(root, 'deleted-rules', 'new.yml')),
          projectDirectory: root,
          rulesDirectory: path.join(root, 'deleted-rules'),
        })

        expect(response.stdout).toBeUndefined()
      }),
    ),
  )

  it.effect('says nothing when the destination directory does not exist yet', () =>
    withRules({ 'block-any.yml': BLOCKING }, (rules) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const response = yield* respond({
          freeze: frozenRules({ 'block-any.yml': BLOCKING }),
          input: writeTo(path.join(rules, 'new', 'nested', 'rule.yml')),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.stdout).toBeUndefined()
      }),
    ),
  )

  it.effect('reports an incomplete payload as before, rather than noting anything about it', () =>
    withRules({ 'block-any.yml': BLOCKING }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          freeze: frozenRules({ 'block-any.yml': BLOCKING }),
          input: JSON.stringify({ tool_input: { content: 'const x = y as any' }, tool_name: 'Write' }),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(1)
        expect(response.stdout).toBeUndefined()
      }),
    ),
  )

  it.effect('appends the note to a denial rather than replacing it', () =>
    withRules({ 'block-any.yml': BLOCKING }, (rules) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        // A rule document whose own CONTENT breaks a rule: both things are true at once, and the
        // decision must win while the explanation still arrives.
        const response = yield* respond({
          freeze: frozenRules({ 'block-any.yml': BLOCKING.replace("'**/*.ts'", "'**/*.{ts,yml}'") }),
          input: writeTo(path.join(rules, 'new.yml'), 'const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.stdout).toContain('"permissionDecision":"deny"')
        expect(response.stdout).toContain('FROZEN MESSAGE')
        expect(response.stdout).toContain('does not take effect until it is committed')
      }),
    ),
  )
})

/**
 * The Copilot emit contract: a second price list for the same four outcomes.
 *
 * The exit codes are not a preference here, they are forced. GitHub's hooks reference says a
 * `preToolUse` hook's exit 2 is a deny and that **any other non-zero exit denies too**, as "hook
 * errored". So exit 1 does not mean "reported, and the write proceeds" under Copilot — it means the
 * tool call is blocked with a reason nobody can act on. There is no exit 1 in this contract at all.
 *
 * Nothing here can be run against a real Copilot binary from this repository. What is asserted is
 * the contract as GitHub documents it, and the design says so in the reference rather than implying
 * a measurement nobody took.
 */
const COPILOT_EDIT = `
id: no-as-any
language: tsx
message: 'as any erases the type'
rule:
  pattern: $X as any
`

/** Loads cleanly and cannot run — the class `--freeze off` cannot repair. */
const NOT_A_MATCHER = 'id: broken\nlanguage: tsx\nrule:\n  nonsense: true\n'

const copilotEdit = (content: string, filePath = '/repo/src/widget.ts') =>
  JSON.stringify({ cwd: '/repo', toolArgs: { new_str: content, old_str: '', path: filePath }, toolName: 'edit' })

/** Whatever the response said, on whichever stream it said it on. */
const spoken = (response: HookResponse): string => `${response.stdout ?? ''}\n${response.stderr ?? ''}`

layer(platform)('the Copilot emit contract', (it) => {
  // T-A6 — `toEqual` on the whole document rather than `toMatchObject`: an extra key would be a
  // second contract smuggled into the first, and a stray `hookSpecificOutput` is exactly the
  // envelope Copilot ignores (github/copilot-cli#2013) and the likeliest reason a deny read as an
  // allow in the first place.
  it.effect('denies with exit 2, Copilot’s own document on stdout, and the reason on stderr', () =>
    withRules({ 'no-as-any.yml': COPILOT_EDIT }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          agent: 'copilot',
          input: copilotEdit('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(2)
        const payload = JSON.parse(response.stdout ?? '{}')
        expect(payload).toEqual({
          permissionDecision: 'deny',
          permissionDecisionReason: expect.stringContaining('as any erases the type'),
        })
        expect(response.stderr).toContain('as any erases the type')
      }),
    ),
  )

  // T-A9b — the guard the whole contract parameter exists for, mirroring T10. A WELL-FORMED Copilot
  // payload and a rule that cannot run at match time: if `judgedTarget` ever judges this against the
  // wrong contract it lands on `Malformed`, which reports instead of denying, and `--fail closed`
  // stops applying under `--agent copilot` with nothing to show for it.
  it.effect('denies a write it could not check, on a well-formed Copilot payload', () =>
    withRules({ 'broken.yml': NOT_A_MATCHER }, (rules) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const response = yield* respond({
          agent: 'copilot',
          failure: 'closed',
          input: JSON.stringify({
            cwd: rules,
            toolArgs: { new_str: 'const x = 1', old_str: '', path: path.join(rules, 'src', 'a.ts') },
            toolName: 'edit',
          }),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(2)
        expect(JSON.parse(response.stdout ?? '{}').permissionDecisionReason).toContain('could not run')
      }),
    ),
  )

  // T-A9c — the freeze's rule-edit note reaches a Copilot author too. It keys on the judged target
  // being a Write, so a payload read against the wrong contract silently never produces one.
  it.effect('explains why editing a rule document changed nothing', () =>
    withRules({ 'block-any.yml': BLOCKING }, (rules) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const response = yield* respond({
          agent: 'copilot',
          freeze: frozenRules({ 'block-any.yml': BLOCKING }),
          input: JSON.stringify({
            cwd: rules,
            toolArgs: { content: 'name: not a rule\n', path: path.join(rules, 'new.yml') },
            toolName: 'create',
          }),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(spoken(response)).toContain('does not take effect until it is committed')
      }),
    ),
  )

  // T-A10 — a freeze refusal denies in exit-2 form, and still names the escape that works.
  it.effect('denies a freeze it cannot honour in exit-2 form, naming --freeze off', () =>
    withRules({}, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          agent: 'copilot',
          freeze: () =>
            Effect.succeed({
              config: { _tag: 'Broken', reason: 'git said no' },
              rules: { _tag: 'Broken', reason: 'git said no' },
            }),
          input: copilotEdit('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(2)
        expect(JSON.parse(response.stdout ?? '{}').permissionDecisionReason).toContain('--freeze off')
      }),
    ),
  )

  // R9 — the last Copilot diagnostic that did not name its contract. A reader seeing it could not
  // tell which contract had rejected their payload, which is the whole reason the prefix exists.
  it.effect('names the contract on stdin it could not read as JSON', () =>
    withRules({ 'no-as-any.yml': COPILOT_EDIT }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          agent: 'copilot',
          input: 'this is not json',
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(0)
        expect(response.stderr).toContain('copilot: could not read the hook payload as JSON')
      }),
    ),
  )

  // T-A13 — the default path, with the flag explicitly absent. Cannot be seen failing by
  // withholding code; guarded by inverting `emitterFor`'s ternary and watching both rows go red.
  it.effect('answers exactly as it always has when no agent is declared', () =>
    withRules({ 'no-as-any.yml': COPILOT_EDIT }, (rules) =>
      Effect.gen(function* () {
        const denied = yield* respond({
          agent: undefined,
          input: writeOf('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(denied.exitCode).toBe(0)
        expect(denied.stderr).toBeUndefined()
        expect(JSON.parse(denied.stdout ?? '{}').hookSpecificOutput.permissionDecision).toBe('deny')

        const incomplete = yield* respond({
          agent: undefined,
          input: JSON.stringify({ tool_input: { content: 'const x = y as any' }, tool_name: 'Write' }),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(incomplete.exitCode).toBe(1)
        expect(incomplete.stdout).toBeUndefined()
        expect(incomplete.stderr).toBe(
          'falsestart: Write carried no content/file_path to judge (tool_input carried: content)',
        )
      }),
    ),
  )
})

/**
 * The outcomes Copilot forces to exit 0, and the one it forces onto the other runtime's channel.
 *
 * Exit 1 is not available here for anything: it denies. So every non-deny answer costs 0, which
 * makes `docs/architecture.md`'s fifth row STRONGER under Copilot — a malformed payload cannot deny
 * even in principle — and makes `--fail open` mean what it says instead of inverting.
 */
layer(platform)('what a Copilot guard failure costs', (it) => {
  // T-A7 — 1 would deny, which is `--fail open` silently becoming fail-closed with a reason the
  // reader cannot act on. That inversion is the one thing `--fail`'s design refuses.
  it.effect('reports a rule tree it could not load at exit 0, not 1', () =>
    withRules({ 'broken.yml': 'id: 7\nlanguage: tsx' }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          agent: 'copilot',
          input: copilotEdit('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(0)
        expect(response.stdout).toBeUndefined()
        expect(response.stderr).toContain('could not load rules from')
      }),
    ),
  )

  // T-A8 — the same failure under the other policy, in exit-2 form, still leading with the sentence
  // that stops an agent rewriting code nothing judged.
  it.effect('denies under --fail closed in exit-2 form, still leading with the unchecked notice', () =>
    withRules({ 'broken.yml': 'id: 7\nlanguage: tsx' }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          agent: 'copilot',
          failure: 'closed',
          input: copilotEdit('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(2)
        const reason = String(JSON.parse(response.stdout ?? '{}').permissionDecisionReason)
        expect(reason).toContain('falsestart could not check this write')
        expect(reason).toContain('--fail open')
      }),
    ),
  )

  // T-A9 — KNOWN LIMITATION, stated so it is not mistaken for coverage: this payload is malformed
  // under both contracts, so it passes with or without the contract being threaded correctly. What
  // it guards is "a malformed payload never denies" and nothing else. The contract wiring is
  // guarded by the well-formed payload above.
  it.effect('never denies a malformed Copilot payload, even under --fail closed', () =>
    withRules({ 'no-as-any.yml': COPILOT_EDIT }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          agent: 'copilot',
          failure: 'closed',
          input: JSON.stringify({ toolArgs: { path: '/r/a.ts' }, toolName: 'edit' }),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(0)
        expect(response.stdout).toBeUndefined()
        expect(response.stderr).toContain('carried no new_str/path to judge')
      }),
    ),
  )

  // T-A9d — the misdeclaration goes out on the channel the runtime that ACTUALLY sent it reads. The
  // evidence of who is on the other end is stronger than the flag, and the message is useless on
  // the wrong channel: emitted Copilot-style it would be exit 0 with nothing Claude Code shows,
  // which is silence — and silence is precisely what makes this direction dangerous.
  it.effect('answers a misdeclared agent on the other runtime’s channel', () =>
    withRules({ 'no-as-any.yml': COPILOT_EDIT }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          agent: 'copilot',
          input: JSON.stringify({
            tool_input: { content: 'const x = 1', file_path: '/repo/src/a.ts' },
            tool_name: 'Write',
          }),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(1)
        expect(response.stderr).toContain('--agent claude-code')
        expect(response.stdout).toBeUndefined()
      }),
    ),
  )

  // A misdeclared flag means NOTHING in the session is being judged, so the notice is the whole
  // answer — and it must not cost a judged write to produce. Answered before the rules source, the
  // freeze's four git spawns and the rule-tree load, all of which ran first while the payload was
  // never going to be judged by any of them. A broken rule tree is the fixture that measures it:
  // if the tree is still loaded, the response names the tree instead of the flag.
  it.effect('answers a misdeclared agent without loading anything to answer it', () =>
    withRules({ 'broken.yml': 'id: 7\nlanguage: tsx' }, (rules) =>
      Effect.gen(function* () {
        let spawned = 0
        const response = yield* respond({
          agent: 'copilot',
          failure: 'closed',
          freeze: () => {
            spawned += 1
            return Effect.succeed({ config: frozenWith({}), rules: frozenWith({}) })
          },
          input: JSON.stringify({
            tool_input: { content: 'const x = 1', file_path: '/repo/src/a.ts' },
            tool_name: 'Write',
          }),
          projectDirectory: rules,
          rulesDirectory: rules,
          unresolvedRules: UNRESOLVED,
        })

        expect(spawned).toBe(0)
        expect(response.exitCode).toBe(1)
        expect(response.stderr).toContain('--agent claude-code')
        // Not the rules package, not the broken tree, and NOT a denial: `--fail closed` is a policy
        // about a guard that could not do its job on a payload it was going to judge. This payload
        // is not one, in either contract — the same reason a malformed payload is never the REASON
        // to deny.
        expect(response.stdout).toBeUndefined()
        expect(response.stderr).not.toContain('could not resolve rules package')
      }),
    ),
  )

  // T-A12 — the hot path through the whole of `respond`, in both spellings. A broken rule tree on
  // disk is the fixture that makes this measurable: if the tree is loaded at all, this is exit 0
  // with a stderr notice rather than silence.
  it.effect('costs a Copilot tool call that writes nothing exactly nothing, in either spelling', () =>
    withRules({ 'broken.yml': 'id: 7\nlanguage: tsx' }, (rules) =>
      Effect.gen(function* () {
        for (const input of [
          JSON.stringify({ toolArgs: '{"command":"ls"}', toolName: 'bash' }),
          JSON.stringify({ tool_input: { command: 'ls' }, tool_name: 'bash' }),
        ]) {
          const response = yield* respond({
            agent: 'copilot',
            input,
            projectDirectory: rules,
            rulesDirectory: rules,
          })

          expect(response.exitCode).toBe(0)
          expect(response.stdout).toBeUndefined()
          expect(response.stderr).toBeUndefined()
        }
      }),
    ),
  )
})

/**
 * Advice under Copilot: shown, and deciding nothing.
 *
 * Copilot's `preToolUse` output has three keys and not one of them is non-deciding.
 * `permissionDecision: "allow"` would AUTO-APPROVE a write the permission flow would otherwise have
 * prompted for, and `"ask"` would make advice block — both of which `decide.ts` rejects by name. So
 * advice goes to stderr and stdout stays empty, which forbids both at once.
 *
 * The cost is real and is documented: a `severity: warning` finding reaches the user and the log
 * under Copilot, and never the model.
 */
layer(platform)('Copilot advice', (it) => {
  // T-A11a — `toBeUndefined` on stdout rather than "does not contain allow": the danger is emitting
  // a `permissionDecision` at all, and asserting the channel is empty forbids every value of it.
  it.effect('shows an advisory finding without deciding anything', () =>
    withRules({ 'soft.yml': `${COPILOT_EDIT}severity: warning\n` }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          agent: 'copilot',
          input: copilotEdit('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(0)
        expect(response.stdout).toBeUndefined()
        expect(response.stderr).toContain('as any erases the type')
      }),
    ),
  )

  // T-A11b — the other source of advice, which carries no finding at all, lands on the same channel.
  it.effect('reports an unscoped write on the same channel', () =>
    withRules({ 'no-as-any.yml': `${COPILOT_EDIT}files:\n  - '**/*.tsx'\n` }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          agent: 'copilot',
          input: copilotEdit('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
          warnUnscoped: true,
        })

        expect(response.exitCode).toBe(0)
        expect(response.stdout).toBeUndefined()
        expect(response.stderr).toContain('no rule is scoped to')
      }),
    ),
  )
})

/**
 * Registered at an event falsestart does not implement (#63).
 *
 * The emission is the whole point here, not the verdict: `decide` reporting is worth nothing if
 * `respond` still writes a `PreToolUse` document to stdout, and worth less than nothing if the
 * refusal reaches Copilot as exit 1 — every other non-zero exit denies there, so a refusal that
 * exited 1 would deny every tool call in the repository over a REGISTRATION mistake.
 *
 * So the channel is the declared contract's own `problem` channel, which is exit 1 + stderr under
 * Claude Code ("non-blocking error, stderr shown to the user, execution continues" — the same row
 * `PostToolUse` uses) and exit 0 + stderr under Copilot. Neither can deny, in any policy.
 */
const AT_ANOTHER_EVENT = JSON.stringify({
  hook_event_name: 'PostToolUse',
  tool_input: { content: 'const x = value as any', file_path: '/repo/src/widget.ts' },
  tool_name: 'Write',
})

layer(platform)('registered at an event falsestart does not implement', (it) => {
  it.effect('refuses on Claude Code’s channel instead of emitting a PreToolUse document', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          input: AT_ANOTHER_EVENT,
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(1)
        // The bug, asserted as an absence: this used to be a document naming `PreToolUse` and
        // carrying `permissionDecision`, which `PostToolUse` does not define and the runtime
        // silently ignores. Asserting the channel is EMPTY forbids every shape of it.
        expect(response.stdout).toBeUndefined()
        expect(response.stderr).toContain('this hook was invoked for `PostToolUse`')
        expect(response.stderr).toContain('falsestart scan')
      }),
    ),
  )

  // The sharp edge. Copilot denies on any non-zero exit other than 2, so the one thing this
  // refusal must never be under `--agent copilot` is exit 1 — a registration mistake would then
  // block `bash`, `view` and `grep` for the whole session.
  it.effect('never exits 1 under --agent copilot, in either policy', () =>
    withRules({ 'no-as-any.yml': COPILOT_EDIT }, (rules) =>
      Effect.gen(function* () {
        for (const failure of ['open', 'closed'] as const) {
          const response = yield* respond({
            agent: 'copilot',
            failure,
            input: JSON.stringify({
              hook_event_name: 'PostToolUse',
              tool_input: { new_str: 'const x = value as any', old_str: '', path: '/repo/src/widget.ts' },
              tool_name: 'edit',
            }),
            projectDirectory: rules,
            rulesDirectory: rules,
          })

          expect(response.exitCode).toBe(0)
          expect(response.stdout).toBeUndefined()
          expect(response.stderr).toContain('copilot: this hook was invoked for `PostToolUse`')
        }
      }),
    ),
  )

  // `--fail closed` is a policy about a guard that could not check a write it was going to judge.
  // This is not one: falsestart was not asked to judge anything, and a denial here would be the
  // ignored-document bug again in a louder costume — at PostToolUse Claude Code cannot block.
  it.effect('never denies under --fail closed either', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          failure: 'closed',
          input: AT_ANOTHER_EVENT,
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(1)
        expect(response.stdout).toBeUndefined()
      }),
    ),
  )

  // Answered before the rules source, the freeze's four git spawns and the rule-tree load, for the
  // reason the misdeclared-`--agent` notice is: nothing in the session is being judged, so naming
  // a broken tree or an unresolvable package would answer a question nobody is in a position to
  // ask. The broken tree is what measures it — if it is still loaded, it is what gets named.
  it.effect('answers without loading anything to answer it', () =>
    withRules({ 'broken.yml': 'id: 7\nlanguage: tsx' }, (rules) =>
      Effect.gen(function* () {
        let spawned = 0
        const loaded = yield* respond({
          freeze: () => {
            spawned += 1
            return Effect.succeed({ config: frozenWith({}), rules: frozenWith({}) })
          },
          input: AT_ANOTHER_EVENT,
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(spawned).toBe(0)
        expect(loaded.stderr).toContain('this hook was invoked for `PostToolUse`')
        expect(loaded.stderr).not.toContain('could not load rules from')

        // The other guard failure answered above this one, and the sharpest of the pair: under
        // `--fail closed` an unresolvable rules package used to DENY this payload — a denial, at an
        // event where the runtime cannot block, in a document naming the wrong event.
        const unresolved = yield* respond({
          failure: 'closed',
          input: AT_ANOTHER_EVENT,
          projectDirectory: rules,
          rulesDirectory: rules,
          unresolvedRules: UNRESOLVED,
        })

        expect(unresolved.stdout).toBeUndefined()
        expect(unresolved.stderr).toContain('this hook was invoked for `PostToolUse`')
        expect(unresolved.stderr).not.toContain('could not resolve rules package')
      }),
    ),
  )

  // The regression an adversarial review found, pinned where it happened: on the CHANNEL. With the
  // event refusal winning, `--agent copilot` in front of a Claude Code payload at another event
  // answered at exit 0 on Copilot's channel, which Claude Code writes to the debug log and nowhere
  // else — while the release before it said `Set --agent claude-code` at exit 1, in the transcript.
  // A fix that turns a visible diagnostic into silence is a regression whatever its exit code says.
  it.effect('keeps the misdeclared-agent notice, which is the only one that can be read here', () =>
    withRules({ 'no-as-any.yml': COPILOT_EDIT }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          agent: 'copilot',
          input: AT_ANOTHER_EVENT,
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(1)
        expect(response.stderr).toContain('--agent claude-code')
        expect(response.stderr).not.toContain('this hook was invoked for')
      }),
    ),
  )

  // A tool call falsestart would have deferred at PreToolUse costs the same at any other event:
  // silence. It is registration noise otherwise — most of a session's traffic writes nothing, and
  // a notice on every `Bash` call is one the reader learns to skip.
  it.effect('stays silent about a tool call it would never have judged anyway', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          input: JSON.stringify({ hook_event_name: 'PostToolUse', tool_input: { command: 'ls' }, tool_name: 'Bash' }),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(0)
        expect(response.stdout).toBeUndefined()
        expect(response.stderr).toBeUndefined()
      }),
    ),
  )

  // The two negatives, through the whole of `respond` rather than only through `decide`: a payload
  // naming `PreToolUse` and a payload naming no event at all both still deny, in the exact shape
  // they always have.
  it.effect('denies exactly as it always has at PreToolUse, named or absent', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        for (const input of [
          writeOf('const x = value as any'),
          JSON.stringify({
            tool_input: { content: 'const x = value as any', file_path: '/repo/src/widget.ts' },
            tool_name: 'Write',
          }),
        ]) {
          const response = yield* respond({ input, projectDirectory: rules, rulesDirectory: rules })

          expect(response.exitCode).toBe(0)
          expect(response.stderr).toBeUndefined()
          const payload = JSON.parse(response.stdout ?? '{}')
          expect(payload.hookSpecificOutput.hookEventName).toBe('PreToolUse')
          expect(payload.hookSpecificOutput.permissionDecision).toBe('deny')
        }
      }),
    ),
  )
})

layer(platform)('judging with more than one rule source', (it) => {
  const noDateNow = `id: no-date-now\nlanguage: tsx\nseverity: error\nmessage: 'Date.now() is not injectable'\nrule:\n  pattern: Date.now()\nfiles:\n  - '**/*.{ts,tsx}'\n`

  it.effect("blocks with a rule from a shipped source as well as the caller's own", () =>
    withRules({ 'no-as-any.yml': noAsAny }, (own) =>
      withRules({ 'no-date-now.yml': noDateNow }, (shipped) =>
        Effect.gen(function* () {
          const judge = (content: string) =>
            respond({
              input: writeOf(content),
              projectDirectory: own,
              rulesDirectory: own,
              shippedDirectories: [shipped],
            })

          // Both halves, because a union that quietly loaded only one of them would look exactly
          // like the feature working from either side alone.
          expect((yield* judge('const x = value as any')).stdout).toContain('no-as-any')
          expect((yield* judge('const t = Date.now()')).stdout).toContain('no-date-now')
        }),
      ),
    ),
  )

  it.effect('reports both directories when one of two sources cannot be loaded', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (own) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const absent = path.join(own, 'absent')
        const response = yield* respond({
          input: writeOf('const x = value as any'),
          projectDirectory: own,
          rulesDirectory: own,
          shippedDirectories: [absent],
        })

        expect(response.stderr).toContain('could not load rules from')
        expect(response.stderr).toContain(absent)
        expect(response.stderr).toContain(own)
      }),
    ),
  )
})
