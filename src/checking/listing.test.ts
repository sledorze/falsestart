/**
 * The rule set as a document, field for field and byte for byte.
 *
 * Both halves are pinned deliberately. The FIELD SET is a compatibility surface — whatever this
 * emits, an adopting repo asserts on — so a sixth field has to be added here before it can be
 * added anywhere, rather than arriving as a silent widening of a promise. The BYTES are pinned
 * because the layout is the reason anyone can diff two runs at all, and it lives here rather than
 * in `cli.ts` precisely so a test can see it.
 */
import { describe, effect, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { describeRules, ruleListText } from './listing.ts'
import type { Rule } from './rule.ts'
import { appliesTo } from './scope.ts'

const ruleOf = (fields: Partial<Rule> & { readonly id: string }): Rule => ({
  language: 'tsx',
  rule: { pattern: '$X as any' },
  ...fields,
})

describe('the rule set as a document', () => {
  it('emits exactly the five documented fields, and nothing from the matcher', () => {
    // The rule carries every optional field the format has, so anything that leaks leaks here.
    // This is the compatibility-surface test: a sixth key means a promise to a consumer's decode
    // side, and it should not be possible to make that promise by accident.
    const entries = describeRules([
      {
        constraints: { X: { regex: '^any$' } },
        files: ['src/**/*.ts'],
        id: 'no-as-any',
        ignores: ['**/*.test.ts'],
        language: 'tsx',
        message: 'as any erases the type',
        note: 'narrow with a type instead',
        rule: { pattern: '$X as any' },
        severity: 'warning',
        utils: { anyKeyword: { kind: 'any' } },
      },
    ])

    expect(Object.keys(entries[0] ?? {})).toEqual(['files', 'id', 'ignores', 'language', 'severity'])
    expect(entries[0]).toEqual({
      files: ['src/**/*.ts'],
      id: 'no-as-any',
      ignores: ['**/*.test.ts'],
      language: 'tsx',
      severity: 'warning',
    })
  })

  it('resolves a severity the document did not write', () => {
    // A document that omits `severity` and one that spells out `error` describe the same
    // behaviour, so they must not diff against each other.
    const entries = describeRules([ruleOf({ id: 'a-rule', severity: 'warning' }), ruleOf({ id: 'b-rule' })])

    expect(entries.map((entry) => entry.severity)).toEqual(['warning', 'error'])
  })

  it('tells a rule that declares no scope from a rule scoped to nothing', () => {
    // `null` and `[]` are opposites, and collapsing them reports the exact reverse of the truth
    // for one of the two. The `appliesTo` half anchors why: it is the behaviour the encoding is
    // describing, so if that ever stops holding this test says so rather than the docs going quietly
    // false.
    const declaresNothing = ruleOf({ id: 'a-rule' })
    const scopedToNothing = ruleOf({ files: [], id: 'b-rule', ignores: ['**/*.md'] })

    expect(appliesTo(declaresNothing, 'src/x.ts')).toBeTruthy()
    expect(appliesTo(scopedToNothing, 'src/x.ts')).toBeFalsy()

    expect(describeRules([declaresNothing, scopedToNothing])).toEqual([
      { files: null, id: 'a-rule', ignores: null, language: 'tsx', severity: 'error' },
      { files: [], id: 'b-rule', ignores: ['**/*.md'], language: 'tsx', severity: 'error' },
    ])
  })

  it('orders by id, not by the order the rules arrived in', () => {
    // Loader order is the rule documents' PATH order, which leaks the tree's layout into the
    // output: filing a rule under a different category would diff while nothing about behaviour
    // changed, and a diff that fires on a non-change is one people stop reading.
    const entries = describeRules(['d-rule', 'b-rule', 'c-rule', 'a-rule'].map((id) => ruleOf({ id })))

    expect(entries.map((entry) => entry.id)).toEqual(['a-rule', 'b-rule', 'c-rule', 'd-rule'])
  })

  effect('renders one rule per line, in the key order the schema declares', () =>
    Effect.gen(function* () {
      const text = yield* ruleListText([
        ruleOf({ files: ['src/**/*.ts'], id: 'a-rule' }),
        ruleOf({ id: 'b-rule', ignores: ['**/*.md'] }),
      ])

      // The exact bytes, not a round-trip: one rule per line is what makes adding or dropping a
      // rule a one-line diff, and a whitespace-blind assertion is how the same layout regressed
      // once in `baseline.ts`, silently.
      expect(text).toBe(
        `[\n  {"files":["src/**/*.ts"],"id":"a-rule","ignores":null,"language":"tsx","severity":"error"},\n  {"files":null,"id":"b-rule","ignores":["**/*.md"],"language":"tsx","severity":"error"}\n]\n`,
      )
    }),
  )

  effect('renders an empty rule set as [] and nothing else', () =>
    Effect.gen(function* () {
      // `[]` rather than `[\n]`, matching `baselineText`. It is an answer, not a failure: the
      // document says outright that nothing loaded.
      expect(yield* ruleListText([])).toBe('[]\n')
    }),
  )
})
