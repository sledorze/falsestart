import { describe, effect, expect } from '@effect/vitest'
import { Effect } from 'effect'
import type { Rule } from '../core/rule.ts'
import { parseRule } from '../core/rule.ts'
import { decide } from './decide.ts'

const rulesOf = (...sources: readonly string[]) => Effect.all(sources.map((source) => parseRule(source, 'test.yml')))

const noAsAny = `
id: no-as-any
language: tsx
message: 'as any erases the type'
rule:
  pattern: $X as any
`

const writePayload = (content: string, path = '/repo/src/widget.ts') => ({
  tool_input: { content, file_path: path },
  tool_name: 'Write',
})

describe('hook decision', () => {
  effect('denies a Write whose content violates a rule', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), writePayload('const x = value as any'))

      expect(decision._tag).toBe('Deny')
      expect(decision._tag === 'Deny' && decision.reason).toContain('as any erases the type')
    }),
  )

  effect('names the rule and the line in the denial', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), writePayload('const ok = 1\nconst x = y as any'))

      const reason = decision._tag === 'Deny' ? decision.reason : ''
      expect(reason).toContain('no-as-any')
      expect(reason).toContain('2')
    }),
  )

  effect('defers a Write whose content is clean', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), writePayload('const x = value as Widget'))

      expect(decision._tag).toBe('Defer')
    }),
  )

  effect('judges an Edit by the text it would introduce', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), {
        tool_input: {
          file_path: '/repo/src/widget.ts',
          new_string: 'const x = value as any',
          old_string: 'const x = value',
        },
        tool_name: 'Edit',
      })

      expect(decision._tag).toBe('Deny')
    }),
  )

  effect('has no opinion about tools that do not write source', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), {
        tool_input: { command: 'const x = value as any' },
        tool_name: 'Bash',
      })

      expect(decision._tag).toBe('Defer')
    }),
  )

  effect('respects the rule file scope, so an out-of-scope path is not blocked', () =>
    Effect.gen(function* () {
      const scoped = yield* rulesOf(`${noAsAny}files:\n  - '**/*.tsx'\n`)

      const decision = yield* decide(scoped, writePayload('const x = value as any', '/repo/src/widget.ts'))

      expect(decision._tag).toBe('Defer')
    }),
  )

  effect('lists every violation rather than only the first', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), writePayload('const a = x as any\nconst b = y as any'))

      const reason = decision._tag === 'Deny' ? decision.reason : ''
      expect(reason.match(/no-as-any/g)).toHaveLength(2)
    }),
  )

  effect('advises rather than blocks on a finding below error severity', () =>
    Effect.gen(function* () {
      const advisory = yield* rulesOf(`${noAsAny}severity: warning\n`)

      const decision = yield* decide(advisory, writePayload('const x = value as any'))

      // Not Deny — it must not stop the write. Not Defer either: dropping it would make a
      // `warning` rule do nothing at all.
      expect(decision._tag).toBe('Advise')
      expect(decision._tag === 'Advise' && decision.note).toContain('as any erases the type')
    }),
  )

  effect('prefers blocking over advising when both kinds are found', () =>
    Effect.gen(function* () {
      const mixed = yield* rulesOf(noAsAny, `${noAsAny.replace('no-as-any', 'soft-rule')}severity: warning\n`)

      const decision = yield* decide(mixed, writePayload('const x = value as any'))

      expect(decision._tag).toBe('Deny')
    }),
  )

  effect('reports rather than blocks when the payload makes no sense', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), 'not a payload at all')

      expect(decision._tag).toBe('Report')
    }),
  )

  effect('reports a payload that names no tool', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), { tool_input: { content: 'x' } })

      expect(decision._tag).toBe('Report')
    }),
  )

  effect('reports a write tool whose input is not an object', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), { tool_input: 'nonsense', tool_name: 'Write' })

      expect(decision._tag).toBe('Report')
    }),
  )

  effect('reports a Write that carries no path to judge', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), {
        tool_input: { content: 'const x = value as any' },
        tool_name: 'Write',
      })

      expect(decision._tag).toBe('Report')
    }),
  )

  effect('reports, and does not block, when a rule itself cannot run', () =>
    Effect.gen(function* () {
      const broken: Rule = { id: 'broken', language: 'tsx', rule: { nonsense: true } }

      const decision = yield* decide([broken], writePayload('const x = 1'))

      expect(decision._tag).toBe('Report')
      expect(decision._tag === 'Report' && decision.problem).toContain('broken')
    }),
  )
})

describe('project-relative scoping', () => {
  effect('applies a repo-relative rule glob to the absolute path a hook reports', () =>
    Effect.gen(function* () {
      // Regression: rules are authored as `src/**/*.ts`, hooks report `/repo/src/a.ts`, and
      // matching one against the other used to silently never fire.
      const scoped = yield* rulesOf(`${noAsAny}files:\n  - 'src/**/*.ts'\n`)

      const decision = yield* decide(scoped, {
        cwd: '/repo',
        tool_input: { content: 'const x = value as any', file_path: '/repo/src/widget.ts' },
        tool_name: 'Write',
      })

      expect(decision._tag).toBe('Deny')
    }),
  )

  effect('still keeps a repo-relative rule off a path it does not cover', () =>
    Effect.gen(function* () {
      const scoped = yield* rulesOf(`${noAsAny}files:\n  - 'src/**/*.ts'\n`)

      const decision = yield* decide(scoped, {
        cwd: '/repo',
        tool_input: { content: 'const x = value as any', file_path: '/repo/vendor/widget.ts' },
        tool_name: 'Write',
      })

      expect(decision._tag).toBe('Defer')
    }),
  )

  effect('falls back to the absolute path when the payload carries no cwd', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), writePayload('const x = value as any'))

      expect(decision._tag).toBe('Deny')
    }),
  )
})

describe('notebook writes', () => {
  effect('judges a NotebookEdit by the source it would introduce', () =>
    Effect.gen(function* () {
      // NotebookEdit writes real source and was previously an unjudged bypass.
      const decision = yield* decide(yield* rulesOf(noAsAny), {
        tool_input: {
          cell_type: 'code',
          new_source: 'const x = value as any',
          notebook_path: '/repo/analysis.ipynb',
        },
        tool_name: 'NotebookEdit',
      })

      expect(decision._tag).toBe('Deny')
    }),
  )

  effect('scopes a notebook by its own path field', () =>
    Effect.gen(function* () {
      // The path lives in `notebook_path`, not `file_path`; reading the wrong key would leave the
      // rule unscoped rather than out of scope.
      const scoped = yield* rulesOf(`${noAsAny}files:\n  - '**/*.ts'\n`)

      const decision = yield* decide(scoped, {
        tool_input: { new_source: 'const x = value as any', notebook_path: '/repo/analysis.ipynb' },
        tool_name: 'NotebookEdit',
      })

      expect(decision._tag).toBe('Defer')
    }),
  )

  effect('reports a NotebookEdit missing its path', () =>
    Effect.gen(function* () {
      const decision = yield* decide(yield* rulesOf(noAsAny), {
        tool_input: { new_source: 'const x = value as any' },
        tool_name: 'NotebookEdit',
      })

      expect(decision._tag).toBe('Report')
    }),
  )
})
