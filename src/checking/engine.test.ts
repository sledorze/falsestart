import { describe, effect, expect } from '@effect/vitest'
import { Effect } from 'effect'
import { checkFile } from './engine.ts'
import type { Rule } from './rule.ts'
import { parseRule } from './rule.ts'

const ruleOf = (source: string) => parseRule(source, 'test.yml')

// `Effect.all` rather than `Effect.forEach`: a lint rule keyed on the NAME `forEach` reads any
// two-argument call as an array iteration with a `thisArg`, which this is not.
const rulesOf = (...sources: readonly string[]) => Effect.all(sources.map((source) => ruleOf(source)))

const noAsAny = (extra = '') => `
id: no-as-any
language: tsx
message: 'as any erases the type'
rule:
  pattern: $X as any
${extra}
`

const dirty = { content: 'const x = value as any', path: 'src/widget.ts' }

describe('check engine', () => {
  effect('reports a finding when an in-scope rule matches', () =>
    Effect.gen(function* () {
      const findings = yield* checkFile(yield* rulesOf(noAsAny()), dirty)

      expect(findings).toHaveLength(1)
      expect(findings[0]?.ruleId).toBe('no-as-any')
      expect(findings[0]?.message).toBe('as any erases the type')
      expect(findings[0]?.line).toBe(1)
    }),
  )

  effect('reports nothing for conforming content', () =>
    Effect.gen(function* () {
      const findings = yield* checkFile(yield* rulesOf(noAsAny()), {
        content: 'const x = value as Widget',
        path: 'src/widget.ts',
      })

      expect(findings).toEqual([])
    }),
  )

  effect('does not run a rule whose files glob excludes the path', () =>
    Effect.gen(function* () {
      const scoped = noAsAny("files:\n  - '**/*.tsx'")

      // Same violating content, only the path differs — the rule must stay silent.
      const findings = yield* checkFile(yield* rulesOf(scoped), dirty)

      expect(findings).toEqual([])
    }),
  )

  effect('does not run a rule the path is ignored by', () =>
    Effect.gen(function* () {
      const scoped = noAsAny("ignores:\n  - '**/*.test.ts'")

      const findings = yield* checkFile(yield* rulesOf(scoped), {
        content: dirty.content,
        path: 'src/widget.test.ts',
      })

      expect(findings).toEqual([])
    }),
  )

  effect('aggregates findings across every applicable rule', () =>
    Effect.gen(function* () {
      const rules = yield* rulesOf(
        noAsAny(),
        `
id: no-let
language: tsx
message: prefer const
rule:
  pattern: let $N = $V
`,
      )

      const findings = yield* checkFile(rules, { content: 'let x = value as any', path: 'src/widget.ts' })

      expect(findings.map((finding) => finding.ruleId).toSorted()).toEqual(['no-as-any', 'no-let'])
    }),
  )

  effect('defaults severity to error when the rule omits it', () =>
    Effect.gen(function* () {
      const findings = yield* checkFile(yield* rulesOf(noAsAny()), dirty)

      expect(findings[0]?.severity).toBe('error')
    }),
  )

  effect('preserves a declared severity', () =>
    Effect.gen(function* () {
      const findings = yield* checkFile(yield* rulesOf(noAsAny('severity: warning')), dirty)

      expect(findings[0]?.severity).toBe('warning')
    }),
  )

  effect('falls back to note when the rule carries no message', () =>
    Effect.gen(function* () {
      const rules = yield* rulesOf(`
id: note-only
language: tsx
note: the longer rationale
rule:
  pattern: $X as any
`)

      const findings = yield* checkFile(rules, dirty)

      expect(findings[0]?.message).toBe('the longer rationale')
    }),
  )

  effect('falls back to the rule id when it carries neither message nor note', () =>
    Effect.gen(function* () {
      const rules = yield* rulesOf(`
id: bare-rule
language: tsx
rule:
  pattern: $X as any
`)

      const findings = yield* checkFile(rules, dirty)

      expect(findings[0]?.message).toContain('bare-rule')
    }),
  )

  effect('returns nothing when there are no rules at all', () =>
    Effect.gen(function* () {
      expect(yield* checkFile([], dirty)).toEqual([])
    }),
  )

  effect('reports one finding per rule per position, not one per matching alternative', () =>
    Effect.gen(function* () {
      // An `any:` rule can match several of its alternatives at the same node. Shipped,
      // `load().then(d).catch(e)` tripped `no-then-catch` twice at identical coordinates, and a
      // reader of the blocked-write message sees two problems with nothing to tell them apart.
      const overlapping: Rule = {
        id: 'overlapping',
        language: 'tsx',
        rule: { any: [{ pattern: '$E.then($$$A)' }, { pattern: '$E.catch($$$A)' }] },
      }

      // A chain: `.then` and `.catch` are different alternatives whose matched nodes START at the
      // same offset, so both report line 1 column 11.
      const source = 'const r = load().then((d) => d).catch((e) => handle(e))'
      const findings = yield* checkFile([overlapping], { content: source, path: 'src/a.ts' })

      expect(findings).toHaveLength(1)
    }),
  )

  effect('fails rather than under-reporting when a rule cannot be run', () =>
    Effect.gen(function* () {
      const broken: Rule = { id: 'broken', language: 'tsx', rule: { nonsense: true } }

      const error = yield* Effect.flip(checkFile([broken], dirty))

      expect(error._tag).toBe('MatchError')
      expect(error.ruleId).toBe('broken')
    }),
  )
})
