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

  effect('does not block on a finding below error severity', () =>
    Effect.gen(function* () {
      const advisory = yield* rulesOf(`${noAsAny}severity: warning\n`)

      const decision = yield* decide(advisory, writePayload('const x = value as any'))

      expect(decision._tag).toBe('Defer')
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
