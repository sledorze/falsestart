/**
 * The shipped rules, proved against worked examples.
 *
 * Every rule carries at least one example it must catch and one it must leave alone. The second
 * kind is the one that matters most: a rule with only positive examples looks correct right up
 * until it starts firing on code nobody meant to forbid.
 *
 * The coverage gate at the bottom fails if a rule is added to `rules/` without examples, so the
 * corpus cannot quietly grow an untested member.
 */
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { describe, effect, expect } from '@effect/vitest'
import { Effect, Layer } from 'effect'
import { loadRules } from './core/loader.ts'
import type { RuleExpectation } from './testing/assess.ts'
import { assessRule, findUntestedRules } from './testing/assess.ts'

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)

const corpus = loadRules('rules').pipe(Effect.provide(platform), Effect.orDie)

const src = 'src/service.ts'

/** `catches` must trip the rule; `allows` must not. Paths are meaningful — scope is behaviour. */
const EXAMPLES: Readonly<Record<string, { readonly allows: readonly string[]; readonly catches: readonly string[] }>> =
  {
    'no-as-any': {
      allows: ['const w = value as Widget', 'const n = value as unknown as Widget'],
      catches: ['const w = value as any', 'call(payload as any)'],
    },
    'no-as-never': {
      allows: ['const n = value as Narrow'],
      catches: ['const n = value as never'],
    },
    'no-await': {
      allows: ['const run = () => Effect.tryPromise({ try: () => fetch(url), catch: onError })'],
      catches: ['const run = async () => { const r = await fetch(url); return r }'],
    },
    'no-double-cast': {
      allows: ['const w = value as Widget', 'const u: unknown = value'],
      catches: ['const w = value as unknown as Widget'],
    },
    'no-new-promise': {
      allows: ['const p = Effect.async<number>((resume) => resume(Effect.succeed(1)))'],
      catches: ['const p = new Promise((resolve) => resolve(1))'],
    },
    'no-process-env': {
      allows: ['const port = yield* Config.integer("PORT")'],
      catches: ['const port = process.env.PORT'],
    },
    'no-process-exit': {
      allows: ['return Effect.fail(new Fatal())'],
      catches: ['process.exit(1)'],
    },
    'no-then-catch': {
      allows: ['const r = Effect.map(effect, decode)', 'const v = thenable.thenify(x)'],
      catches: ['load().then(use)', 'load().catch(onError)', 'load().finally(cleanup)'],
    },
    'no-try-catch': {
      allows: ['const r = Effect.try({ try: () => parse(raw), catch: onError })'],
      catches: ['try { parse(raw) } catch (error) { report(error) }'],
    },
  }

const expectationsFor = (ruleId: string): readonly RuleExpectation[] => {
  const example = EXAMPLES[ruleId]
  if (example === undefined) {
    return []
  }

  return [
    ...example.catches.map((code, index) => ({
      code,
      expectViolation: true,
      name: `${ruleId} catches #${index + 1}: ${code}`,
      path: src,
    })),
    ...example.allows.map((code, index) => ({
      code,
      expectViolation: false,
      name: `${ruleId} allows #${index + 1}: ${code}`,
      path: src,
    })),
    // Every rule in this corpus exempts test files. Proving it per rule keeps a future scope
    // change from silently widening a rule to files it was never meant to police.
    ...example.catches.slice(0, 1).map((code) => ({
      code,
      expectViolation: false,
      name: `${ruleId} leaves test files alone`,
      path: 'src/service.test.ts',
    })),
  ]
}

describe('shipped rule corpus', () => {
  effect('loads cleanly', () =>
    Effect.gen(function* () {
      const rules = yield* corpus

      expect(rules.length).toBeGreaterThan(0)
    }),
  )

  effect('every rule behaves as its examples say', () =>
    Effect.gen(function* () {
      const rules = yield* corpus

      const failures: string[] = []
      for (const rule of rules) {
        const results = yield* assessRule(rule, expectationsFor(rule.id))
        failures.push(
          ...results.filter((result) => !result.passed).map((result) => `${result.name} — ${result.detail}`),
        )
      }

      expect(failures).toEqual([])
    }),
  )

  effect('no rule ships without examples', () =>
    Effect.gen(function* () {
      const rules = yield* corpus

      expect(findUntestedRules(rules, Object.keys(EXAMPLES))).toEqual([])
    }),
  )
})
