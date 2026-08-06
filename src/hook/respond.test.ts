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
          freeze: () => ({ config: frozenWith({}), rules: frozenWith({ 'block-any.yml': BLOCKING }) }),
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
          freeze: () => ({ config: { _tag: 'Broken', reason }, rules: { _tag: 'Broken', reason } }),
          input: writeOf('const x = value as any'),
          projectDirectory: '/no/such/place',
          rulesDirectory: '/no/such/place',
        }).pipe(Effect.provide(platform))

        expect(response.exitCode).toBe(0)
        expect(response.stdout).toContain('"permissionDecision":"deny"')
        expect(response.stdout).toContain(reason)
        expect(response.stdout).toContain('--freeze=off')
      }),
    )
  })

  // T46 — F3. `respond.ts` turns any ConfigError into a non-blocking notice, so without this a
  // committed config that will not parse is a disarm through the path this change exists to close.
  it.effect('denies when the committed config will not parse', () =>
    withRules({ 'block-any.yml': BLOCKING }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          freeze: () => ({
            config: frozenWith({ 'falsestart.config.json': '{oops' }),
            rules: nothingToFreeze,
          }),
          input: writeOf('const x = value as any'),
          projectDirectory: rules,
          rulesDirectory: rules,
        })

        expect(response.exitCode).toBe(0)
        expect(response.stdout).toContain('"permissionDecision":"deny"')
        expect(response.stdout).toContain('--freeze=off')
      }),
    ),
  )

  // T47 — the same for the rules half. A COMMITTED rule that does not load is a repository-wide
  // problem a commit introduced, which is exactly what `scan` already fails closed on.
  it.effect('denies when the committed rule tree will not load', () =>
    withRules({ 'block-any.yml': BLOCKING }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond({
          freeze: () => ({ config: frozenWith({}), rules: frozenWith({ 'broken.yml': 'id: 7\nlanguage: tsx' }) }),
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
          freeze: () => ({
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

const frozenRules = (documents: Readonly<Record<string, string>>) => () => ({
  config: frozenWith({}),
  rules: frozenWith(documents),
})

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
          freeze: frozenRules({ 'block-any.yml': BLOCKING }),
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
