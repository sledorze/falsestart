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
  // Every shape below was run against the real `ast-grep` CLI (@ast-grep/cli 0.45) and records
  // what it actually decided, not what seemed reasonable. The first draft of this validator was
  // written from reasoning and got three of these wrong in both directions.
  const ACCEPTED: readonly (readonly [string, string])[] = [
    ['a structured pattern', 'pattern: $X as any'],
    ['all with one structured pattern', 'all:\n    - pattern: $X as any'],
    ['all where a pattern narrows and a regex does not', "all:\n    - pattern: $X as any\n    - regex: 'value'"],
    ['all of two structured patterns', 'all:\n    - pattern: $X as any\n    - pattern: value as $T'],
    ['all with a kind alongside a regex', "all:\n    - kind: identifier\n    - regex: '^foo$'"],
    ['all with a kind alongside a bare metavariable', 'all:\n    - pattern: $X\n    - kind: identifier'],
    ['all of a single kind', 'all:\n    - kind: identifier'],
    ['any where every branch narrows', 'any:\n    - pattern: $X as any\n    - pattern: value as $T'],
    ['any of kinds', 'any:\n    - kind: identifier\n    - kind: number'],
    ['an empty any, which matches nothing', 'any: []'],
  ]

  const REJECTED: readonly (readonly [string, string])[] = [
    ['a bare regex', "regex: 'foo'"],
    ['a bare metavariable pattern', 'pattern: $X'],
    ['a bare multi-metavariable pattern', 'pattern: $$$ARGS'],
    ['all of a bare metavariable and a regex', "all:\n    - pattern: $X\n    - regex: 'foo'"],
    ['all of two bare metavariables', 'all:\n    - pattern: $X\n    - pattern: $Y'],
    ['all of regexes', "all:\n    - regex: 'foo'\n    - regex: 'bad'"],
    ['all of a single regex', "all:\n    - regex: 'foo'"],
    ['all of a relational clause and a regex', "all:\n    - has:\n        kind: identifier\n    - regex: 'foo'"],
    ['an empty all', 'all: []'],
    ['any where one branch does not narrow', "any:\n    - pattern: $X as any\n    - regex: 'value'"],
    ['any of regexes', "any:\n    - regex: 'foo'\n    - regex: 'bad'"],
    ['a bare has', 'has:\n    kind: identifier'],
    ['a bare inside', 'has:\n    kind: variable_declarator'],
    ['a negated regex alone', "not:\n    regex: 'foo'"],
    ['a negated kind alone', 'not:\n    kind: identifier'],
    ['a nested all that narrows nothing', "any:\n    - all:\n        - pattern: $X\n        - regex: 'foo'"],
  ]

  const ruleFor = (body: string) => `id: probe\nlanguage: tsx\nrule:\n  ${body}\n`

  for (const [name, body] of ACCEPTED) {
    effect(`accepts ${name}`, () =>
      Effect.gen(function* () {
        const rule = yield* parseRule(ruleFor(body), 'probe.yml')

        // Validation must not stand in the way of running it at all.
        expect(yield* findViolations(rule, 'const bad = value as any')).toBeInstanceOf(Array)
      }),
    )
  }

  for (const [name, body] of REJECTED) {
    effect(`rejects ${name}`, () =>
      Effect.gen(function* () {
        const rule = yield* parseRule(ruleFor(body), 'probe.yml')

        const error = yield* Effect.flip(findViolations(rule, 'const bad = value as any'))

        expect(error._tag).toBe('MatchError')
      }),
    )
  }

  effect('resolves a matches: reference rather than assuming it narrows nothing', () =>
    Effect.gen(function* () {
      const rule = yield* parseRule(
        `
id: uses-util
language: tsx
utils:
  anyKeyword:
    kind: predefined_type
rule:
  matches: anyKeyword
`,
        'probe.yml',
      )

      expect(yield* findViolations(rule, 'const bad = value as any')).toBeInstanceOf(Array)
    }),
  )

  effect('surfaces a failure from ast-grep itself, not only from our own pre-check', () =>
    Effect.gen(function* () {
      // Narrows a kind, so it passes validation and reaches the engine — which rejects the kind.
      const rule = yield* parseRule('id: bogus-kind\nlanguage: tsx\nrule:\n  kind: no_such_node_kind\n', 'probe.yml')

      const error = yield* Effect.flip(findViolations(rule, 'const a = 1'))

      expect(error.ruleId).toBe('bogus-kind')
    }),
  )

  effect('accepts an object-form pattern, which carries its own context', () =>
    Effect.gen(function* () {
      // `pattern: { context, selector }` is a mapping rather than a string, so the
      // bare-metavariable test does not apply to it.
      const rule = yield* parseRule(
        'id: contextual\nlanguage: tsx\nrule:\n  pattern:\n    context: const $N = $V\n    selector: variable_declarator\n',
        'probe.yml',
      )

      expect(yield* findViolations(rule, 'const a = 1')).toHaveLength(1)
    }),
  )

  effect('rejects a bare string rule, which ast-grep does not accept either', () =>
    Effect.gen(function* () {
      const rule = yield* parseRule('id: shorthand\nlanguage: tsx\nrule: $X as any\n', 'probe.yml')

      expect((yield* Effect.flip(findViolations(rule, 'const bad = value as any')))._tag).toBe('MatchError')
    }),
  )

  effect('rejects a matcher that is not a mapping at all', () =>
    Effect.gen(function* () {
      const rule = yield* parseRule('id: numeric\nlanguage: tsx\nrule: 42\n', 'probe.yml')

      expect((yield* Effect.flip(findViolations(rule, 'const a = 1')))._tag).toBe('MatchError')
    }),
  )
})
