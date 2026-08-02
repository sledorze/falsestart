import { describe, effect, expect } from '@effect/vitest'
import { Effect } from 'effect'
import { findViolations } from './matcher.ts'
import { parseRule } from './rule.ts'

const violationsOf = (ruleSource: string, code: string) =>
  parseRule(ruleSource, 'test.yml').pipe(Effect.flatMap((rule) => findViolations(rule, code)))

const textsOf = (ruleSource: string, code: string) =>
  violationsOf(ruleSource, code).pipe(Effect.map((found) => found.map((violation) => violation.text)))

const asAny = `
id: no-as-any
language: tsx
rule:
  pattern: $X as any
`

const stringCoercion = (constraints: string) => `
id: no-string-coercion
language: tsx
rule:
  pattern: String($ARG)
constraints:
${constraints}
`

describe('match engine', () => {
  effect('finds a violation for a matching pattern', () =>
    Effect.gen(function* () {
      expect(yield* textsOf(asAny, 'const x = value as any')).toEqual(['value as any'])
    }),
  )

  effect('finds nothing in conforming code', () =>
    Effect.gen(function* () {
      expect(yield* textsOf(asAny, 'const x = value as Widget')).toEqual([])
    }),
  )

  effect('reports every occurrence, not just the first', () =>
    Effect.gen(function* () {
      const found = yield* textsOf(asAny, 'const a = x as any\nconst b = y as any\n')

      expect(found).toHaveLength(2)
    }),
  )

  effect('reports one-based line and column for the match', () =>
    Effect.gen(function* () {
      const [violation] = yield* violationsOf(asAny, 'const ok = 1\nconst bad = value as any\n')

      expect(violation?.line).toBe(2)
      expect(violation?.column).toBe(13)
    }),
  )

  effect('supports composite matchers', () =>
    Effect.gen(function* () {
      const rule = `
id: no-promise-chaining
language: tsx
rule:
  any:
    - pattern: $E.then($$$A)
    - pattern: $E.catch($$$A)
`

      expect(yield* textsOf(rule, 'run().then(a)')).toHaveLength(1)
      expect(yield* textsOf(rule, 'run().catch(a)')).toHaveLength(1)
      expect(yield* textsOf(rule, 'run().finally(a)')).toEqual([])
    }),
  )

  effect('narrows matches with a regex constraint on a metavariable', () =>
    Effect.gen(function* () {
      const rule = stringCoercion("  ARG:\n    regex: '^value$'")

      expect(yield* textsOf(rule, 'String(value)')).toEqual(['String(value)'])
      expect(yield* textsOf(rule, 'String(other)')).toEqual([])
    }),
  )

  effect('honours a negated constraint as an exemption', () =>
    Effect.gen(function* () {
      const rule = stringCoercion("  ARG:\n    not:\n      regex: '^err'")

      expect(yield* textsOf(rule, 'String(value)')).toEqual(['String(value)'])
      expect(yield* textsOf(rule, 'String(err)')).toEqual([])
    }),
  )

  effect("applies the regex crate's inline case-insensitive flag", () =>
    Effect.gen(function* () {
      const rule = stringCoercion("  ARG:\n    not:\n      regex: '(?i)^err'")

      expect(yield* textsOf(rule, 'String(ERR)')).toEqual([])
      expect(yield* textsOf(rule, 'String(value)')).toEqual(['String(value)'])
    }),
  )

  effect('resolves a named utility rule referenced by matches:', () =>
    Effect.gen(function* () {
      const rule = `
id: no-any-assertion
language: tsx
utils:
  anyKeyword:
    kind: predefined_type
    regex: '^any$'
rule:
  kind: as_expression
  has:
    matches: anyKeyword
`

      expect(yield* textsOf(rule, 'const x = value as any')).toEqual(['value as any'])
      expect(yield* textsOf(rule, 'const x = value as Widget')).toEqual([])
    }),
  )

  effect('parses each language it claims to support', () =>
    Effect.gen(function* () {
      const css = `
id: no-important
language: css
rule:
  kind: important
`

      expect(yield* textsOf(css, 'a { color: red !important; }')).toHaveLength(1)
    }),
  )

  effect('fails with the rule id when the matcher is structurally invalid', () =>
    Effect.gen(function* () {
      // Parsed up front so the flipped error is a MatchError specifically, rather than the
      // union it would be if the parse step could also fail here.
      const rule = yield* parseRule(
        `
id: broken-rule
language: tsx
rule:
  nonsense: true
`,
        'broken.yml',
      )
      const error = yield* Effect.flip(findViolations(rule, 'const x = 1'))

      expect(error._tag).toBe('MatchError')
      expect(error.ruleId).toBe('broken-rule')
    }),
  )
})

describe('rule structure validation', () => {
  effect('rejects an `all` of bare pattern/regex with no kind, as the ast-grep CLI does', () =>
    Effect.gen(function* () {
      // The upstream CLI rejects this ("Rule must specify a set of AST kinds"); the napi binding
      // accepts it and then matches essentially every node. Without this check a rule that the
      // real engine considers broken silently reports a violation on almost any input.
      const rule = yield* parseRule(
        `
id: all-without-kind
language: tsx
rule:
  all:
    - pattern: $X
    - regex: 'foo'
`,
        'broken.yml',
      )

      const error = yield* Effect.flip(findViolations(rule, 'const foo = 1'))

      expect(error._tag).toBe('MatchError')
      expect(error.reason).toContain('kind')
    }),
  )

  effect('still allows an `all` that does pin a kind', () =>
    Effect.gen(function* () {
      const rule = yield* parseRule(
        `
id: all-with-kind
language: tsx
rule:
  all:
    - kind: identifier
    - regex: '^foo$'
`,
        'ok.yml',
      )

      expect(yield* findViolations(rule, 'const foo = 1')).toHaveLength(1)
    }),
  )

  effect('allows a single-element `all`, which is unambiguous', () =>
    Effect.gen(function* () {
      const rule = yield* parseRule(
        `
id: all-single
language: tsx
rule:
  all:
    - pattern: $X as any
`,
        'ok.yml',
      )

      expect(yield* findViolations(rule, 'const a = b as any')).toHaveLength(1)
    }),
  )

  effect('rejects an empty `all`', () =>
    Effect.gen(function* () {
      const rule = yield* parseRule('id: empty-all\nlanguage: tsx\nrule:\n  all: []\n', 'broken.yml')

      const error = yield* Effect.flip(findViolations(rule, 'const a = 1'))

      expect(error.reason).toContain('empty')
    }),
  )
})
