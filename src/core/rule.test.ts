import { describe, effect, expect } from '@effect/vitest'
import { Effect } from 'effect'
import { parseRule } from './rule.ts'

const minimal = `
id: no-as-any
language: tsx
rule:
  pattern: $X as any
`

const expectRejection = (source: string, origin = 'rule.yml') =>
  Effect.flip(parseRule(source, origin)).pipe(Effect.map((error) => error.reason))

describe('rule document parsing', () => {
  effect('parses a minimal rule', () =>
    Effect.gen(function* () {
      const rule = yield* parseRule(minimal, 'no-as-any.yml')

      expect(rule.id).toBe('no-as-any')
      expect(rule.language).toBe('tsx')
      expect(rule.rule).toEqual({ pattern: '$X as any' })
    }),
  )

  effect('leaves absent optional fields absent rather than undefined-valued', () =>
    Effect.gen(function* () {
      const rule = yield* parseRule(minimal, 'no-as-any.yml')

      expect(Object.hasOwn(rule, 'files')).toBeFalsy()
      expect(Object.hasOwn(rule, 'severity')).toBeFalsy()
      expect(Object.hasOwn(rule, 'message')).toBeFalsy()
    }),
  )

  effect('parses every optional field when present', () =>
    Effect.gen(function* () {
      const rule = yield* parseRule(
        `
id: no-raw-coercion
language: typescript
severity: warning
message: use a parser
note: |
  Longer rationale.
rule:
  pattern: String($ARG)
constraints:
  ARG:
    kind: identifier
    regex: '^value$'
    not:
      kind: string
      regex: '(?i)^err'
utils:
  insideBridge:
    kind: pair
files:
  - '**/*.ts'
ignores:
  - '**/*.test.ts'
`,
        'full.yml',
      )

      expect(rule.severity).toBe('warning')
      expect(rule.message).toBe('use a parser')
      expect(rule.note).toContain('Longer rationale.')
      expect(rule.files).toEqual(['**/*.ts'])
      expect(rule.ignores).toEqual(['**/*.test.ts'])
      expect(rule.utils).toEqual({ insideBridge: { kind: 'pair' } })
      expect(rule.constraints?.ARG).toEqual({
        kind: 'identifier',
        not: { kind: 'string', regex: '(?i)^err' },
        regex: '^value$',
      })
    }),
  )

  effect('reports the origin on failure', () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(parseRule('id: [', 'broken.yml'))

      expect(error.origin).toBe('broken.yml')
      expect(error._tag).toBe('RuleParseError')
    }),
  )

  effect('rejects malformed YAML', () =>
    Effect.gen(function* () {
      expect(yield* expectRejection('id: "unterminated')).toContain('YAML')
    }),
  )

  effect('rejects a document that is not a mapping', () =>
    Effect.gen(function* () {
      expect(yield* expectRejection('- a\n- b')).toContain('mapping')
    }),
  )

  effect('rejects a missing id', () =>
    Effect.gen(function* () {
      expect(yield* expectRejection('language: tsx\nrule:\n  pattern: x')).toContain('id')
    }),
  )

  effect('rejects an empty id', () =>
    Effect.gen(function* () {
      expect(yield* expectRejection('id: ""\nlanguage: tsx\nrule:\n  pattern: x')).toContain('id')
    }),
  )

  effect('rejects a missing rule matcher', () =>
    Effect.gen(function* () {
      expect(yield* expectRejection('id: x\nlanguage: tsx')).toContain('rule')
    }),
  )

  effect('rejects an unsupported language', () =>
    Effect.gen(function* () {
      expect(yield* expectRejection('id: x\nlanguage: yaml\nrule:\n  pattern: x')).toContain('language')
    }),
  )

  effect('rejects an unknown severity', () =>
    Effect.gen(function* () {
      expect(yield* expectRejection('id: x\nlanguage: tsx\nseverity: fatal\nrule:\n  pattern: x')).toContain('severity')
    }),
  )

  effect('rejects non-string glob entries', () =>
    Effect.gen(function* () {
      expect(yield* expectRejection('id: x\nlanguage: tsx\nrule:\n  pattern: x\nfiles:\n  - 7')).toContain('files')
    }),
  )

  effect('rejects a constraint that is not a mapping', () =>
    Effect.gen(function* () {
      expect(yield* expectRejection('id: x\nlanguage: tsx\nrule:\n  pattern: x\nconstraints:\n  ARG: nope')).toContain(
        'constraints',
      )
    }),
  )
})
