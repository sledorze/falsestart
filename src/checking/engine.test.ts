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

/**
 * Which grammar a file is parsed with is decided by the FILE, not by the rule.
 *
 * Every shipped rule declares `language: tsx`, which in falsestart means "parse it as TSX" rather
 * than "only .tsx files" — that is what lets one rule cover `.ts`, `.mts` and `.js`. The cost was
 * that a `.ts` file was being parsed with the TSX grammar, and the two grammars genuinely differ:
 * TSX reads `<string>` as the start of a JSX element, TypeScript reads it as a cast. After one, TSX
 * cannot see the rest of the file.
 *
 * Measured over 424 real `.ts` files: three findings the TypeScript grammar sees and TSX does not,
 * including a real `try`/`catch`. Not a large number, and a missed violation regardless — which is
 * the one kind of wrong this tool cannot be.
 */
describe('choosing a grammar', () => {
  const castThenTry = 'const a = <string>value\ntry { f() } catch (cause) {}'

  const noTryCatch = `
id: no-try-catch
language: tsx
message: 'try/catch'
rule:
  kind: try_statement
files:
  - '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'
`

  effect('parses a .ts file as TypeScript, so an angle-bracket cast does not hide the rest', () =>
    Effect.gen(function* () {
      const rules = yield* rulesOf(noTryCatch)

      const found = yield* checkFile(rules, { content: castThenTry, path: 'src/a.ts' })

      expect(found.map((finding) => finding.ruleId)).toEqual(['no-try-catch'])
    }),
  )

  effect('parses .mts and .cts as TypeScript too', () =>
    Effect.gen(function* () {
      const rules = yield* rulesOf(noTryCatch)
      const counts: number[] = []

      for (const path of ['src/a.mts', 'src/a.cts']) {
        counts.push((yield* checkFile(rules, { content: castThenTry, path })).length)
      }

      expect(counts).toEqual([1, 1])
    }),
  )

  effect('still parses a .tsx file as TSX, where the same text really is JSX', () =>
    Effect.gen(function* () {
      // The opposite mistake would be just as bad: `<string>value` in a .tsx file IS an unclosed
      // JSX element, and parsing it as a cast would invent a `try` the file does not have.
      const rules = yield* rulesOf(noTryCatch)

      expect(yield* checkFile(rules, { content: castThenTry, path: 'src/a.tsx' })).toHaveLength(0)
    }),
  )

  effect('parses a .js file as JavaScript', () =>
    Effect.gen(function* () {
      const rules = yield* rulesOf(noTryCatch)

      expect(yield* checkFile(rules, { content: 'try { f() } catch (cause) {}', path: 'src/a.js' })).toHaveLength(1)
    }),
  )

  effect('leaves a rule for a language outside the JavaScript family alone', () =>
    Effect.gen(function* () {
      // A CSS rule scoped to `.css` must keep its own grammar; the extension says nothing about
      // which JavaScript-family parser to use, and overriding it would break the rule entirely.
      const cssRule = `
id: no-important
language: css
message: 'no !important'
rule:
  pattern: '!important'
files:
  - '**/*.css'
`
      const rules = yield* rulesOf(cssRule)

      expect(yield* checkFile(rules, { content: 'a { color: red !important; }', path: 'src/a.css' })).toHaveLength(1)
    }),
  )
})
