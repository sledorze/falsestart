import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { describe, effect, expect } from '@effect/vitest'
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
      yield* fs.writeFileString(path.join(root, name), contents)
    }

    return yield* use(root)
  }).pipe(Effect.scoped, Effect.provide(platform))

const writeOf = (content: string) =>
  JSON.stringify({
    hook_event_name: 'PreToolUse',
    tool_input: { content, file_path: '/repo/src/widget.ts' },
    tool_name: 'Write',
  })

describe('hook response', () => {
  effect('emits a deny decision in the shape the hook contract defines', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond(rules, writeOf('const x = value as any'))

        // Blocking is exit 0 WITH json on stdout. Exit 2 would discard stdout entirely.
        expect(response.exitCode).toBe(0)
        const payload = JSON.parse(response.stdout ?? '{}')
        expect(payload.hookSpecificOutput.hookEventName).toBe('PreToolUse')
        expect(payload.hookSpecificOutput.permissionDecision).toBe('deny')
        expect(payload.hookSpecificOutput.permissionDecisionReason).toContain('as any erases the type')
      }),
    ),
  )

  effect('stays silent when the write is clean', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond(rules, writeOf('const x = value as Widget'))

        expect(response.exitCode).toBe(0)
        expect(response.stdout).toBeUndefined()
        expect(response.stderr).toBeUndefined()
      }),
    ),
  )

  effect('emits advisory findings as a system message with no permission decision', () =>
    withRules({ 'soft.yml': `${noAsAny}severity: warning\n` }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond(rules, writeOf('const x = value as any'))

        expect(response.exitCode).toBe(0)
        const payload = JSON.parse(response.stdout ?? '{}')
        expect(payload.systemMessage).toContain('as any erases the type')
        // No permissionDecision: advising must not silently approve the write either.
        expect(payload.hookSpecificOutput).toBeUndefined()
      }),
    ),
  )

  effect('surfaces a problem without blocking when the input is not JSON', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond(rules, 'this is not json')

        // Exit 1 is the contract's non-blocking error: the user sees it, the write proceeds.
        expect(response.exitCode).toBe(1)
        expect(response.stderr).toContain('JSON')
        expect(response.stdout).toBeUndefined()
      }),
    ),
  )

  effect('surfaces a problem without blocking when the rules cannot be loaded', () =>
    withRules({}, (rules) =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const response = yield* respond(path.join(rules, 'absent'), writeOf('const x = value as any'))

        expect(response.exitCode).toBe(1)
        expect(response.stderr).toBeDefined()
        expect(response.stdout).toBeUndefined()
      }),
    ),
  )

  effect('surfaces a problem without blocking when a rule document is malformed', () =>
    withRules({ 'broken.yml': 'id: 7\nlanguage: tsx' }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond(rules, writeOf('const x = value as any'))

        expect(response.exitCode).toBe(1)
        expect(response.stderr).toContain('broken.yml')
      }),
    ),
  )

  effect('surfaces a problem without blocking when a judgeable payload is incomplete', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        // A Write with no file_path: judgeable in principle, but there is no path to scope by.
        const response = yield* respond(
          rules,
          JSON.stringify({ tool_input: { content: 'const x = y as any' }, tool_name: 'Write' }),
        )

        expect(response.exitCode).toBe(1)
        expect(response.stdout).toBeUndefined()
      }),
    ),
  )

  effect('has no opinion about a tool that writes no source', () =>
    withRules({ 'no-as-any.yml': noAsAny }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond(rules, JSON.stringify({ tool_input: { command: 'ls' }, tool_name: 'Bash' }))

        expect(response.exitCode).toBe(0)
        expect(response.stdout).toBeUndefined()
      }),
    ),
  )

  effect('does not load rules for a tool it will not judge', () =>
    // A broken rule tree must not turn an unrelated Bash call into an error notice.
    withRules({ 'broken.yml': 'id: 7\nlanguage: tsx' }, (rules) =>
      Effect.gen(function* () {
        const response = yield* respond(rules, JSON.stringify({ tool_input: {}, tool_name: 'Bash' }))

        expect(response.exitCode).toBe(0)
        expect(response.stderr).toBeUndefined()
      }),
    ),
  )
})
