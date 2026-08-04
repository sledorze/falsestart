/**
 * Turning falsestart's rules into rule documents the upstream ast-grep CLI will execute.
 *
 * The two engines disagree about what `language` MEANS, and that is the whole reason this module
 * exists. falsestart picks files by a rule's `files` globs and parses each with the rule's declared
 * language; ast-grep picks files by the language's own extension mapping and then narrows with
 * `files`. So a rule saying `language: tsx`, scoped to `**\/*.ts`, matches everything under
 * falsestart and NOTHING under ast-grep — measured: 0 findings over a 424-file corpus.
 *
 * Reproducing falsestart's answer therefore means emitting one copy per language family the rule
 * can actually reach. The corner cases below are the ones that make that more than a rename.
 */
import { describe, expect, it } from 'vitest'
import type { Rule } from '../checking/index.ts'
import { hydrate, originalRuleId } from './hydrate.ts'

const ruleOf = (id: string, files?: readonly string[], ignores?: readonly string[]): Rule => ({
  id,
  language: 'tsx',
  rule: { pattern: '$X as any' },
  ...(files === undefined ? {} : { files }),
  ...(ignores === undefined ? {} : { ignores }),
})

const languagesOf = (documents: readonly { readonly document: { readonly language: string } }[]) =>
  documents.map((d) => d.document.language).toSorted()

describe('hydrating rules for the upstream CLI', () => {
  it('emits one copy per language family the rule can reach', () => {
    // `language: tsx` in falsestart means "parse it as TSX", not "only .tsx files". A rule scoped
    // to every source extension has to become three documents or ast-grep will never show it a
    // `.ts` file.
    const rule = ruleOf('no-as-any', ['**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'])

    expect(languagesOf(hydrate([rule], {}))).toEqual(['javascript', 'tsx', 'typescript'])
  })

  it('emits only the families the globs actually admit', () => {
    // The five TypeScript-syntax rules ship scoped to TypeScript extensions only. Emitting a
    // JavaScript copy of them would claim coverage that cannot fire.
    const rule = ruleOf('no-as-any', ['**/*.{ts,tsx,mts,cts}'])

    expect(languagesOf(hydrate([rule], {}))).toEqual(['tsx', 'typescript'])
  })

  it('gives every copy a distinct id, because ast-grep refuses duplicates', () => {
    const documents = hydrate([ruleOf('no-as-any', ['**/*.{ts,js}'])], {})
    const ids = documents.map((d) => d.document.id)

    expect(new Set(ids).size).toBe(ids.length)
  })

  it('can map a copy back to the rule it came from, for reporting', () => {
    // The finding a user reads must name `no-as-any`, not `no-as-any__typescript`.
    const documents = hydrate([ruleOf('no-as-any', ['**/*.{ts,js}'])], {})
    const origins = documents.map((copy) => originalRuleId(copy.document.id))

    expect(new Set(origins)).toEqual(new Set(['no-as-any']))
  })

  it('leaves an id that was never hydrated alone', () => {
    // Callable on a finding from either engine without the caller knowing which produced it.
    expect(originalRuleId('no-as-any')).toBe('no-as-any')
  })

  it('keeps a rule with no files at all reachable in every family', () => {
    // Absent `files` means every path, which is a real shape — a rule may rely entirely on its
    // matcher. Dropping it here would silently unguard everything.
    const documents = hydrate([ruleOf('anywhere')], {})

    expect(languagesOf(documents)).toEqual(['javascript', 'tsx', 'typescript'])
  })

  it('carries files and ignores through unchanged', () => {
    const rule = ruleOf('r', ['src/**/*.ts'], ['**/*.test.ts'])
    const [first] = hydrate([rule], {})

    expect(first?.document.files).toEqual(['src/**/*.ts'])
    expect(first?.document.ignores).toEqual(['**/*.test.ts'])
  })

  it('unions scan-level exclusions into ignores rather than replacing them', () => {
    // Within one rule, ignoring is a UNION: a path is out if ANY ignore glob names it. Replacing
    // would resurrect the rule's own exemptions; intersecting would make the rule wider than
    // authored, which is how a rule starts firing on the test files it exempts.
    const rule = ruleOf('r', ['src/**/*.ts'], ['**/*.test.ts'])
    const [first] = hydrate([rule], { exclude: ['legacy/**'] })

    expect(first?.document.ignores).toEqual(['**/*.test.ts', 'legacy/**'])
  })

  it('gives a rule with no ignores the exclusions alone', () => {
    const [first] = hydrate([ruleOf('r', ['src/**/*.ts'])], { exclude: ['legacy/**'] })

    expect(first?.document.ignores).toEqual(['legacy/**'])
  })

  it('preserves constraints and utils verbatim', () => {
    // These are the parts a copy must not paraphrase: nine shipped rules carry constraints, and a
    // dropped one silently widens the rule.
    const rule: Rule = {
      constraints: { NS: { regex: '^Effect$' } },
      id: 'r',
      language: 'tsx',
      rule: { pattern: '$NS.$M()' },
      utils: { helper: { kind: 'identifier' } },
    }
    const [first] = hydrate([rule], {})

    expect(first?.document.constraints).toEqual({ NS: { regex: '^Effect$' } })
    expect(first?.document.utils).toEqual({ helper: { kind: 'identifier' } })
  })

  it('keeps severity and message, which are what a reader acts on', () => {
    const rule: Rule = { id: 'r', language: 'tsx', message: 'do not', rule: {}, severity: 'error' }
    const [first] = hydrate([rule], {})

    expect(first?.document.message).toBe('do not')
    expect(first?.document.severity).toBe('error')
  })

  it('respects a rule that inverts the usual scoping', () => {
    // The three test-only rules are scoped to `*.test.*`. A copy that quietly widened them would
    // start reporting on ordinary source.
    const rule = ruleOf('no-vi-mocking', ['**/*.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'])
    const [first] = hydrate([rule], {})

    expect(first?.document.files).toEqual(['**/*.test.{ts,tsx,mts,cts,js,jsx,mjs,cjs}'])
    expect(languagesOf(hydrate([rule], {}))).toEqual(['javascript', 'tsx', 'typescript'])
  })

  it('emits nothing for a rule whose globs admit no source extension', () => {
    // `**/*.ipynb` is a real, documented scope. There is no ast-grep language family for it, and
    // inventing one would run the rule against files it was never meant to see.
    expect(hydrate([ruleOf('notebooks', ['**/*.ipynb'])], {})).toEqual([])
  })

  it('emits nothing for no rules', () => {
    expect(hydrate([], {})).toEqual([])
  })

  it('does not let one rule leak into another', () => {
    const documents = hydrate([ruleOf('a', ['**/*.ts']), ruleOf('b', ['**/*.js'])], {})
    const languagesFor = (id: string) =>
      documents.filter((copy) => originalRuleId(copy.document.id) === id).map((copy) => copy.document.language)

    expect(languagesFor('a')).toEqual(['typescript'])
    expect(languagesFor('b')).toEqual(['javascript'])
  })
})
