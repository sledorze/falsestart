import { describe, effect, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { parseRule } from '../checking/rule.ts'
import { assessRule, findUntestedRules } from './assess.ts'

const noAsAny = parseRule(
  `
id: no-as-any
language: tsx
message: 'as any erases the type'
rule:
  pattern: $X as any
files:
  - '**/*.ts'
`,
  'no-as-any.yml',
)

describe('rule assessment', () => {
  effect('passes a violating case that does trip the rule', () =>
    Effect.gen(function* () {
      const results = yield* assessRule(yield* noAsAny, [
        { code: 'const x = v as any', expectViolation: true, name: 'plain cast', path: 'a.ts' },
      ])

      expect(results[0]?.passed).toBeTruthy()
    }),
  )

  effect('fails a violating case the rule misses', () =>
    Effect.gen(function* () {
      const results = yield* assessRule(yield* noAsAny, [
        { code: 'const x = v as Widget', expectViolation: true, name: 'should have tripped', path: 'a.ts' },
      ])

      expect(results[0]?.passed).toBeFalsy()
      expect(results[0]?.detail).toContain('expected a violation')
    }),
  )

  effect('passes a valid case the rule leaves alone', () =>
    Effect.gen(function* () {
      const results = yield* assessRule(yield* noAsAny, [
        { code: 'const x = v as Widget', expectViolation: false, name: 'narrow cast', path: 'a.ts' },
      ])

      expect(results[0]?.passed).toBeTruthy()
    }),
  )

  effect('fails a valid case the rule wrongly flags', () =>
    Effect.gen(function* () {
      const results = yield* assessRule(yield* noAsAny, [
        { code: 'const x = v as any', expectViolation: false, name: 'false positive', path: 'a.ts' },
      ])

      expect(results[0]?.passed).toBeFalsy()
      expect(results[0]?.detail).toContain('unexpected')
    }),
  )

  effect('honours the rule file scope, so a case can prove where a rule must NOT reach', () =>
    Effect.gen(function* () {
      const results = yield* assessRule(yield* noAsAny, [
        { code: 'const x = v as any', expectViolation: false, name: 'out of scope', path: 'a.tsx' },
      ])

      expect(results[0]?.passed).toBeTruthy()
    }),
  )

  effect('reports each case independently', () =>
    Effect.gen(function* () {
      const results = yield* assessRule(yield* noAsAny, [
        { code: 'const x = v as any', expectViolation: true, name: 'first', path: 'a.ts' },
        { code: 'const y = w as W', expectViolation: true, name: 'second', path: 'a.ts' },
      ])

      expect(results.map((result) => result.passed)).toEqual([true, false])
      expect(results.map((result) => result.name)).toEqual(['first', 'second'])
    }),
  )

  effect('returns nothing to report when given no cases', () =>
    Effect.gen(function* () {
      expect(yield* assessRule(yield* noAsAny, [])).toEqual([])
    }),
  )
})

describe('rule test coverage gate', () => {
  const rules = [{ id: 'alpha' }, { id: 'beta' }, { id: 'gamma' }]

  it('names rules that have no test file', () => {
    expect(findUntestedRules(rules, ['alpha.test.ts', 'gamma.test.ts'])).toEqual(['beta'])
  })

  it('is satisfied when every rule is covered', () => {
    expect(findUntestedRules(rules, ['alpha.test.ts', 'beta.test.ts', 'gamma.test.ts'])).toEqual([])
  })

  it('ignores test files that match no rule', () => {
    expect(findUntestedRules([{ id: 'alpha' }], ['alpha.test.ts', 'stray.test.ts'])).toEqual([])
  })

  it('reports every rule when there are no tests at all', () => {
    expect(findUntestedRules(rules, [])).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('matches a test file regardless of the directory it sits in', () => {
    expect(findUntestedRules([{ id: 'alpha' }], ['rules/type-safety/alpha.test.ts'])).toEqual([])
  })
})
