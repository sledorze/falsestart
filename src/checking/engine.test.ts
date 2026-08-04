import { describe, effect, expect } from '@effect/vitest'
import { Effect } from 'effect'
import { checkFile, fallbacks } from './engine.ts'
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

/**
 * A rule that cannot run under the file's grammar must not silence the rules that can.
 *
 * Choosing the grammar from the extension made this reachable through ordinary configuration:
 * widen a TypeScript-syntax rule to `.js` with a documented `files` override, and its pattern no
 * longer compiles — `$X as any` is not valid under the JavaScript grammar. The whole check for that
 * file then failed, so a real `process.exit(1)` in the same file was ALLOWED, because the hook
 * treats "a rule could not run" as non-blocking. One misconfigured rule turned the guard off.
 *
 * The answer is to fall back to the grammar the rule itself declares. That is the grammar its
 * author wrote the pattern against, so it is the one under which it is meant to compile.
 */
describe('a rule that cannot run under the file grammar', () => {
  const asAnyForJs = `
id: no-as-any
language: tsx
message: 'as any'
rule:
  pattern: $X as any
files:
  - '**/*.{ts,js}'
`

  const noProcessExit = `
id: no-process-exit
language: tsx
message: 'no process.exit'
rule:
  pattern: process.exit($$$ARGS)
files:
  - '**/*.{ts,js}'
`

  effect('does not stop the other rules from reporting', () =>
    Effect.gen(function* () {
      const rules = yield* rulesOf(asAnyForJs, noProcessExit)

      const found = yield* checkFile(rules, { content: 'process.exit(1)', path: 'src/a.js' })

      expect(found.map((finding) => finding.ruleId)).toEqual(['no-process-exit'])
    }),
  )

  effect('falls back to the grammar the rule declares, so it still matches what it was written for', () =>
    Effect.gen(function* () {
      // `kind: jsx_element` exists in the TSX grammar and not in TypeScript. A rule declaring
      // `tsx` and scoped to `.ts` is asking for exactly that, and must keep working.
      const jsxRule = `
id: no-jsx
language: tsx
message: 'no jsx'
rule:
  kind: jsx_element
files:
  - '**/*.ts'
`
      const rules = yield* rulesOf(jsxRule)

      const found = yield* checkFile(rules, { content: 'const x = <div>hi</div>', path: 'src/a.ts' })

      expect(found.map((finding) => finding.ruleId)).toEqual(['no-jsx'])
    }),
  )

  effect('still reports a rule that cannot run under EITHER grammar', () =>
    Effect.gen(function* () {
      // The fallback must not become a way of swallowing a genuinely broken rule.
      const broken = `
id: broken
language: tsx
message: 'broken'
rule:
  matches: no-such-util
files:
  - '**/*.ts'
`
      const rules = yield* rulesOf(broken)

      const outcome = yield* Effect.result(checkFile(rules, { content: 'const a = 1', path: 'src/a.ts' }))

      expect(outcome._tag).toBe('Failure')
    }),
  )
})

/**
 * A fallback that nobody can see is the same disease this codebase keeps treating.
 *
 * `findingsFor` silently retries a rule under its declared grammar when the file's grammar cannot
 * compile it. That keeps one misconfigured rule from disabling the others — but a rule quietly
 * running under a different grammar than the file implies is exactly the kind of fact that is true
 * for months and surprises somebody. It is a property of the RULE SET, not of any one write, so it
 * is reported once rather than on every tool call.
 */
describe('reporting a grammar fallback', () => {
  effect('names a rule that cannot run under the grammar its own scope implies', () =>
    Effect.gen(function* () {
      const asAnyForJs = `
id: no-as-any
language: tsx
message: 'as any'
rule:
  pattern: $X as any
files:
  - '**/*.{ts,js}'
`
      const rules = yield* rulesOf(asAnyForJs)

      expect(yield* fallbacks(rules)).toEqual([{ declared: 'tsx', extension: 'js', ruleId: 'no-as-any' }])
    }),
  )

  effect('says nothing about a rule that runs everywhere it is scoped', () =>
    Effect.gen(function* () {
      const rules = yield* rulesOf(noAsAny("files:\n  - '**/*.{ts,tsx,mts,cts}'"))

      expect(yield* fallbacks(rules)).toEqual([])
    }),
  )

  effect('finds a fallback for a rule scoped to a directory, not just a bare extension', () =>
    Effect.gen(function* () {
      // Probing with a bare `probe.js` skipped every directory-anchored rule — which is the shape
      // the CLI's own help documents (`files: ['src/domain/**/*.ts']`). The fallback then happened
      // in production while the diagnostic reported the rule set healthy: silent, which is the one
      // thing this report exists to prevent.
      const directoryScoped = `
id: domain-as-any
language: tsx
message: 'as any'
rule:
  pattern: $X as any
files:
  - 'src/domain/**/*.js'
`
      const rules = yield* rulesOf(directoryScoped)

      expect(yield* fallbacks(rules)).toEqual([{ declared: 'tsx', extension: 'js', ruleId: 'domain-as-any' }])
    }),
  )

  effect('covers a rule that declares no files at all, which reaches every path', () =>
    Effect.gen(function* () {
      // A rule may rely entirely on its matcher. It still lands on `.js` files, and its pattern
      // still has to compile there or fall back.
      const unscoped = `
id: everywhere-as-any
language: tsx
message: 'as any'
rule:
  pattern: $X as any
`
      const rules = yield* rulesOf(unscoped)
      const reported = yield* fallbacks(rules)

      expect(reported.map((entry) => entry.extension).toSorted()).toEqual(['cjs', 'js', 'jsx', 'mjs'])
    }),
  )

  effect('does not call a rule that runs under NO grammar a fallback', () =>
    Effect.gen(function* () {
      // "Falls back to tsx" claims a working recovery. A rule that cannot run at all has none, and
      // is reported as broken elsewhere; saying both is worse than saying one.
      const broken = `
id: broken
language: tsx
message: 'broken'
rule:
  matches: no-such-util
files:
  - '**/*.ts'
`
      const rules = yield* rulesOf(broken)

      expect(yield* fallbacks(rules)).toEqual([])
    }),
  )

  effect('says nothing about the shipped corpus, which is the point', () =>
    Effect.gen(function* () {
      const rules = yield* rulesOf(
        noAsAny("files:\n  - '**/*.{ts,tsx,mts,cts}'"),
        `
id: no-try-catch
language: tsx
message: 'try'
rule:
  kind: try_statement
files:
  - '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'
`,
      )

      expect(yield* fallbacks(rules)).toEqual([])
    }),
  )
})
